// Bật/tắt Remote Ask: ghi cờ `remote` vào config + báo trạng thái lên Telegram.

import { homedir } from 'node:os';
import { basename } from 'node:path';

import { hasCredentials, loadConfig, makeTelegram } from '../hook/notify-telegram.mjs';
import { readConfig, writeConfig } from './config.mjs';

export async function runRemote(mode, { home = homedir(), log = console.log, cwd = process.cwd() } = {}) {
  if (mode !== 'on' && mode !== 'off') {
    log('Cách dùng: cc-notify-telegram remote on|off');
    return false;
  }
  const config = readConfig(home);
  if (!config) {
    log('Chưa có config — chạy: npx cc-notify-telegram init');
    return false;
  }
  config.remote = mode === 'on';
  writeConfig(config, home);
  log(
    config.remote
      ? '📱 Remote Ask BẬT — câu hỏi của Claude sẽ gửi qua Telegram (câu hỏi đang treo sẽ nhả về máy khi tắt).'
      : '🖥 Remote Ask TẮT — câu hỏi hiện tại máy như bình thường.'
  );
  const cfg = loadConfig({ home });
  if (hasCredentials(cfg)) {
    const project = basename(cwd);
    await makeTelegram(cfg)
      .sendMessage(config.remote ? `📱 Remote Ask BẬT (từ ${project})` : `🖥 Remote Ask TẮT (từ ${project})`)
      .catch(() => log('⚠️  Không gửi được tin báo trạng thái (offline?) — cờ vẫn đã lưu.'));
  }
  return true;
}
