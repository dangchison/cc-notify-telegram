// Gỡ cài đặt: bỏ 4 entry khỏi settings.json (có backup), xoá hook file.
// --purge: xoá thêm config (token), state dir và block CLAUDE.md.

import { copyFileSync, existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { stateDir } from '../hook/notify-telegram.mjs';
import { configPath } from './config.mjs';
import { installPaths } from './init.mjs';
import { removeOurEntries } from './settings.mjs';
import { hasBlock, removeBlock } from './snippet.mjs';

export async function runUninstall(flags, { home = homedir(), log = console.log } = {}) {
  const paths = installPaths(home);

  if (existsSync(paths.settingsFile)) {
    try {
      const settings = JSON.parse(readFileSync(paths.settingsFile, 'utf8'));
      const next = removeOurEntries(settings);
      if (JSON.stringify(next) !== JSON.stringify(settings)) {
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
        copyFileSync(paths.settingsFile, `${paths.settingsFile}.bak-${stamp}`);
        writeFileSync(paths.settingsFile, JSON.stringify(next, null, 2) + '\n');
        log('✅ Đã gỡ 4 hook entry khỏi settings.json (có backup .bak-*)');
      }
    } catch {
      log(`⚠️  Không parse được ${paths.settingsFile} — bỏ qua, tự gỡ entry cc-notify-telegram bằng tay.`);
    }
  }

  if (existsSync(paths.hookFile)) {
    unlinkSync(paths.hookFile);
    log(`✅ Đã xoá ${paths.hookFile}`);
  }

  if (flags.purge) {
    const cfgFile = configPath(home);
    if (existsSync(cfgFile)) {
      unlinkSync(cfgFile);
      log('✅ Đã xoá config (bot token).');
    }
    rmSync(stateDir(home), { recursive: true, force: true });
    if (existsSync(paths.claudeMdFile)) {
      const content = readFileSync(paths.claudeMdFile, 'utf8');
      if (hasBlock(content)) {
        writeFileSync(paths.claudeMdFile, removeBlock(content));
        log('✅ Đã gỡ block marker khỏi CLAUDE.md.');
      }
    }
  } else {
    log('ℹ️  Config (token) + hướng dẫn trong CLAUDE.md vẫn giữ — thêm --purge để xoá sạch.');
  }
  log('👋 Đã gỡ cc-notify-telegram.');
  return true;
}
