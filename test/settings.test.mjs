import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HOOK_ENTRIES,
  findLegacyStopEntries,
  hookCommand,
  isInstalled,
  mergeSettings,
  removeOurEntries,
} from '../src/settings.mjs';
import { hasBlock, removeBlock, upsertBlock } from '../src/snippet.mjs';
import { readLegacyConf } from '../src/config.mjs';
import { parseArgs } from '../bin/cli.mjs';

const OPTS = { nodePath: '/usr/local/bin/node', hookPath: '/home/u/.claude/hooks/cc-notify-telegram.mjs' };

// settings mô phỏng máy đang có hook khác (csm-*) + statusLine + legacy bash hook.
const userSettings = () => ({
  theme: 'dark-ansi',
  statusLine: { type: 'command', command: '/x/statusline.sh' },
  permissions: { allow: ['mcp__codegraph__codegraph_search'] },
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: '/home/u/.claude/hooks/notify-telegram.sh', timeout: 20 }] }],
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: '/home/u/.claude/hooks/csm-pretooluse.sh' }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command: '/home/u/.claude/hooks/csm-session-end.sh' }] }],
  },
});

test('mergeSettings: thêm đủ 4 entry, GIỮ NGUYÊN hook csm-* + key lạ', () => {
  const merged = mergeSettings(userSettings(), OPTS);
  assert.ok(isInstalled(merged));
  assert.equal(merged.theme, 'dark-ansi');
  assert.deepEqual(merged.permissions, { allow: ['mcp__codegraph__codegraph_search'] });
  // csm PreToolUse matcher * còn nguyên, entry của mình thêm SAU
  assert.equal(merged.hooks.PreToolUse[0].hooks[0].command, '/home/u/.claude/hooks/csm-pretooluse.sh');
  assert.equal(merged.hooks.PreToolUse[1].matcher, 'AskUserQuestion');
  assert.equal(merged.hooks.PreToolUse[1].hooks[0].timeout, 1830);
  assert.equal(merged.hooks.SessionEnd.length, 1);
  // legacy bash hook mặc định KHÔNG bị gỡ
  assert.equal(findLegacyStopEntries(merged).length, 1);
});

test('mergeSettings: removeLegacy gỡ đúng hook bash cũ khỏi Stop', () => {
  const merged = mergeSettings(userSettings(), { ...OPTS, removeLegacy: true });
  assert.equal(findLegacyStopEntries(merged).length, 0);
  const stopCommands = merged.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command));
  assert.deepEqual(stopCommands, [hookCommand(OPTS.nodePath, OPTS.hookPath, 'stop')]);
});

test('mergeSettings: idempotent — chạy 2 lần không duplicate, đổi node path thì update in-place', () => {
  const once = mergeSettings(userSettings(), OPTS);
  const twice = mergeSettings(once, OPTS);
  assert.deepEqual(twice, once);

  const moved = mergeSettings(once, { ...OPTS, nodePath: '/opt/node22/bin/node' });
  assert.equal(moved.hooks.Stop.length, once.hooks.Stop.length);
  const ourStop = moved.hooks.Stop.find((g) => g.hooks[0].command.includes('cc-notify-telegram.mjs'));
  assert.match(ourStop.hooks[0].command, /^"\/opt\/node22\/bin\/node"/);
});

test('mergeSettings: settings rỗng/null → tự dựng structure', () => {
  const merged = mergeSettings(null, OPTS);
  assert.ok(isInstalled(merged));
  assert.equal(merged.hooks.Stop.length, 1);
});

test('hookCommand: path luôn bọc nháy kép (chịu khoảng trắng Windows)', () => {
  assert.equal(
    hookCommand('C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\a b\\.claude\\hooks\\cc-notify-telegram.mjs', 'ask'),
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\a b\\.claude\\hooks\\cc-notify-telegram.mjs" ask'
  );
});

test('removeOurEntries: gỡ sạch 4 entry, trả settings về nguyên trạng (kể cả legacy)', () => {
  const original = userSettings();
  const merged = mergeSettings(original, OPTS);
  const removed = removeOurEntries(merged);
  assert.deepEqual(removed, original);
  assert.ok(!isInstalled(removed));
});

test('removeOurEntries: dọn key hooks rỗng sau khi gỡ', () => {
  const onlyOurs = mergeSettings({}, OPTS);
  const removed = removeOurEntries(onlyOurs);
  assert.equal(removed.hooks, undefined);
});

// ---------------------------------------------------------------------------
// snippet CLAUDE.md
// ---------------------------------------------------------------------------

test('upsertBlock: thêm vào cuối, chạy lại thay-thế không duplicate', () => {
  const v1 = upsertBlock('# CLAUDE.md của user\n', 'nội dung A');
  assert.ok(hasBlock(v1));
  assert.match(v1, /# CLAUDE\.md của user/);
  const v2 = upsertBlock(v1, 'nội dung B');
  assert.equal(v2.match(/cc-notify-telegram:start/g).length, 1);
  assert.match(v2, /nội dung B/);
  assert.ok(!v2.includes('nội dung A'));
});

test('upsertBlock trên file rỗng + removeBlock trả lại gần nguyên trạng', () => {
  const added = upsertBlock('', 'block');
  assert.ok(hasBlock(added));
  assert.ok(!hasBlock(removeBlock(added)));
  const around = upsertBlock('phần đầu\n', 'block') + 'phần cuối\n';
  const removed = removeBlock(around);
  assert.match(removed, /phần đầu/);
  assert.match(removed, /phần cuối/);
  assert.ok(!hasBlock(removed));
});

// ---------------------------------------------------------------------------
// legacy telegram.conf + parseArgs
// ---------------------------------------------------------------------------

test('readLegacyConf: parse KEY=value dạng shell, bỏ comment', () => {
  const home = mkdtempSync(join(tmpdir(), 'ccnt-legacy-'));
  mkdirSync(join(home, '.claude', 'hooks'), { recursive: true });
  writeFileSync(
    join(home, '.claude', 'hooks', 'telegram.conf'),
    '# chmod 600. KHÔNG commit\nTELEGRAM_BOT_TOKEN=123:abc\nTELEGRAM_CHAT_ID="-100200"\n'
  );
  assert.deepEqual(readLegacyConf(home), { botToken: '123:abc', chatId: '-100200' });
  assert.equal(readLegacyConf(mkdtempSync(join(tmpdir(), 'ccnt-none-'))), null);
});

test('parseArgs: positional + value flag + bool flag + dạng key=value', () => {
  const flags = parseArgs(['init', '--token', '123:abc', '--chat-id=-100', '--yes', '--lang', 'en']);
  assert.deepEqual(flags._, ['init']);
  assert.equal(flags.token, '123:abc');
  assert.equal(flags['chat-id'], '-100');
  assert.equal(flags.yes, true);
  assert.equal(flags.lang, 'en');
});

test('HOOK_ENTRIES: PreToolUse timeout đủ dài cho remoteAskTimeoutSec tối đa (1770 < 1830)', () => {
  const ask = HOOK_ENTRIES.find((e) => e.arg === 'ask');
  assert.ok(ask.timeout > 1770);
});
