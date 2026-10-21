// Which voice handler a request goes to. Matched on the path alone, so a query string or a trailing
// slash doesn't turn speech into a 404, and a known path with the wrong method gets 405, not 404.
export const VOICE_ROUTES = {
  '/voice/inbox': { method: 'GET', name: 'inbox' },
  '/voice/tts': { method: 'POST', name: 'tts' },
  '/voice/photo': { method: 'POST', name: 'photo' },
  '/voice': { method: 'POST', name: 'speech' },
  '/voice/confirm': { method: 'POST', name: 'speech' },
  '/voice/send': { method: 'POST', name: 'speech' },
};

export function route(method, url) {
  let pathname;
  try { pathname = new URL(url, 'http://relay').pathname.replace(/\/+$/, '') || '/'; } catch { return { status: 404 }; }
  const r = Object.hasOwn(VOICE_ROUTES, pathname) ? VOICE_ROUTES[pathname] : null;
  if (!r) return { status: 404, pathname };
  if (r.method !== method) return { status: 405, allow: r.method, pathname };
  return { name: r.name, pathname };
}

// The inbox cursor: a message id, or "from now" when absent. Anything else is null (a 400), so a bad
// cursor can't replay the whole backlog.
export function inboxAfter(searchParams, latest) {
  if (!searchParams.has('after')) return latest;
  const raw = searchParams.get('after');
  return /^\d+$/.test(raw) ? Number(raw) : null;
}
