import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildAskMessage,
  buildDenyReason,
  buildStopMessage,
  chunkMessage,
  classifyUpdate,
  denyOutput,
  extractDoneSummary,
  extractLocalAnswers,
  fallbackBody,
  firstUserSnippet,
  gcStateDir,
  isLocalKeyword,
  lastAssistantText,
  loadConfig,
  pendingKey,
  resolveAnswerTokens,
  strings,
  summaryToBullets,
  tryAcquireLock,
} from '../hook/notify-telegram.mjs';

const str = strings({ lang: 'vi' });

const jsonl = (...entries) => entries.map((e) => JSON.stringify(e));

const assistantLine = (text, extra = {}) => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }] },
  ...extra,
});

// ---------------------------------------------------------------------------
// event stop — parse transcript
// ---------------------------------------------------------------------------

test('lastAssistantText: lấy text block CUỐI, bỏ sidechain', () => {
  const lines = jsonl(
    { type: 'user', message: { content: 'hi' } },
    assistantLine('tin subagent', { isSidechain: true }),
    assistantLine('tin đầu'),
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use' }, { type: 'text', text: 'tin cuối' }] },
    }
  );
  assert.equal(lastAssistantText(lines), 'tin cuối');
});

test('lastAssistantText: transcript rỗng/hỏng → chuỗi rỗng', () => {
  assert.equal(lastAssistantText([]), '');
  assert.equal(lastAssistantText(['not-json', '{"type":"user"}']), '');
});

test('firstUserSnippet: lấy yêu cầu ĐẦU, làm sạch tag, cắt 60 codepoint', () => {
  const long = 'â'.repeat(70); // ký tự ngoài ASCII — cắt phải theo codepoint
  const lines = jsonl(
    { type: 'user', isMeta: true, message: { content: 'meta bỏ qua' } },
    { type: 'user', message: { content: `<system-reminder>noise</system-reminder> <b>${long}</b>` } },
    { type: 'user', message: { content: 'yêu cầu sau' } }
  );
  const snippet = firstUserSnippet(lines);
  assert.equal(snippet, 'â'.repeat(60) + '…');
});

test('firstUserSnippet: content dạng array block', () => {
  const lines = jsonl({
    type: 'user',
    message: { content: [{ type: 'text', text: 'sửa  bug' }, { type: 'image' }] },
  });
  assert.equal(firstUserSnippet(lines), 'sửa bug');
});

test('extractDoneSummary + summaryToBullets', () => {
  const text = 'Xong việc!\n<!-- CC_NOTIFY_DONE: Sửa hook | merged #65 -->';
  assert.equal(extractDoneSummary(text), 'Sửa hook | merged #65');
  assert.equal(summaryToBullets('Sửa hook | merged #65'), '• Sửa hook\n• merged #65');
  assert.equal(extractDoneSummary('không có marker'), '');
});

test('fallbackBody: gỡ dòng marker + comment, trim dòng trống, cap 3800 codepoint', () => {
  const text = ['', 'Kết quả tốt <!-- note -->', '', '<!-- CC_NOTIFY_DONE -->', 'dòng cuối', ''].join('\n');
  assert.equal(fallbackBody(text), 'Kết quả tốt \n\ndòng cuối');
  const huge = 'ê'.repeat(3900);
  assert.equal(Array.from(fallbackBody(huge)).length, 3801); // 3800 + '…'
});

test('buildStopMessage: done có tóm tắt trong marker', () => {
  const msg = buildStopMessage({
    last: 'OK\n<!-- CC_NOTIFY_DONE: việc 1 | việc 2 -->',
    project: 'packflow',
    snippet: '',
    str,
  });
  assert.equal(msg, '✅ packflow\n• việc 1\n• việc 2');
});

test('buildStopMessage: escalate ưu tiên trước done, suffix generic', () => {
  const msg = buildStopMessage({
    last: '🛑 Cần bạn merge PR\n<!-- CC_NOTIFY_ESCALATE -->\n<!-- CC_NOTIFY_DONE: x -->',
    project: 'packflow',
    snippet: '',
    str,
  });
  assert.equal(msg, '🛑 Cần bạn merge PR\n— packflow: mở Claude Code xem chi tiết');
});

test('buildStopMessage: chuỗi fallback — body → snippet → plain', () => {
  const viaBody = buildStopMessage({
    last: 'Đã xong hết.\n<!-- CC_NOTIFY_DONE -->',
    project: 'p',
    snippet: 'yêu cầu',
    str,
  });
  assert.equal(viaBody, '✅ p\nĐã xong hết.');

  const viaSnippet = buildStopMessage({
    last: '<!-- CC_NOTIFY_DONE -->',
    project: 'p',
    snippet: 'yêu cầu',
    str,
  });
  assert.equal(viaSnippet, '✅ p · "yêu cầu"\n— đã hoàn thành công việc');

  const plain = buildStopMessage({ last: '<!-- CC_NOTIFY_DONE -->', project: 'p', snippet: '', str });
  assert.equal(plain, '✅ p — đã hoàn thành công việc');

  assert.equal(buildStopMessage({ last: 'không marker', project: 'p', snippet: '', str }), null);
});

// ---------------------------------------------------------------------------
// event ask — format câu hỏi + phân loại reply
// ---------------------------------------------------------------------------

const QUESTIONS = [
  {
    question: 'Chọn database?',
    multiSelect: false,
    options: [{ label: 'Postgres', description: 'quen thuộc' }, { label: 'SQLite' }],
  },
  {
    question: 'Deploy đâu?',
    multiSelect: true,
    options: [{ label: 'VPS' }, { label: 'Docker' }],
  },
];

test('buildAskMessage: tag session, đánh số câu/option, ghi chú multiSelect, footer', () => {
  const msg = buildAskMessage(QUESTIONS, { project: 'packflow', suffix: 'a1b2', str });
  assert.match(msg, /^❓ \[packflow · a1b2\] Claude đang hỏi:/);
  assert.match(msg, /1\. Chọn database\?\n   A\. Postgres — quen thuộc\n   B\. SQLite/);
  assert.match(msg, /2\. Deploy đâu\? \(chọn được nhiều\)/);
  assert.match(msg, /Reply "local"/);
});

test('buildAskMessage: GIỮ NGUYÊN mô tả dài, KHÔNG cắt (regression: bug cắt 80cp)', () => {
  const longDesc = 'Đây là mô tả rất chi tiết cần đọc đầy đủ. '.repeat(10); // ~420 codepoint
  const msg = buildAskMessage(
    [{ question: 'Q?', options: [{ label: 'X', description: longDesc }] }],
    { project: 'p', suffix: '', str }
  );
  assert.ok(msg.includes(longDesc), 'phải chứa full mô tả');
  assert.ok(!msg.includes('…'), 'không được có dấu cắt …');
});

test('chunkMessage: gộp theo dòng, mỗi chunk ≤ limit, ghép lại nguyên văn', () => {
  const text = Array.from({ length: 40 }, (_, i) => `dòng ${i} ${'x'.repeat(40)}`).join('\n');
  const chunks = chunkMessage(text, 300);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(Array.from(c).length <= 300);
  assert.equal(chunks.join('\n'), text);
});

test('chunkMessage: hard-split dòng đơn siêu dài (không mất ký tự)', () => {
  const huge = 'a'.repeat(1000);
  const chunks = chunkMessage(huge, 400);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(Array.from(c).length <= 400);
  assert.equal(chunks.join(''), huge);
});

test('chunkMessage: text ngắn → đúng 1 chunk', () => {
  assert.deepEqual(chunkMessage('ngắn gọn', 4000), ['ngắn gọn']);
});

test('classifyUpdate: group phải reply đúng tin câu hỏi', () => {
  const pending = [{ messageId: 10, sentAt: Date.now() }];
  const base = { chat: { id: -100, type: 'supergroup' }, text: '1A', date: Math.floor(Date.now() / 1000) };
  const ctx = { chatId: -100, pending };

  assert.equal(classifyUpdate({ message: { ...base, reply_to_message: { message_id: 10 } } }, ctx).kind, 'reply');
  assert.equal(classifyUpdate({ message: { ...base, reply_to_message: { message_id: 99 } } }, ctx).kind, 'ignore');
  assert.equal(classifyUpdate({ message: base }, ctx).kind, 'ignore'); // tin trần trong group
  assert.equal(
    classifyUpdate({ message: { ...base, chat: { id: -200, type: 'supergroup' }, reply_to_message: { message_id: 10 } } }, ctx).kind,
    'ignore' // sai chat
  );
});

test('classifyUpdate: private — 1 câu chờ nhận tin trần MỚI, nhiều câu bắt reply', () => {
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const one = { chatId: 5, pending: [{ messageId: 10, sentAt: now }] };
  const fresh = { message: { chat: { id: 5, type: 'private' }, text: 'chọn 1', date: nowSec + 5 } };
  const stale = { message: { chat: { id: 5, type: 'private' }, text: 'tin cũ', date: nowSec - 3600 } };

  assert.deepEqual(classifyUpdate(fresh, one), { kind: 'reply', messageId: 10, text: 'chọn 1' });
  assert.equal(classifyUpdate(stale, one).kind, 'ignore'); // backlog cũ không được tính

  const two = { chatId: 5, pending: [{ messageId: 10, sentAt: now }, { messageId: 11, sentAt: now }] };
  assert.equal(classifyUpdate(fresh, two).kind, 'need-reply-hint');
  assert.equal(
    classifyUpdate({ message: { ...fresh.message, reply_to_message: { message_id: 11 } } }, two).messageId,
    11
  );
});

test('classifyUpdate: câu hỏi bị chunk (nhiều messageIds) — reply vào TIN NÀO cũng nhận', () => {
  const ctx = { chatId: 7, pending: [{ messageId: 30, messageIds: [28, 29, 30], sentAt: Date.now() }] };
  const base = { chat: { id: 7, type: 'supergroup' }, text: '2C', date: Math.floor(Date.now() / 1000) };
  // reply vào chunk giữa (29) vẫn khớp
  assert.deepEqual(classifyUpdate({ message: { ...base, reply_to_message: { message_id: 29 } } }, ctx), {
    kind: 'reply',
    messageId: 29,
    text: '2C',
  });
  // reply vào chunk đầu (28) cũng khớp
  assert.equal(classifyUpdate({ message: { ...base, reply_to_message: { message_id: 28 } } }, ctx).messageId, 28);
  // id ngoài nhóm → bỏ
  assert.equal(classifyUpdate({ message: { ...base, reply_to_message: { message_id: 99 } } }, ctx).kind, 'ignore');
});

test('resolveAnswerTokens: "1A, 2B", "A" khi 1 câu, text tự do → null', () => {
  assert.deepEqual(resolveAnswerTokens('1A, 2b', QUESTIONS), [
    'Câu 1 "Chọn database?" → "Postgres"',
    'Câu 2 "Deploy đâu?" → "Docker"',
  ]);
  assert.deepEqual(resolveAnswerTokens('B', [QUESTIONS[0]]), ['Câu 1 "Chọn database?" → "SQLite"']);
  assert.equal(resolveAnswerTokens('A', QUESTIONS), null); // 2 câu mà không ghi số câu
  assert.equal(resolveAnswerTokens('dùng Postgres đi', QUESTIONS), null);
  assert.equal(resolveAnswerTokens('9Z', QUESTIONS), null);
});

test('buildDenyReason: kèm diễn giải khi reply là token, chỉ nguyên văn khi text tự do', () => {
  const tokenized = buildDenyReason('1A', QUESTIONS, str);
  assert.match(tokenized, /^Người dùng trả lời qua Telegram: "1A"\n\(Diễn giải/);
  const free = buildDenyReason('thôi dùng SQLite', QUESTIONS, str);
  assert.equal(free, 'Người dùng trả lời qua Telegram: "thôi dùng SQLite"');
});

test('denyOutput: JSON đúng schema PreToolUse deny', () => {
  const out = JSON.parse(denyOutput('lý do'));
  assert.deepEqual(out, {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'lý do',
    },
  });
});

test('isLocalKeyword', () => {
  assert.ok(isLocalKeyword('local'));
  assert.ok(isLocalKeyword('  LOCAL  '));
  assert.ok(!isLocalKeyword('locally'));
  assert.ok(!isLocalKeyword('1A'));
});

test('pendingKey: ổn định theo (session, câu hỏi), khác session → khác key', () => {
  const a = pendingKey('s1', QUESTIONS);
  assert.equal(a, pendingKey('s1', QUESTIONS));
  assert.notEqual(a, pendingKey('s2', QUESTIONS));
  assert.notEqual(a, pendingKey('s1', [QUESTIONS[0]]));
});

// ---------------------------------------------------------------------------
// event ask-done — trích đáp án từ tool_response (shape phòng thủ)
// ---------------------------------------------------------------------------

test('extractLocalAnswers: map answers, string, shape lạ', () => {
  assert.equal(extractLocalAnswers({ answers: { 'Chọn database?': 'Postgres' } }), '"Postgres"');
  assert.equal(extractLocalAnswers({ 'Q1?': 'A', 'Q2?': 'B' }), '"A", "B"');
  assert.equal(extractLocalAnswers('Postgres'), 'Postgres');
  assert.equal(extractLocalAnswers(null), '');
  assert.match(extractLocalAnswers({ weird: 1 }), /weird/); // fallback stringify
});

// ---------------------------------------------------------------------------
// state dir: lock takeover + GC
// ---------------------------------------------------------------------------

test('tryAcquireLock: lock mới không cướp được, lock stale (>60s) thì takeover', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccnt-'));
  const lock = join(dir, 'poll.lock');
  assert.ok(tryAcquireLock(lock), 'lấy được lock lần đầu');
  assert.ok(!tryAcquireLock(lock), 'lock đang sống — không cướp');
  const past = new Date(Date.now() - 120_000);
  utimesSync(lock, past, past); // giả lập poller chết (heartbeat cũ 2 phút)
  assert.ok(tryAcquireLock(lock), 'stale → takeover');
});

test('gcStateDir: xoá pending/inbox quá 24h, giữ file mới', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccnt-'));
  for (const sub of ['pending', 'inbox']) mkdirSync(join(dir, sub), { recursive: true });
  const oldFile = join(dir, 'pending', 'old.json');
  const newFile = join(dir, 'pending', 'new.json');
  writeFileSync(oldFile, '{}');
  writeFileSync(newFile, '{}');
  const past = new Date(Date.now() - 25 * 3600 * 1000);
  utimesSync(oldFile, past, past);
  gcStateDir(dir);
  assert.ok(!existsSync(oldFile));
  assert.ok(existsSync(newFile));
});

// ---------------------------------------------------------------------------
// loadConfig: default + env override + clamp timeout
// ---------------------------------------------------------------------------

test('loadConfig: đọc file, env override, clamp remoteAskTimeoutSec dưới trần 1770', () => {
  const home = mkdtempSync(join(tmpdir(), 'ccnt-home-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(
    join(home, '.claude', 'cc-notify-telegram.json'),
    JSON.stringify({ botToken: 'T', chatId: '-1', remote: true, remoteAskTimeoutSec: 99999 })
  );
  const cfg = loadConfig({ home, env: {} });
  assert.equal(cfg.botToken, 'T');
  assert.equal(cfg.remote, true);
  assert.equal(cfg.remoteAskTimeoutSec, 1770);

  const overridden = loadConfig({ home, env: { TELEGRAM_CHAT_ID: '-42', CC_NOTIFY_REMOTE: 'off' } });
  assert.equal(overridden.chatId, '-42');
  assert.equal(overridden.remote, false);

  const empty = loadConfig({ home: mkdtempSync(join(tmpdir(), 'ccnt-e-')), env: {} });
  assert.equal(empty.botToken, '');
  assert.equal(empty.remoteAskTimeoutSec, 900);
});
