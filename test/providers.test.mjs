import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildAskMessage, buildPermMessage, buildStopMessage, strings } from '../hook/notify-telegram.mjs';
import { AntigravityProvider, ClaudeProvider, CodexProvider, ProviderRegistry } from '../src/providers/index.mjs';
import { normalizePayload } from '../src/adapters/payload-normalizer.mjs';

const str = strings({ lang: 'vi' });

test('ProviderRegistry: resolve provider từ payload và fallback Claude', () => {
  const registry = new ProviderRegistry();
  assert.equal(registry.resolve({ provider: 'codex' }).id, 'codex');
  assert.equal(registry.resolve({ providerId: 'antigravity' }).id, 'antigravity');
  assert.equal(registry.resolve({ provider: 'unknown' }).id, 'claude');
});

test('ClaudeProvider: formatOutput giữ schema Claude hiện tại', () => {
  const provider = new ClaudeProvider();
  assert.deepEqual(JSON.parse(provider.formatOutput({ behavior: 'deny', reason: 'answer' }, 'ask')), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'answer',
    },
  });
  assert.deepEqual(JSON.parse(provider.formatOutput({ behavior: 'allow' }, 'perm')), {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  });
});

test('CodexProvider: normalize command approval payload và format app-server decisions', () => {
  const provider = new CodexProvider();
  const payload = provider.normalizePayload(
    { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', command: 'npm test', cwd: '/repo/app', reason: 'verify' },
    'perm'
  );
  assert.equal(payload.provider, 'codex');
  assert.equal(payload.sessionId, 'thread-1');
  assert.equal(payload.toolName, 'Command');
  assert.deepEqual(payload.toolInput, { command: 'npm test', cwd: '/repo/app', reason: 'verify' });
  assert.deepEqual(JSON.parse(provider.formatOutput({ behavior: 'allow' }, 'perm')), {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  });
  assert.deepEqual(JSON.parse(provider.formatOutput({ behavior: 'deny', reason: 'no' }, 'perm')), {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'no' } },
  });
});

test('CodexProvider: registerHooks ghi lifecycle hooks vào hooks.json', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-notify-codex-'));
  const codexDir = join(home, '.codex');
  mkdirSync(codexDir, { recursive: true });
  const configFile = join(codexDir, 'config.toml');
  writeFileSync(configFile, 'model = "gpt-5"\n\n[tui.model_availability_nux]\n"gpt-5.6-sol" = 1\n');

  const provider = new CodexProvider();
  await provider.registerHooks({ nodePath: '/usr/bin/node', hookPath: '/tmp/hook.mjs', home });

  const hooks = JSON.parse(readFileSync(join(codexDir, 'hooks.json'), 'utf8'));
  assert.match(hooks.hooks.Stop[0].hooks[0].command, /"\/usr\/bin\/node" "\/tmp\/hook\.mjs" stop codex/);
  assert.match(hooks.hooks.PermissionRequest[0].hooks[0].command, /"\/usr\/bin\/node" "\/tmp\/hook\.mjs" perm codex/);
  assert.equal(hooks.hooks.PermissionRequest[0].matcher, '*');
  assert.equal(readFileSync(configFile, 'utf8'), 'model = "gpt-5"\n\n[tui.model_availability_nux]\n"gpt-5.6-sol" = 1\n');
});

test('CodexProvider: registerHooks migrate owned notify block without touching user notify', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-notify-codex-'));
  const codexDir = join(home, '.codex');
  mkdirSync(codexDir, { recursive: true });
  const configFile = join(codexDir, 'config.toml');
  writeFileSync(
    configFile,
    [
      'model = "gpt-5"',
      '# ai-notify-telegram notify',
      'notify = ["/old-owned"]',
      'notify = ["/user-owned"]',
      '',
      '[plugins.demo]',
      'enabled = true',
      '',
    ].join('\n')
  );

  const provider = new CodexProvider();
  await provider.registerHooks({ nodePath: '/usr/bin/node', hookPath: '/tmp/hook.mjs', home });

  const config = readFileSync(configFile, 'utf8');
  assert.equal(config.match(/^notify\s*=/gm)?.length, 1);
  assert.doesNotMatch(config, /"\/old-owned"/);
  assert.match(config, /"\/user-owned"/);
});

test('CodexProvider: unregisterHooks removes only owned lifecycle hooks', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cc-notify-codex-'));
  const codexDir = join(home, '.codex');
  mkdirSync(codexDir, { recursive: true });

  const provider = new CodexProvider();
  await provider.registerHooks({ nodePath: '/usr/bin/node', hookPath: '/tmp/hook.mjs', home });
  const hooksFile = join(codexDir, 'hooks.json');
  const hooks = JSON.parse(readFileSync(hooksFile, 'utf8'));
  hooks.hooks.Stop.push({ hooks: [{ type: 'command', command: 'python3 /tmp/user-stop.py' }] });
  writeFileSync(hooksFile, JSON.stringify(hooks, null, 2) + '\n');

  await provider.unregisterHooks({ home });

  const next = JSON.parse(readFileSync(hooksFile, 'utf8'));
  assert.equal(next.hooks.Stop.length, 1);
  assert.equal(next.hooks.Stop[0].hooks[0].command, 'python3 /tmp/user-stop.py');
  assert.equal(next.hooks.PermissionRequest, undefined);
});

test('AntigravityProvider: normalize hook payload và format PreToolUse decisions', () => {
  const provider = new AntigravityProvider();
  const payload = provider.normalizePayload(
    {
      provider: 'antigravity',
      conversationId: 'conv-1',
      workspacePaths: ['/repo/site'],
      transcriptPath: '/tmp/transcript.jsonl',
      toolCall: {
        name: 'ask_question',
        args: {
          questions: [{ question: 'DB?', is_multi_select: true, options: [{ label: 'Postgres' }] }],
        },
      },
    },
    'ask'
  );
  assert.equal(payload.provider, 'antigravity');
  assert.equal(payload.sessionId, 'conv-1');
  assert.equal(payload.project, 'site');
  assert.equal(payload.toolName, 'ask_question');
  assert.equal(payload.questions[0].multiSelect, true);
  assert.deepEqual(JSON.parse(provider.formatOutput({ behavior: 'allow' }, 'perm')), { decision: 'allow' });
  assert.deepEqual(JSON.parse(provider.formatOutput({ behavior: 'deny', reason: 'blocked' }, 'perm')), {
    decision: 'deny',
    reason: 'blocked',
  });
});

test('normalizePayload adapter dispatches by provider', () => {
  const payload = normalizePayload({ provider: 'antigravity', conversationId: 'c1', workspacePaths: ['/w/p'] }, 'stop');
  assert.equal(payload.provider, 'antigravity');
  assert.equal(payload.sessionId, 'c1');
});

test('message builders support provider tag only when providerId is supplied', () => {
  assert.match(buildAskMessage([{ question: 'Q?', options: [] }], { project: 'p', suffix: 's1', str }), /^❓ \[p · s1\] Claude đang hỏi:/);
  assert.match(buildAskMessage([{ question: 'Q?', options: [] }], { project: 'p', suffix: 's1', str, providerId: 'codex' }), /^❓ \[Codex · p · s1\] Codex đang hỏi:/);
  assert.match(buildPermMessage({ toolName: 'Bash', toolInput: { command: 'ls' }, project: 'p', suffix: 's1', str, providerId: 'antigravity' }), /^🔐 \[Antigravity · p · s1\] Antigravity xin quyền dùng:/);
  assert.match(buildStopMessage({ last: '<!-- AI_NOTIFY_DONE: done -->', project: 'p', snippet: '', str, providerId: 'codex' }), /^✅ p\n• done/);
});
