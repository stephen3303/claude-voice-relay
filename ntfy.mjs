// Optional phone notifications through ntfy (https://ntfy.sh, or a self-hosted server): everything the
// relay says (answers, questions, "Claude needs you") is also posted to one ntfy topic, so it reaches the
// phone when the Bridge app isn't open. The topic URL works like a password on a public server, so it is
// never logged.

// https only, with a topic: https://host[:port]/topic (no user:pass@, which fetch refuses and would echo).
const NTFY_URL = /^https:\/\/[^/\s?#@]+\/([A-Za-z0-9_-]{1,64})$/;
// Without a token the topic is the only lock, so it must be long enough not to be guessed.
export const MIN_OPEN_TOPIC = 20;
export const ntfyUrlOk = (url, { token = '' } = {}) => {
  const m = NTFY_URL.exec(String(url));
  return !!m && (!!token || m[1].length >= MIN_OPEN_TOPIC);
};

// Returns send(text), or null when ntfy isn't set up. A failed post is logged and never thrown, since the
// message is already in the app's inbox.
export function makeNtfy({ fetch = globalThis.fetch, url, token = '', title = 'Bridge', log = () => {}, timeoutMs = 10_000 }) {
  if (!url) return null;
  if (!ntfyUrlOk(url, { token })) {
    log(`WARNING: NTFY_URL must be https://server/topic, with a topic of at least ${MIN_OPEN_TOPIC} random characters unless NTFY_TOKEN is set; phone notifications are off.`);
    return null;
  }
  return async function send(text) {
    const headers = { title, 'content-type': 'text/plain; charset=utf-8' };
    if (token) headers.authorization = `Bearer ${token}`;
    try {
      // No redirects: one would re-send the message (and the token, on the same origin) somewhere else.
      const res = await fetch(url, { method: 'POST', headers, body: String(text).slice(0, 4000), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) log(`ntfy answered ${res.status}`);
    } catch (e) {
      // Not e.message: fetch errors can quote the URL, and with it the topic.
      log('ntfy failed:', e.name === 'TimeoutError' ? 'timed out' : e.cause?.code || e.name);
    }
  };
}
