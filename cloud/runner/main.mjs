// The agent runner's entry point: a Fargate task started by the Voice Lambda (cloud/api/agents.mjs) for one
// agent of the owner. It signs Claude Code in with the owner's claude.ai login (Secrets Manager, bridge/owner-claude,
// made by cloud/setup/setup-owner.ps1), runs the agent's pending turns (turns.mjs), and puts the login back
// when Claude Code refreshed it, so the next runner starts from the current one.
//
// The CLI gets only cloudEnv's allowlist (HOME, PATH, ...), never the task's AWS credentials, and it never runs
// tools here: with --cloud the work happens in the claude.ai session.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { runCloud, resolveClaude, fireRoutine, fireRoutineSession, routineUrlOk } from '../../cloud-agents.mjs';
import { makeNtfy } from '../../ntfy.mjs';
import { addMessage } from '../api/inbox.mjs';
import { statusUpdate, failedStatus } from '../api/status.mjs';
import { makeRunner } from './turns.mjs';
import { prepareRepo } from './repo.mjs';

const { TABLE, USER_ID: user, AGENT_KEY: key, RUN_ID: run, CLAUDE_SECRET, ROUTINE_SECRET, REPLY_URL } = process.env;
const log = (...a) => console.log(new Date().toISOString(), ...a);
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sm = new SecretsManagerClient({});
const git = promisify(execFile);
const Key = { pk: `USER#${user}`, sk: `AGENT#${key}` };

async function conditional(command) {
  try { return await db.send(command); }
  catch (e) { if (e.name === 'ConditionalCheckFailedException') return null; throw e; }
}

const store = {
  // Each turn restarts the stale clock (agents.mjs STALE_MS is a bit over one turn's limit).
  async take() {
    const r = await conditional(new UpdateCommand({ TableName: TABLE, Key,
      UpdateExpression: 'SET startedAt = :now REMOVE pending[0]',
      ConditionExpression: '#run = :run AND size(pending) > :zero',
      ExpressionAttributeNames: { '#run': 'run' }, ExpressionAttributeValues: { ':run': run, ':zero': 0, ':now': Date.now() },
      ReturnValues: 'ALL_OLD' }));
    if (!r?.Attributes) return null;
    const { pending, ...agent } = r.Attributes;
    return { agent, text: pending[0] };
  },
  async finish() {
    return !!await conditional(new UpdateCommand({ TableName: TABLE, Key, UpdateExpression: 'SET busy = :f, lastAt = :t REMOVE runArn',
      ConditionExpression: '#run = :run AND (attribute_not_exists(pending) OR size(pending) = :zero)',
      ExpressionAttributeNames: { '#run': 'run' }, ExpressionAttributeValues: { ':run': run, ':f': false, ':t': Date.now(), ':zero': 0 } }));
  },
  async isRun() {
    const r = await db.send(new GetCommand({ TableName: TABLE, Key, ConsistentRead: true }));
    return r.Item?.run === run;
  },
  async update(_u, _k, fields) {
    const names = { '#run': 'run' }, values = { ':run': run };
    const sets = Object.entries(fields).map(([f, v], i) => { names[`#f${i}`] = f; values[`:v${i}`] = v; return `#f${i} = :v${i}`; });
    await conditional(new UpdateCommand({ TableName: TABLE, Key, UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: '#run = :run', ExpressionAttributeNames: names, ExpressionAttributeValues: values }));
  },
};

// ---------- the owner's claude.ai login ----------
// { credentials: <~/.claude/.credentials.json>, oauthAccount?, routineUrl?, routineToken?, ntfyUrl?, ntfyToken? }
const home = os.homedir();
const credFile = path.join(home, '.claude', '.credentials.json');
let secret = null, saved = '';
async function signIn() {
  secret = JSON.parse((await sm.send(new GetSecretValueCommand({ SecretId: CLAUDE_SECRET }))).SecretString);
  if (!secret?.credentials) throw new Error('bridge/owner-claude has no claude.ai login');
  fs.mkdirSync(path.dirname(credFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(credFile, JSON.stringify(secret.credentials), { mode: 0o600 });
  fs.writeFileSync(path.join(home, '.claude.json'),
    JSON.stringify({ hasCompletedOnboarding: true, ...(secret.oauthAccount ? { oauthAccount: secret.oauthAccount } : {}) }), { mode: 0o600 });
  saved = fs.readFileSync(credFile, 'utf8');
}
// The task routine (bridge/owner-routine, { url, token }): new tasks start as its sessions. null when it isn't set up.
async function taskRoutine() {
  try {
    const r = JSON.parse((await sm.send(new GetSecretValueCommand({ SecretId: ROUTINE_SECRET }))).SecretString);
    return r?.token && routineUrlOk(r.url) ? r : null;
  } catch (e) {
    if (e.name === 'ResourceNotFoundException') return null;
    throw e;
  }
}
// Claude Code refreshes the login when its access token expires, and the old refresh token stops working.
// The new one goes back at once, so a runner lost mid-task doesn't leave the next one with a dead login.
async function keepLogin() {
  if (!secret) return;
  let now;
  try { now = fs.readFileSync(credFile, 'utf8'); JSON.parse(now); } catch { return; }   // mid-write: next time
  if (now === saved) return;
  saved = now;
  // A refresh token the server rejected is blanked on disk; saving that would only hide the original login.
  const oauth = JSON.parse(now)?.claudeAiOauth;
  if (!oauth?.accessToken || !oauth?.refreshToken) { log('the claude.ai login was rejected; it needs a new sign-in'); return; }
  await sm.send(new PutSecretValueCommand({ SecretId: CLAUDE_SECRET, SecretString: JSON.stringify({ ...secret, credentials: JSON.parse(now) }) }));
  log('saved the refreshed claude.ai login');
}
const timer = setInterval(() => keepLogin().catch((e) => log('saving the login failed:', e.name)), 30_000);

let code = 0;
try {
  log('runner', key, run);
  await signIn();
  const ntfy = makeNtfy({ url: secret.ntfyUrl || '', token: secret.ntfyToken || '', log });
  const routineOn = !!secret.routineToken && routineUrlOk(secret.routineUrl);
  const task = await taskRoutine();
  const runAgent = makeRunner({
    store,
    prepare: (a, dir) => prepareRepo({ git: (args, opts) => git('git', args, opts), repo: a.repo, branch: a.branch, dir }),
    run: (o) => runCloud({ spawn, claudeBin: resolveClaude({ bin: 'claude' }), env: process.env, ...o }),
    deliver: (u, text) => addMessage(db, TABLE, u, text),
    notify: ntfy,
    fireRoutine: routineOn ? () => fireRoutine({ url: secret.routineUrl, token: secret.routineToken }) : null,
    startSession: task ? (text) => fireRoutineSession({ url: task.url, token: task.token, text }) : null,
    replyUrl: REPLY_URL || '',
    setStatus: (u, k, fields) => db.send(new UpdateCommand(statusUpdate(TABLE, u, k, fields, { by: 'bridge' }))),
    workRoot: path.join(home, 'work'),
    exists: fs.existsSync,
    log,
  });
  await runAgent(user, key, run);
} catch (e) {
  // A JSON error quotes what it parsed, which could be the secret: only its name is logged.
  log('runner failed:', e.name, e instanceof SyntaxError ? '' : e.message);
  code = 1;
  // Said, and not left busy until it goes stale: the next "task" or reply can start a runner at once.
  if (await store.isRun().catch(() => false)) {
    await store.update(user, key, { busy: false }).catch(() => {});
    const why = /claude\.ai login|ResourceNotFound/.test(`${e.name} ${e.message}`)
      ? "the claude.ai login for cloud agents isn't set up. Run the owner setup script on your PC." : 'its runner hit an error.';
    await addMessage(db, TABLE, user, `${key} couldn't start: ${why}`).catch(() => {});
    await db.send(new UpdateCommand(statusUpdate(TABLE, user, key, failedStatus(`it couldn't start: ${why}`), { by: 'bridge' }))).catch(() => {});
  }
} finally {
  clearInterval(timer);
  await keepLogin().catch((e) => log('saving the login failed:', e.name));
}
process.exit(code);
