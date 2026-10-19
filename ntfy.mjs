// Phone alerts through ntfy (https://ntfy.sh), for when the Bridge app isn't open to hear the inbox.
// NTFY_TOPIC is the secret: anyone who knows it can read the alerts, so make it long and random.
export function makeNtfy({ topic, server = 'https://ntfy.sh', fetchFn = fetch, log = () => {} }) {
  const enabled = /^[A-Za-z0-9_-]{8,64}$/.test(topic || '');
  return {
    enabled,
    async send(message, title = 'Bridge') {
      if (!enabled) return false;
      try {
        const res = await fetchFn(`${server.replace(/\/+$/, '')}/${topic}`, {
          method: 'POST',
          // Headers must be ASCII, so strip anything else from the title.
          headers: { Title: String(title).replace(/[^\x20-\x7e]/g, '').slice(0, 60) || 'Bridge' },
          body: String(message).slice(0, 500),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) { log('ntfy failed:', res.status); return false; }
        return true;
      } catch (e) { log('ntfy failed:', e.message); return false; }
    },
  };
}
