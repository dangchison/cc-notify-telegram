// Bật/tắt Remote Ask (`remote`) và Remote Permission (`remotePermission`):
// ghi cờ vào config + báo trạng thái lên Telegram.

import { homedir } from 'node:os';
import { basename } from 'node:path';

import { hasCredentials, loadConfig, makeTelegram } from '../hook/notify-telegram.mjs';
import { PROVIDERS, isToggleEnabled, readConfig, writeConfig } from './config.mjs';

const MODES = {
  remote: {
    usage: 'Cách dùng: cc-notify-telegram remote on|off [claude|codex|antigravity]',
    on: '📱 Remote Ask BẬT — câu hỏi của Claude sẽ gửi qua Telegram (câu hỏi đang treo sẽ nhả về máy khi tắt).',
    off: '🖥 Remote Ask TẮT — câu hỏi hiện tại máy như bình thường.',
    onTg: (project, provider) => `📱 Remote Ask BẬT${provider ? ` cho ${provider}` : ''} (từ ${project})`,
    offTg: (project, provider) => `🖥 Remote Ask TẮT${provider ? ` cho ${provider}` : ''} (từ ${project})`,
  },
  remotePermission: {
    usage: 'Cách dùng: cc-notify-telegram remote-perm on|off [claude|codex|antigravity]',
    on: '🔐 Remote Permission BẬT — yêu cầu quyền sẽ gửi kèm nút bấm qua Telegram.',
    off: '🖥 Remote Permission TẮT — hộp thoại quyền hiện tại máy như bình thường.',
    onTg: (project, provider) => `🔐 Remote Permission BẬT${provider ? ` cho ${provider}` : ''} (từ ${project})`,
    offTg: (project, provider) => `🖥 Remote Permission TẮT${provider ? ` cho ${provider}` : ''} (từ ${project})`,
  },
};

function activeProviders(config, provider) {
  if (provider) return [provider];
  const enabled = Array.isArray(config.enabledProviders) ? config.enabledProviders : ['claude'];
  const ids = enabled.filter((id) => PROVIDERS.includes(id));
  return ids.length ? ids : ['claude'];
}

function hasProviderTopics(config, providers) {
  return providers.some((id) => config.providerThreads?.[id] != null && config.providerThreads[id] !== '');
}

async function sendStatusMessage({ config, home, provider, providers, texts, enabling, project, log }) {
  if (provider || hasProviderTopics(config, providers)) {
    for (const id of providers) {
      const cfg = loadConfig({ home, providerId: id });
      if (!hasCredentials(cfg)) continue;
      await makeTelegram(cfg)
        .sendMessage(enabling ? texts.onTg(project, id) : texts.offTg(project, id), { providerId: id })
        .catch((err) =>
          log(`⚠️  Không gửi được tin báo trạng thái cho ${id}: ${err.message || err} — cờ vẫn đã lưu.`)
        );
    }
    return;
  }

  const cfg = loadConfig({ home, providerId: 'claude' });
  if (hasCredentials(cfg)) {
    await makeTelegram(cfg)
      .sendMessage(enabling ? texts.onTg(project) : texts.offTg(project))
      .catch((err) => log(`⚠️  Không gửi được tin báo trạng thái: ${err.message || err} — cờ vẫn đã lưu.`));
  }
}

export async function runRemote(
  mode,
  { home = homedir(), log = console.log, cwd = process.cwd(), key = 'remote', provider } = {}
) {
  const texts = MODES[key];
  if (mode !== 'on' && mode !== 'off') {
    log(texts.usage);
    return false;
  }
  const config = readConfig(home);
  if (!config) {
    log('Chưa có config — chạy: npx cc-notify-telegram init');
    return false;
  }
  const enabling = mode === 'on';
  if (provider && !PROVIDERS.includes(provider)) {
    log(`Provider không hợp lệ "${provider}". Hỗ trợ: ${PROVIDERS.join(', ')}`);
    return false;
  }
  const targetProviders = activeProviders(config, provider);
  const current = config[key] && typeof config[key] === 'object' ? config[key] : { global: config[key] === true, providers: {} };
  current.providers = current.providers || {};
  if (provider) {
    if (enabling) current.global = true;
    current.providers[provider] = enabling;
    if (enabling && !config.enabledProviders.includes(provider)) config.enabledProviders.push(provider);
  } else {
    current.global = enabling;
    for (const id of PROVIDERS) current.providers[id] = enabling;
  }
  config[key] = current;
  writeConfig(config, home);
  log(provider ? `${enabling ? texts.on : texts.off} (${provider})` : enabling ? texts.on : texts.off);

  // Remote Permission vô dụng nếu thiếu 2 điều kiện này — nói ngay thay vì để user chờ mãi.
  if (key === 'remotePermission' && enabling) {
    if (!(config.allowedUserIds || []).length) {
      log('⚠️  Chưa có allowedUserIds — KHÔNG ai duyệt được từ xa (fail-closed).');
      log('    Chạy `npx cc-notify-telegram init` để dò/thêm user ID được phép duyệt.');
    }
    const missingRemote = targetProviders.filter((id) => !isToggleEnabled(config, 'remote', id));
    if (missingRemote.length) {
      log('⚠️  Remote Ask đang TẮT — bật luôn bằng `npx cc-notify-telegram remote on`.');
    }
  }

  await sendStatusMessage({
    config,
    home,
    provider,
    providers: targetProviders,
    texts,
    enabling,
    project: basename(cwd),
    log,
  });
  return true;
}
