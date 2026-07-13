#!/usr/bin/env node
// cc-notify-telegram — Claude Code hook runtime (self-contained, zero-dependency).
//
// Một file duy nhất được installer copy vào ~/.claude/hooks/, phục vụ 4 hook event
// (arg đầu tiên quyết định event):
//   stop      Stop hook            → báo Telegram khi tin cuối chứa marker CC_NOTIFY_DONE/ESCALATE
//   ask       PreToolUse hook      → Remote Ask: gửi AskUserQuestion qua Telegram, chờ reply
//   ask-done  PostToolUse hook     → chốt sổ tin câu hỏi khi user trả lời tại máy
//   notify    Notification hook    → forward "cần permission / đang chờ input" khi remote bật
//
// Nguyên tắc an toàn: LUÔN exit 0, lỗi gì cũng im lặng — không bao giờ chặn Claude Code.
// Không output gì trên stdout = hành vi mặc định (UI hiện như thường).

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Đường dẫn & config
// ---------------------------------------------------------------------------

export const MARKER_DONE = 'CC_NOTIFY_DONE';
export const MARKER_ESCALATE = 'CC_NOTIFY_ESCALATE';

const POLL_LONG_SEC = 20; // long-poll getUpdates mỗi vòng
const LOCK_STALE_MS = 60_000; // heartbeat cũ hơn ngưỡng này = poller chết → takeover
const PENDING_TTL_MS = 24 * 60 * 60 * 1000; // dọn rác file pending/inbox mồ côi
const MAX_ASK_TIMEOUT_SEC = 1770; // phải < timeout 1830s của hook entry trong settings

export function claudeDir(home = homedir()) {
  return join(home, '.claude');
}

export function stateDir(home = homedir()) {
  return join(claudeDir(home), 'cc-notify-telegram');
}

export function loadConfig({ env = process.env, home = homedir() } = {}) {
  let file = {};
  try {
    file = JSON.parse(readFileSync(join(claudeDir(home), 'cc-notify-telegram.json'), 'utf8'));
  } catch {
    // chưa cài config → mọi event tự thoát im lặng
  }
  const envRemote = env.CC_NOTIFY_REMOTE;
  const timeout = Number(file.remoteAskTimeoutSec);
  return {
    botToken: env.TELEGRAM_BOT_TOKEN || file.botToken || '',
    chatId: env.TELEGRAM_CHAT_ID || file.chatId || '',
    threadId: env.TELEGRAM_THREAD_ID || file.threadId || undefined,
    lang: file.lang === 'en' ? 'en' : 'vi',
    silent: file.silent === true,
    remote:
      envRemote != null
        ? ['1', 'true', 'on'].includes(String(envRemote).toLowerCase())
        : file.remote === true,
    remoteAskTimeoutSec:
      Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, MAX_ASK_TIMEOUT_SEC) : 900,
  };
}

export function hasCredentials(cfg) {
  return Boolean(cfg.botToken && cfg.chatId);
}

// ---------------------------------------------------------------------------
// Chuỗi tin nhắn (vi/en)
// ---------------------------------------------------------------------------

const STRINGS = {
  vi: {
    doneFallback: '— đã hoàn thành công việc',
    donePlain: 'đã hoàn thành công việc',
    escalateFallback: '🛑 Cần bạn xử lý',
    escalateSuffix: (project) => `— ${project}: mở Claude Code xem chi tiết`,
    askHeader: (tag) => `❓ ${tag} Claude đang hỏi:`,
    askFooter:
      '↩️ Reply tin này để trả lời (vd: "1A" / "1A, 2B" / mô tả tự do).\nReply "local" nếu muốn trả lời tại máy.',
    askMulti: '(chọn được nhiều)',
    answeredTg: (text) => `✅ Đã trả lời qua Telegram: "${text}"`,
    movedLocal: '🖥 Câu hỏi chuyển về máy — đang chờ tại terminal…',
    timedOut: '⏰ Hết giờ chờ trên Telegram — câu hỏi đang chờ tại máy.',
    answeredLocal: (text) => `🖥✅ Đã trả lời tại máy: ${text}`,
    closedUnanswered: '⛔ Câu hỏi đã đóng (lượt làm việc kết thúc, không có trả lời).',
    replyHint: (n) => `🔁 Đang có ${n} câu hỏi chờ — hãy REPLY vào đúng tin câu hỏi muốn trả lời.`,
    testMessage: '✅ Test từ cc-notify-telegram',
    answerPrefix: (text) => `Người dùng trả lời qua Telegram: "${text}"`,
    answerResolved: (parts) => `(Diễn giải lựa chọn: ${parts.join('; ')})`,
    notifyPrefix: '🔔',
  },
  en: {
    doneFallback: '— task completed',
    donePlain: 'task completed',
    escalateFallback: '🛑 Needs your attention',
    escalateSuffix: (project) => `— ${project}: open Claude Code for details`,
    askHeader: (tag) => `❓ ${tag} Claude is asking:`,
    askFooter:
      '↩️ Reply to this message to answer (e.g. "1A" / "1A, 2B" / free text).\nReply "local" to answer at the machine.',
    askMulti: '(multiple choices allowed)',
    answeredTg: (text) => `✅ Answered via Telegram: "${text}"`,
    movedLocal: '🖥 Question moved to the machine — waiting at the terminal…',
    timedOut: '⏰ Telegram wait timed out — question is now waiting at the machine.',
    answeredLocal: (text) => `🖥✅ Answered at the machine: ${text}`,
    closedUnanswered: '⛔ Question closed (turn ended without an answer).',
    replyHint: (n) => `🔁 ${n} questions are pending — please REPLY to the exact question message.`,
    testMessage: '✅ Test from cc-notify-telegram',
    answerPrefix: (text) => `User answered via Telegram: "${text}"`,
    answerResolved: (parts) => `(Interpreted choices: ${parts.join('; ')})`,
    notifyPrefix: '🔔',
  },
};

export function strings(cfg) {
  return STRINGS[cfg.lang] || STRINGS.vi;
}

// ---------------------------------------------------------------------------
// Telegram API client (fetch built-in, timeout 10s, cho phép inject để test)
// ---------------------------------------------------------------------------

export function makeTelegram(cfg, fetchFn = fetch) {
  const base = `https://api.telegram.org/bot${cfg.botToken}`;
  async function call(method, params, timeoutMs = 10_000) {
    const res = await fetchFn(`${base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`telegram ${method} failed: ${data.description || res.status}`);
    return data.result;
  }
  return {
    sendMessage: (text, extra = {}) =>
      call('sendMessage', {
        chat_id: cfg.chatId,
        text,
        ...(cfg.silent ? { disable_notification: true } : {}),
        ...(cfg.threadId ? { message_thread_id: Number(cfg.threadId) } : {}),
        ...extra,
      }),
    editMessageText: (messageId, text) =>
      call('editMessageText', { chat_id: cfg.chatId, message_id: messageId, text }),
    getUpdates: (params) =>
      call('getUpdates', { allowed_updates: ['message'], ...params }, ((params.timeout || 0) + 10) * 1000),
    getMe: () => call('getMe', {}),
  };
}

// ---------------------------------------------------------------------------
// EVENT stop — port 1:1 từ notify-telegram.sh (bash + jq)
// ---------------------------------------------------------------------------

export function parseJsonl(lines) {
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // dòng hỏng (file đang được ghi dở) → bỏ qua như jq -s vẫn chạy tiếp
    }
  }
  return out;
}

// Tin nhắn text CUỐI của assistant trong 80 dòng cuối transcript (bỏ sidechain/subagent).
export function lastAssistantText(lines) {
  const texts = [];
  for (const entry of parseJsonl(lines.slice(-80))) {
    if (entry?.type !== 'assistant' || entry.isSidechain === true) continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    }
  }
  return texts.at(-1) ?? '';
}

// "Tên session" = yêu cầu ĐẦU TIÊN của user trong 200 dòng đầu, làm sạch tag, cắt 60 codepoint.
export function firstUserSnippet(lines) {
  const candidates = [];
  for (const entry of parseJsonl(lines.slice(0, 200))) {
    if (entry?.type !== 'user' || entry.isSidechain === true || entry.isMeta === true) continue;
    const content = entry.message?.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join(' ');
    }
    if (text) candidates.push(text);
  }
  const raw = candidates[0] ?? '';
  const cleaned = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const cps = Array.from(cleaned);
  return cps.length > 60 ? cps.slice(0, 60).join('') + '…' : cleaned;
}

// Tóm tắt nhúng trong marker: <!-- CC_NOTIFY_DONE: ý 1 | ý 2 --> (dòng đầu tiên khớp).
export function extractDoneSummary(text) {
  for (const line of text.split('\n')) {
    const m = line.match(new RegExp(`.*${MARKER_DONE}:\\s*(.*\\S)\\s*-->.*`));
    if (m) return m[1];
  }
  return '';
}

export function summaryToBullets(summary) {
  return summary
    .split('|')
    .map((part) => `• ${part.trim()}`)
    .join('\n');
}

// Fallback khi marker không kèm tóm tắt: forward tin cuối, gỡ marker/comment, trim dòng trống.
export function fallbackBody(text) {
  let lines = text
    .split('\n')
    .filter((l) => !l.includes(MARKER_DONE) && !l.includes(MARKER_ESCALATE))
    .map((l) => l.replace(/<!--[^>]*-->/g, ''));
  let start = -1;
  let end = -1;
  lines.forEach((l, i) => {
    if (/\S/.test(l)) {
      if (start === -1) start = i;
      end = i;
    }
  });
  if (start === -1) return '';
  let body = lines.slice(start, end + 1).join('\n');
  const cps = Array.from(body);
  if (cps.length > 3800) body = cps.slice(0, 3800).join('') + '…';
  return body;
}

export function extractEscalateLine(text, str) {
  const line = text.split('\n').find((l) => l.includes('🛑'));
  const cleaned = line ? line.replace(/<!--.*-->/g, '').trim() : '';
  return cleaned || str.escalateFallback;
}

// Quyết định nội dung gửi cho event stop; trả null nếu không có marker (không gửi gì).
export function buildStopMessage({ last, project, snippet, str }) {
  if (last.includes(MARKER_ESCALATE)) {
    return `${extractEscalateLine(last, str)}\n${str.escalateSuffix(project)}`;
  }
  if (!last.includes(MARKER_DONE)) return null;

  const summary = extractDoneSummary(last);
  if (summary) return `✅ ${project}\n${summaryToBullets(summary)}`;

  const body = fallbackBody(last);
  if (body) return `✅ ${project}\n${body}`;
  if (snippet) return `✅ ${project} · "${snippet}"\n${str.doneFallback}`;
  return `✅ ${project} — ${str.donePlain}`;
}

export function projectName(payload, env = process.env) {
  return basename(env.CLAUDE_PROJECT_DIR || payload.cwd || '') || 'claude';
}

async function runStop(payload, cfg, tg, env) {
  const transcript = payload.transcript_path;
  if (!transcript || !existsSync(transcript)) return;
  const lines = readFileSync(transcript, 'utf8').split('\n').filter(Boolean);
  const str = strings(cfg);
  const message = buildStopMessage({
    last: lastAssistantText(lines),
    project: projectName(payload, env),
    snippet: firstUserSnippet(lines),
    str,
  });
  // Quét pending mồ côi của session này (user Esc câu hỏi → PostToolUse không bắn).
  await sweepSessionPending(payload.session_id, cfg, tg).catch(() => {});
  if (message) await tg.sendMessage(message);
}

// ---------------------------------------------------------------------------
// EVENT ask — Remote Ask 2 chiều
// ---------------------------------------------------------------------------

export function pendingKey(sessionId, questions) {
  const texts = (questions || []).map((q) => q?.question || '');
  return createHash('sha1')
    .update(`${sessionId || ''}\n${JSON.stringify(texts)}`)
    .digest('hex')
    .slice(0, 16);
}

function ensureStateDirs(home) {
  const dir = stateDir(home);
  for (const sub of ['pending', 'inbox']) mkdirSync(join(dir, sub), { recursive: true });
  return dir;
}

export function buildAskMessage(questions, { project, suffix, str }) {
  const tag = suffix ? `[${project} · ${suffix}]` : `[${project}]`;
  const out = [str.askHeader(tag), ''];
  questions.forEach((q, qi) => {
    const multi = q.multiSelect ? ` ${str.askMulti}` : '';
    out.push(`${qi + 1}. ${q.question}${multi}`);
    (q.options || []).forEach((opt, oi) => {
      const letter = String.fromCharCode(65 + oi);
      let desc = opt.description ? ` — ${opt.description}` : '';
      const cps = Array.from(desc);
      if (cps.length > 80) desc = cps.slice(0, 80).join('') + '…';
      out.push(`   ${letter}. ${opt.label}${desc}`);
    });
  });
  out.push('', str.askFooter);
  let text = out.join('\n');
  const cps = Array.from(text);
  if (cps.length > 4000) text = cps.slice(0, 4000).join('') + '…';
  return text;
}

export function isLocalKeyword(text) {
  return /^\s*local\s*$/i.test(text || '');
}

// Diễn giải reply dạng token ("1A", "2b", "A" khi 1 câu) thành nhãn option; text tự do → null.
export function resolveAnswerTokens(raw, questions) {
  const parts = (raw || '').trim().split(/[\s,;]+/).filter(Boolean);
  if (!parts.length) return null;
  const resolved = [];
  for (const part of parts) {
    const m = part.match(/^(\d*)([A-Za-z])$/);
    if (!m) return null;
    const qIndex = m[1] ? Number(m[1]) - 1 : questions.length === 1 ? 0 : -1;
    const oIndex = m[2].toUpperCase().charCodeAt(0) - 65;
    const question = questions[qIndex];
    const option = question?.options?.[oIndex];
    if (!question || !option) return null;
    resolved.push(`Câu ${qIndex + 1} "${question.question}" → "${option.label}"`);
  }
  return resolved;
}

export function buildDenyReason(replyText, questions, str) {
  const lines = [str.answerPrefix(replyText)];
  const resolved = resolveAnswerTokens(replyText, questions);
  if (resolved) lines.push(str.answerResolved(resolved));
  return lines.join('\n');
}

export function denyOutput(reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

// Phân loại một update Telegram so với các câu hỏi đang chờ.
// ctx: { chatId, pending: [{messageId, sentAt(ms)}] }
// Group: BẮT BUỘC reply đúng tin câu hỏi. Private: 1 câu chờ thì tin trần cũng tính
// (nhưng phải MỚI hơn lúc gửi câu hỏi — chặn backlog getUpdates cũ), nhiều câu → nhắc reply.
export function classifyUpdate(update, ctx) {
  const msg = update?.message;
  if (!msg || typeof msg.text !== 'string') return { kind: 'ignore' };
  if (String(msg.chat?.id) !== String(ctx.chatId)) return { kind: 'ignore' };
  const pendingIds = ctx.pending.map((p) => p.messageId);
  const replyTo = msg.reply_to_message?.message_id;
  if (replyTo != null) {
    if (!pendingIds.includes(replyTo)) return { kind: 'ignore' };
    return { kind: 'reply', messageId: replyTo, text: msg.text.trim() };
  }
  if (msg.chat?.type === 'private') {
    if (ctx.pending.length === 1) {
      const freshEnough = (msg.date || 0) * 1000 >= ctx.pending[0].sentAt - 2000;
      if (!freshEnough) return { kind: 'ignore' };
      return { kind: 'reply', messageId: ctx.pending[0].messageId, text: msg.text.trim() };
    }
    if (ctx.pending.length > 1) return { kind: 'need-reply-hint' };
  }
  return { kind: 'ignore' };
}

// --- pending/inbox/lock: phối hợp nhiều session qua filesystem ---

function pendingPath(dir, key) {
  return join(dir, 'pending', `${key}.json`);
}

function inboxPath(dir, messageId) {
  return join(dir, 'inbox', `${messageId}.json`);
}

export function listPending(dir) {
  const out = [];
  let files = [];
  try {
    files = readdirSync(join(dir, 'pending'));
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      out.push({ file: join(dir, 'pending', f), ...JSON.parse(readFileSync(join(dir, 'pending', f), 'utf8')) });
    } catch {
      // file dở dang → bỏ qua vòng này
    }
  }
  return out;
}

export function tryAcquireLock(lockFile) {
  try {
    writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    try {
      const age = Date.now() - statSync(lockFile).mtimeMs;
      if (age > LOCK_STALE_MS) {
        unlinkSync(lockFile);
        writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
        return true;
      }
    } catch {
      // race với process khác → thua, thử lại vòng sau
    }
    return false;
  }
}

function touchLock(lockFile) {
  try {
    const now = new Date();
    utimesSync(lockFile, now, now);
  } catch {
    // mất lock file → vòng sau acquire lại
  }
}

function releaseLock(lockFile, held) {
  if (!held) return;
  try {
    unlinkSync(lockFile);
  } catch {
    // đã bị takeover — không sao
  }
}

function readOffset(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'offset.json'), 'utf8')).offset || 0;
  } catch {
    return 0;
  }
}

function writeOffset(dir, offset) {
  try {
    writeFileSync(join(dir, 'offset.json'), JSON.stringify({ offset }));
  } catch {
    // mất offset chỉ tốn thêm 1 lần đọc lại backlog
  }
}

// Dọn file pending/inbox quá hạn (session chết không kịp dọn).
export function gcStateDir(dir, now = Date.now()) {
  for (const sub of ['pending', 'inbox']) {
    let files = [];
    try {
      files = readdirSync(join(dir, sub));
    } catch {
      continue;
    }
    for (const f of files) {
      const p = join(dir, sub, f);
      try {
        if (now - statSync(p).mtimeMs > PENDING_TTL_MS) unlinkSync(p);
      } catch {
        // đã bị xoá bởi process khác
      }
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Vòng chờ trả lời: poller trung tâm (giữ lock) long-poll getUpdates và phân phát
// reply vào inbox theo message_id; session không giữ lock chỉ watch inbox của mình.
async function waitForReply({ tg, cfg, dir, ownMessageId, deadline, env, home }) {
  const lockFile = join(dir, 'poll.lock');
  let holdingLock = false;
  let lastHintAt = 0;
  try {
    while (Date.now() < deadline) {
      // remote off giữa chừng (user về máy) → nhả câu hỏi về UI local trong vài giây
      if (!loadConfig({ env, home }).remote) return { type: 'remote-off' };

      // 1) inbox của mình có sẵn câu trả lời (poller khác phân phát)?
      const inboxFile = inboxPath(dir, ownMessageId);
      if (existsSync(inboxFile)) {
        let msg = null;
        try {
          msg = JSON.parse(readFileSync(inboxFile, 'utf8'));
          unlinkSync(inboxFile);
        } catch {
          // đọc dở → vòng sau
        }
        if (msg?.text != null) return { type: 'reply', text: msg.text };
      }

      // 2) trở thành poller trung tâm nếu chưa ai giữ lock
      if (!holdingLock) holdingLock = tryAcquireLock(lockFile);
      if (!holdingLock) {
        await sleep(700);
        continue;
      }

      touchLock(lockFile);
      let updates = [];
      try {
        // long-poll không dài quá thời gian còn lại — để timeout nhả đúng hạn
        const remainSec = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
        updates = await tg.getUpdates({ offset: readOffset(dir), timeout: Math.min(POLL_LONG_SEC, remainSec) });
      } catch {
        await sleep(2000); // mạng lỗi / 409 conflict tạm thời → thử lại
        continue;
      }
      if (updates.length) writeOffset(dir, updates.at(-1).update_id + 1);

      const pending = listPending(dir);
      for (const update of updates) {
        const verdict = classifyUpdate(update, { chatId: cfg.chatId, pending });
        if (verdict.kind === 'reply') {
          if (verdict.messageId === ownMessageId) return { type: 'reply', text: verdict.text };
          try {
            writeFileSync(inboxPath(dir, verdict.messageId), JSON.stringify({ text: verdict.text }));
          } catch {
            // session kia sẽ timeout → chấp nhận
          }
        } else if (verdict.kind === 'need-reply-hint' && Date.now() - lastHintAt > 60_000) {
          lastHintAt = Date.now();
          await tg.sendMessage(strings(cfg).replyHint(pending.length)).catch(() => {});
        }
      }
    }
    return { type: 'timeout' };
  } finally {
    releaseLock(lockFile, holdingLock);
  }
}

async function runAsk(payload, cfg, tg, env, home = homedir()) {
  if (!cfg.remote) return null;
  const questions = payload.tool_input?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;

  const dir = ensureStateDirs(home);
  gcStateDir(dir);
  const str = strings(cfg);
  const text = buildAskMessage(questions, {
    project: projectName(payload, env),
    suffix: String(payload.session_id || '').slice(-4),
    str,
  });

  let sent;
  try {
    sent = await tg.sendMessage(text);
  } catch {
    return null; // Telegram lỗi → UI local như thường
  }
  if (!sent?.message_id) return null;

  const key = pendingKey(payload.session_id, questions);
  writeFileSync(
    pendingPath(dir, key),
    JSON.stringify({ messageId: sent.message_id, sessionId: payload.session_id || '', sentAt: Date.now() })
  );

  const deadline = Date.now() + cfg.remoteAskTimeoutSec * 1000;
  const outcome = await waitForReply({ tg, cfg, dir, ownMessageId: sent.message_id, deadline, env, home });

  if (outcome.type === 'reply' && !isLocalKeyword(outcome.text)) {
    await tg.editMessageText(sent.message_id, str.answeredTg(outcome.text)).catch(() => {});
    try {
      unlinkSync(pendingPath(dir, key));
    } catch {
      // đã bị GC
    }
    return denyOutput(buildDenyReason(outcome.text, questions, str));
  }

  // local / remote-off / timeout → giữ pending cho ask-done chốt sổ khi user bấm tại máy
  const note =
    outcome.type === 'timeout' ? str.timedOut : str.movedLocal;
  await tg.editMessageText(sent.message_id, `${text}\n\n${note}`).catch(() => {});
  return null;
}

// ---------------------------------------------------------------------------
// EVENT ask-done — PostToolUse: chốt sổ tin Telegram khi trả lời tại máy
// ---------------------------------------------------------------------------

// tool_response của AskUserQuestion có thể đổi shape theo version → trích phòng thủ.
export function extractLocalAnswers(toolResponse) {
  const answers = toolResponse?.answers ?? toolResponse;
  if (answers && typeof answers === 'object' && !Array.isArray(answers)) {
    const parts = Object.entries(answers)
      .filter(([, v]) => typeof v === 'string' && v)
      .map(([q, v]) => `"${v}"`);
    if (parts.length) return parts.join(', ');
  }
  if (typeof answers === 'string' && answers) return answers;
  try {
    const s = JSON.stringify(toolResponse);
    if (s && s !== '{}' && s !== 'null') return Array.from(s).slice(0, 200).join('');
  } catch {
    // không stringify được
  }
  return '';
}

async function runAskDone(payload, cfg, tg, home = homedir()) {
  const questions = payload.tool_input?.questions;
  if (!Array.isArray(questions)) return;
  const dir = stateDir(home);
  const file = pendingPath(dir, pendingKey(payload.session_id, questions));
  if (!existsSync(file)) return; // remote off, hoặc đã trả lời qua Telegram
  let pending = null;
  try {
    pending = JSON.parse(readFileSync(file, 'utf8'));
    unlinkSync(file);
  } catch {
    return;
  }
  const str = strings(cfg);
  const answers = extractLocalAnswers(payload.tool_response);
  await tg.editMessageText(pending.messageId, str.answeredLocal(answers || '…'));
}

// Stop sweep: câu hỏi bị Esc (PostToolUse không bắn) → đóng tin cho khỏi treo mồ côi.
async function sweepSessionPending(sessionId, cfg, tg, home = homedir()) {
  if (!sessionId) return;
  const dir = stateDir(home);
  for (const p of listPending(dir)) {
    if (p.sessionId !== sessionId) continue;
    try {
      unlinkSync(p.file);
    } catch {
      continue; // process khác vừa xử lý
    }
    await tg.editMessageText(p.messageId, strings(cfg).closedUnanswered).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// EVENT notify — forward Notification (permission / idle) khi remote bật
// ---------------------------------------------------------------------------

async function runNotify(payload, cfg, tg, env) {
  if (!cfg.remote) return;
  const message = payload.message;
  if (!message || typeof message !== 'string') return;
  await tg.sendMessage(`${strings(cfg).notifyPrefix} [${projectName(payload, env)}] ${message}`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main() {
  const args = process.argv.slice(2);
  const cfg = loadConfig();

  if (args.includes('--test')) {
    if (hasCredentials(cfg)) await makeTelegram(cfg).sendMessage(strings(cfg).testMessage);
    return null;
  }
  if (!hasCredentials(cfg)) return null;

  const event = args[0] || 'stop';
  let payload = {};
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return null;
  }
  const tg = makeTelegram(cfg);

  if (event === 'stop') return runStop(payload, cfg, tg, process.env).then(() => null);
  if (event === 'ask') return runAsk(payload, cfg, tg, process.env);
  if (event === 'ask-done') return runAskDone(payload, cfg, tg).then(() => null);
  if (event === 'notify') return runNotify(payload, cfg, tg, process.env).then(() => null);
  return null;
}

// realpath để guard vẫn đúng nếu file/thư mục được symlink (cùng lý do với bin/cli.mjs).
let isMain = false;
try {
  isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
} catch {
  isMain = false;
}
if (isMain) {
  main()
    .then((output) => {
      if (output) process.stdout.write(output + '\n');
      process.exit(0);
    })
    .catch(() => process.exit(0));
}
