#!/usr/bin/env node
// CLI cc-notify-telegram: init (mặc định) | test | status | remote on|off | uninstall

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { hasCredentials, loadConfig, makeTelegram, strings } from '../hook/notify-telegram.mjs';
import { runInit } from '../src/init.mjs';
import { runRemote } from '../src/remote.mjs';
import { runStatus } from '../src/status.mjs';
import { runUninstall } from '../src/uninstall.mjs';

const VALUE_FLAGS = new Set(['token', 'chat-id', 'thread-id', 'lang']);

export function parseArgs(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      flags._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 2) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const key = arg.slice(2);
      if (VALUE_FLAGS.has(key) && argv[i + 1] != null && !argv[i + 1].startsWith('--')) {
        flags[key] = argv[++i];
      } else {
        flags[key] = true;
      }
    }
  }
  return flags;
}

const HELP = `cc-notify-telegram — Claude Code ↔ Telegram

Cách dùng:
  npx cc-notify-telegram [init]     Wizard cài đặt (token, chat ID, hooks, CLAUDE.md)
  npx cc-notify-telegram test       Gửi tin test
  npx cc-notify-telegram status     Kiểm tra sức khoẻ toàn chuỗi notify
  npx cc-notify-telegram remote on  Bật Remote Ask (trả lời câu hỏi của Claude qua Telegram)
  npx cc-notify-telegram remote off Tắt Remote Ask (câu hỏi hiện tại máy)
  npx cc-notify-telegram uninstall  Gỡ hooks (--purge: xoá cả config/token + CLAUDE.md block)

Cờ cho init (non-interactive):
  --token <bot-token> --chat-id <id> [--thread-id <n>] [--lang vi|en]
  [--silent] [--yes] [--no-test] [--no-claude-md] [--remove-legacy|--keep-legacy]
`;

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const command = flags._[0] || 'init';

  if (flags.version) {
    console.log(createRequire(import.meta.url)('../package.json').version);
    return true;
  }
  if (flags.help || command === 'help') {
    console.log(HELP);
    return true;
  }

  switch (command) {
    case 'init':
      return runInit(flags);
    case 'test': {
      const cfg = loadConfig();
      if (!hasCredentials(cfg)) {
        console.log('Chưa có config — chạy: npx cc-notify-telegram init');
        return false;
      }
      await makeTelegram(cfg).sendMessage(strings(cfg).testMessage);
      console.log('✅ Đã gửi tin test — kiểm tra Telegram.');
      return true;
    }
    case 'status':
      return runStatus({});
    case 'remote':
      return runRemote(flags._[1], {});
    case 'uninstall':
      return runUninstall(flags);
    default:
      console.log(`Không biết lệnh "${command}".\n\n${HELP}`);
      return false;
  }
}

// npx chạy bin qua symlink trong .bin → phải realpath trước khi so với import.meta.url,
// không thì guard tưởng file đang bị import và CLI im lặng không làm gì.
let isMain = false;
try {
  isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
} catch {
  isMain = false;
}
if (isMain) {
  main()
    .then((ok) => process.exit(ok === false ? 1 : 0))
    .catch((err) => {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    });
}
