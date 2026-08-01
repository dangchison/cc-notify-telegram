import { test } from 'node:test';
import assert from 'node:assert/strict';

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
  assert.equal(JSON.parse(provider.formatOutput({ behavior: 'allow' }, 'perm')).decision, 'accept');
  assert.equal(JSON.parse(provider.formatOutput({ behavior: 'allow', session: true }, 'perm')).decision, 'acceptForSession');
  assert.equal(JSON.parse(provider.formatOutput({ behavior: 'deny', reason: 'no' }, 'perm')).decision, 'decline');
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
