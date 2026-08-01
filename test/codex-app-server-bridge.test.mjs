import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  appServerQuestionsToAsk,
  handleServerRequest,
  patchInitializeRequest,
  resolveAppServerAnswers,
} from '../src/codex-app-server-bridge.mjs';

const QUESTIONS = [
  {
    id: 'stack',
    header: 'Stack',
    question: 'Choose frontend?',
    isOther: true,
    isSecret: false,
    options: [
      { label: 'Vue', description: 'team default' },
      { label: 'React', description: 'client asks' },
    ],
  },
  {
    id: 'deploy',
    header: 'Deploy',
    question: 'Choose target?',
    isOther: false,
    isSecret: false,
    options: [
      { label: 'VPS', description: '' },
      { label: 'Docker', description: '' },
    ],
  },
];

test('patchInitializeRequest opts into experimental app-server API', () => {
  const patched = patchInitializeRequest({
    method: 'initialize',
    id: 1,
    params: { clientInfo: { name: 'client' }, capabilities: { requestAttestation: true } },
  });

  assert.equal(patched.params.clientInfo.name, 'client');
  assert.equal(patched.params.capabilities.requestAttestation, true);
  assert.equal(patched.params.capabilities.experimentalApi, true);
});

test('appServerQuestionsToAsk maps app-server question shape to Telegram ask shape', () => {
  const mapped = appServerQuestionsToAsk(QUESTIONS);

  assert.equal(mapped[0].question, 'Stack: Choose frontend?');
  assert.equal(mapped[0].options[1].label, 'React');
  assert.equal(mapped[0].appServerId, 'stack');
  assert.equal(mapped[0].isOther, true);
});

test('resolveAppServerAnswers resolves option tokens or exact free text', () => {
  const mapped = appServerQuestionsToAsk(QUESTIONS);

  assert.deepEqual(resolveAppServerAnswers('1B 2A', mapped), ['React', 'VPS']);
  assert.deepEqual(resolveAppServerAnswers('Vue\nDocker', mapped), ['Vue', 'Docker']);
  assert.equal(resolveAppServerAnswers('React', mapped), null);
  assert.deepEqual(resolveAppServerAnswers('custom', [mapped[0]]), ['custom']);
});

test('handleServerRequest ignores non-ASK requests', async () => {
  const result = await handleServerRequest({ method: 'turn/completed', id: 2, params: {} }, {});
  assert.equal(result, null);
});

test('handleServerRequest answers app-server ASK requests from Telegram reply tokens', async () => {
  const edits = [];
  const result = await handleServerRequest(
    {
      method: 'item/tool/requestUserInput',
      id: 42,
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        questions: QUESTIONS,
        autoResolutionMs: null,
      },
    },
    {
      cfg: { lang: 'vi', providerId: 'codex', remoteAskTimeoutSec: 900 },
      tg: {
        editMessageText: async (id, text) => edits.push({ id, text }),
      },
      promptAsk: async () => ({
        type: 'ok',
        outcome: { type: 'reply', text: '1B 2A' },
        anchorId: 99,
        pendingFile: '/tmp/no-such-pending.json',
      }),
    }
  );

  assert.deepEqual(result, { id: 42, result: { answers: ['React', 'VPS'] } });
  assert.equal(edits[0].id, 99);
  assert.match(edits[0].text, /Đã trả lời qua Telegram/);
});
