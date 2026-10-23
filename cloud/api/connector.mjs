// Bridge as a Claude connector: a remote MCP server at /api/mcp (streamable HTTP, stateless, JSON
// responses) and the OAuth 2.1 authorization server Claude's custom connectors sign in through
// (dynamic client registration, PKCE S256, refresh tokens). People sign in with Apple on the web, so
// the connector reaches the same Bridge account as the app.
// Dependencies are passed in, so tests run with fakes and no AWS.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { APPLE_ISSUER, KID, signJwt, verifyJwt } from './auth.mjs';
import { OWNER } from './owner.mjs';
import { resolveProject, norm } from './agents.mjs';
import { cleanStatus, FIELDS, HEALTH } from './status.mjs';

export const ACCESS_S = 3600;            // access tokens: an hour, then Claude refreshes
export const REFRESH_S = 30 * 86400;     // a sign-in lasts 30 days, like app sessions, however often it refreshes
export const CLIENT_S = 90 * 86400;      // a registered client unused this long is forgotten
export const INBOX_LATEST = 20;
const CODE_S = 5 * 60;                   // authorization codes
const LOGIN_S = 10 * 60;                 // the Sign in with Apple round trip
const BODY_MAX = 1024 * 1024;
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const DEFAULT_VERSION = '2025-06-18';
const SCOPE = 'bridge';

// Only Claude (claude.ai and its apps) and local clients such as Claude Code can register. Open
// registration with any redirect would let anyone mint a look-alike client that phishes the code.
export const REDIRECTS = [
  /^https:\/\/claude\.(?:ai|com)\/api\/mcp\/auth_callback$/,
  /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?\/[^\s#]*$/,
];

const INSTRUCTIONS = [
  "Bridge runs the user's Claude Code agents, one per project, and reads their answers aloud on the user's",
  'phone and glasses. Use send_task to start work in a project or to answer an agent that asked something,',
  'and read_inbox to hear back. Agents work on their own and answer later, so check the inbox after a while.',
  'get_status reports on every project from its status file (what needs the user, details, the morning and evening',
  'briefings), and update_status lets any session report on a project in the same format.',
  "When Bridge says it can't do something, tell the user what it said; don't guess at a setting to change.",
].join(' ');

export const TOOLS = [
  {
    name: 'send_task',
    title: 'Send a task',
    description: [
      "Starts a task for one of the user's Bridge agents, or answers the agent that is waiting.",
      'With project: starts the task in that project (a repository name, or the name the user calls it).',
      'Without project: the text goes to the agent that asked a question, for example "yes".',
      'The agent works on its own; its answer arrives in the inbox (read_inbox).',
      'Say back the project and task and get a yes from the user before sending.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'The project, for a new task. Leave out to answer the waiting agent.', maxLength: 200 },
        task: { type: 'string', description: 'What the agent should do, or the answer to its question.', minLength: 1, maxLength: 4000 },
      },
      required: ['task'],
      additionalProperties: false,
    },
    annotations: { title: 'Send a task', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'read_inbox',
    title: 'Read the inbox',
    description: [
      "Reads what the user's agents said: finished tasks, questions, errors. Newest last.",
      'Pass the last id you saw as after to get only newer messages. Messages are kept for a week.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: { after: { type: 'integer', minimum: 0, description: 'Only messages with a higher id.' } },
      additionalProperties: false,
    },
    annotations: { title: 'Read the inbox', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_status',
    title: 'Status of projects',
    description: [
      "Reports on the user's projects from each worker's status file and live state, worded to be read aloud.",
      'mode all: one line per project, blocked first. needs_me: only what needs the user. morning or evening: the',
      'briefing. With projects: those projects (one project gives its whole status file). structuredContent has the fields.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['all', 'needs_me', 'morning', 'evening'], description: 'Which report. Default all.' },
        projects: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 20, description: 'Only these projects, by name or alias.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Status of projects', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'update_status',
    title: 'Update a project status',
    description: [
      "Writes a project's status file, the standard report Bridge reads aloud in status reports and briefings.",
      'Send only the fields that changed; each is one short plain sentence with no markdown, since it is spoken.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'The project, by name or alias.', maxLength: 200 },
        health: { type: 'string', enum: HEALTH, description: FIELDS.health },
        done: { type: 'string', maxLength: 300, description: FIELDS.done },
        in_progress: { type: 'string', maxLength: 300, description: FIELDS.inProgress },
        id: { type: 'string', maxLength: 40, description: FIELDS.id },
        next: { type: 'string', maxLength: 300, description: FIELDS.next },
        needs: { type: 'string', maxLength: 300, description: FIELDS.needs },
        owner: { type: 'string', maxLength: 40, description: FIELDS.owner },
        where: { type: 'string', maxLength: 300, description: FIELDS.where },
        overnight: { type: 'string', maxLength: 300, description: FIELDS.overnight },
      },
      required: ['project'],
      additionalProperties: false,
    },
    annotations: { title: 'Update a project status', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

const ONLY_OWNER = "Project status is only for the Bridge owner's agents.";

const b64url = (b) => Buffer.from(b).toString('base64url');
const sha256 = (s) => createHash('sha256').update(s).digest();
const random = (n = 32) => b64url(randomBytes(n));
const sameSecret = (a, b) => a.length === b.length && timingSafeEqual(a, b);

/**
 * deps.issuer: the tokens' iss (the same as app sessions')
 * deps.servicesId: the Sign in with Apple Services ID (the web client; Apple tokens' aud)
 * deps.publicUrl: the address Claude uses, e.g. https://api.talktobridge.com (default: the request's host)
 * deps.sign(bytes), deps.publicJwk(), deps.appleKeys(): as in auth.mjs
 * deps.store: { saveClient(id, client, expiresS), getClient(id), saveGrant(key, data, expiresS), takeGrant(key),
 *   saveRefresh(user, hash, data, expiresS), useRefresh(user, hash) -> { data, reused } | null, revokeFamily(user, family) }
 *   takeGrant reads and deletes in one step, so a code or sign-in is used once. useRefresh marks a refresh
 *   token used in one step and says whether it already was. Refresh tokens are kept under the user's
 *   own records, so deleting the account revokes them.
 * deps.startTask(user, { project, task }) -> spoken line
 * deps.orchestrator: { board(user), report(user, command), setStatus(user, key, fields), projects(user) } (orchestrator.mjs;
 *   optional, owner only)
 * deps.userFor(sub) -> the user whose tasks and inbox the tools use (optional; the owner's Apple account is OWNER)
 * deps.messagesAfter(user, id) -> [{ id, text, at }], deps.latestMessages(user, n) -> the newest n, oldest first
 * deps.now() -> ms
 */
export function makeConnector(deps) {
  const now = deps.now ?? Date.now;
  const nowS = () => Math.floor(now() / 1000);
  const ACCESS_AUD = `${deps.issuer}/mcp`;
  const sessionKey = async (kid) => (kid === KID ? deps.publicJwk() : null);
  const appleKey = async (kid) => (await deps.appleKeys()).keys.find((k) => k.kid === kid);

  // Refresh tokens are opaque: "<user>.<random>". Each one works once and is replaced by the next in
  // its family; a used one coming back means it leaked, so the whole family is revoked.
  async function tokens(sub, clientId, { family = random(16), authTime = nowS() } = {}) {
    const iat = nowS();
    const refresh = `${b64url(sub)}.${random()}`;
    await deps.store.saveRefresh(sub, b64url(sha256(refresh)), { client_id: clientId, family, auth_time: authTime }, authTime + REFRESH_S);
    return {
      access_token: await signJwt({ iss: deps.issuer, aud: ACCESS_AUD, sub, client_id: clientId, scope: SCOPE, iat, exp: iat + ACCESS_S }, deps.sign),
      token_type: 'Bearer',
      expires_in: ACCESS_S,
      refresh_token: refresh,
      scope: SCOPE,
    };
  }

  // ---------- OAuth: metadata (RFC 9728, RFC 8414) ----------
  const resourceMetadata = (base) => ({
    resource: `${base}/api/mcp`,
    authorization_servers: [base],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Bridge',
  });
  const serverMetadata = (base) => ({
    issuer: base,
    authorization_endpoint: `${base}/api/oauth/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    registration_endpoint: `${base}/api/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: [SCOPE],
  });

  // ---------- OAuth: dynamic client registration (RFC 7591) ----------
  async function register(body) {
    const uris = body?.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || !uris.every((u) => typeof u === 'string' && REDIRECTS.some((r) => r.test(u)))) {
      return json(400, { error: 'invalid_redirect_uri', error_description: 'Bridge accepts Claude and localhost redirect addresses only.' });
    }
    const method = body.token_endpoint_auth_method ?? 'none';
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) {
      return json(400, { error: 'invalid_client_metadata', error_description: `Unsupported token_endpoint_auth_method ${method}.` });
    }
    const clientId = random(16);
    const secret = method === 'none' ? null : random();
    const client = {
      client_name: String(body.client_name ?? 'Claude').slice(0, 100),
      redirect_uris: uris,
      token_endpoint_auth_method: method,
      ...(secret ? { secretHash: b64url(sha256(secret)) } : {}),
      created: nowS(),
    };
    await deps.store.saveClient(clientId, client, nowS() + CLIENT_S);
    const { secretHash, created, ...shown } = client;
    return json(201, {
      client_id: clientId, client_id_issued_at: created, ...shown,
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    });
  }

  // ---------- OAuth: authorize, by way of Sign in with Apple ----------
  async function authorize(base, q) {
    const client = q.client_id && await deps.store.getClient(q.client_id);
    if (!client) return page(400, 'This connector isn’t registered', 'Remove Bridge from Claude’s connectors and add it again.');
    const redirect = q.redirect_uri ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : null);
    if (!redirect || !client.redirect_uris.includes(redirect)) return page(400, 'Unknown return address', 'Remove Bridge from Claude’s connectors and add it again.');
    const back = (error, description) => found(withQuery(redirect, { error, error_description: description, state: q.state, iss: base }));
    if (q.response_type !== 'code') return back('unsupported_response_type', 'Use response_type=code.');
    if (!q.code_challenge || q.code_challenge_method !== 'S256') return back('invalid_request', 'PKCE with S256 is required.');

    const login = random(), nonce = random();
    await deps.store.saveGrant(`login#${login}`, {
      client_id: q.client_id, redirect_uri: redirect, code_challenge: q.code_challenge, state: q.state ?? null, nonce,
    }, nowS() + LOGIN_S);
    // response_type "code id_token" makes Apple post the ID token straight back; nothing is
    // exchanged with Apple's token endpoint, so Bridge needs no Apple client secret.
    const apple = withQuery('https://appleid.apple.com/auth/authorize', {
      client_id: deps.servicesId, redirect_uri: `${base}/api/oauth/apple`,
      response_type: 'code id_token', response_mode: 'form_post', state: login, nonce,
    });
    return page(200, `Connect ${client.client_name} to Bridge`,
      `${client.client_name} will be able to start tasks for your Bridge agents and read what they say. Sign in with the Apple ID you use in the Bridge app.`,
      { href: apple, label: 'Sign in with Apple' });
  }

  async function appleReturn(base, form) {
    const login = form.state && await deps.store.takeGrant(`login#${form.state}`);
    if (!login) return page(400, 'That sign-in expired', 'Go back to Claude and connect Bridge again.');
    const back = (params) => found(withQuery(login.redirect_uri, { ...params, state: login.state, iss: base }));
    if (form.error) return back({ error: 'access_denied', error_description: 'Sign in with Apple was cancelled.' });
    let claims;
    try {
      claims = await verifyJwt(form.id_token, appleKey, { issuer: APPLE_ISSUER, audience: deps.servicesId, now: now() });
      if (claims.nonce !== login.nonce) throw new Error('nonce mismatch');
    } catch (e) {
      console.warn('connector sign-in refused:', e.message);
      return back({ error: 'access_denied', error_description: 'Sign in with Apple could not be checked.' });
    }
    const code = random();
    await deps.store.saveGrant(`code#${b64url(sha256(code))}`, {
      sub: `apple.${claims.sub}`,   // the same account id the app's sign-in makes (auth.mjs)
      client_id: login.client_id, redirect_uri: login.redirect_uri, code_challenge: login.code_challenge,
    }, nowS() + CODE_S);
    return back({ code });
  }

  // ---------- OAuth: token ----------
  async function token(headers, form) {
    let clientId = form.client_id, secret = form.client_secret;
    const basic = /^Basic\s+(.+)$/i.exec(headers?.authorization ?? '');
    if (basic) {
      const [id, ...rest] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
      try { clientId = decodeURIComponent(id); secret = decodeURIComponent(rest.join(':')); }
      catch { return oauthError(401, 'invalid_client', 'Malformed client credentials.'); }
    }
    const client = clientId && await deps.store.getClient(clientId);
    if (!client) return oauthError(401, 'invalid_client', 'Unknown client.');
    if (client.secretHash && !(secret && sameSecret(Buffer.from(b64url(sha256(secret))), Buffer.from(client.secretHash)))) {
      return oauthError(401, 'invalid_client', 'Wrong client secret.');
    }

    // Each use keeps a client registered for another CLIENT_S.
    const touch = () => deps.store.saveClient(clientId, client, nowS() + CLIENT_S);
    if (form.grant_type === 'authorization_code') {
      const grant = form.code && await deps.store.takeGrant(`code#${b64url(sha256(form.code))}`);
      if (!grant || grant.client_id !== clientId) return oauthError(400, 'invalid_grant', 'The code is unknown, used or expired.');
      if (form.redirect_uri && form.redirect_uri !== grant.redirect_uri) return oauthError(400, 'invalid_grant', 'redirect_uri does not match.');
      if (!form.code_verifier || b64url(sha256(form.code_verifier)) !== grant.code_challenge) return oauthError(400, 'invalid_grant', 'PKCE check failed.');
      await touch();
      return json(200, await tokens(grant.sub, clientId), { 'cache-control': 'no-store' });
    }
    if (form.grant_type === 'refresh_token') {
      const invalid = () => oauthError(400, 'invalid_grant', 'The refresh token is invalid, used or expired.');
      const [userPart, secretPart] = String(form.refresh_token ?? '').split('.');
      if (!userPart || !secretPart) return invalid();
      const sub = Buffer.from(userPart, 'base64url').toString('utf8');
      const hash = b64url(sha256(form.refresh_token));
      const found = await deps.store.useRefresh(sub, hash);
      if (!found) return invalid();
      const row = found.data;
      if (found.reused || row.client_id !== clientId) { await deps.store.revokeFamily(sub, row.family); return invalid(); }
      await touch();
      return json(200, await tokens(sub, clientId, { family: row.family, authTime: row.auth_time }), { 'cache-control': 'no-store' });
    }
    return oauthError(400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
  }

  // ---------- MCP ----------
  async function callTool(user, name, args = {}) {
    if (name === 'send_task') {
      const task = typeof args.task === 'string' ? args.task.trim() : '';
      const project = typeof args.project === 'string' && args.project.trim() ? args.project.trim().slice(0, 200) : null;
      if (!task) return toolText('task is required.', true);
      if (task.length > 4000) return toolText('task is too long (4000 characters at most).', true);
      return toolText(await deps.startTask(user, { project, task }));
    }
    if (name === 'read_inbox') {
      const after = Number.isInteger(args.after) && args.after > 0 ? args.after : 0;
      // No cursor: the newest messages, since Claude usually asks "what did my agents say?" first.
      const messages = after ? await deps.messagesAfter(user, after) : await deps.latestMessages(user, INBOX_LATEST);
      const last = messages.reduce((m, x) => Math.max(m, x.id), after);
      const shown = messages.map(({ id, text, at }) => ({ id, text, age_seconds: Math.round((now() - at) / 1000) }));
      return {
        content: [{ type: 'text', text: shown.length ? JSON.stringify({ last, messages: shown }) : 'No new messages.' }],
        structuredContent: { last, messages: shown },
      };
    }
    if (name === 'get_status') {
      if (user !== OWNER || !deps.orchestrator) return toolText(ONLY_OWNER, true);
      const names = Array.isArray(args.projects) ? args.projects.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : [];
      const mode = { needs_me: 'needs', morning: 'morning', evening: 'evening' }[args.mode] ?? 'all';
      const command = names.length === 1 ? { kind: 'details', name: names[0] } : names.length ? { kind: 'some', names } : { kind: mode };
      const text = await deps.orchestrator.report(user, command);
      const projects = (await deps.orchestrator.board(user)).map((v) => ({ name: v.name, tag: v.tag, repo: v.repo, health: v.health,
        working: v.working, needs: v.needs, problem: v.problem, status: v.status }));
      return { content: [{ type: 'text', text }], structuredContent: { text, projects } };
    }
    if (name === 'update_status') {
      if (user !== OWNER || !deps.orchestrator) return toolText(ONLY_OWNER, true);
      const p = resolveProject(String(args.project ?? ''), await deps.orchestrator.projects(user));
      if (!p) return toolText(`No project called ${String(args.project ?? '').slice(0, 200)}. Use a name from get_status.`, true);
      const fields = cleanStatus({ ...args, inProgress: args.in_progress });
      if (!Object.keys(fields).length) return toolText('Send at least one field to update.', true);
      await deps.orchestrator.setStatus(user, norm(p.name), fields, 'worker');
      return toolText(`Saved ${p.name}'s status.`);
    }
    return null;
  }

  async function rpc(user, msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id ?? null, -32600, 'Invalid request.');
    if (!('id' in msg)) return null;   // a notification, such as notifications/initialized
    const { id, method, params } = msg;
    if (method === 'initialize') {
      const asked = params?.protocolVersion;
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : DEFAULT_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'bridge', title: 'Bridge', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      });
    }
    if (method === 'ping') return rpcResult(id, {});
    if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });
    if (method === 'tools/call') {
      try {
        const r = await callTool(user, params?.name, params?.arguments ?? {});
        return r ? rpcResult(id, r) : rpcError(id, -32602, `Unknown tool: ${params?.name}`);
      } catch (e) {
        console.error('tool', params?.name, e);
        return rpcResult(id, toolText('Bridge Cloud hit an error. Try again in a moment.', true));
      }
    }
    return rpcError(id, -32601, `Method not found: ${method}`);
  }

  async function mcp(base, event, raw) {
    const challenge = `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/api/mcp"`;
    const bearer = /^Bearer\s+(.+)$/i.exec(event.headers?.authorization ?? '')?.[1];
    let claims;
    try { claims = await verifyJwt(bearer, sessionKey, { issuer: deps.issuer, audience: ACCESS_AUD, now: now() }); }
    catch {
      return json(401, { error: 'invalid_token', error_description: 'Connect Bridge in Claude’s connector settings.' },
        { 'www-authenticate': bearer ? `${challenge}, error="invalid_token"` : challenge });
    }
    if (event.requestContext.http.method !== 'POST') return json(405, rpcError(null, -32000, 'Use POST.'), { allow: 'POST' });
    if (raw.length > BODY_MAX) return json(413, rpcError(null, -32600, 'Request too large.'));
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return json(400, rpcError(null, -32700, 'Parse error.')); }
    // Refresh tokens stay under the signed-in account; only the tools act as the owner.
    const user = deps.userFor ? await deps.userFor(claims.sub) : claims.sub;
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => rpc(user, m)))).filter(Boolean);
      return out.length ? json(200, out) : accepted();
    }
    const out = await rpc(user, body);
    return out ? json(200, out) : accepted();
  }

  return async function connector(event) {
    const method = event.requestContext.http.method;
    const path = event.rawPath;
    const route = `${method} ${path}`;
    const base = (deps.publicUrl || `https://${event.requestContext.domainName}`).replace(/\/+$/, '');
    const raw = event.body ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8') : Buffer.alloc(0);
    try {
      if (path === '/api/mcp') return await mcp(base, event, raw);
      if (route === 'GET /.well-known/oauth-protected-resource' || route === 'GET /.well-known/oauth-protected-resource/api/mcp') {
        return json(200, resourceMetadata(base));
      }
      if (route === 'GET /.well-known/oauth-authorization-server') return json(200, serverMetadata(base));
      if (route === 'POST /api/oauth/register') {
        let body = null;
        try { body = JSON.parse(raw.toString('utf8')); } catch { /* answered below */ }
        return await register(body);
      }
      if (route === 'GET /api/oauth/authorize') return await authorize(base, event.queryStringParameters ?? {});
      if (route === 'POST /api/oauth/apple') return await appleReturn(base, form(raw));
      if (route === 'POST /api/oauth/token') return await token(event.headers, form(raw, event.headers?.['content-type']));
      return json(404, { error: 'Not found.' });
    } catch (e) {
      console.error(route, e);
      return json(500, { error: 'server_error', error_description: 'Bridge Cloud hit an error. Try again in a moment.' });
    }
  };
}

// A form body (OAuth's format), or JSON from lenient clients.
function form(raw, contentType = '') {
  const s = raw.toString('utf8');
  if (/json/i.test(contentType)) { try { return JSON.parse(s) ?? {}; } catch { return {}; } }
  return Object.fromEntries(new URLSearchParams(s));
}

function withQuery(url, params) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  return u.toString();
}

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const toolText = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });
const json = (statusCode, body, headers = {}) => ({ statusCode, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const oauthError = (statusCode, error, error_description) => json(statusCode, { error, error_description }, { 'cache-control': 'no-store' });
const accepted = () => ({ statusCode: 202, headers: {}, body: '' });
const found = (location) => ({ statusCode: 302, headers: { location, 'cache-control': 'no-store' }, body: '' });

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The one page a person sees: what is being connected, and the Sign in with Apple button.
function page(statusCode, title, text, button) {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>
:root { color-scheme: light dark; --bg: #f5f5f7; --card: #fff; --text: #1d1d1f; --muted: #6e6e73; --btn: #000; --btn-text: #fff; }
@media (prefers-color-scheme: dark) { :root { --bg: #000; --card: #1c1c1e; --text: #f5f5f7; --muted: #a1a1a6; --btn: #fff; --btn-text: #000; } }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text);
  font: 17px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { box-sizing: border-box; width: min(420px, calc(100% - 32px)); background: var(--card); border-radius: 18px; padding: 32px 24px; }
h1 { font-size: 22px; margin: 0 0 12px; } p { color: var(--muted); margin: 0 0 24px; }
a.btn { display: block; text-align: center; background: var(--btn); color: var(--btn-text); text-decoration: none;
  border-radius: 10px; padding: 14px; font-weight: 600; }
</style></head><body><main><h1>${esc(title)}</h1><p>${esc(text)}</p>
${button ? `<a class="btn" href="${esc(button.href)}">${esc(button.label)}</a>` : ''}</main></body></html>`;
  return { statusCode, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' }, body };
}
