// Wizard cài đặt: hỏi token + chat ID (auto-detect), ghi config 600, copy hook,
// merge settings.json (có backup), chèn snippet CLAUDE.md, gửi tin test.
//
// Non-interactive: --token <t> --chat-id <id> [--thread-id N] [--lang vi|en]
//                  [--silent] [--yes] [--no-claude-md] [--no-test] [--keep-legacy]

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

import { loadConfig, makeTelegram } from '../hook/notify-telegram.mjs';
import { PROVIDERS, readConfig, readLegacyConf, writeConfig } from './config.mjs';
import { findLegacyStopEntries, isInstalled, mergeSettings } from './settings.mjs';
import { hasBlock, upsertBlock } from './snippet.mjs';
import { ProviderRegistry } from './providers/index.mjs';

const HOOK_SOURCE = fileURLToPath(new URL('../hook/notify-telegram.mjs', import.meta.url));

export function installPaths(home = homedir()) {
  const claude = join(home, '.claude');
  return {
    claude,
    hookFile: join(claude, 'hooks', 'cc-notify-telegram.mjs'),
    settingsFile: join(claude, 'settings.json'),
    claudeMdFile: join(claude, 'CLAUDE.md'),
  };
}

function readSettingsOrThrow(file) {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    // TUYỆT ĐỐI không ghi đè file settings đang hỏng — bắt user sửa tay trước.
    throw new Error(
      `Không parse được ${file} (JSON hỏng?). Sửa file này trước rồi chạy lại init.`
    );
  }
}

function backupThenWrite(file, data) {
  if (existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    copyFileSync(file, `${file}.bak-${stamp}`);
  }
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

async function detectChatId(tg, ask, log) {
  log('');
  log('🔎 Auto-detect chat ID: add bot vào group (hoặc chat riêng với bot),');
  log('   rồi MENTION @bot hoặc REPLY một tin của bot (group bật privacy mode');
  log('   nên tin thường sẽ không tới bot). Xong bấm Enter để dò.');
  for (;;) {
    const answer = await ask('   Enter để dò / hoặc gõ thẳng chat ID: ');
    if (answer.trim()) return answer.trim();
    let updates = [];
    try {
      updates = await tg.getUpdates({ timeout: 0, offset: -50 });
    } catch (err) {
      log(`   ⚠️  getUpdates lỗi: ${err.message}`);
      continue;
    }
    const chats = new Map();
    for (const u of updates) {
      const chat = u.message?.chat;
      if (chat?.id != null) {
        chats.set(chat.id, chat.title || chat.username || chat.first_name || String(chat.id));
      }
    }
    if (!chats.size) {
      log('   Chưa thấy chat nào — kiểm tra đã nhắn/mention bot chưa rồi Enter thử lại.');
      continue;
    }
    const list = [...chats.entries()];
    list.forEach(([id, title], i) => log(`   ${i + 1}. ${title}  (${id})`));
    const pick = await ask(`   Chọn 1-${list.length} (hoặc Enter dò lại): `);
    const idx = Number(pick) - 1;
    if (list[idx]) return String(list[idx][0]);
  }
}

// Dò Telegram user ID được phép duyệt permission — cùng khuôn với detectChatId (đọc getUpdates,
// lấy message.from). Đây là allowlist cho Remote Permission: ai không có trong đây bấm nút cũng vô hiệu.
async function detectUserIds(tg, ask, log) {
  log('');
  log('👤 Ai được duyệt permission từ Telegram? Nhắn cho bot MỘT tin bất kỳ (mention/reply');
  log('   nếu ở group) rồi bấm Enter để dò. Hoặc gõ thẳng user ID, nhiều ID cách nhau dấu phẩy.');
  for (;;) {
    const answer = await ask('   Enter để dò / hoặc gõ user ID: ');
    if (answer.trim()) {
      return answer
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    let updates = [];
    try {
      updates = await tg.getUpdates({ timeout: 0, offset: -50 });
    } catch (err) {
      log(`   ⚠️  getUpdates lỗi: ${err.message}`);
      continue;
    }
    const users = new Map();
    for (const u of updates) {
      const from = u.message?.from ?? u.callback_query?.from;
      if (from?.id != null && !from.is_bot) {
        users.set(String(from.id), from.username ? `@${from.username}` : from.first_name || String(from.id));
      }
    }
    if (!users.size) {
      log('   Chưa thấy ai — nhắn cho bot một tin rồi Enter thử lại.');
      continue;
    }
    const list = [...users.entries()];
    list.forEach(([id, name], i) => log(`   ${i + 1}. ${name}  (${id})`));
    const pick = await ask(`   Chọn 1-${list.length} (nhiều thì cách nhau dấu phẩy, Enter dò lại): `);
    const picked = pick
      .split(',')
      .map((s) => list[Number(s.trim()) - 1]?.[0])
      .filter(Boolean);
    if (picked.length) return picked;
  }
}

export async function runInit(flags, { home = homedir(), log = console.log } = {}) {
  const paths = installPaths(home);
  const interactive = !flags.yes && process.stdin.isTTY === true;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = async (q) => (rl ? (await rl.question(q)) : '');

  try {
    log('📦 cc-notify-telegram — cài đặt hook Telegram cho Claude Code (ghi vào ~/.claude, áp dụng mọi repo)');

    // ── 1. Gom config: flags > config hiện có > legacy telegram.conf ──────────
    const existing = readConfig(home) || {};
    const legacy = readLegacyConf(home) || {};
    if (legacy.botToken && !existing.botToken) log('♻️  Thấy telegram.conf của bản bash cũ — dùng làm giá trị mặc định.');

    let botToken = flags.token || existing.botToken || legacy.botToken || '';
    let chatId = flags['chat-id'] || existing.chatId || legacy.chatId || '';

    if (!botToken && interactive) {
      log('');
      log('🤖 Chưa có bot? Chat với @BotFather trên Telegram → /newbot → copy token.');
      botToken = (await ask('   Bot token: ')).trim();
    }
    if (!botToken) throw new Error('Thiếu bot token (dùng --token hoặc chạy interactive).');

    // Xác thực token sớm — token sai thì cài xong cũng vô dụng.
    const tgProbe = makeTelegram({ botToken, chatId: '' });
    let botName = '';
    try {
      const me = await tgProbe.getMe();
      botName = me.username ? `@${me.username}` : String(me.id);
      log(`✅ Token hợp lệ — bot ${botName}`);
    } catch (err) {
      if (interactive) throw new Error(`Token không hợp lệ (getMe: ${err.message}). Chạy lại init.`);
      log(`⚠️  Không xác thực được token (${err.message}) — vẫn tiếp tục (offline?).`);
    }

    if (!chatId && interactive) chatId = await detectChatId(tgProbe, ask, log);
    if (!chatId) throw new Error('Thiếu chat ID (dùng --chat-id hoặc chạy interactive).');

    // ── 1b. Remote Permission (opt-in, mặc định TẮT) ─────────────────────────
    // Duyệt lệnh từ xa rủi ro cao hơn hẳn trả lời câu hỏi, nên phải hỏi riêng và
    // BẮT BUỘC có allowlist — không allowlist thì hook tự im lặng (fail-closed).
    let allowedUserIds = []
      .concat(flags['allow-user'] ?? [])
      .flatMap((v) => String(v).split(','))
      .map((s) => s.trim())
      .filter(Boolean);
    let remotePermission = allowedUserIds.length > 0;
    if (!allowedUserIds.length && Array.isArray(existing.allowedUserIds)) {
      allowedUserIds = existing.allowedUserIds.map(String);
      remotePermission = existing.remotePermission === true;
    }
    if (interactive && !allowedUserIds.length) {
      log('');
      log('🔐 Remote Permission: duyệt hộp thoại "Allow Claude to run …?" bằng nút bấm Telegram.');
      log('   Rủi ro cao hơn Remote Ask — chỉ user ID bạn chọn mới bấm được, và không bao giờ');
      log('   ghi permission rule vĩnh viễn vào settings.json.');
      const answer = await ask('   Bật Remote Permission? [y/N]: ');
      if (/^y/i.test(answer.trim())) {
        allowedUserIds = await detectUserIds(tgProbe, ask, log);
        remotePermission = allowedUserIds.length > 0;
      }
    }

    const selectedProviders = String(flags.providers || flags.provider || 'claude')
      .split(',')
      .map((s) => s.trim())
      .filter((id) => PROVIDERS.includes(id));
    const enabledProviders = [
      ...new Set(['claude', ...(existing.enabledProviders || []), ...(selectedProviders.length ? selectedProviders : [])]),
    ];
    const remote = existing.remote && typeof existing.remote === 'object'
      ? existing.remote
      : { global: existing.remote === true, providers: { claude: existing.remote === true } };
    const remotePermissionConfig = existing.remotePermission && typeof existing.remotePermission === 'object'
      ? existing.remotePermission
      : { global: existing.remotePermission === true || remotePermission, providers: { claude: existing.remotePermission === true || remotePermission } };
    if (remotePermission) {
      remotePermissionConfig.global = true;
      remotePermissionConfig.providers = { ...(remotePermissionConfig.providers || {}), claude: true };
    }
    const config = {
      version: 1,
      botToken,
      chatId,
      ...(flags['thread-id'] ? { threadId: Number(flags['thread-id']) } : existing.threadId ? { threadId: existing.threadId } : {}),
      providerThreads: existing.providerThreads || {},
      enabledProviders,
      lang: flags.lang === 'en' ? 'en' : existing.lang === 'en' && !flags.lang ? 'en' : 'vi',
      ...(flags.silent || existing.silent ? { silent: true } : {}),
      remote,
      ...(existing.remoteAskTimeoutSec ? { remoteAskTimeoutSec: existing.remoteAskTimeoutSec } : {}),
      ...(allowedUserIds.length ? { allowedUserIds } : {}),
      remotePermission: remotePermissionConfig,
      ...(existing.sessionAllowTtlMin ? { sessionAllowTtlMin: existing.sessionAllowTtlMin } : {}),
    };
    const configFile = writeConfig(config, home);
    log(`✅ Config → ${configFile} (chmod 600)`);

    // ── 2. Copy hook runtime ──────────────────────────────────────────────────
    mkdirSync(join(paths.claude, 'hooks'), { recursive: true });
    copyFileSync(HOOK_SOURCE, paths.hookFile);
    if (process.platform !== 'win32') chmodSync(paths.hookFile, 0o755);
    log(`✅ Hook → ${paths.hookFile}`);

    // ── 3. Merge settings.json (backup trước khi ghi) ────────────────────────
    const settings = readSettingsOrThrow(paths.settingsFile);
    let removeLegacy = Boolean(flags['remove-legacy']);
    const legacyEntries = findLegacyStopEntries(settings);
    if (legacyEntries.length && !flags['keep-legacy'] && !removeLegacy) {
      if (interactive) {
        const answer = await ask('♻️  Thấy hook bash notify-telegram.sh cũ trong settings — thay bằng bản mới? [Y/n]: ');
        removeLegacy = !/^n/i.test(answer.trim());
      } else {
        removeLegacy = true; // --yes: bản mới thay bản cũ (file .sh trên đĩa vẫn giữ nguyên)
      }
    }
    const nodePath = process.execPath; // path node TUYỆT ĐỐI — né nvm/PATH trong non-interactive shell
    const merged = mergeSettings(settings, { nodePath, hookPath: paths.hookFile, removeLegacy });
    if (JSON.stringify(merged) !== JSON.stringify(settings)) {
      backupThenWrite(paths.settingsFile, merged);
      log(
        `✅ settings.json: đăng ký 5 hook (Stop / PreToolUse / PostToolUse / Notification / PermissionRequest)${removeLegacy ? ' — đã gỡ entry bash cũ' : ''}`
      );
    } else {
      log('✅ settings.json đã đúng — không cần sửa.');
    }

    const registry = new ProviderRegistry();
    for (const providerId of enabledProviders.filter((id) => id !== 'claude')) {
      try {
        const result = await registry.get(providerId).registerHooks({ nodePath, hookPath: paths.hookFile, home });
        log(`✅ ${registry.get(providerId).displayName}: ${result.updatedFiles.join(', ')}`);
      } catch (err) {
        log(`⚠️  Không đăng ký được ${providerId}: ${err.message}`);
      }
    }

    // ── 4. Snippet CLAUDE.md (giao thức marker — không có nó Claude không phát marker) ─
    if (!flags['no-claude-md']) {
      let consent = true;
      if (interactive && !hasBlock(existsSync(paths.claudeMdFile) ? readFileSync(paths.claudeMdFile, 'utf8') : '')) {
        const answer = await ask('📝 Thêm hướng dẫn marker vào ~/.claude/CLAUDE.md (bắt buộc để Claude biết khi nào báo)? [Y/n]: ');
        consent = !/^n/i.test(answer.trim());
      }
      if (consent) {
        const snippet = readFileSync(
          fileURLToPath(new URL(`../snippets/claude-md.${config.lang}.md`, import.meta.url)),
          'utf8'
        );
        const current = existsSync(paths.claudeMdFile) ? readFileSync(paths.claudeMdFile, 'utf8') : '';
        writeFileSync(paths.claudeMdFile, upsertBlock(current, snippet));
        log(`✅ Snippet marker → ${paths.claudeMdFile}`);
      } else {
        log('⏭  Bỏ qua CLAUDE.md — tự thêm sau bằng nội dung trong snippets/ nếu muốn nhận notify.');
      }
    }

    const snippetMap = {
      codex: 'codex-md',
      antigravity: 'agents-md',
    };
    for (const providerId of enabledProviders.filter((id) => id !== 'claude')) {
      if (flags['no-agent-md']) continue;
      const provider = registry.get(providerId);
      const snippetName = snippetMap[providerId];
      if (!snippetName) continue;
      const snippet = readFileSync(
        fileURLToPath(new URL(`../snippets/${snippetName}.${config.lang}.md`, import.meta.url)),
        'utf8'
      );
      const file = provider.paths(home).instructionFile;
      mkdirSync(dirname(file), { recursive: true });
      const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
      writeFileSync(file, upsertBlock(current, snippet));
      log(`✅ Snippet marker → ${file}`);
    }

    // ── 5. Tin test ───────────────────────────────────────────────────────────
    if (!flags['no-test']) {
      try {
        await makeTelegram(loadConfig({ home })).sendMessage(
          `✅ cc-notify-telegram đã cài xong${botName ? ` (bot ${botName})` : ''} — bạn sẽ nhận thông báo ở đây.`
        );
        log('✅ Đã gửi tin test — kiểm tra Telegram!');
      } catch (err) {
        log(`⚠️  Gửi tin test lỗi: ${err.message} — chạy \`cc-notify-telegram status\` để chẩn đoán.`);
      }
    }

    log('');
    log('🎉 Xong! Mở session Claude Code MỚI để CLAUDE.md được nạp.');
    log('   • Bật trả lời câu hỏi qua Telegram khi ra ngoài:  npx cc-notify-telegram remote on');
    if (remotePermission) {
      log('   • Bật/tắt duyệt quyền từ xa:                      npx cc-notify-telegram remote-perm on|off');
    }
    log('   • Kiểm tra sức khoẻ:                              npx cc-notify-telegram status');
    return isInstalled(merged);
  } finally {
    rl?.close();
  }
}
