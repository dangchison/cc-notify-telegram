import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeTelegram } from '../hook/notify-telegram.mjs';

function fakeFetch(responses, calls) {
  return async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const next = responses.shift();
    return {
      json: async () => next,
      status: next.status || 200,
    };
  };
}

test('makeTelegram.sendMessage: providerThreads chọn đúng topic và không gửi providerId', async () => {
  const calls = [];
  const tg = makeTelegram(
    { botToken: 'T', chatId: '-100', threadId: 1, providerThreads: { codex: 34 }, silent: true },
    fakeFetch([{ ok: true, result: { message_id: 1 } }], calls)
  );

  await tg.sendMessage('hello', { providerId: 'codex' });
  assert.equal(calls[0].body.message_thread_id, 34);
  assert.equal(calls[0].body.providerId, undefined);
  assert.equal(calls[0].body.disable_notification, true);
});

test('makeTelegram.sendMessage: explicit message_thread_id override provider thread', async () => {
  const calls = [];
  const tg = makeTelegram(
    { botToken: 'T', chatId: '-100', threadId: 1, providerThreads: { codex: 34 } },
    fakeFetch([{ ok: true, result: { message_id: 1 } }], calls)
  );

  await tg.sendMessage('hello', { providerId: 'codex', message_thread_id: 99 });
  assert.equal(calls[0].body.message_thread_id, 99);
});

test('makeTelegram.sendMessage: provider không có thread fallback sang threadId', async () => {
  const calls = [];
  const tg = makeTelegram(
    { botToken: 'T', chatId: '-100', threadId: 7, providerThreads: {} },
    fakeFetch([{ ok: true, result: { message_id: 1 } }], calls)
  );

  await tg.sendMessage('hello', { providerId: 'antigravity' });
  assert.equal(calls[0].body.message_thread_id, 7);
});

test('makeTelegram.sendMessage: lỗi message_thread_id thì retry không kèm topic', async () => {
  const calls = [];
  const tg = makeTelegram(
    { botToken: 'T', chatId: '-100', providerThreads: { codex: 34 }, silent: true },
    fakeFetch(
      [
        { ok: false, description: 'Bad Request: message_thread_id_invalid' },
        { ok: true, result: { message_id: 2 } },
      ],
      calls
    )
  );

  const sent = await tg.sendMessage('hello', { providerId: 'codex' });
  assert.equal(sent.message_id, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.message_thread_id, 34);
  assert.equal(calls[1].body.message_thread_id, undefined);
  assert.equal(calls[1].body.disable_notification, true);
});

test('makeTelegram.sendMessage: lỗi không liên quan thread thì không retry', async () => {
  const calls = [];
  const tg = makeTelegram(
    { botToken: 'T', chatId: '-100', providerThreads: { codex: 34 } },
    fakeFetch([{ ok: false, description: 'Unauthorized' }], calls)
  );

  await assert.rejects(() => tg.sendMessage('hello', { providerId: 'codex' }), /Unauthorized/);
  assert.equal(calls.length, 1);
});
