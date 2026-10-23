import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign, createHash } from 'node:crypto';
import { makeConnector, ACCESS_S, REDIRECTS } from './connector.mjs';
import { makeAuth, APPLE_ISSUER } from './auth.mjs';

const ISSUER = 'https://talktobridge.com';
const SERVICES_ID = 'com.talktobridge.bridge.web';
const BUNDLE_ID = 'com.talktobridge.bridge';
const HOST = 'abc.execute-api.us-east-1.amazonaws.com';
const BASE = `https://${HOST}`;
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const apple = generateKeyPairSync('rsa', { modulusLength: 2048 });
const bridge = generateKeyPairSync('rsa', { modulusLength: 2048 });
const NOW = 1_800_000_000_000;
const b64url = (b) => Buffer.from(b).toString('base64url');

function appleToken(claims) {
  const body = `${b64url(JSON.stringify({ alg: 'RS256', kid: 'apple-1' }))}.${b64url(JSON.stringify({
    iss: APPLE_ISSUER, aud: SERVICES_ID, sub: '001.abc', exp: NOW / 1000 + 600, ...claims,
  }))}`;
  return `${body}.${createSign('RSA-SHA256').update(body).sign(apple.privateKey).toString('base64url')}`;
}

function setup({ userFor } = {}) {
  let clock = NOW;
  const clients = new Map(), grants = new Map(), refresh = new Map(), started = [], inbox = [], reports = [], statuses = [];
  const keys = {
    appleKeys: async () => ({ keys: [{ ...apple.publicKey.export({ format: 'jwk' }), kid: 'apple-1' }] }),
    sign: async (bytes) => createSign('RSA-SHA256').update(bytes).sign(bridge.privateKey),
    publicJwk: async () => bridge.publicKey.export({ format: 'jwk' }),
  };
  const connector = makeConnector({
    issuer: ISSUER, servicesId: SERVICES_ID, ...keys, now: () => clock,
    store: {
      saveClient: async (id, c, expires) => clients.set(id, { c: structuredClone(c), expires }),
      getClient: async (id) => { const e = clients.get(id); return e && e.expires > clock / 1000 ? structuredClone(e.c) : null; },
      saveGrant: async (k, data, expires) => grants.set(k, { data, expires }),
      takeGrant: async (k) => { const g = grants.get(k); grants.delete(k); return g && g.expires > clock / 1000 ? g.data : null; },
      // Like DynamoDB's rows under USER#<sub>, sk RT#<hash>.
      saveRefresh: async (u, h, data, expires) => refresh.set(`${u}|${h}`, { data, expires }),
      useRefresh: async (u, h) => {
        const r = refresh.get(`${u}|${h}`);
        if (!r) return null;
        if (r.used) return { data: r.data, reused: true };
        r.used = true;
        return r.expires > clock / 1000 ? { data: r.data, reused: false } : null;
      },
      revokeFamily: async (u, family) => {
        for (const [k, r] of refresh) if (k.startsWith(`${u}|`) && r.data.family === family) refresh.delete(k);
      },
    },
    userFor,
    orchestrator: {
      report: async (user, command) => { reports.push({ user, command }); return 'All good.'; },
      board: async () => [{ name: 'trading bot', tag: 'TB', repo: 'x/trading-bot', health: 'on track', working: false, needs: [], problem: '', status: null }],
      setStatus: async (user, key, fields, by) => statuses.push({ user, key, fields, by }),
      projects: async () => [{ name: 'trading bot', repo: 'x/trading-bot', aliases: ['the trader'] }],
    },
    startTask: async (user, t) => { started.push({ user, ...t }); return 'Sent.'; },
    messagesAfter: async (user, after) => inbox.filter((m) => m.user === user && m.id > after).slice(0, 20),
    latestMessages: async (user, n) => inbox.filter((m) => m.user === user).slice(-n),
  });
  const app = makeAuth({ issuer: ISSUER, audience: BUNDLE_ID, ...keys, now: () => clock, deleteUser: async () => {} });

  const call = (method, rawPath, { body, query, headers = {} } = {}) => connector({
    requestContext: { http: { method }, domainName: HOST }, rawPath, headers,
    queryStringParameters: query, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const register = async (extra = {}) =>
    JSON.parse((await call('POST', '/api/oauth/register', { body: { client_name: 'Claude', redirect_uris: [CALLBACK], ...extra } })).body);

  // The whole sign-in, as Claude and the browser do it: authorize, Sign in with Apple, code back.
  const verifier = 'v'.repeat(50);
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  async function signIn(client, { sub = '001.abc' } = {}) {
    const page = await call('GET', '/api/oauth/authorize', { query: {
      response_type: 'code', client_id: client.client_id, redirect_uri: CALLBACK,
      code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz',
    } });
    assert.equal(page.statusCode, 200);
    const href = new URL(page.body.match(/href="([^"]+)"/)[1].replaceAll('&amp;', '&'));
    const form = new URLSearchParams({ state: href.searchParams.get('state'), code: 'apple-code',
      id_token: appleToken({ sub, nonce: href.searchParams.get('nonce') }) });
    const back = await call('POST', '/api/oauth/apple', { body: form.toString() });
    assert.equal(back.statusCode, 302);
    return new URL(back.headers.location);
  }
  const exchange = (client, code, extra = {}) => call('POST', '/api/oauth/token', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK,
      client_id: client.client_id, code_verifier: verifier, ...extra }).toString(),
  });
  async function connect() {
    const client = await register();
    const code = (await signIn(client)).searchParams.get('code');
    return { client, ...JSON.parse((await exchange(client, code)).body) };
  }
  const mcp = (token, body) => call('POST', '/api/mcp', { body, headers: token ? { authorization: `Bearer ${token}` } : {} });

  const refreshWith = (client_id, token) => call('POST', '/api/oauth/token', {
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id }).toString() });
  // What deleteUser does to the connector's rows: everything under USER#<sub> goes.
  const deleteAccount = (sub) => { for (const k of refresh.keys()) if (k.startsWith(`${sub}|`)) refresh.delete(k); };

  return { call, register, signIn, exchange, connect, mcp, refreshWith, deleteAccount, started, inbox, reports, statuses, app, grants, clients,
    advance: (ms) => (clock += ms) };
}

test('metadata points Claude at the sign-in', async () => {
  const { call } = setup();
  const pr = JSON.parse((await call('GET', '/.well-known/oauth-protected-resource/api/mcp')).body);
  assert.deepEqual([pr.resource, pr.authorization_servers], [`${BASE}/api/mcp`, [BASE]]);
  const as = JSON.parse((await call('GET', '/.well-known/oauth-authorization-server')).body);
  assert.equal(as.issuer, BASE);
  assert.equal(as.token_endpoint, `${BASE}/api/oauth/token`);
  assert.equal(as.registration_endpoint, `${BASE}/api/oauth/register`);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
});

test('MCP without a token answers 401 with where to sign in', async () => {
  const { mcp } = setup();
  const r = await mcp(null, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(r.statusCode, 401);
  assert.equal(r.headers['www-authenticate'], `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/api/mcp"`);
  assert.match((await mcp('junk', {})).headers['www-authenticate'], /error="invalid_token"/);
});

test('registration accepts Claude and localhost redirects only', async () => {
  const { call, register } = setup();
  assert.ok((await register()).client_id);
  assert.ok((await register({ redirect_uris: ['http://localhost:33418/callback'] })).client_id);
  for (const uri of ['https://evil.example/cb', 'https://claude.ai.evil.example/api/mcp/auth_callback', 'http://claude.ai/api/mcp/auth_callback']) {
    const r = await call('POST', '/api/oauth/register', { body: { redirect_uris: [uri] } });
    assert.equal(r.statusCode, 400, uri);
  }
  assert.equal((await call('POST', '/api/oauth/register', { body: 'not json' })).statusCode, 400);
  assert.ok(REDIRECTS.some((r) => r.test('https://claude.com/api/mcp/auth_callback')));
});

test('sign in with Apple, then the code becomes tokens that work for MCP', async () => {
  const { connect, mcp, started, inbox } = setup();
  const { access_token, refresh_token, expires_in, token_type } = await connect();
  assert.deepEqual([token_type, expires_in, !!refresh_token], ['Bearer', ACCESS_S, true]);
  const claims = JSON.parse(Buffer.from(access_token.split('.')[1], 'base64url'));
  assert.equal(claims.sub, 'apple.001.abc', 'the same account id as the app');

  const init = JSON.parse((await mcp(access_token, { jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude', version: '1' } } })).body);
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'bridge');
  assert.ok(init.result.capabilities.tools);
  assert.equal((await mcp(access_token, { jsonrpc: '2.0', method: 'notifications/initialized' })).statusCode, 202);

  const list = JSON.parse((await mcp(access_token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).body);
  assert.deepEqual(list.result.tools.map((t) => t.name), ['send_task', 'read_inbox', 'get_status', 'update_status']);

  const sent = JSON.parse((await mcp(access_token, { jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'send_task', arguments: { project: ' trading bot ', task: 'add a stop-loss check' } } })).body);
  assert.deepEqual(sent.result.content, [{ type: 'text', text: 'Sent.' }]);
  const answer = JSON.parse((await mcp(access_token, { jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'send_task', arguments: { task: 'yes' } } })).body);
  assert.equal(answer.result.isError, undefined);
  assert.deepEqual(started, [
    { user: 'apple.001.abc', project: 'trading bot', task: 'add a stop-loss check' },
    { user: 'apple.001.abc', project: null, task: 'yes' },
  ]);

  inbox.push({ user: 'apple.001.abc', id: 1, text: 'Done. Opened a pull request.', at: NOW - 30_000 },
    { user: 'apple.001.abc', id: 2, text: 'Tests pass.', at: NOW }, { user: 'apple.other', id: 3, text: 'not yours', at: NOW });
  const read = JSON.parse((await mcp(access_token, { jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'read_inbox', arguments: { after: 1 } } })).body);
  assert.deepEqual(read.result.structuredContent, { last: 2, messages: [{ id: 2, text: 'Tests pass.', age_seconds: 0 }] });
  const none = JSON.parse((await mcp(access_token, { jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'read_inbox', arguments: { after: 2 } } })).body);
  assert.equal(none.result.content[0].text, 'No new messages.');
});

test('bad tool calls and methods get JSON-RPC errors, and batches work', async () => {
  const { connect, mcp, started } = setup();
  const { access_token } = await connect();
  const r = JSON.parse((await mcp(access_token, [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_task', arguments: { task: '  ' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'rm_rf' } },
    { jsonrpc: '2.0', id: 3, method: 'resources/list' },
    { jsonrpc: '2.0', id: 4, method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/cancelled' },
  ])).body);
  assert.equal(r.length, 4);
  assert.equal(r[0].result.isError, true);
  assert.equal(r[1].error.code, -32602);
  assert.equal(r[2].error.code, -32601);
  assert.deepEqual(r[3].result, {});
  assert.equal(started.length, 0);
  assert.equal((await mcp(access_token, '{nope')).statusCode, 400);
  assert.equal((await mcp(access_token, { id: 1 })).statusCode, 200);
});

test('an unknown protocol version gets one Bridge supports', async () => {
  const { connect, mcp } = setup();
  const { access_token } = await connect();
  const r = JSON.parse((await mcp(access_token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } })).body);
  assert.equal(r.result.protocolVersion, '2025-06-18');
});

test('a code works once, with the right verifier, before it expires', async () => {
  const { register, signIn, exchange, advance } = setup();
  const client = await register();
  const code1 = (await signIn(client)).searchParams.get('code');
  assert.equal((await exchange(client, code1, { code_verifier: 'w'.repeat(50) })).statusCode, 400, 'wrong verifier');
  assert.equal((await exchange(client, code1)).statusCode, 400, 'a failed try used it up');

  const code2 = (await signIn(client)).searchParams.get('code');
  assert.equal((await exchange(client, code2)).statusCode, 200);
  assert.equal((await exchange(client, code2)).statusCode, 400, 'used once');

  const code3 = (await signIn(client)).searchParams.get('code');
  const other = await register();
  assert.equal((await exchange(other, code3)).statusCode, 400, 'another client');

  const code4 = (await signIn(client)).searchParams.get('code');
  advance(6 * 60_000);
  assert.equal((await exchange(client, code4)).statusCode, 400, 'expired');
});

test('the redirect carries state and issuer back to Claude', async () => {
  const { register, signIn } = setup();
  const back = await signIn(await register());
  assert.equal(`${back.origin}${back.pathname}`, CALLBACK);
  assert.equal(back.searchParams.get('state'), 'xyz');
  assert.equal(back.searchParams.get('iss'), BASE);
});

test('authorize refuses unknown clients and redirects, and needs PKCE', async () => {
  const { call, register } = setup();
  const client = await register();
  const q = { response_type: 'code', client_id: client.client_id, redirect_uri: CALLBACK, code_challenge: 'c', code_challenge_method: 'S256' };
  assert.equal((await call('GET', '/api/oauth/authorize', { query: { ...q, client_id: 'nope' } })).statusCode, 400);
  assert.equal((await call('GET', '/api/oauth/authorize', { query: { ...q, redirect_uri: 'https://evil.example/cb' } })).statusCode, 400);
  const plain = await call('GET', '/api/oauth/authorize', { query: { ...q, code_challenge_method: 'plain' } });
  assert.equal(plain.statusCode, 302);
  assert.equal(new URL(plain.headers.location).searchParams.get('error'), 'invalid_request');
  const page = await call('GET', '/api/oauth/authorize', { query: { ...q, redirect_uri: undefined } });
  assert.equal(page.statusCode, 200, 'the only registered redirect is the default');
  assert.match(page.body, /appleid\.apple\.com\/auth\/authorize/);
  assert.match(page.body, /response_mode=form_post/);
});

test('Apple tokens with the wrong audience, nonce or signature are refused; sign-ins are used once', async () => {
  const { call, register } = setup();
  const client = await register();
  const start = async () => {
    const page = await call('GET', '/api/oauth/authorize', { query: { response_type: 'code', client_id: client.client_id,
      redirect_uri: CALLBACK, code_challenge: 'c', code_challenge_method: 'S256' } });
    return new URL(page.body.match(/href="([^"]+)"/)[1].replaceAll('&amp;', '&')).searchParams;
  };
  const finish = (state, id_token) => call('POST', '/api/oauth/apple', { body: new URLSearchParams({ state, id_token }).toString() });
  const errorOf = (r) => new URL(r.headers.location).searchParams.get('error');

  let p = await start();
  assert.equal(errorOf(await finish(p.get('state'), appleToken({ nonce: p.get('nonce'), aud: BUNDLE_ID }))), 'access_denied');
  p = await start();
  assert.equal(errorOf(await finish(p.get('state'), appleToken({ nonce: 'other' }))), 'access_denied');
  p = await start();
  const forged = appleToken({ nonce: p.get('nonce') }).replace(/\.[^.]+$/, '.AAAA');
  assert.equal(errorOf(await finish(p.get('state'), forged)), 'access_denied');
  p = await start();
  assert.equal(errorOf(await call('POST', '/api/oauth/apple', { body: new URLSearchParams({ state: p.get('state'), error: 'user_cancelled_authorize' }).toString() })), 'access_denied');
  assert.equal((await finish(p.get('state'), appleToken({ nonce: p.get('nonce') }))).statusCode, 400, 'used once');
  assert.equal((await finish('made-up', appleToken({}))).statusCode, 400);
});

test('refresh tokens give new tokens to their own client only', async () => {
  const { connect, register, call, mcp, refreshWith, advance } = setup();
  const { client, refresh_token, access_token } = await connect();
  advance(2 * 3600_000);
  assert.equal((await mcp(access_token, { jsonrpc: '2.0', id: 1, method: 'ping' })).statusCode, 401, 'access token expired');
  const r = await refreshWith(client.client_id, refresh_token);
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  const next = JSON.parse(r.body);
  assert.notEqual(next.refresh_token, refresh_token, 'rotated');
  assert.equal((await mcp(next.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' })).statusCode, 200);
  assert.equal((await refreshWith((await register()).client_id, next.refresh_token)).statusCode, 400, 'another client');
  assert.equal((await refreshWith(client.client_id, access_token)).statusCode, 400, 'an access token is not a refresh token');
  assert.equal((await refreshWith(client.client_id, 'junk')).statusCode, 400);
  assert.equal((await call('POST', '/api/oauth/token', { body: 'grant_type=password&client_id=' + client.client_id })).statusCode, 400);
});

test('a refresh token works once; using an old one again revokes its whole sign-in', async () => {
  const { connect, refreshWith } = setup();
  const { client, refresh_token: first } = await connect();
  const second = JSON.parse((await refreshWith(client.client_id, first)).body).refresh_token;
  assert.equal((await refreshWith(client.client_id, first)).statusCode, 400, 'reuse refused');
  assert.equal((await refreshWith(client.client_id, second)).statusCode, 400, 'and the newer one in its family is revoked');
});

test('a sign-in lasts 30 days however often it refreshes', async () => {
  const { connect, refreshWith, advance } = setup();
  let { client, refresh_token } = await connect();
  for (let day = 0; day < 3; day++) {
    advance(9 * 86400_000);
    const r = await refreshWith(client.client_id, refresh_token);
    assert.equal(r.statusCode, 200, `day ${(day + 1) * 9}`);
    refresh_token = JSON.parse(r.body).refresh_token;
  }
  advance(4 * 86400_000);   // day 31
  assert.equal((await refreshWith(client.client_id, refresh_token)).statusCode, 400);
});

test('deleting the account disconnects Claude', async () => {
  const { connect, refreshWith, deleteAccount } = setup();
  const { client, refresh_token } = await connect();
  deleteAccount('apple.001.abc');
  assert.equal((await refreshWith(client.client_id, refresh_token)).statusCode, 400);
});

test("the owner's Apple account uses the owner's agents and inbox; refresh stays with the account", async () => {
  const { connect, mcp, refreshWith, started, inbox } = setup({ userFor: async (sub) => (sub === 'apple.001.abc' ? 'owner' : sub) });
  const { client, access_token, refresh_token } = await connect();
  await mcp(access_token, { jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'send_task', arguments: { project: 'bridge', task: 'list the open pull requests' } } });
  assert.deepEqual(started, [{ user: 'owner', project: 'bridge', task: 'list the open pull requests' }]);
  inbox.push({ user: 'owner', id: 1, text: 'One open pull request.', at: NOW }, { user: 'apple.001.abc', id: 2, text: 'not the owner inbox', at: NOW });
  const read = JSON.parse((await mcp(access_token, { jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'read_inbox', arguments: {} } })).body);
  assert.deepEqual(read.result.structuredContent.messages.map((m) => m.text), ['One open pull request.']);
  assert.equal((await refreshWith(client.client_id, refresh_token)).statusCode, 200, 'refresh tokens are still found under the Apple account');
});

test('read_inbox with no cursor gives the newest messages', async () => {
  const { connect, mcp, inbox } = setup();
  const { access_token } = await connect();
  for (let id = 1; id <= 50; id++) inbox.push({ user: 'apple.001.abc', id, text: `m${id}`, at: NOW });
  const r = JSON.parse((await mcp(access_token, { jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'read_inbox', arguments: null } })).body);
  const ids = r.result.structuredContent.messages.map((m) => m.id);
  assert.deepEqual([ids.length, ids[0], ids.at(-1), r.result.structuredContent.last], [20, 31, 50, 50]);
});

test('registered clients are forgotten after 90 days unused, and kept while used', async () => {
  const { connect, register, refreshWith, signIn, advance } = setup();
  const { client, refresh_token } = await connect();
  advance(29 * 86400_000);
  assert.equal((await refreshWith(client.client_id, refresh_token)).statusCode, 200);
  advance(80 * 86400_000);
  await signIn(client);   // 109 days after registering, but used 80 days ago
  const idle = await register();
  advance(91 * 86400_000);
  await assert.rejects(signIn(idle), 'an idle client is gone');
});

test('a client registered with a secret must send it', async () => {
  const { call, register, signIn, exchange } = setup();
  const client = await register({ token_endpoint_auth_method: 'client_secret_post' });
  assert.ok(client.client_secret);
  const code = (await signIn(client)).searchParams.get('code');
  assert.equal((await exchange(client, code, { client_secret: 'wrong' })).statusCode, 401);
  const code2 = (await signIn(client)).searchParams.get('code');
  assert.equal((await exchange(client, code2, { client_secret: client.client_secret })).statusCode, 200);
  const code3 = (await signIn(client)).searchParams.get('code');
  const basic = Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64');
  const r = await call('POST', '/api/oauth/token', { headers: { authorization: `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: code3, redirect_uri: CALLBACK, code_verifier: 'v'.repeat(50) }).toString() });
  assert.equal(r.statusCode, 200, 'client_secret_basic');
  assert.equal((await exchange({ client_id: 'nope' }, 'x')).statusCode, 401, 'unknown client');
  const bad = await call('POST', '/api/oauth/token', { headers: { authorization: `Basic ${Buffer.from('abc:%E0%A4%A').toString('base64')}` },
    body: 'grant_type=authorization_code&code=x' });
  assert.equal(bad.statusCode, 401, 'malformed Basic credentials');
});

test('connector tokens and app sessions do not stand in for each other', async () => {
  const { connect, mcp, app } = setup();
  const { access_token } = await connect();
  assert.equal((await app.authorize({ headers: { authorization: `Bearer ${access_token}` } })).isAuthorized, false);
  // An app session (audience: the bundle ID) is refused by the MCP endpoint.
  const appSession = await (async () => {
    const r = await app.auth({ requestContext: { http: { method: 'POST' }, authorizer: { lambda: { sub: 'apple.001.abc' } } }, rawPath: '/api/auth/refresh' });
    return JSON.parse(r.body).token;
  })();
  assert.equal((await mcp(appSession, { jsonrpc: '2.0', id: 1, method: 'ping' })).statusCode, 401);
});

test('MCP only takes POST once signed in; unknown routes are 404', async () => {
  const { connect, call } = setup();
  const { access_token } = await connect();
  assert.equal((await call('GET', '/api/mcp', { headers: { authorization: `Bearer ${access_token}` } })).statusCode, 405);
  assert.equal((await call('GET', '/api/oauth/nope')).statusCode, 404);
});

test("the owner's status tools: reports by mode or project, and status updates by name or alias", async () => {
  const { connect, mcp, reports, statuses } = setup({ userFor: async (sub) => (sub === 'apple.001.abc' ? 'owner' : sub) });
  const { access_token } = await connect();
  const call = async (name, args) => JSON.parse((await mcp(access_token, { jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name, arguments: args } })).body).result;
  const all = await call('get_status', {});
  assert.equal(all.content[0].text, 'All good.');
  assert.equal(all.structuredContent.projects[0].tag, 'TB');
  await call('get_status', { mode: 'needs_me' });
  await call('get_status', { projects: ['the trader'] });
  await call('get_status', { projects: ['a', 'b'], mode: 'morning' });
  assert.deepEqual(reports.map((r) => r.command), [{ kind: 'all' }, { kind: 'needs' }, { kind: 'details', name: 'the trader' },
    { kind: 'some', names: ['a', 'b'] }]);
  assert.equal((await call('update_status', { project: 'the trader', health: 'blocked', in_progress: 'Waiting on a key', needs: 'An API key' })).isError, undefined);
  assert.deepEqual(statuses, [{ user: 'owner', key: 'tradingbot', by: 'worker',
    fields: { health: 'blocked', inProgress: 'Waiting on a key', needs: 'An API key' } }]);
  assert.equal((await call('update_status', { project: 'zebra', health: 'blocked' })).isError, true);
  assert.equal((await call('update_status', { project: 'trading bot' })).isError, true);
});

test('status tools are only for the owner', async () => {
  const { connect, mcp, statuses } = setup();
  const { access_token } = await connect();
  for (const name of ['get_status', 'update_status']) {
    const r = JSON.parse((await mcp(access_token, { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: { project: 'trading bot', health: 'blocked' } } })).body).result;
    assert.equal(r.isError, true, name);
  }
  assert.deepEqual(statuses, []);
});
