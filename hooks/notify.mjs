// Claude Code Notification hook: forwards "Claude needs you" events to the relay.
// Must never block or fail Claude Code, so every error is swallowed.
import path from 'node:path';
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', async () => {
  try {
    const e = JSON.parse(input || '{}');
    const project = e.cwd ? path.basename(e.cwd).replace(/[_\-.]+/g, ' ') : 'Claude Code';
    const text = `${project}: ${e.message || 'Claude needs your input.'}`;
    await fetch(`http://127.0.0.1:${process.env.CLAUDE_RELAY_PORT || 47878}/notify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }), signal: AbortSignal.timeout(2000),
    });
  } catch { /* relay not running */ }
});
