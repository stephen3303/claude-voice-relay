// Optional phone notifications through ntfy (https://ntfy.sh, or a self-hosted server): everything the
// relay says (answers, questions, "Claude needs you") is also posted to one ntfy topic, so it reaches the
// phone when the Bridge app isn't open. The topic URL works like a password on a public server, so it is
// never logged.

// https only, with a topic: https://host[:port]/topic
const NTFY_URL = /^https:\/\/[^/\s?#]+\/[A-Za-z0-9_-]{1,64}$/;
export const ntfyUrlOk = (url) => NTFY_URL.test(String(url));

// Returns send(text), or null when ntfy isn't set up. A failed post is logged and never thrown, since the
// message is already in the app's inbox.
export function makeNtfy({ fetch = globalThis.fetch, url, token = '', title = 'Bridge', log = () => {}, timeoutMs = 10_000 }) {
  if (!url) return null;
  if (!ntfyUrlOk(url)) { log('WARNING: NTFY_URL must be https://server/topic; phone notifications are off.'); return null; }
  return async function send(text) {
    const headers = { title, 'content-type': 'text/plain; charset=utf-8' };
    if (token) headers.authorization = `Bearer ${token}`;
    try {
      const res = await fetch(url, { method: 'POST', headers, body: String(text).slice(0, 4000), signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) log(`ntfy answered ${res.status}`);
    } catch (e) { log('ntfy failed:', e.name === 'TimeoutError' ? 'timed out' : e.message); }
  };
}
