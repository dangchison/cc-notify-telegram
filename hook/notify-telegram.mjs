#!/usr/bin/env node
// cc-notify-telegram — Claude Code hook runtime (self-contained, zero-dependency).
//
// Một file duy nhất được installer copy vào ~/.claude/hooks/, phục vụ 5 hook event
// (arg đầu tiên quyết định event):
//   stop      Stop hook              → báo Telegram khi tin cuối chứa marker CC_NOTIFY_DONE/ESCALATE
//   ask       PreToolUse hook        → Remote Ask: gửi AskUserQuestion qua Telegram, chờ reply
//   ask-done  PostToolUse hook       → chốt sổ tin câu hỏi khi user trả lời tại máy
//   notify    Notification hook      → forward "cần permission / đang chờ input" khi remote bật
//   perm      PermissionRequest hook → Remote Permission: gửi yêu cầu quyền kèm nút bấm, chờ chọn
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
export const AI_MARKER_DONE = 'AI_NOTIFY_DONE';
export const AI_MARKER_ESCALATE = 'AI_NOTIFY_ESCALATE';
export const PROVIDERS = ['claude', 'codex', 'antigravity'];

const PROVIDER_DISPLAY = {
  claude: 'Claude',
  codex: 'Codex',
  antigravity: 'Antigravity',
};

const POLL_LONG_SEC = 20; // long-poll getUpdates mỗi vòng
const LOCK_STALE_MS = 60_000; // heartbeat cũ hơn ngưỡng này = poller chết → takeover
const PENDING_TTL_MS = 24 * 60 * 60 * 1000; // dọn rác file pending/inbox mồ côi
const MAX_ASK_TIMEOUT_SEC = 1770; // phải < timeout 1830s của hook entry trong settings
const MAX_SESSION_ALLOW_MIN = 8 * 60; // trần "cho phép tất cả trong session" — không để mở vô hạn

export function claudeDir(home = homedir()) {
  return join(home, '.claude');
}

export function configDir(home = homedir()) {
  return join(home, '.config', 'ai-notify-telegram');
}

export function configFile(home = homedir()) {
  return join(configDir(home), 'config.json');
}

export function legacyConfigFile(home = homedir()) {
  return join(claudeDir(home), 'cc-notify-telegram.json');
}

export function stateDir(home = homedir()) {
  return join(configDir(home), 'state');
}

export function legacyStateDir(home = homedir()) {
  return join(claudeDir(home), 'cc-notify-telegram');
}

export function normalizeProviderId(value) {
  return PROVIDERS.includes(value) ? value : 'claude';
}

export function providerDisplayName(providerId = 'claude') {
  return PROVIDER_DISPLAY[normalizeProviderId(providerId)];
}

function boolOrDefault(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeProviderMap(value, fallback = false) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(PROVIDERS.map((id) => [id, boolOrDefault(input[id], fallback)]));
}

function normalizeToggle(value, fallback = false, { legacy = false } = {}) {
  if (typeof value === 'boolean') {
    if (legacy) return { global: value, providers: { claude: value, codex: false, antigravity: false } };
    return { global: value, providers: normalizeProviderMap(null, value) };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const global = boolOrDefault(value.global, fallback);
    return { global, providers: normalizeProviderMap(value.providers, global) };
  }
  return { global: fallback, providers: normalizeProviderMap(null, fallback) };
}

function normalizeEnabledProviders(value) {
  if (!Array.isArray(value)) return ['claude'];
  const ids = [...new Set(value.filter((id) => PROVIDERS.includes(id)))];
  return ids.length ? ids : ['claude'];
}

function readConfigFile(home) {
  try {
    return { data: JSON.parse(readFileSync(configFile(home), 'utf8')), legacy: false };
  } catch {
    try {
      return { data: JSON.parse(readFileSync(legacyConfigFile(home), 'utf8')), legacy: true };
    } catch {
      return { data: {}, legacy: false };
    }
  }
}

export function isProviderEnabled(cfg, providerId = 'claude') {
  return (cfg.enabledProviders || ['claude']).includes(normalizeProviderId(providerId));
}

export function isRemoteEnabled(cfg, providerId = 'claude') {
  const id = normalizeProviderId(providerId);
  if (!isProviderEnabled(cfg, id)) return false;
  const toggle = cfg.remoteConfig || normalizeToggle(cfg.remote, false);
  return toggle.global === true && toggle.providers[id] === true;
}

export function isRemotePermEnabled(cfg, providerId = 'claude') {
  const id = normalizeProviderId(providerId);
  if (!isProviderEnabled(cfg, id)) return false;
  const toggle = cfg.remotePermissionConfig || normalizeToggle(cfg.remotePermission, false);
  return toggle.global === true && toggle.providers[id] === true;
}

export function loadConfig({ env = process.env, home = homedir(), providerId = 'claude' } = {}) {
  const source = readConfigFile(home);
  const file = source.data;
  const timeout = Number(file.remoteAskTimeoutSec);
  const ttl = Number(file.sessionAllowTtlMin);
  const envBool = (envValue, fallback) =>
    envValue != null ? ['1', 'true', 'on'].includes(String(envValue).toLowerCase()) : fallback;
  const remoteConfig = normalizeToggle(file.remote, false, { legacy: source.legacy });
  const remotePermissionConfig = normalizeToggle(file.remotePermission, false, { legacy: source.legacy });
  if (env.CC_NOTIFY_REMOTE != null || env.AI_NOTIFY_REMOTE != null) {
    const enabled = envBool(env.AI_NOTIFY_REMOTE ?? env.CC_NOTIFY_REMOTE, remoteConfig.global);
    remoteConfig.global = enabled;
    remoteConfig.providers = normalizeProviderMap(null, enabled);
  }
  if (env.CC_NOTIFY_REMOTE_PERM != null || env.AI_NOTIFY_REMOTE_PERM != null) {
    const enabled = envBool(env.AI_NOTIFY_REMOTE_PERM ?? env.CC_NOTIFY_REMOTE_PERM, remotePermissionConfig.global);
    remotePermissionConfig.global = enabled;
    remotePermissionConfig.providers = normalizeProviderMap(null, enabled);
  }
  const cfg = {
    botToken: env.TELEGRAM_BOT_TOKEN || file.botToken || '',
    chatId: env.TELEGRAM_CHAT_ID || file.chatId || '',
    threadId: env.TELEGRAM_THREAD_ID || file.threadId || undefined,
    providerThreads: file.providerThreads && typeof file.providerThreads === 'object' ? file.providerThreads : {},
    enabledProviders: normalizeEnabledProviders(file.enabledProviders),
    lang: file.lang === 'en' ? 'en' : 'vi',
    silent: file.silent === true,
    remoteConfig,
    remotePermissionConfig,
    // So sánh dạng chuỗi: config có thể ghi số hoặc chuỗi, from.id của Telegram luôn là số.
    allowedUserIds: (Array.isArray(file.allowedUserIds) ? file.allowedUserIds : [])
      .map((id) => String(id).trim())
      .filter(Boolean),
    sessionAllowTtlMin: Number.isFinite(ttl) && ttl > 0 ? Math.min(ttl, MAX_SESSION_ALLOW_MIN) : 30,
    remoteAskTimeoutSec:
      Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, MAX_ASK_TIMEOUT_SEC) : 900,
  };
  cfg.remote = isRemoteEnabled(cfg, providerId);
  cfg.remotePermission = isRemotePermEnabled(cfg, providerId);
  return cfg;
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
    escalateSuffix: (project, provider = 'Claude Code') => `— ${project}: mở ${provider} xem chi tiết`,
    askHeader: (tag, provider = 'Claude') => `❓ ${tag} ${provider} đang hỏi:`,
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
    permHeader: (tag, provider = 'Claude') => `🔐 ${tag} ${provider} xin quyền dùng:`,
    permFooter: '👇 Chọn bên dưới — chỉ tài khoản trong allowlist mới bấm được.',
    permNoDetail: '(không có chi tiết)',
    btnAllow: '✅ Cho phép',
    btnDeny: '⛔ Từ chối',
    btnAllowSession: (min) => `✅ Cho phép tất cả (${min}′)`,
    btnLocal: '🖥 Để máy xử lý',
    permAllowed: (who) => `✅ Đã cho phép${who}`,
    permAllowedSession: (who, until) =>
      `✅ Đã cho phép TẤT CẢ trong session này đến ${until}${who}`,
    permDenied: (who) => `⛔ Đã từ chối${who}`,
    permDenyReason: 'Người dùng đã TỪ CHỐI yêu cầu quyền này qua Telegram.',
    permTimedOut: '⏰ Hết giờ chờ trên Telegram — yêu cầu quyền đang chờ tại máy.',
    permMovedLocal: '🖥 Yêu cầu quyền chuyển về máy — đang chờ tại terminal…',
    permSendFailed: '⚠️ Không gửi được đầy đủ nội dung — yêu cầu quyền chuyển về máy.',
    permClosed: '⛔ Yêu cầu quyền đã đóng (lượt làm việc kết thúc).',
    permNoRight: 'Bạn không có quyền duyệt yêu cầu này.',
    planNotice: (tag, provider = 'Claude Code') =>
      `📋 ${tag} ${provider} có plan cần bạn duyệt — mở ${provider} để đọc và chọn (Accept / Revise / Reject).`,
  },
  en: {
    doneFallback: '— task completed',
    donePlain: 'task completed',
    escalateFallback: '🛑 Needs your attention',
    escalateSuffix: (project, provider = 'Claude Code') => `— ${project}: open ${provider} for details`,
    askHeader: (tag, provider = 'Claude') => `❓ ${tag} ${provider} is asking:`,
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
    permHeader: (tag, provider = 'Claude') => `🔐 ${tag} ${provider} is requesting permission to use:`,
    permFooter: '👇 Choose below — only allowlisted accounts can act.',
    permNoDetail: '(no details)',
    btnAllow: '✅ Allow',
    btnDeny: '⛔ Deny',
    btnAllowSession: (min) => `✅ Allow all (${min}′)`,
    btnLocal: '🖥 Handle at the machine',
    permAllowed: (who) => `✅ Allowed${who}`,
    permAllowedSession: (who, until) => `✅ Allowed EVERYTHING in this session until ${until}${who}`,
    permDenied: (who) => `⛔ Denied${who}`,
    permDenyReason: 'The user DENIED this permission request via Telegram.',
    permTimedOut: '⏰ Telegram wait timed out — the request is now waiting at the machine.',
    permMovedLocal: '🖥 Permission request moved to the machine — waiting at the terminal…',
    permSendFailed: '⚠️ Could not send the full request — falling back to the machine.',
    permClosed: '⛔ Permission request closed (turn ended).',
    permNoRight: 'You are not allowed to approve this request.',
    planNotice: (tag, provider = 'Claude Code') =>
      `📋 ${tag} ${provider} has a plan to review — open ${provider} to read and choose (Accept / Revise / Reject).`,
  },
};

export function strings(cfg) {
  return STRINGS[cfg.lang] || STRINGS.vi;
}

// ---------------------------------------------------------------------------
// Telegram API client (fetch built-in, timeout 30s, cho phép inject để test)
// ---------------------------------------------------------------------------

export const TELEGRAM_API_TIMEOUT_MS = 30_000;

export function makeTelegram(cfg, fetchFn = fetch) {
  const base = `https://api.telegram.org/bot${cfg.botToken}`;
  async function call(method, params, timeoutMs = TELEGRAM_API_TIMEOUT_MS) {
    let res;
    try {
      res = await fetchFn(`${base}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError' || String(err?.message || '').includes('aborted due to timeout')) {
        throw new Error(`telegram ${method} timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      throw err;
    }
    const data = await res.json();
    if (!data.ok) {
      const migrate = data.parameters?.migrate_to_chat_id;
      throw new Error(
        `telegram ${method} failed: ${data.description || res.status}${migrate ? ` (migrate_to_chat_id: ${migrate})` : ''}`
      );
    }
    return data.result;
  }
  return {
    sendMessage: async (text, extra = {}) => {
      const provider = extra.providerId ?? cfg.providerId;
      const threadId = extra.message_thread_id ?? cfg.providerThreads?.[provider] ?? cfg.threadId;
      const params = {
        chat_id: cfg.chatId,
        text,
        ...(cfg.silent ? { disable_notification: true } : {}),
        ...(threadId != null && threadId !== '' ? { message_thread_id: Number(threadId) } : {}),
        ...extra,
      };
      delete params.providerId;
      try {
        return await call('sendMessage', params);
      } catch (err) {
        if (String(err.message || '').includes('message_thread_id') && params.message_thread_id != null) {
          delete params.message_thread_id;
          return call('sendMessage', params);
        }
        throw err;
      }
    },
    // editMessageText KHÔNG kèm reply_markup ⇒ Telegram gỡ luôn bàn phím nút của tin đó,
    // nên tin đã chốt không thể bị bấm lại.
    editMessageText: (messageId, text) =>
      call('editMessageText', { chat_id: cfg.chatId, message_id: messageId, text }),
    answerCallbackQuery: (callbackQueryId, extra = {}) =>
      call('answerCallbackQuery', { callback_query_id: callbackQueryId, ...extra }),
    getUpdates: (params) =>
      call(
        'getUpdates',
        { allowed_updates: ['message', 'callback_query'], ...params },
        ((params.timeout || 0) + 10) * 1000
      ),
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
    const m = line.match(new RegExp(`.*(?:${MARKER_DONE}|${AI_MARKER_DONE}):\\s*(.*\\S)\\s*-->.*`));
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
    .filter(
      (l) =>
        !l.includes(MARKER_DONE) &&
        !l.includes(MARKER_ESCALATE) &&
        !l.includes(AI_MARKER_DONE) &&
        !l.includes(AI_MARKER_ESCALATE)
    )
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
export function buildStopMessage({ last, project, snippet, str, providerId }) {
  const provider = providerId ? providerDisplayName(providerId) : undefined;
  if (last.includes(MARKER_ESCALATE) || last.includes(AI_MARKER_ESCALATE)) {
    return `${extractEscalateLine(last, str)}\n${str.escalateSuffix(project, provider)}`;
  }
  if (!last.includes(MARKER_DONE) && !last.includes(AI_MARKER_DONE)) return null;

  const summary = extractDoneSummary(last);
  if (summary) return `✅ ${project}\n${summaryToBullets(summary)}`;

  const body = fallbackBody(last);
  if (body) return `✅ ${project}\n${body}`;
  if (snippet) return `✅ ${project} · "${snippet}"\n${str.doneFallback}`;
  return `✅ ${project} — ${str.donePlain}`;
}

export function projectName(payload, env = process.env) {
  const workspace = Array.isArray(payload.workspacePaths) ? payload.workspacePaths[0] : '';
  return basename(env.CLAUDE_PROJECT_DIR || payload.cwd || payload.cwdPath || workspace || '') || 'project';
}

export function buildTag({ providerId, project = 'project', suffix = '', sessionId = '' }) {
  const tail = suffix || (sessionId ? String(sessionId).slice(-4) : '');
  const parts = providerId ? [providerDisplayName(providerId), project] : [project];
  if (tail) parts.push(tail);
  return `[${parts.join(' · ')}]`;
}

function buildTurnCompleteMessage({ last, project, snippet, str, providerId, sessionId }) {
  const markerMessage = buildStopMessage({ last, project, snippet, str, providerId });
  if (markerMessage) return markerMessage;

  const tag = buildTag({ providerId, project, sessionId });
  const body = fallbackBody(last || '') || (snippet ? `"${snippet}"\n${str.doneFallback}` : str.donePlain);
  return `✅ ${tag}\n${body}`;
}

async function runStop(payload, cfg, tg, env) {
  const transcript = payload.transcript_path;
  const hasTranscript = transcript && existsSync(transcript);
  const lines = hasTranscript ? readFileSync(transcript, 'utf8').split('\n').filter(Boolean) : [];
  const str = strings(cfg);
  const last = payload.last_assistant_message || payload.lastAssistantMessage || lastAssistantText(lines);
  const snippet = firstUserSnippet(lines);
  const project = projectName(payload, env);
  const message =
    cfg.providerId === 'codex'
      ? buildTurnCompleteMessage({ last, project, snippet, str, providerId: cfg.providerId, sessionId: payload.session_id })
      : buildStopMessage({
          last,
          project,
          snippet,
          str,
          providerId: cfg.providerId,
        });
  // Quét pending mồ côi của session này (user Esc câu hỏi → PostToolUse không bắn).
  await sweepSessionPending(payload.session_id, cfg, tg).catch(() => {});
  if (message) await tg.sendMessage(message, { providerId: cfg.providerId });
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

const STATE_SUBDIRS = ['pending', 'inbox', 'session-allow'];

function ensureStateDirs(home) {
  const dir = stateDir(home);
  for (const sub of STATE_SUBDIRS) mkdirSync(join(dir, sub), { recursive: true });
  return dir;
}

// Full câu hỏi + FULL nhãn/mô tả mọi lựa chọn — KHÔNG cắt (chunkMessage lo phần dài).
export function buildAskMessage(questions, { project, suffix, str, providerId }) {
  const tag = buildTag({ providerId, project, suffix });
  const out = [str.askHeader(tag, providerId ? providerDisplayName(providerId) : undefined), ''];
  questions.forEach((q, qi) => {
    const multi = q.multiSelect ? ` ${str.askMulti}` : '';
    out.push(`${qi + 1}. ${q.question}${multi}`);
    (q.options || []).forEach((opt, oi) => {
      const letter = String.fromCharCode(65 + oi);
      const desc = opt.description ? ` — ${opt.description}` : '';
      out.push(`   ${letter}. ${opt.label}${desc}`);
    });
    out.push(''); // dòng trống ngăn cách giữa các câu cho dễ đọc
  });
  out.push(str.askFooter);
  return out.join('\n');
}

// Telegram giới hạn 4096 ký tự/tin. Câu hỏi dài → tách theo ranh giới dòng thành nhiều tin
// (mỗi tin ≤ limit); dòng đơn siêu dài thì hard-split theo codepoint. KHÔNG bao giờ cắt mất chữ.
export function chunkMessage(text, limit = 4000) {
  const chunks = [];
  let cur = '';
  const flush = () => {
    if (cur) chunks.push(cur);
    cur = '';
  };
  for (const line of text.split('\n')) {
    const cps = Array.from(line);
    const parts =
      cps.length > limit
        ? Array.from({ length: Math.ceil(cps.length / limit) }, (_, i) =>
            cps.slice(i * limit, (i + 1) * limit).join('')
          )
        : [line];
    for (const part of parts) {
      const candidate = cur ? `${cur}\n${part}` : part;
      if (Array.from(candidate).length > limit) {
        flush();
        cur = part;
      } else {
        cur = candidate;
      }
    }
  }
  flush();
  return chunks.length ? chunks : [''];
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

export function formatAskOutput(providerId, reason) {
  const provider = normalizeProviderId(providerId);
  if (provider === 'antigravity') return JSON.stringify({ decision: 'deny', reason });
  // Codex CLI notifications do not expose a stable simple hook output contract for Ask.
  // Keep Claude-compatible output as the safe default until a concrete app-server bridge is used.
  return denyOutput(reason);
}

// Phân loại một update Telegram so với các câu hỏi đang chờ.
// ctx: { chatId, pending: [{messageId, sentAt(ms)}] }
// Group: BẮT BUỘC reply đúng tin câu hỏi. Private: 1 câu chờ thì tin trần cũng tính
// (nhưng phải MỚI hơn lúc gửi câu hỏi — chặn backlog getUpdates cũ), nhiều câu → nhắc reply.
// Một câu hỏi có thể trải trên nhiều tin (khi bị chunk) → reply vào TIN NÀO trong nhóm cũng nhận.
const idsOf = (p) => (Array.isArray(p.messageIds) && p.messageIds.length ? p.messageIds : [p.messageId]);
export function classifyUpdate(update, ctx) {
  // Bấm nút inline (Remote Permission). Callback query LUÔN tới bot bất kể privacy mode,
  // và kèm from.id không giả được → đây là kênh duy nhất kiểm tra được ai bấm.
  const cq = update?.callback_query;
  if (cq) {
    if (String(cq.message?.chat?.id) !== String(ctx.chatId)) return { kind: 'ignore' };
    const messageId = cq.message?.message_id;
    if (messageId == null || !ctx.pending.flatMap(idsOf).includes(messageId)) return { kind: 'ignore' };
    const action = String(cq.data || '').match(/^([adsl]):/)?.[1];
    if (!action) return { kind: 'ignore' };
    return {
      kind: 'callback',
      action,
      messageId,
      fromId: cq.from?.id,
      fromName: cq.from?.first_name || cq.from?.username || '',
      callbackId: cq.id,
    };
  }

  const msg = update?.message;
  if (!msg || typeof msg.text !== 'string') return { kind: 'ignore' };
  if (String(msg.chat?.id) !== String(ctx.chatId)) return { kind: 'ignore' };
  // Yêu cầu quyền CHỈ nhận qua nút bấm — text reply không bao giờ duyệt được permission,
  // nên chúng bị loại khỏi mọi phép so khớp dưới đây.
  const asks = ctx.pending.filter((p) => p.kind !== 'perm');
  const allIds = asks.flatMap(idsOf);
  const replyTo = msg.reply_to_message?.message_id;
  if (replyTo != null) {
    if (!allIds.includes(replyTo)) return { kind: 'ignore' };
    return { kind: 'reply', messageId: replyTo, text: msg.text.trim() };
  }
  if (msg.chat?.type === 'private') {
    if (asks.length === 1) {
      const freshEnough = (msg.date || 0) * 1000 >= asks[0].sentAt - 2000;
      if (!freshEnough) return { kind: 'ignore' };
      const ids = idsOf(asks[0]);
      return { kind: 'reply', messageId: ids[ids.length - 1], text: msg.text.trim() };
    }
    if (asks.length > 1) return { kind: 'need-reply-hint' };
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

// Dọn file pending/inbox/session-allow quá hạn (session chết không kịp dọn).
export function gcStateDir(dir, now = Date.now()) {
  for (const sub of STATE_SUBDIRS) {
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
// reply/bấm nút vào inbox theo message_id; session không giữ lock chỉ watch inbox của mình.
// mode 'ask' = chờ text reply; mode 'perm' = chờ bấm nút inline.
async function waitForReply({ tg, cfg, dir, ownMessageIds, deadline, env, home, mode = 'ask' }) {
  const lockFile = join(dir, 'poll.lock');
  let holdingLock = false;
  let lastHintAt = 0;
  try {
    while (Date.now() < deadline) {
      // Tắt cờ giữa chừng (user về máy) → nhả về UI local trong vài giây.
      // Đọc lại config MỖI vòng nên `remote off` / `remote-perm off` có hiệu lực ngay.
      const live = loadConfig({ env, home, providerId: cfg.providerId });
      if (!live.remote || (mode === 'perm' && !live.remotePermission)) return { type: 'remote-off' };

      // 1) inbox của mình có sẵn kết quả (poller khác phân phát)? — vào bất kỳ chunk nào
      for (const id of ownMessageIds) {
        const inboxFile = inboxPath(dir, id);
        if (!existsSync(inboxFile)) continue;
        let msg = null;
        try {
          msg = JSON.parse(readFileSync(inboxFile, 'utf8'));
          unlinkSync(inboxFile);
        } catch {
          // đọc dở → vòng sau
        }
        if (msg?.action) return { type: 'callback', action: msg.action, fromName: msg.fromName || '' };
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
        if (verdict.kind === 'callback') {
          // Ai bấm cũng tới được bot → allowlist là hàng rào duy nhất. Kiểm ở đây (chứ không
          // trong classifyUpdate) để còn báo ngược cho người bấm biết vì sao không ăn.
          if (!live.allowedUserIds.includes(String(verdict.fromId))) {
            await tg
              .answerCallbackQuery(verdict.callbackId, { text: strings(cfg).permNoRight, show_alert: true })
              .catch(() => {});
            continue;
          }
          await tg.answerCallbackQuery(verdict.callbackId, {}).catch(() => {}); // tắt spinner
          if (ownMessageIds.includes(verdict.messageId)) {
            return { type: 'callback', action: verdict.action, fromName: verdict.fromName };
          }
          try {
            writeFileSync(
              inboxPath(dir, verdict.messageId),
              JSON.stringify({ action: verdict.action, fromName: verdict.fromName })
            );
          } catch {
            // session kia sẽ timeout → chấp nhận
          }
        } else if (verdict.kind === 'reply') {
          if (ownMessageIds.includes(verdict.messageId)) return { type: 'reply', text: verdict.text };
          try {
            writeFileSync(inboxPath(dir, verdict.messageId), JSON.stringify({ text: verdict.text }));
          } catch {
            // session kia sẽ timeout → chấp nhận
          }
        } else if (verdict.kind === 'need-reply-hint' && Date.now() - lastHintAt > 60_000) {
          lastHintAt = Date.now();
          const askCount = pending.filter((p) => p.kind !== 'perm').length;
          await tg.sendMessage(strings(cfg).replyHint(askCount), { providerId: cfg.providerId }).catch(() => {});
        }
      }
    }
    return { type: 'timeout' };
  } finally {
    releaseLock(lockFile, holdingLock);
  }
}

export async function promptTelegramAsk({ payload, cfg, tg, env, home = homedir(), questions, text }) {
  if (!cfg.remote) return { type: 'remote-off' };
  if (!Array.isArray(questions) || questions.length === 0) return { type: 'invalid' };

  const dir = ensureStateDirs(home);
  gcStateDir(dir);

  const messageIds = [];
  for (const chunk of chunkMessage(text)) {
    let sent;
    try {
      sent = await tg.sendMessage(chunk, { providerId: cfg.providerId });
    } catch {
      break;
    }
    if (!sent?.message_id) break;
    messageIds.push(sent.message_id);
  }
  if (!messageIds.length) return { type: 'send-failed' };

  const anchorId = messageIds[messageIds.length - 1];
  const key = pendingKey(payload.session_id, questions);
  writeFileSync(
    pendingPath(dir, key),
    JSON.stringify({ messageId: anchorId, messageIds, sessionId: payload.session_id || '', sentAt: Date.now() })
  );

  const deadline = Date.now() + cfg.remoteAskTimeoutSec * 1000;
  const outcome = await waitForReply({ tg, cfg, dir, ownMessageIds: messageIds, deadline, env, home });
  return { type: 'ok', outcome, anchorId, key, dir, pendingFile: pendingPath(dir, key) };
}

async function runAsk(payload, cfg, tg, env, home = homedir()) {
  if (!cfg.remote) return null;
  const questions = payload.tool_input?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;

  const str = strings(cfg);
  const text = buildAskMessage(questions, {
    project: projectName(payload, env),
    suffix: String(payload.session_id || '').slice(-4),
    str,
    providerId: cfg.providerId,
  });

  const prompt = await promptTelegramAsk({ payload, cfg, tg, env, home, questions, text });
  if (prompt.type !== 'ok') return null;
  const { outcome, anchorId, key, dir } = prompt;

  if (outcome.type === 'reply' && !isLocalKeyword(outcome.text)) {
    await tg.editMessageText(anchorId, str.answeredTg(outcome.text)).catch(() => {});
    try {
      unlinkSync(pendingPath(dir, key));
    } catch {
      // đã bị GC
    }
    return formatAskOutput(cfg.providerId, buildDenyReason(outcome.text, questions, str));
  }

  // local / remote-off / timeout → giữ pending cho ask-done chốt sổ khi user bấm tại máy.
  // Chỉ sửa tin neo thành ghi chú ngắn (KHÔNG nhồi lại full text — có thể vượt 4096).
  await tg.editMessageText(anchorId, outcome.type === 'timeout' ? str.timedOut : str.movedLocal).catch(() => {});
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
    const str = strings(cfg);
    await tg.editMessageText(p.messageId, p.kind === 'perm' ? str.permClosed : str.closedUnanswered).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// EVENT perm — Remote Permission: duyệt hộp thoại quyền bằng nút bấm Telegram
// ---------------------------------------------------------------------------
//
// PermissionRequest hook CHỈ bắn khi hộp thoại quyền sắp hiện (tool đã được allow-rule
// duyệt sẵn thì không bắn) ⇒ không cần lọc gì thêm để tránh spam.
//
// Schema (đã đối chiếu zod trong binary Claude Code 2.1.149):
//   in : { session_id, transcript_path, cwd, permission_mode?, hook_event_name,
//          tool_name, tool_input, permission_suggestions? }
//   out: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision:
//            { behavior:'allow', updatedInput?, updatedPermissions? }
//          | { behavior:'deny', message?, interrupt? } } }
// Không in gì = im lặng KHÔNG phải đồng ý — hộp thoại vẫn hiện tại máy.

export function permOutput(behavior, { message } = {}) {
  const decision =
    behavior === 'deny' ? { behavior: 'deny', ...(message ? { message } : {}) } : { behavior: 'allow' };
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
}

export function formatPermissionOutput(providerId, behavior, { message, session = false } = {}) {
  const provider = normalizeProviderId(providerId);
  if (provider === 'antigravity') {
    if (behavior === 'allow') return JSON.stringify({ decision: 'allow' });
    return JSON.stringify({ decision: 'deny', ...(message ? { reason: message } : {}) });
  }
  if (provider === 'codex') {
    return permOutput(behavior, { message });
  }
  return permOutput(behavior, { message });
}

const capText = (value, max) => {
  const cps = Array.from(String(value));
  return cps.length > max ? cps.slice(0, max).join('') + '…' : cps.join('');
};

// Render ĐÚNG thứ đang được xin quyền. Duyệt mù là rủi ro lớn nhất của tính năng này,
// nên nội dung gửi đi phải là nguyên văn (chỉ cap những field có thể dài vô hạn).
export function describePermission(toolName, toolInput) {
  const t = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const fenced = (value, max = 1500) => ['```', capText(value, max), '```'];
  const out = [];

  if (toolName === 'Bash' || toolName === 'PowerShell') {
    if (t.description) out.push(String(t.description));
    if (t.command) out.push(...fenced(t.command, 3000));
  } else if (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') {
    if (t.file_path) out.push(String(t.file_path));
    const body = t.new_string ?? t.content ?? t.new_source;
    if (body != null) out.push(...fenced(body));
  } else if (toolName === 'WebFetch') {
    if (t.url) out.push(String(t.url));
    if (t.prompt) out.push(capText(t.prompt, 400));
  } else if (toolName === 'WebSearch') {
    if (t.query) out.push(String(t.query));
  } else if (Object.keys(t).length) {
    try {
      out.push(...fenced(JSON.stringify(t, null, 2), 2000));
    } catch {
      out.push(...fenced(String(t)));
    }
  }
  return out.filter((line) => line !== '' && line != null).join('\n');
}

export function buildPermMessage({ toolName, toolInput, project, suffix, str, providerId }) {
  const tag = buildTag({ providerId, project, suffix });
  const detail = describePermission(toolName, toolInput);
  return [str.permHeader(tag, providerId ? providerDisplayName(providerId) : undefined), '', `🔧 ${toolName}`, detail || str.permNoDetail, '', str.permFooter].join('\n');
}

// callback_data giới hạn 64 byte của Telegram → prefix 1 ký tự + key 16 hex = 18 byte.
export function permKeyboard(key, str, ttlMin) {
  return {
    inline_keyboard: [
      [
        { text: str.btnAllow, callback_data: `a:${key}` },
        { text: str.btnDeny, callback_data: `d:${key}` },
      ],
      [
        { text: str.btnAllowSession(ttlMin), callback_data: `s:${key}` },
        { text: str.btnLocal, callback_data: `l:${key}` },
      ],
    ],
  };
}

function sessionAllowPath(dir, sessionId) {
  const safe = createHash('sha1').update(String(sessionId || '')).digest('hex').slice(0, 16);
  return join(dir, 'session-allow', `${safe}.json`);
}

// "Cho phép tất cả trong session này" — CÓ HẠN (trần MAX_SESSION_ALLOW_MIN), không bao giờ
// ghi permission rule ra settings.json: hết hạn là tự hỏi lại.
export function writeSessionAllow(dir, sessionId, ttlMin, now = Date.now()) {
  const expiresAt = now + Math.max(1, Number(ttlMin) || 30) * 60_000;
  writeFileSync(sessionAllowPath(dir, sessionId), JSON.stringify({ sessionId, expiresAt }));
  return expiresAt;
}

export function readSessionAllow(dir, sessionId, now = Date.now()) {
  try {
    const { expiresAt } = JSON.parse(readFileSync(sessionAllowPath(dir, sessionId), 'utf8'));
    return expiresAt > now ? expiresAt : 0;
  } catch {
    return 0;
  }
}

const hhmm = (ts) => new Date(ts).toTimeString().slice(0, 5);

// Tool KHÔNG hợp với nút Allow/Deny: lựa chọn thật cần đọc kỹ tại máy (Accept/Revise/Reject…),
// và tool_input thường không chứa nội dung để duyệt. Ở chế độ thường ExitPlanMode đi kênh
// riêng (requiresUserInteraction) nên KHÔNG tới hook này; giữ đây làm lớp phòng thủ cho các
// chế độ mà nó lọt qua — khi đó chỉ BÁO "có plan", không dựng nút.
const NOTIFY_ONLY_TOOLS = new Set(['ExitPlanMode']);

// Tin báo gọn cho tool notify-only (không nút, nhả về máy để duyệt).
export function buildPlanNotice({ project, suffix, str, providerId }) {
  const tag = buildTag({ providerId, project, suffix });
  return str.planNotice(tag, providerId ? providerDisplayName(providerId) : undefined);
}

async function runPerm(payload, cfg, tg, env, home = homedir()) {
  if (!cfg.remote || !cfg.remotePermission) return null;
  // FAIL-CLOSED: không khai báo ai được duyệt thì không hỏi từ xa, hộp thoại về máy.
  if (!cfg.allowedUserIds.length) return null;
  const toolName = payload.tool_name;
  if (!toolName) return null;
  // AskUserQuestion đã có Remote Ask (PreToolUse) lo — không bao giờ đưa vào luồng nút bấm.
  if (toolName === 'AskUserQuestion') return null;

  const str = strings(cfg);

  // Plan (và tool notify-only khác): chỉ gửi 1 tin BÁO rồi nhả về máy — KHÔNG nút, KHÔNG pending,
  // KHÔNG đụng session-allow (đặt trước readSessionAllow để "cho phép tất cả" không nuốt plan).
  if (NOTIFY_ONLY_TOOLS.has(toolName)) {
    await tg
      .sendMessage(
        buildPlanNotice({
          project: projectName(payload, env),
          suffix: String(payload.session_id || '').slice(-4),
          str,
          providerId: cfg.providerId,
        }),
        { providerId: cfg.providerId }
      )
      .catch(() => {});
    return null;
  }

  const dir = ensureStateDirs(home);
  gcStateDir(dir);

  // Đã bấm "cho phép tất cả" và còn hạn → duyệt thẳng, KHÔNG gửi tin (đây là cơ chế chống spam).
  if (readSessionAllow(dir, payload.session_id)) return formatPermissionOutput(cfg.providerId, 'allow');

  const key = pendingKey(payload.session_id, [{ question: `${toolName}:${JSON.stringify(payload.tool_input ?? null)}` }]);
  const chunks = chunkMessage(
    buildPermMessage({
      toolName,
      toolInput: payload.tool_input,
      project: projectName(payload, env),
      suffix: String(payload.session_id || '').slice(-4),
      str,
      providerId: cfg.providerId,
    })
  );

  // Bàn phím nút gắn vào tin CUỐI. Gửi thiếu dù chỉ 1 chunk là nhả về máy: duyệt khi mới
  // thấy một PHẦN của lệnh nguy hiểm hơn nhiều so với việc phải ra máy bấm.
  const messageIds = [];
  let sendFailed = false;
  for (let i = 0; i < chunks.length; i++) {
    const isAnchor = i === chunks.length - 1;
    try {
      const sent = await tg.sendMessage(
        chunks[i],
        isAnchor
          ? { reply_markup: permKeyboard(key, str, cfg.sessionAllowTtlMin), providerId: cfg.providerId }
          : { providerId: cfg.providerId }
      );
      if (!sent?.message_id) throw new Error('no message_id');
      messageIds.push(sent.message_id);
    } catch {
      sendFailed = true;
      break;
    }
  }
  if (sendFailed || !messageIds.length) {
    if (messageIds.length) {
      await tg.editMessageText(messageIds[messageIds.length - 1], str.permSendFailed).catch(() => {});
    }
    return null;
  }
  const anchorId = messageIds[messageIds.length - 1];

  writeFileSync(
    pendingPath(dir, key),
    JSON.stringify({
      kind: 'perm',
      messageId: anchorId,
      messageIds,
      sessionId: payload.session_id || '',
      toolName,
      sentAt: Date.now(),
    })
  );

  const outcome = await waitForReply({
    tg,
    cfg,
    dir,
    ownMessageIds: messageIds,
    deadline: Date.now() + cfg.remoteAskTimeoutSec * 1000,
    env,
    home,
    mode: 'perm',
  });

  try {
    unlinkSync(pendingPath(dir, key));
  } catch {
    // đã bị GC/sweep
  }

  if (outcome.type === 'callback' && outcome.action !== 'l') {
    const who = outcome.fromName ? ` (${outcome.fromName})` : '';
    if (outcome.action === 'd') {
      await tg.editMessageText(anchorId, str.permDenied(who)).catch(() => {});
      return formatPermissionOutput(cfg.providerId, 'deny', { message: str.permDenyReason });
    }
    if (outcome.action === 's') {
      const until = writeSessionAllow(dir, payload.session_id, cfg.sessionAllowTtlMin);
      await tg.editMessageText(anchorId, str.permAllowedSession(who, hhmm(until))).catch(() => {});
    } else {
      await tg.editMessageText(anchorId, str.permAllowed(who)).catch(() => {});
    }
    return formatPermissionOutput(cfg.providerId, 'allow', { session: outcome.action === 's' });
  }

  // 'l' (để máy xử lý) / remote-off / timeout → im lặng ⇒ hộp thoại hiện tại máy.
  await tg
    .editMessageText(anchorId, outcome.type === 'timeout' ? str.permTimedOut : str.permMovedLocal)
    .catch(() => {});
  return null;
}

// ---------------------------------------------------------------------------
// EVENT notify — forward Notification (permission / idle) khi remote bật
// ---------------------------------------------------------------------------

// Message của Notification kiểu "cần duyệt plan" (nhận diện để KHÔNG lọc nhầm khi chống trùng).
const PLAN_MESSAGE_RE = /\bplan\b/i;

// Quyết định có bỏ qua một Notification để tránh TRÙNG với tin do PermissionRequest hook gửi.
// Khi remote-perm bật, mọi hộp thoại xin-quyền (Bash/Edit…) đã được hook `perm` gửi kèm nút →
// tin `permission_prompt` của Notification chỉ là bản sao nghèo hơn ⇒ bỏ. NHƯNG chừa plan:
// ExitPlanMode KHÔNG qua hook `perm`, nên tin plan phải được giữ (2 lớp: message chứa "plan").
export function shouldSkipNotification(notificationType, message, cfg) {
  return (
    cfg.remotePermission === true &&
    notificationType === 'permission_prompt' &&
    !PLAN_MESSAGE_RE.test(String(message || ''))
  );
}

async function runNotify(payload, cfg, tg, env) {
  if (!cfg.remote) return;
  if (cfg.providerId === 'codex' && payload.type === 'agent-turn-complete') {
    const project = projectName(payload, env);
    const tag = buildTag({ providerId: cfg.providerId, project, sessionId: payload.session_id });
    const body =
      fallbackBody(payload.last_assistant_message || '') ||
      (Array.isArray(payload.input_messages) && payload.input_messages.length
        ? `"${payload.input_messages.join(' ').slice(0, 120)}"\n${strings(cfg).doneFallback}`
        : strings(cfg).donePlain);
    await tg.sendMessage(`✅ ${tag}\n${body}`, { providerId: cfg.providerId });
    return;
  }
  const message = payload.message;
  if (!message || typeof message !== 'string') return;
  if (shouldSkipNotification(payload.notification_type, message, cfg)) return;
  const tag = buildTag({
    providerId: cfg.providerId,
    project: projectName(payload, env),
    sessionId: payload.session_id,
  });
  await tg.sendMessage(`${strings(cfg).notifyPrefix} ${tag} ${message}`, { providerId: cfg.providerId });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function parseRuntimeArgs(args, env = process.env) {
  if (PROVIDERS.includes(args[0])) {
    return { providerId: args[0], event: args[1] || 'stop' };
  }
  return {
    event: args[0] || 'stop',
    providerId: normalizeProviderId(args[1] || env.AI_NOTIFY_PROVIDER || env.CC_NOTIFY_PROVIDER || 'claude'),
  };
}

function normalizeRuntimePayload(raw, providerId, event, env = process.env) {
  const provider = normalizeProviderId(raw.provider || raw.providerId || providerId);
  const toolCall = raw.toolCall || {};
  const toolArgs = toolCall.args || raw.tool_input || raw.toolInput || {};
  const questions = Array.isArray(toolArgs.questions)
    ? toolArgs.questions.map((q) => ({
        ...q,
        multiSelect: q.multiSelect ?? q.is_multi_select,
      }))
    : raw.questions;
  const command = raw.command || raw.item?.command || raw.commandActions?.[0]?.command;
  const sessionId = raw.session_id || raw.sessionId || raw.conversationId || raw.threadId || raw.turnId || '';
  return {
    ...raw,
    provider,
    session_id: sessionId,
    turn_id: raw.turn_id || raw.turnId || raw['turn-id'],
    transcript_path: raw.transcript_path || raw.transcriptPath,
    cwd: raw.cwd || raw.cwdPath || raw.workspacePaths?.[0] || process.cwd(),
    tool_name: raw.tool_name || raw.toolName || toolCall.name || (command ? 'Command' : undefined),
    tool_input: {
      ...(command ? { command, cwd: raw.cwd, reason: raw.reason } : {}),
      ...toolArgs,
      ...(questions ? { questions } : {}),
    },
    tool_response: raw.tool_response || raw.toolResponse,
    message: raw.message || raw.reason || raw.notification?.message,
    notification_type: raw.notification_type || raw.notificationType,
    type: raw.type,
    input_messages: raw.input_messages || raw.inputMessages || raw['input-messages'],
    last_assistant_message: raw.last_assistant_message || raw.lastAssistantMessage || raw['last-assistant-message'],
    _normalizedProvider: provider,
    _normalizedEvent: event,
    _project: projectName(raw, env),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const parsed = parseRuntimeArgs(args);
  let cfg = loadConfig({ providerId: parsed.providerId });

  if (args.includes('--test')) {
    if (hasCredentials(cfg)) await makeTelegram(cfg).sendMessage(strings(cfg).testMessage);
    return null;
  }
  if (!hasCredentials(cfg)) return null;

  let payload = {};
  const stdin = await readStdin();
  const argvPayload = args.find((arg, index) => index > 1 && String(arg).trim().startsWith('{'));
  try {
    payload = JSON.parse(stdin || argvPayload || '{}');
  } catch {
    return null;
  }
  const providerId = normalizeProviderId(payload.provider || payload.providerId || parsed.providerId);
  cfg = loadConfig({ providerId });
  cfg.providerId = providerId;
  payload = normalizeRuntimePayload(payload, providerId, parsed.event, process.env);
  const tg = makeTelegram(cfg);

  if (parsed.event === 'stop') return runStop(payload, cfg, tg, process.env).then(() => null);
  if (parsed.event === 'ask') return runAsk(payload, cfg, tg, process.env);
  if (parsed.event === 'ask-done') return runAskDone(payload, cfg, tg).then(() => null);
  if (parsed.event === 'notify') return runNotify(payload, cfg, tg, process.env).then(() => null);
  if (parsed.event === 'perm') return runPerm(payload, cfg, tg, process.env);
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
