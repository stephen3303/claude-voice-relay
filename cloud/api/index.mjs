// Lambda entry point: wires voice.mjs to DynamoDB, Bedrock, Polly, APNs (push.mjs) and Bridge Pro (storekit.mjs). The AWS SDK v3 ships with the
// Node.js 22 Lambda runtime, so there is nothing to bundle.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import { KMSClient, SignCommand, GetPublicKeyCommand } from '@aws-sdk/client-kms';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { createHash, createPublicKey } from 'node:crypto';
import { makeHandler, LOOK_PROMPT } from './voice.mjs';
import { addMessage } from './inbox.mjs';
import { makeAuth } from './auth.mjs';
import { makeApns, makeNotifier, http2Send } from './push.mjs';
import { makeSpeak } from './speech.mjs';
import { makePro } from './storekit.mjs';
import { makeAgents } from './agents.mjs';
import { makeOwner, OWNER } from './owner.mjs';
import { ECSClient, RunTaskCommand, StopTaskCommand } from '@aws-sdk/client-ecs';

const TABLE = process.env.TABLE;
const LOOK_MODEL = process.env.LOOK_MODEL || 'us.anthropic.claude-haiku-5-5';
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const bedrock = new BedrockRuntimeClient({});
const polly = new PollyClient({});
const SPEECH_VOICE = 'Ruth';   // Polly's en-US voice with both generative and neural engines
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
  addMessage: (user, text) => addMessage(db, TABLE, user, text),
  // Natural-voice characters spent today, per account (pk SPEECH#<sub>, outside USER#<sub> so deleting and
  // recreating an account doesn't reset it; it expires in 3 days) and in total (pk ALL). Refused past max.
  async spendSpeech(key, day, chars, max) {
    try {
      await db.send(new UpdateCommand({
        TableName: TABLE, Key: { pk: key, sk: `SPEECH#${day}` },
        UpdateExpression: 'ADD n :c SET expires = if_not_exists(expires, :exp)',
        ConditionExpression: 'attribute_not_exists(n) OR n <= :room',
        ExpressionAttributeValues: { ':c': chars, ':room': max - chars, ':exp': Math.floor(Date.now() / 1000) + 3 * 86400 },
      }));
      return true;
    } catch (e) {
      if (e.name === 'ConditionalCheckFailedException') return false;
      throw e;
    }
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

// The command's result, or null when its condition failed.
async function conditional(command) {
  try { return await db.send(command); }
  catch (e) { if (e.name !== 'ConditionalCheckFailedException') throw e; return null; }
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

// The app's spoken replies (speech.mjs).
const speak = makeSpeak({
  voice: SPEECH_VOICE,
  synth: async (params, options) => (await polly.send(new SynthesizeSpeechCommand(params), options)).AudioStream.transformToByteArray(),
});

// Bridge Pro (storekit.mjs). pk PRO#<originalTransactionId>, sk OWNER: the account the subscription belongs to and
// its refunded transaction IDs, outside USER#<sub> so a refund outlives the account. pk USER#<sub>, sk PRO: until when.
// Reads are strongly consistent, so a refund written a moment ago is seen.
const proStore = {
  async owner(tx) {
    const r = await db.send(new GetCommand({ TableName: TABLE, Key: { pk: `PRO#${tx}`, sk: 'OWNER' }, ConsistentRead: true }));
    return r.Item ?? null;
  },
  async claim(tx, user) {
    // Under the account first, so deleting it (deleteUser) frees the subscription even with no Pro left. A stray
    // entry is harmless: freeing only removes an owner that is this account.
    await db.send(new PutCommand({ TableName: TABLE, Item: { pk: `USER#${user}`, sk: `PROTX#${tx}`, tx } }));
    try {
      await db.send(new UpdateCommand({ TableName: TABLE, Key: { pk: `PRO#${tx}`, sk: 'OWNER' },
        UpdateExpression: 'SET #user = :user', ConditionExpression: 'attribute_not_exists(#user) OR #user = :user',
        ExpressionAttributeNames: { '#user': 'user' }, ExpressionAttributeValues: { ':user': user } }));
      return true;
    } catch (e) {
      if (e.name === 'ConditionalCheckFailedException') return false;
      throw e;
    }
  },
  async revoke(tx, transactionId) {
    const r = await db.send(new UpdateCommand({ TableName: TABLE, Key: { pk: `PRO#${tx}`, sk: 'OWNER' },
      UpdateExpression: 'ADD revoked :id', ExpressionAttributeValues: { ':id': new Set([transactionId]) }, ReturnValues: 'ALL_NEW' }));
    return r.Attributes?.user ?? null;
  },
  async unrevoke(tx, transactionId) {
    await db.send(new UpdateCommand({ TableName: TABLE, Key: { pk: `PRO#${tx}`, sk: 'OWNER' },
      UpdateExpression: 'DELETE revoked :id', ExpressionAttributeValues: { ':id': new Set([transactionId]) } }));
  },
  async getPro(user) {
    const r = await db.send(new GetCommand({ TableName: TABLE, Key: { pk: `USER#${user}`, sk: 'PRO' }, ConsistentRead: true }));
    return r.Item ?? null;
  },
  async setPro(user, { tx, transactionId, product, env, until }) {
    await conditional(new PutCommand({ TableName: TABLE,
      Item: { pk: `USER#${user}`, sk: 'PRO', tx, transactionId, product, env, until },
      ConditionExpression: 'attribute_not_exists(#until) OR #until < :until',
      ExpressionAttributeNames: { '#until': 'until' }, ExpressionAttributeValues: { ':until': until } }));
  },
  async dropPro(user, transactionId) {
    await conditional(new DeleteCommand({ TableName: TABLE, Key: { pk: `USER#${user}`, sk: 'PRO' },
      ConditionExpression: 'transactionId = :id', ExpressionAttributeValues: { ':id': transactionId } }));
  },
};
const pro = makePro({ store: proStore, bundleId: process.env.BUNDLE_ID });

// ---------- agent tasks (agents.mjs): the owner's agents, run by cloud/runner on Fargate ----------
// pk USER#<sub>; sk PROJECT#<key> (the projects "in <name>" can name: cloud/setup/setup-owner.ps1 writes them),
// AGENT#<key> (an agent's state and pending turns; the runner takes them).
const agentStore = {
  async projects(user) {
    return (await queryPrefix(user, 'PROJECT#')).map(({ name, repo, branch, aliases }) => ({ name, repo, branch, aliases }));
  },
  async agents(user) {
    return (await queryPrefix(user, 'AGENT#')).map(({ pk, sk, ...a }) => ({ ...a, key: sk.slice('AGENT#'.length) }));
  },
  async claim(user, { key, ...agent }, staleBefore) {
    return !!await conditional(new PutCommand({ TableName: TABLE, Item: { pk: `USER#${user}`, sk: `AGENT#${key}`, ...agent },
      ConditionExpression: 'attribute_not_exists(pk) OR busy = :f OR startedAt < :stale',
      ExpressionAttributeValues: { ':f': false, ':stale': staleBefore } }));
  },
  async wake(user, key, text, run, now, staleBefore) {
    return !!await conditional(new UpdateCommand({ TableName: TABLE, Key: { pk: `USER#${user}`, sk: `AGENT#${key}` },
      UpdateExpression: 'SET busy = :t, #run = :run, startedAt = :now, lastAt = :now, pending = :p, awaiting = :f REMOVE runArn',
      ConditionExpression: 'attribute_exists(pk) AND (busy = :f OR startedAt < :stale)',
      ExpressionAttributeNames: { '#run': 'run' },
      ExpressionAttributeValues: { ':t': true, ':f': false, ':run': run, ':now': now, ':p': [text], ':stale': staleBefore } }));
  },
  async queue(user, key, text, staleBefore) {
    return !!await conditional(new UpdateCommand({ TableName: TABLE, Key: { pk: `USER#${user}`, sk: `AGENT#${key}` },
      UpdateExpression: 'SET pending = list_append(if_not_exists(pending, :none), :p)',
      ConditionExpression: 'busy = :t AND startedAt >= :stale',
      ExpressionAttributeValues: { ':t': true, ':none': [], ':p': [text], ':stale': staleBefore } }));
  },
  async update(user, key, fields, run) {
    const names = { '#run': 'run' }, values = { ':run': run };
    const sets = Object.entries(fields).map(([f, v], i) => { names[`#f${i}`] = f; values[`:v${i}`] = v; return `#f${i} = :v${i}`; });
    await conditional(new UpdateCommand({ TableName: TABLE, Key: { pk: `USER#${user}`, sk: `AGENT#${key}` },
      UpdateExpression: `SET ${sets.join(', ')}`, ConditionExpression: '#run = :run',
      ExpressionAttributeNames: names, ExpressionAttributeValues: values }));
  },
  async remove(user, key) {
    await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: `USER#${user}`, sk: `AGENT#${key}` } }));
  },
  async answered(user, key, fields, hash) {
    const names = {}, values = { ':h': hash };
    const sets = Object.entries(fields).map(([f, v], i) => { names[`#f${i}`] = f; values[`:v${i}`] = v; return `#f${i} = :v${i}`; });
    await conditional(new UpdateCommand({ TableName: TABLE, Key: { pk: `USER#${user}`, sk: `AGENT#${key}` },
      UpdateExpression: `SET ${sets.join(', ')}`, ConditionExpression: 'replyHash = :h',
      ExpressionAttributeNames: names, ExpressionAttributeValues: values }));
  },
};

async function queryPrefix(user, prefix) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const r = await db.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
      ExpressionAttributeValues: { ':pk': `USER#${user}`, ':p': prefix }, ExclusiveStartKey }));
    items.push(...(r.Items ?? []));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

const ecs = new ECSClient({});
const agentTasks = makeAgents({
  store: agentStore,
  async runTask(user, key, run) {
    // Off until the BridgeApi stack has the runner (RUNNER_TASK is its task definition).
    if (!process.env.RUNNER_TASK) throw new Error('The agent runner isn\'t deployed.');
    const r = await ecs.send(new RunTaskCommand({
      cluster: process.env.RUNNER_CLUSTER, taskDefinition: process.env.RUNNER_TASK, launchType: 'FARGATE', count: 1,
      startedBy: 'bridge-voice',
      networkConfiguration: { awsvpcConfiguration: { subnets: process.env.RUNNER_SUBNETS.split(','),
        securityGroups: [process.env.RUNNER_SECURITY_GROUP], assignPublicIp: 'ENABLED' } },
      // Only ids: what was said stays in DynamoDB, out of the ECS API's logs (CloudTrail).
      overrides: { containerOverrides: [{ name: 'runner', environment: [
        { name: 'USER_ID', value: user }, { name: 'AGENT_KEY', value: key }, { name: 'RUN_ID', value: run }] }] },
    }));
    const arn = r.tasks?.[0]?.taskArn;
    if (!arn) throw new Error(r.failures?.[0]?.reason || 'Fargate started nothing');
    return arn;
  },
  async stopTask(arn) {
    await ecs.send(new StopTaskCommand({ cluster: process.env.RUNNER_CLUSTER, task: arn, reason: 'Stopped by voice' }));
  },
  deliver: (user, text, from) => deliver(user, text, from),
  log: (...a) => console.log(...a),
});

// Other accounts' tasks would need API billing (cloud/DESIGN.md, build step 4): until then a confirmed task is
// acknowledged honestly instead of pretending to run.
async function startTask(user, req) {
  if (user === OWNER) return agentTasks.startTask(user, req);
  await deliver(user, agentTasks.notOn(req?.project), req?.project);
  return 'Sent.';
}

// The owner has every Pro feature, with paid Pro's allowances: there's no App Store subscription to check.
const proForOwner = { ...pro, plan: async (user) => (user === OWNER ? 'Production' : pro.plan(user)) };

export const handler = makeHandler({ store, look, startTask, devices, deliver, speak, pro: proForOwner, agentAwaiting: agentTasks.awaiting, splitTask: agentTasks.splitTask,
  agentAnswer: agentTasks.answer });

// App Store Server Notifications v2 (POST /api/appstore/notifications, no authorizer: Apple signs the body).
export async function appStore(event) {
  try {
    const r = await pro.notify(Buffer.from(event.body || '', event.isBase64Encoded ? 'base64' : 'utf8').toString('utf8'));
    if (r.status !== 200) console.warn('App Store notification refused:', r.body.error);
    return { statusCode: r.status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(r.body) };
  } catch (e) {
    console.error('App Store notification', e);
    return { statusCode: 500, body: '' };   // Apple sends it again later
  }
}

// ---------- accounts (auth.mjs): Sign in with Apple, sessions signed by KMS ----------
let appleKeys = null, appleKeysAt = 0, publicJwk = null;

async function deleteUser(sub) {
  // Its subscriptions are free to join another account; their refunds stay on record.
  const claimed = await db.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :t)',
    ExpressionAttributeValues: { ':pk': `USER#${sub}`, ':t': 'PROTX#' } }));
  for (const { tx } of claimed.Items ?? []) {
    await conditional(new UpdateCommand({ TableName: TABLE, Key: { pk: `PRO#${tx}`, sk: 'OWNER' }, UpdateExpression: 'REMOVE #user',
      ConditionExpression: '#user = :sub', ExpressionAttributeNames: { '#user': 'user' }, ExpressionAttributeValues: { ':sub': sub } }));
  }
  for (;;) {
    const r = await db.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `USER#${sub}` }, ProjectionExpression: 'pk, sk', Limit: 100 }));
    if (!r.Items?.length) return;
    await Promise.all(r.Items.map((Key) => db.send(new DeleteCommand({ TableName: TABLE, Key }))));
  }
}

async function fetchAppleKeys() {
  if (!appleKeys || Date.now() - appleKeysAt > 3600_000) {
    const r = await fetch('https://appleid.apple.com/auth/keys', { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`Apple keys: ${r.status}`);
    appleKeys = await r.json(); appleKeysAt = Date.now();
  }
  return appleKeys;
}

async function sign(bytes) {
  const r = await kms.send(new SignCommand({ KeyId: process.env.SIGNING_KEY, MessageType: 'DIGEST',
    Message: createHash('sha256').update(bytes).digest(), SigningAlgorithm: 'RSASSA_PKCS1_V1_5_SHA_256' }));
  return Buffer.from(r.Signature);
}

async function getPublicJwk() {
  if (!publicJwk) {
    const r = await kms.send(new GetPublicKeyCommand({ KeyId: process.env.SIGNING_KEY }));
    const { n, e, kty } = createPublicKey({ key: Buffer.from(r.PublicKey), format: 'der', type: 'spki' }).export({ format: 'jwk' });
    publicJwk = { kty, n, e };
  }
  return publicJwk;
}

// The owner token (owner.mjs): only its SHA-256 is stored, as bridge/owner. Until it exists nobody is the owner.
const isOwner = makeOwner({
  async secret() {
    if (!process.env.OWNER_SECRET) return null;
    try {
      return JSON.parse((await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: process.env.OWNER_SECRET }))).SecretString);
    } catch (e) {
      if (e.name === 'ResourceNotFoundException') return null;
      throw e;
    }
  },
});

const accounts = makeAuth({
  isOwner,
  issuer: process.env.ISSUER,
  audience: process.env.BUNDLE_ID,
  appleKeys: fetchAppleKeys,
  sign,
  publicJwk: getPublicJwk,
  deleteUser,
});
export const { auth, authorize } = accounts;

// ---------- Claude connector (connector.mjs): MCP server and its OAuth sign-in ----------
import { makeConnector } from './connector.mjs';

// OAuth clients: pk CLIENT#<id>, sk CLIENT, forgotten after 90 days unused. Sign-ins in progress and
// authorization codes: pk GRANT#<key>, sk GRANT, removed when used (and by TTL). Refresh tokens:
// pk USER#<sub>, sk RT#<sha256>, so deleting the account (deleteUser) disconnects Claude too.
const grants = {
  async saveClient(id, client, expires) {
    await db.send(new PutCommand({ TableName: TABLE, Item: { pk: `CLIENT#${id}`, sk: 'CLIENT', client, expires } }));
  },
  async getClient(id) {
    const r = await db.send(new GetCommand({ TableName: TABLE, Key: { pk: `CLIENT#${id}`, sk: 'CLIENT' } }));
    return r.Item && r.Item.expires > Date.now() / 1000 ? r.Item.client : null;
  },
  async saveGrant(key, data, expires) {
    await db.send(new PutCommand({ TableName: TABLE, Item: { pk: `GRANT#${key}`, sk: 'GRANT', data, expires } }));
  },
  async takeGrant(key) {
    const r = await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: `GRANT#${key}`, sk: 'GRANT' }, ReturnValues: 'ALL_OLD' }));
    const item = r.Attributes;
    return item && item.expires > Date.now() / 1000 ? item.data : null;   // TTL deletes lazily
  },
  async saveRefresh(user, hash, data, expires) {
    await db.send(new PutCommand({ TableName: TABLE, Item: { pk: `USER#${user}`, sk: `RT#${hash}`, data, expires } }));
  },
  async useRefresh(user, hash) {
    const Key = { pk: `USER#${user}`, sk: `RT#${hash}` };
    try {
      const r = await db.send(new UpdateCommand({ TableName: TABLE, Key, UpdateExpression: 'SET used = :t',
        ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(used)',
        ExpressionAttributeValues: { ':t': true }, ReturnValues: 'ALL_NEW' }));
      const item = r.Attributes;
      return item.expires > Date.now() / 1000 ? { data: item.data, reused: false } : null;
    } catch (e) {
      if (e.name !== 'ConditionalCheckFailedException') throw e;
      const r = await db.send(new GetCommand({ TableName: TABLE, Key }));
      return r.Item ? { data: r.Item.data, reused: true } : null;
    }
  },
  async revokeFamily(user, family) {
    const r = await db.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :rt)',
      ExpressionAttributeValues: { ':pk': `USER#${user}`, ':rt': 'RT#' } }));
    await Promise.all((r.Items ?? []).filter((i) => i.data?.family === family)
      .map(({ pk, sk }) => db.send(new DeleteCommand({ TableName: TABLE, Key: { pk, sk } }))));
  },
};

// The newest inbox messages, oldest first.
async function latestMessages(user, n) {
  const r = await db.send(new QueryCommand({
    TableName: TABLE, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :m)',
    ExpressionAttributeValues: { ':pk': `USER#${user}`, ':m': 'MSG#' }, ScanIndexForward: false, Limit: n,
  }));
  return (r.Items ?? []).reverse().map(({ id, text, at }) => ({ id, text, at }));
}

export const connector = makeConnector({
  issuer: process.env.ISSUER,
  servicesId: process.env.SERVICES_ID,
  publicUrl: process.env.PUBLIC_URL,
  appleKeys: fetchAppleKeys,
  sign,
  publicJwk: getPublicJwk,
  store: grants,
  startTask,
  messagesAfter: (user, after) => store.messagesAfter(user, after),
  latestMessages,
});
