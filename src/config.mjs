// Đọc/ghi config multi-provider (chứa bot token → chmod 600 trên Unix).
// Đường dẫn mới: ~/.config/ai-notify-telegram/config.json
// Đường dẫn cũ vẫn được đọc để không làm hỏng máy đã cài Claude trước đó.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PROVIDERS = ['claude', 'codex', 'antigravity'];

export function configPath(home = homedir()) {
  return join(home, '.config', 'ai-notify-telegram', 'config.json');
}

export function legacyConfigPath(home = homedir()) {
  return join(home, '.claude', 'cc-notify-telegram.json');
}

function boolOrDefault(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

export function normalizeProviderMap(value, fallback = false) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(PROVIDERS.map((id) => [id, boolOrDefault(input[id], fallback)]));
}

export function normalizeToggle(value, fallback = false, { legacy = false } = {}) {
  if (typeof value === 'boolean') {
    if (legacy) return { global: value, providers: { claude: value, codex: false, antigravity: false } };
    return { global: value, providers: normalizeProviderMap(null, value) };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const global = boolOrDefault(value.global, fallback);
    return { global, providers: normalizeProviderMap(value.providers, global) };
  }
  return { global: fallback, providers: normalizeProviderMap(null, fallback) };
}

export function isToggleEnabled(cfg, key, provider = 'claude') {
  const toggle = normalizeToggle(cfg?.[key], false);
  if (!toggle.global) return false;
  return toggle.providers[provider] === true;
}

export function normalizeConfig(cfg = {}, { legacy = false } = {}) {
  const enabledProviders = Array.isArray(cfg.enabledProviders)
    ? cfg.enabledProviders.filter((id) => PROVIDERS.includes(id))
    : ['claude'];
  const uniqueEnabled = [...new Set(enabledProviders.length ? enabledProviders : ['claude'])];
  return {
    ...cfg,
    providerThreads: cfg.providerThreads && typeof cfg.providerThreads === 'object' ? cfg.providerThreads : {},
    enabledProviders: uniqueEnabled,
    remote: normalizeToggle(cfg.remote, false, { legacy }),
    remotePermission: normalizeToggle(cfg.remotePermission, false, { legacy }),
  };
}

export function readConfig(home = homedir()) {
  const files = [
    { file: configPath(home), legacy: false },
    { file: legacyConfigPath(home), legacy: true },
  ];
  for (const item of files) {
    try {
      return normalizeConfig(JSON.parse(readFileSync(item.file, 'utf8')), { legacy: item.legacy });
    } catch {
      // thử đường dẫn tiếp theo
    }
  }
  return null;
}

export function readRawConfig(home = homedir()) {
  try {
    return JSON.parse(readFileSync(configPath(home), 'utf8'));
  } catch {
    return null;
  }
}

export function writeConfig(cfg, home = homedir()) {
  const file = configPath(home);
  mkdirSync(join(home, '.config', 'ai-notify-telegram'), { recursive: true });
  writeFileSync(file, JSON.stringify(normalizeConfig(cfg), null, 2) + '\n');
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
