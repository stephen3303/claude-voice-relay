// Bridge Cloud push: how an agent starts a conversation. When an agent posts to a user's inbox,
// each of their phones gets one push over APNs:
//   - a VoIP push (PushKit), which the app turns into an incoming CallKit call, when the phone said
//     headphones or glasses are connected and the user allowed calls. Answering it (a tap on the
//     glasses or AirPods works) opens a conversation that reads the message aloud.
//   - otherwise an ordinary notification; tapping it opens Bridge and starts the conversation.
// Nothing is sent while the user is already in a conversation: its inbox poll reads the message.
// Dependencies are passed in, so tests run with fakes and no network.
import { createPrivateKey, sign } from 'node:crypto';
import http2 from 'node:http2';

export const APNS_HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' };
const TOKEN_REFRESH_MS = 50 * 60_000;   // Apple: renew provider tokens after 20 and before 60 minutes
export const LISTENING_MS = 45_000;     // an inbox poll this recent means a conversation is open
const ALERT_MAX = 180;

const b64url = (b) => Buffer.from(b).toString('base64url');
const otherEnv = (env) => (env === 'sandbox' ? 'production' : 'sandbox');

/**
 * deps.teamId, deps.keyId, deps.key: the APNs auth key (.p8 PEM) from developer.apple.com
 * deps.bundleId: the app's bundle ID (the alert topic; VoIP pushes use <bundleId>.voip)
 * deps.send(host, path, headers, body) -> { status, reason }   (HTTP/2; http2Send below)
 * deps.now() -> ms
 */
export function makeApns(deps) {
  const now = deps.now ?? Date.now;
  const key = createPrivateKey(deps.key);
  let jwt = null, jwtAt = 0;

  function providerToken() {
    if (!jwt || now() - jwtAt >= TOKEN_REFRESH_MS) {
      jwtAt = now();
      const body = `${b64url(JSON.stringify({ alg: 'ES256', kid: deps.keyId }))}.${b64url(JSON.stringify({ iss: deps.teamId, iat: Math.floor(jwtAt / 1000) }))}`;
      // JOSE wants the raw r||s signature, not DER.
      jwt = `${body}.${b64url(sign('sha256', Buffer.from(body), { key, dsaEncoding: 'ieee-p1363' }))}`;
    }
    return jwt;
  }

  /**
   * kind 'call' (VoIP) or 'alert'. Returns { result: 'ok'|'gone'|'error', env, reason }.
   * A token from the other APNs environment (a development build on production, or the reverse)
   * is retried there once, and the env that worked is returned so the caller can keep it.
   */
  return async function push(token, env, kind, payload) {
    const headers = {
      authorization: `bearer ${providerToken()}`,
      'apns-topic': kind === 'call' ? `${deps.bundleId}.voip` : deps.bundleId,
      'apns-push-type': kind === 'call' ? 'voip' : 'alert',
      'apns-priority': '10',
      // A call rings now or never; a notification is still worth an hour later.
      'apns-expiration': kind === 'call' ? '0' : String(Math.floor(now() / 1000) + 3600),
    };
    const body = JSON.stringify(payload);
    let r;
    for (const tryEnv of [env, otherEnv(env)]) {
      r = await deps.send(APNS_HOSTS[tryEnv], `/3/device/${token}`, headers, body);
      if (r.status === 200) return { result: 'ok', env: tryEnv };
      if (r.status === 410) return { result: 'gone', env: tryEnv, reason: r.reason };
      if (!(r.status === 400 && r.reason === 'BadDeviceToken')) break;
    }
    // BadDeviceToken in both environments: the token is no good anywhere.
    if (r.status === 400 && r.reason === 'BadDeviceToken') return { result: 'gone', env, reason: r.reason };
    if (r.status === 403 && r.reason === 'ExpiredProviderToken') jwt = null;
    return { result: 'error', env, reason: `${r.status} ${r.reason ?? ''}`.trim() };
  };
}

/**
 * deps.devices: { list(user), save(user, device), remove(user, deviceId), lastListened(user) -> ms|0 }
 *   device: { device, token?, voipToken?, env, headset, calls, at }
 * deps.apns: makeApns(...)
 * deps.now() -> ms
 */
export function makeNotifier(deps) {
  const now = deps.now ?? Date.now;
  // A connection failure for one phone mustn't stop the others getting the message.
  const apns = (token, env, kind, payload) =>
    deps.apns(token, env, kind, payload).catch((e) => ({ result: 'error', env, reason: e.message }));

  /** An agent's message for the user. Returns what each phone got, for logs and tests. */
  return async function notify(user, { text, from, id }) {
    if (now() - (await deps.devices.lastListened(user)) < LISTENING_MS) return [];
    const title = from || 'Bridge';
    const body = text.length > ALERT_MAX ? `${text.slice(0, ALERT_MAX - 1)}…` : text;
    const sent = [];
    for (const d of await deps.devices.list(user)) {
      let device = d, got = null;
      if (d.voipToken && d.calls && d.headset) {
        const r = await apns(d.voipToken, d.env, 'call', { from: title, text: body, id });
        if (r.result === 'ok') got = 'call';
        if (r.result === 'gone') device = { ...device, voipToken: undefined };
        if (r.env !== d.env && r.result !== 'error') device = { ...device, env: r.env };
      }
      if (!got && device.token) {
        const r = await apns(device.token, device.env, 'alert', {
          aps: { alert: { title, body }, sound: 'default', 'interruption-level': 'time-sensitive',
            category: 'AGENT_MESSAGE', 'thread-id': title },
          id,
        });
        if (r.result === 'ok') got = 'alert';
        if (r.result === 'gone') device = { ...device, token: undefined };
        if (r.env !== device.env && r.result !== 'error') device = { ...device, env: r.env };
      }
      if (!device.token && !device.voipToken) await deps.devices.remove(user, d.device);
      else if (device !== d) await deps.devices.save(user, device);
      sent.push({ device: d.device, got: got ?? 'nothing' });
    }
    return sent;
  };
}

/** Lambda's HTTP/2 client for APNs: one session per host, kept while the container lives. */
const sessions = new Map();
export function http2Send(host, path, headers, body) {
  let session = sessions.get(host);
  if (!session || session.closed || session.destroyed) {
    session = http2.connect(`https://${host}`);
    session.on('error', () => sessions.delete(host));
    session.on('close', () => sessions.delete(host));
    session.unref();   // don't keep an invocation open for the connection
    sessions.set(host, session);
  }
  return new Promise((resolve, reject) => {
    const req = session.request({ ':method': 'POST', ':path': path, 'content-type': 'application/json', ...headers });
    req.setTimeout(10_000, () => req.close(http2.constants.NGHTTP2_CANCEL));
    let status = 0, data = '';
    req.on('response', (h) => { status = h[':status']; });
    req.setEncoding('utf8');
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      let reason;
      try { reason = data ? JSON.parse(data).reason : undefined; } catch { /* not JSON */ }
      resolve({ status, reason });
    });
    req.on('error', reject);
    req.end(body);
  });
}
