import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isToggleEnabled, readConfig, writeConfig } from '../src/config.mjs';
import { runRemote } from '../src/remote.mjs';
import { parseArgs } from '../bin/cli.mjs';

test('readConfig: legacy boolean remote chỉ migrate cho Claude, không bật nhầm provider mới', () => {
  const home = mkdtempSync(join(tmpdir(), 'ccnt-legacy-cfg-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(
    join(home, '.claude', 'cc-notify-telegram.json'),
    JSON.stringify({ botToken: 'T', chatId: '-1', remote: true, remotePermission: true })
  );

  const cfg = readConfig(home);
  assert.equal(isToggleEnabled(cfg, 'remote', 'claude'), true);
  assert.equal(isToggleEnabled(cfg, 'remote', 'codex'), false);
  assert.equal(isToggleEnabled(cfg, 'remotePermission', 'antigravity'), false);
});

test('runRemote: global và per-provider toggles ghi đúng schema', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ccnt-toggle-'));
  writeConfig({ enabledProviders: ['claude'], remote: false, remotePermission: false }, home);
  const logs = [];

  assert.equal(await runRemote('on', { home, log: (line) => logs.push(line), provider: 'codex' }), true);
  let cfg = readConfig(home);
  assert.equal(cfg.remote.global, true);
  assert.equal(cfg.remote.providers.codex, true);
  assert.ok(cfg.enabledProviders.includes('codex'));
  assert.equal(isToggleEnabled(cfg, 'remote', 'codex'), true);
  assert.equal(isToggleEnabled(cfg, 'remote', 'antigravity'), false);

  assert.equal(await runRemote('off', { home, log: () => {} }), true);
  cfg = readConfig(home);
  assert.equal(cfg.remote.global, false);
  assert.equal(cfg.remote.providers.claude, false);
  assert.equal(cfg.remote.providers.codex, false);
});

test('runRemote: unknown provider fail rõ và không ghi provider lạ', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ccnt-bad-provider-'));
  writeConfig({ enabledProviders: ['claude'], remote: false }, home);
  const logs = [];

  assert.equal(await runRemote('on', { home, log: (line) => logs.push(line), provider: 'cursor' }), false);
  assert.match(logs.join('\n'), /Provider không hợp lệ/);
  assert.equal(readConfig(home).remote.providers.cursor, undefined);
});

test('runRemote: global command gửi từng provider vào providerThreads khi có topic mapping', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ccnt-topic-route-'));
  writeConfig(
    {
      botToken: 'T',
      chatId: '-100',
      enabledProviders: ['claude', 'codex', 'antigravity'],
      providerThreads: { claude: 5, codex: 6, antigravity: 7 },
      remote: false,
    },
    home
  );
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return { json: async () => ({ ok: true, result: { message_id: calls.length } }) };
  };
  try {
    assert.equal(await runRemote('on', { home, log: () => {}, cwd: '/repo/app' }), true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((body) => body.message_thread_id), [5, 6, 7]);
  assert.match(calls[0].text, /cho claude/);
  assert.match(calls[1].text, /cho codex/);
  assert.match(calls[2].text, /cho antigravity/);
});

test('runRemote: global command không có providerThreads thì gửi một tin chung', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ccnt-no-topic-route-'));
  writeConfig(
    {
      botToken: 'T',
      chatId: '-100',
      enabledProviders: ['claude', 'codex', 'antigravity'],
      remote: false,
    },
    home
  );
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return { json: async () => ({ ok: true, result: { message_id: calls.length } }) };
  };
  try {
    assert.equal(await runRemote('on', { home, log: () => {}, cwd: '/repo/app' }), true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].message_thread_id, undefined);
  assert.doesNotMatch(calls[0].text, /cho claude|cho codex|cho antigravity/);
});

test('parseArgs: giữ provider positional cho remote command', () => {
  const flags = parseArgs(['remote-perm', 'on', 'antigravity']);
  assert.deepEqual(flags._, ['remote-perm', 'on', 'antigravity']);
});

test('parseArgs: --providers là value flag cho init non-interactive', () => {
  const flags = parseArgs(['init', '--providers', 'claude,codex', '--yes']);
  assert.equal(flags.providers, 'claude,codex');
  assert.equal(flags.yes, true);
});
