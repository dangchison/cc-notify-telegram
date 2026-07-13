// Đọc/ghi config ~/.claude/cc-notify-telegram.json (chứa bot token → chmod 600 trên Unix).

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function configPath(home = homedir()) {
  return join(home, '.claude', 'cc-notify-telegram.json');
}

export function readConfig(home = homedir()) {
  try {
    return JSON.parse(readFileSync(configPath(home), 'utf8'));
  } catch {
    return null;
  }
}

export function writeConfig(cfg, home = homedir()) {
  const file = configPath(home);
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  if (process.platform !== 'win32') chmodSync(file, 0o600);
  return file;
}

// Migrate setup cũ (bash hook): ~/.claude/hooks/telegram.conf dạng shell KEY=value.
export function readLegacyConf(home = homedir()) {
  const file = join(home, '.claude', 'hooks', 'telegram.conf');
  if (!existsSync(file)) return null;
  const out = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*(TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID)\s*=\s*("?)(.*?)\2\s*$/);
    if (m) out[m[1] === 'TELEGRAM_BOT_TOKEN' ? 'botToken' : 'chatId'] = m[3];
  }
  return out.botToken || out.chatId ? out : null;
}
