// Adds the Notification hook to ~/.claude/settings.json without touching other settings.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const file = path.join(os.homedir(), '.claude', 'settings.json');
const hook = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hooks', 'notify.mjs').replace(/\\/g, '/');
const command = `node "${hook}"`;
const s = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
fs.copyFileSync(file, file + '.bak-voice-relay');
s.hooks ??= {};
s.hooks.Notification ??= [];
const already = s.hooks.Notification.some((g) => g.hooks?.some((h) => h.command === command));
if (!already) s.hooks.Notification.push({ hooks: [{ type: 'command', command }] });
fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
console.log(already ? 'hook already installed' : `installed: ${command}`);
