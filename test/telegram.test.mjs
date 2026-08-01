import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeTelegram, TELEGRAM_API_TIMEOUT_MS } from '../hook/notify-telegram.mjs';

function fakeFetch(responses, calls) {
  return async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), signal: init.signal });
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

test('makeTelegram.sendMessage: dùng timeout mặc định 30s và báo lỗi timeout rõ', async () => {
  const originalTimeout = AbortSignal.timeout;
  const timeouts = [];
  AbortSignal.timeout = (ms) => {
    timeouts.push(ms);
    return originalTimeout(ms);
  };
  try {
    const tg = makeTelegram({ botToken: 'T', chatId: '-100' }, async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });

    await assert.rejects(() => tg.sendMessage('hello'), /telegram sendMessage timed out after 30s/);
    assert.deepEqual(timeouts, [TELEGRAM_API_TIMEOUT_MS]);
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test('makeTelegram.sendMessage: lỗi group upgraded hiển thị migrate_to_chat_id', async () => {
  const calls = [];
  const tg = makeTelegram(
    { botToken: 'T', chatId: '-123' },
    fakeFetch(
      [
        {
          ok: false,
          description: 'Bad Request: group chat was upgraded to a supergroup chat',
          parameters: { migrate_to_chat_id: -1003760710918 },
        },
      ],
      calls
    )
  );

  await assert.rejects(() => tg.sendMessage('hello'), /migrate_to_chat_id: -1003760710918/);
});
