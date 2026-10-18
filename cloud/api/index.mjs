// Lambda entry point: wires voice.mjs to DynamoDB, Bedrock and APNs (push.mjs). The AWS SDK v3 ships with the
// Node.js 22 Lambda runtime, so there is nothing to bundle.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { KMSClient, SignCommand, GetPublicKeyCommand } from '@aws-sdk/client-kms';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { createHash, createPublicKey } from 'node:crypto';
import { makeHandler, LOOK_PROMPT, INBOX_KEEP_S } from './voice.mjs';
import { makeAuth } from './auth.mjs';
import { makeApns, makeNotifier, http2Send } from './push.mjs';

const TABLE = process.env.TABLE;
const LOOK_MODEL = process.env.LOOK_MODEL || 'us.anthropic.claude-haiku-5-5';
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const bedrock = new BedrockRuntimeClient({});
const kms = new KMSClient({});

// Single table. pk USER#<sub>; sk HELD (the task waiting for "send it"), SEQ (message counter),
// MSG#<000000id> (inbox, expires after a week), DEVICE#<id> (a phone's push tokens), LISTENING (last inbox poll).
const store = {
  async getHeld(user) {
    const r = await db.send(new GetCommand({ TableName: TABLE, Key: { pk: `USER#${user}`, sk: 'HELD' } }));
    return r.Item?.held ?? null;
  },
  async setHeld(user, held) {
    const Key = { pk: `USER#${user}`, sk: 'HELD' };
    await db.send(held ? new PutCommand({ TableName: TABLE, Item: { ...Key, held } }) : new DeleteCommand({ TableName: TABLE, Key }));
  },
  async addMessage(user, text) {
    const seq = await db.send(new UpdateCommand({
      TableName: TABLE, Key: { pk: `USER#${user}`, sk: 'SEQ' },
      UpdateExpression: 'ADD n :one', ExpressionAttributeValues: { ':one': 1 }, ReturnValues: 'UPDATED_NEW',
    }));
    const id = seq.Attributes.n;
    await db.send(new PutCommand({ TableName: TABLE, Item: {
      pk: `USER#${user}`, sk: `MSG#${String(id).padStart(9, '0')}`, id, text, at: Date.now(),
      expires: Math.floor(Date.now() / 1000) + INBOX_KEEP_S,
    } }));
    return id;
  },
  async messagesAfter(user, after) {
    const r = await db.send(new QueryCommand({
      TableName: TABLE, KeyConditionExpression: 'pk = :pk AND sk > :from',
      ExpressionAttributeValues: { ':pk': `USER#${user}`, ':from': `MSG#${String(after).padStart(9, '0')}` },
      Limit: 20,
    }));
    return (r.Items ?? []).filter((m) => m.sk.startsWith('MSG#')).map(({ id, text, at }) => ({ id, text, at }));
  },
};

const devices = {
  async list(user) {
    const r = await db.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :d)',
      ExpressionAttributeValues: { ':pk': `USER#${user}`, ':d': 'DEVICE#' } }));
    return (r.Items ?? []).map(({ pk, sk, ...device }) => device);
  },
  async save(user, device) {
    const clean = Object.fromEntries(Object.entries(device).filter(([, v]) => v !== undefined));
    await db.send(new PutCommand({ TableName: TABLE, Item: { pk: `USER#${user}`, sk: `DEVICE#${device.device}`, ...clean } }));
  },
  // From a push result: drop dead tokens and fix the environment, only while the dead tokens are still stored.
  async patch(user, id, { env, drop = {} }) {
    const names = {}, values = {}, cond = ['attribute_exists(sk)'], remove = [];
    for (const [field, dead] of Object.entries(drop)) {
      names[`#${field}`] = field; values[`:${field}`] = dead;
      cond.push(`#${field} = :${field}`); remove.push(`#${field}`);
    }
    if (env) { names['#env'] = 'env'; values[':env'] = env; }
    const update = [env ? 'SET #env = :env' : '', remove.length ? `REMOVE ${remove.join(', ')}` : ''].filter(Boolean).join(' ');
    await conditional(new UpdateCommand({ TableName: TABLE, Key: { pk: `USER#${user}`, sk: `DEVICE#${id}` },
      UpdateExpression: update, ConditionExpression: cond.join(' AND '), ExpressionAttributeNames: names,
      ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}) }));
  },
  // expect: the dead tokens; a phone that re-registered since keeps its entry.
  async remove(user, id, expect) {
    const Key = { pk: `USER#${user}`, sk: `DEVICE#${id}` };
    if (!expect) return void await db.send(new DeleteCommand({ TableName: TABLE, Key }));
    const names = {}, values = {}, cond = [];
    for (const field of ['token', 'voipToken']) {
      names[`#${field}`] = field;
      if (expect[field]) { values[`:${field}`] = expect[field]; cond.push(`#${field} = :${field}`); }
      else cond.push(`attribute_not_exists(#${field})`);
    }
    await conditional(new DeleteCommand({ TableName: TABLE, Key, ConditionExpression: cond.join(' AND '),
      ExpressionAttributeNames: names, ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}) }));
  },
  async markListening(user) {
    await db.send(new PutCommand({ TableName: TABLE, Item: { pk: `USER#${user}`, sk: 'LISTENING', at: Date.now() } }));
  },
  async stopListening(user) {
    await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: `USER#${user}`, sk: 'LISTENING' } }));
  },
  async lastListened(user) {
    const r = await db.send(new GetCommand({ TableName: TABLE, Key: { pk: `USER#${user}`, sk: 'LISTENING' } }));
    return r.Item?.at ?? 0;
  },
};

async function conditional(command) {
  try { await db.send(command); }
  catch (e) { if (e.name !== 'ConditionalCheckFailedException') throw e; }
}

// The APNs key lives in Secrets Manager (cloud/setup/setup-apns.ps1). Until it's there, messages
// still reach the inbox; they just don't ring the phone.
let notifier;
async function getNotifier() {
  if (notifier === undefined) {
    try {
      const r = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: process.env.APNS_SECRET }));
      const { teamId, keyId, key } = JSON.parse(r.SecretString);
      notifier = makeNotifier({ devices, apns: makeApns({ teamId, keyId, key, bundleId: process.env.BUNDLE_ID, send: http2Send }) });
    } catch (e) {
      console.warn('Push is off:', e.name, e.message);
      // Only a missing secret is settled; anything else (throttling, a timeout) is tried again next time.
      if (e.name === 'ResourceNotFoundException') notifier = null;
      return null;
    }
  }
  return notifier;
}

/** An agent's spoken line: into the inbox, and a push (call or notification) to the user's phones. */
async function deliver(user, text, from) {
  const id = await store.addMessage(user, text);
  try {
    const notify = await getNotifier();
    if (notify) console.log('push', JSON.stringify(await notify(user, { text, from, id })));
  } catch (e) { console.error('push failed', e); }
  return id;
}

async function look(jpeg, said) {
  const r = await bedrock.send(new ConverseCommand({
    modelId: LOOK_MODEL,
    system: [{ text: LOOK_PROMPT }],
    messages: [{ role: 'user', content: [{ image: { format: 'jpeg', source: { bytes: jpeg } } }, { text: said }] }],
    inferenceConfig: { maxTokens: 300 },
  }));
  return r.output?.message?.content?.find((c) => c.text)?.text?.trim() || "I couldn't make out the photo.";
}

// Cloud agents (Fargate, GitHub App) are build step 4 in cloud/DESIGN.md. Until then a confirmed task
// is acknowledged honestly instead of pretending to run.
async function startTask(user, { project, task }) {
  await deliver(user, `Cloud agents aren't switched on yet, so ${project ?? 'your task'} didn't start. Use your PC relay for now.`, project);
  return 'Sent.';
}

export const handler = makeHandler({ store, look, startTask, devices, deliver });

// ---------- accounts (auth.mjs): Sign in with Apple, sessions signed by KMS ----------
let appleKeys = null, appleKeysAt = 0, publicJwk = null;

async function deleteUser(sub) {
  for (;;) {
    const r = await db.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `USER#${sub}` }, ProjectionExpression: 'pk, sk', Limit: 100 }));
    if (!r.Items?.length) return;
    await Promise.all(r.Items.map((Key) => db.send(new DeleteCommand({ TableName: TABLE, Key }))));
  }
}

const accounts = makeAuth({
  issuer: process.env.ISSUER,
  audience: process.env.BUNDLE_ID,
  async appleKeys() {
    if (!appleKeys || Date.now() - appleKeysAt > 3600_000) {
      const r = await fetch('https://appleid.apple.com/auth/keys', { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`Apple keys: ${r.status}`);
      appleKeys = await r.json(); appleKeysAt = Date.now();
    }
    return appleKeys;
  },
  async sign(bytes) {
    const r = await kms.send(new SignCommand({ KeyId: process.env.SIGNING_KEY, MessageType: 'DIGEST',
      Message: createHash('sha256').update(bytes).digest(), SigningAlgorithm: 'RSASSA_PKCS1_V1_5_SHA_256' }));
    return Buffer.from(r.Signature);
  },
  async publicJwk() {
    if (!publicJwk) {
      const r = await kms.send(new GetPublicKeyCommand({ KeyId: process.env.SIGNING_KEY }));
      const { n, e, kty } = createPublicKey({ key: Buffer.from(r.PublicKey), format: 'der', type: 'spki' }).export({ format: 'jwk' });
      publicJwk = { kty, n, e };
    }
    return publicJwk;
  },
  deleteUser,
});
export const { auth, authorize } = accounts;
