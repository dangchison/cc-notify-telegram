// Doctor: kiểm tra từng mắt xích của chuỗi notify và in ✓/✗ kèm cách sửa.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';

import { loadConfig, makeTelegram, hasCredentials } from '../hook/notify-telegram.mjs';
import { configPath } from './config.mjs';
import { HOOK_ENTRIES } from './settings.mjs';
import { hasBlock } from './snippet.mjs';
import { installPaths } from './init.mjs';

function extractNodePath(command) {
  const m = /^"([^"]+)"/.exec(command || '');
  return m ? m[1] : null;
}

export async function runStatus({ home = homedir(), log = console.log } = {}) {
  const paths = installPaths(home);
  const cfg = loadConfig({ home });
  const rows = [];
  const add = (ok, label, fix = '') => rows.push({ ok, label, fix });

  // Config
  const cfgFile = configPath(home);
  if (hasCredentials(cfg)) {
    add(true, `Config: ${cfgFile}`);
    if (process.platform !== 'win32' && existsSync(cfgFile)) {
      const mode = statSync(cfgFile).mode & 0o777;
      add(mode === 0o600, `Quyền config ${mode.toString(8)} (nên 600)`, 'chmod 600 file config');
    }
  } else {
    add(false, 'Config thiếu botToken/chatId', 'chạy: npx cc-notify-telegram init');
  }

  // Token sống?
  if (hasCredentials(cfg)) {
    try {
      const me = await makeTelegram(cfg).getMe();
      add(true, `Bot @${me.username} — token hợp lệ`);
    } catch (err) {
      add(false, `getMe lỗi: ${err.message}`, 'token sai/hết hạn hoặc offline — kiểm tra @BotFather');
    }
  }

  // Hook file
  add(existsSync(paths.hookFile), `Hook: ${paths.hookFile}`, 'chạy lại init để copy hook');

  // Settings entries + node path còn tồn tại
  let settings = {};
  try {
    settings = JSON.parse(readFileSync(paths.settingsFile, 'utf8'));
  } catch {
    add(false, `Không đọc được ${paths.settingsFile}`, 'chạy lại init');
  }
  for (const spec of HOOK_ENTRIES) {
    const groups = settings?.hooks?.[spec.event] || [];
    const ours = groups.find((g) =>
      (g.hooks || []).some((h) => (h.command || '').includes('cc-notify-telegram.mjs'))
    );
    if (!ours) {
      add(false, `settings.json thiếu hook ${spec.event}`, 'chạy lại init');
      continue;
    }
    const command = ours.hooks.find((h) => (h.command || '').includes('cc-notify-telegram.mjs'))?.command;
    const nodePath = extractNodePath(command);
    const nodeOk = nodePath && existsSync(nodePath);
    add(nodeOk, `Hook ${spec.event} → node ${nodePath || '?'}`, nodeOk ? '' : 'node đã bị xoá/đổi version — chạy lại init');
  }

  // CLAUDE.md snippet
  const claudeMd = existsSync(paths.claudeMdFile) ? readFileSync(paths.claudeMdFile, 'utf8') : '';
  add(
    hasBlock(claudeMd),
    'CLAUDE.md có hướng dẫn marker',
    'không có → Claude không phát marker, không có notify; chạy lại init'
  );

  // Remote mode
  add(true, `Remote Ask: ${cfg.remote ? `ON (chờ tối đa ${cfg.remoteAskTimeoutSec}s)` : 'off'}`);

  let allOk = true;
  for (const r of rows) {
    log(`${r.ok ? '✓' : '✗'} ${r.label}${!r.ok && r.fix ? `\n    ↳ ${r.fix}` : ''}`);
    if (!r.ok) allOk = false;
  }
  log('');
  log(allOk ? '✅ Mọi thứ sẵn sàng.' : '⚠️  Có mục cần sửa (xem ↳ ở trên).');
  return allOk;
}
