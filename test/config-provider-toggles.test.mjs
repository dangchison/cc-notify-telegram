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

test('parseArgs: giữ provider positional cho remote command', () => {
  const flags = parseArgs(['remote-perm', 'on', 'antigravity']);
  assert.deepEqual(flags._, ['remote-perm', 'on', 'antigravity']);
});

test('parseArgs: --providers là value flag cho init non-interactive', () => {
  const flags = parseArgs(['init', '--providers', 'claude,codex', '--yes']);
  assert.equal(flags.providers, 'claude,codex');
  assert.equal(flags.yes, true);
});
