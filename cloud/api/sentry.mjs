// Error reports to Sentry (https://sentry.io) from the relay and from Bridge Cloud, with no SDK: one event per
// error, posted to the DSN's envelope endpoint. The same file is cloud/api/sentry.mjs (sentry.test.mjs checks
// they match), since the Lambda bundle holds only cloud/api.
// Like the app (glasses/ios/GlassesRelay/ErrorReporting.swift), a report is the error and where it happened:
// the error's type and code, the start of its message with addresses, paths and tokens taken out, and the
// stack as function names and file names. Never what was said, the answers, a URL, a user or the token.

import { randomUUID } from 'node:crypto';

// https://<public key>@<host>/<project id>, as Sentry's Client Keys page shows it.
const DSN = /^https:\/\/([0-9a-f]{16,64})@([a-z0-9.-]+(?::\d+)?)\/(\d+)$/;
export const parseDsn = (dsn) => {
  const m = DSN.exec(String(dsn).trim());
  return m ? { key: m[1], url: `https://${m[2]}/api/${m[3]}/envelope/`, dsn: m[0] } : null;
};

// The start of a message, before any quoted detail ("ENOENT: no such file, open 'C:\Users\...'" keeps
// "ENOENT"; "claude exited 1: <its output>" keeps "claude exited 1"), with anything identifying taken out.
export function clean(message) {
  return String(message ?? '').split(/:\s/)[0]
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b|\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}\b/gi, '<ip>')
    .replace(/[A-Za-z]:[\\/][^\s'"]*|(?:~|\/(?:home|Users|mnt|tmp|var|root))\/[^\s'"]*/g, '<path>')
    .replace(/[A-Za-z0-9_\-+/=.]{24,}/g, '<redacted>')
    .replace(/\s+/g, ' ').trim().slice(0, 160);
}

// V8 stack lines, oldest call first as Sentry wants them. File names only: a full path names the user.
export function frames(stack) {
  const out = [];
  for (const line of String(stack ?? '').split('\n').slice(1, 41)) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (!m) continue;
    const file = m[2].replace(/^file:\/\//, '');
    out.push({
      function: (m[1] || '?').slice(0, 100),
      filename: file.split(/[\\/]/).pop().slice(0, 100),
      lineno: Number(m[3]), colno: Number(m[4]),
      in_app: !/^node:|node_modules|^internal\//.test(file),
    });
  }
  return out.reverse();
}

export function toEvent(error, where, { environment, release, now = Date.now() } = {}) {
  const e = error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'non-Error thrown');
  const tags = { where: clean(where) || 'unknown' };
  if (typeof e.code === 'string' || typeof e.code === 'number') tags.code = clean(e.code);
  const status = e.$metadata?.httpStatusCode ?? e.status;
  if (Number.isInteger(status)) tags.status = String(status);
  return {
    event_id: randomUUID().replace(/-/g, ''),
    timestamp: now / 1000,
    platform: 'node', level: 'error', logger: 'bridge',
    environment, release,
    tags,
    contexts: { runtime: { name: 'node', version: process.version }, os: { name: process.platform } },
    exception: { values: [{
      type: clean(e.name) || 'Error',
      value: clean(e.message) || '(no message)',
      stacktrace: { frames: frames(e.stack) },
    }] },
  };
}

// Returns { capture(error, where), flush(ms) }, which do nothing when there's no DSN. A failed post is logged
// and never thrown. The same error from the same place is sent once a minute at most, and 30 an hour in all,
// so a loop can't use up the Sentry quota.
export function makeSentry({ dsn, environment = 'production', release, fetch = globalThis.fetch, log = () => {},
  timeoutMs = 3000, perHour = 30, now = Date.now } = {}) {
  const target = dsn ? parseDsn(dsn) : null;
  if (dsn && !target) log('WARNING: SENTRY_DSN is not a Sentry DSN (https://<key>@<host>/<project>); error reports are off.');
  if (!target) return { enabled: false, capture: async () => {}, flush: async () => {} };
  const auth = `Sentry sentry_version=7, sentry_key=${target.key}, sentry_client=bridge/1`;
  const recent = new Map();
  let hour = 0, sentThisHour = 0;
  const pending = new Set();

  async function post(event) {
    const body = [JSON.stringify({ event_id: event.event_id, sent_at: new Date(now()).toISOString(), dsn: target.dsn }),
      JSON.stringify({ type: 'event' }), JSON.stringify(event)].join('\n');
    try {
      const res = await fetch(target.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/x-sentry-envelope', 'x-sentry-auth': auth }, body });
      if (!res.ok) log(`Sentry answered ${res.status}`);
    } catch (e) {
      log('Sentry report failed:', e.name === 'TimeoutError' ? 'timed out' : e.cause?.code || e.name);
    }
  }

  function capture(error, where) {
    try {
      const event = toEvent(error, where, { environment, release, now: now() });
      const t = now();
      if (Math.floor(t / 3600_000) !== hour) { hour = Math.floor(t / 3600_000); sentThisHour = 0; }
      const key = `${event.tags.where}|${event.exception.values[0].type}|${event.exception.values[0].value}`;
      if (t - (recent.get(key) ?? -Infinity) < 60_000 || sentThisHour >= perHour) return Promise.resolve();
      recent.set(key, t);
      if (recent.size > 200) recent.delete(recent.keys().next().value);
      sentThisHour++;
      const p = post(event).finally(() => pending.delete(p));
      pending.add(p);
      return p;
    } catch (e) {
      log('Sentry report failed:', e.name);
      return Promise.resolve();
    }
  }

  // A Lambda is frozen as soon as it answers, so its handlers wait for reports in flight first.
  const flush = (ms = timeoutMs) => Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, ms).unref?.())]);

  return { enabled: true, capture, flush };
}
