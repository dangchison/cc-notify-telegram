# cc-notify-telegram (ai-notify-telegram)

**Claude Code, OpenAI Codex & Google Antigravity ↔ Telegram** — để AI Agent làm việc, còn bạn đi đâu cũng được.

Tool này hỗ trợ 3 AI Agent CLI/IDE hàng đầu hiện nay (**Claude Code**, **OpenAI Codex**, **Google Antigravity**), cài đặt hook & marker (cấp user — áp dụng **mọi repo** trên máy) làm 3 việc:

1. **📬 Báo khi xong việc / bế tắc** — Agent hoàn thành TOÀN BỘ task thì bạn nhận một tin Telegram tóm tắt cô đọng; Agent bế tắc cần bạn can thiệp thì nhận tin 🛑.
2. **❓ Remote Ask** — khi Agent hỏi ý kiến bạn mà bạn đang ở ngoài, câu hỏi được gửi qua Telegram; bạn **reply ngay trong Telegram** ("1A", "chọn 2", hay mô tả tự do) và câu trả lời quay về đúng session để Agent chạy tiếp. Không cần server, không webhook.
3. **🔐 Remote Permission** *(opt-in, mặc định TẮT)* — yêu cầu xin quyền chạy lệnh/tool được gửi kèm **nút bấm**; bạn chạm ✅/⛔ là Agent chạy tiếp hoặc dừng. Chỉ những Telegram user ID bạn khai báo mới bấm được.

Ví dụ những gì bạn sẽ nhận từ các Agent:

```
✅ [Codex · packflow]
• Refactored API client module
• Fixed memory leak in websocket listener
```

```
❓ [Antigravity · packflow · a1b2] Antigravity đang hỏi:

1. Chọn database driver?
   A. Postgres — pg pool connection
   B. SQLite — file database local

↩️ Reply tin này để trả lời (vd: "1A" / "1A, 2B" / mô tả tự do).
Reply "local" nếu muốn trả lời tại máy.
```

Bạn reply `1A` → tin được sửa thành `✅ Đã trả lời qua Telegram: "1A"` và Agent tiếp tục làm.

```
🔐 [Claude · cc-notify-telegram · c3d4] Claude xin quyền dùng:

🔧 Bash
npm test

👇 Chọn bên dưới — chỉ tài khoản trong allowlist mới bấm được.
   [ ✅ Cho phép ]  [ ⛔ Từ chối ]
   [ ✅ Cho phép tất cả (30′) ]  [ 🖥 Để máy xử lý ]
```

---

## Yêu cầu

- **Node.js ≥ 18** (bạn cài bằng `npx` nên chắc chắn có).
- Một hoặc nhiều AI Agent: **Claude Code**, **OpenAI Codex**, **Google Antigravity**.
- Một **bot Telegram** (miễn phí, tạo trong 1 phút — hướng dẫn ngay dưới).

Hỗ trợ macOS / Linux / Windows (CI chạy test trên cả 3).

## Bước 1 — Tạo bot Telegram

1. Mở Telegram, chat với **@BotFather** → gõ `/newbot` → đặt tên → BotFather trả về **bot token** dạng `123456789:AAxxxxxxxx...`. Giữ token này bí mật.
2. **Add bot vào group** mà bạn muốn nhận thông báo (hoặc chat riêng với bot cũng được).
3. Trong group, **mention @tên_bot hoặc reply một tin của bot** một câu bất kỳ — để bot "nhìn thấy" group (bot mặc định bật *privacy mode*: chỉ thấy tin mention/reply nó; tool này thiết kế tương thích sẵn, **không cần tắt privacy mode**).

## Bước 2 — Cài đặt

```bash
npx -y github:dangchison/cc-notify-telegram
# Hoặc dùng alias lệnh mới:
npx -y github:dangchison/cc-notify-telegram init
```

Wizard sẽ dẫn từng bước:

1. **Chọn AI Agent** — chọn cài đặt cho Claude Code, OpenAI Codex, Google Antigravity (hoặc cả 3).
2. **Bot token** — dán token từ BotFather (token được xác thực ngay bằng `getMe`).
3. **Chat ID** — không cần biết trước: bấm Enter để wizard **tự dò** các chat/topic bot vừa thấy và chọn từ danh sách (hoặc gõ thẳng ID nếu đã biết).
4. Wizard tự làm phần còn lại:
   - ghi config vào `~/.config/ai-notify-telegram/config.json` (chmod 600, tự động chuyển đổi từ config `~/.claude/` cũ nếu có),
   - copy hook runtime vào `~/.claude/hooks/cc-notify-telegram.mjs`,
   - đăng ký hooks vào file cấu hình của từng Agent (`~/.claude/settings.json`, `~/.codex/config.json`, `~/.gemini/config/settings.json`),
   - hỏi có bật **Remote Permission** không (mặc định *không*); đồng ý thì dò luôn Telegram user ID được phép duyệt,
   - hỏi trước khi thêm block hướng dẫn marker vào file hướng dẫn của Agent (`CLAUDE.md`, `CODEX.md`, `AGENTS.md`),
   - gửi một **tin test** để xác nhận thông suốt.

### Cài không cần hỏi đáp (non-interactive)

```bash
npx -y github:dangchison/cc-notify-telegram init \
  --token "123456789:AAxxx" --chat-id "-1001234567890" --yes
# Tuỳ chọn chọn provider: --provider claude,codex,antigravity (hoặc --provider all)
# Tuỳ chọn: --thread-id 42  --lang en  --silent  --no-test  --no-claude-md
# Bật luôn Remote Permission (lặp --allow-user được, hoặc ngăn cách bằng dấu phẩy):
#   --allow-user 111222333 --allow-user 444555666
```

---

## Telegram Topics cho từng Agent

Nếu Telegram group bật **Topics/Forum**, bạn có thể tách tin của từng Agent vào topic riêng bằng `providerThreads`.

Ví dụ:

```json
{
  "chatId": "-1001234567890",
  "providerThreads": {
    "claude": 5,
    "codex": 6,
    "antigravity": 7
  }
}
```

Khi đó:

- Tin từ Claude Code gửi vào topic `message_thread_id = 5`
- Tin từ Codex gửi vào topic `message_thread_id = 6`
- Tin từ Antigravity gửi vào topic `message_thread_id = 7`

Điều kiện cần:

- Group phải là supergroup có bật Topics.
- Bot phải ở trong group và có quyền gửi tin. Nếu muốn bot tự tạo topic demo hoặc quản lý topic, cần nâng bot lên admin và bật quyền **Manage Topics**.
- `message_thread_id` không phải `chatId`; đây là ID riêng của từng topic.

Cách lấy `message_thread_id` khi đã có topic:

1. Vào từng topic, mention bot một tin, ví dụ `@your_bot claude topic`.
2. Chạy đoạn dưới để liệt kê topic ID bot vừa thấy:

```bash
node -e "import('node:fs').then(async fs=>{const p=process.env.HOME+'/.config/ai-notify-telegram/config.json';const c=JSON.parse(fs.readFileSync(p,'utf8'));const r=await fetch('https://api.telegram.org/bot'+c.botToken+'/getUpdates',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({offset:-100,timeout:0,allowed_updates:['message','callback_query']})});const j=await r.json();const out=[];for(const u of j.result||[]){const m=u.message||u.callback_query?.message;if(String(m?.chat?.id)===String(c.chatId)&&m.message_thread_id!=null)out.push({message_thread_id:m.message_thread_id,text:m.text||''});}console.log(JSON.stringify(out,null,2));})"
```

3. Ghi các ID đó vào `~/.config/ai-notify-telegram/config.json`:

```json
"providerThreads": {
  "claude": 5,
  "codex": 6,
  "antigravity": 7
}
```

Nếu topic ID sai hoặc topic bị xoá, tool sẽ thử fallback gửi về group chính để không mất thông báo.

---

## Cách hoạt động

**Notify khi xong việc — giao thức marker.** Block hướng dẫn trong `CLAUDE.md`, `CODEX.md`, hoặc `AGENTS.md` dặn Agent: *khi (và chỉ khi) xong hẳn toàn bộ việc*, kết thúc tin nhắn cuối bằng một HTML comment ẩn `<!-- AI_NOTIFY_DONE: ý 1 | ý 2 -->` (tương thích cả `<!-- CC_NOTIFY_DONE: ... -->`). Stop hook đọc tin cuối trong transcript/history, thấy marker thì tách tóm tắt gửi Telegram (mỗi `|` một bullet).

```
Agent xong việc ─▶ tin cuối chứa <!-- AI_NOTIFY_DONE: … -->
                        │ Stop hook (stop)
                        ▼
                 📬 Telegram: "✅ [Codex · project] • ý 1 • ý 2"
```

**Remote Ask.** Khi bật (`remote on`), hook PreToolUse / Ask Interceptor chặn câu hỏi *trước khi* UI hiện, gửi câu hỏi + options qua Telegram rồi đứng chờ reply (long-poll `getUpdates`):

```
Agent hỏi ý kiến user
   │ PreToolUse / Ask Interceptor                bạn ở ngoài 🚶
   ├─▶ ❓ gửi câu hỏi lên Telegram ──────────────▶ bạn REPLY "1A"
   │◀───────────── nhận reply ────────────────────┘
   ▼
trả câu trả lời về Agent → Agent chạy tiếp
   └─▶ tin câu hỏi được sửa thành "✅ Đã trả lời qua Telegram: 1A"
```

Không ai reply trong `remoteAskTimeoutSec` (mặc định 15 phút) → câu hỏi **tự nhả về UI tại máy** như bình thường, tin Telegram được sửa thành "⏰ … đang chờ tại máy".

> Codex note: completion uses the official `Stop` lifecycle hook, and remote permission uses `PermissionRequest`. Remote Ask for Codex needs a Codex App Server bridge (`tool/requestUserInput`, experimental) and should not be treated as equivalent to Claude `AskUserQuestion` hooks yet.

**Remote Permission.** Khi bật (`remote-perm on`, cần `remote on` sẵn), hook Permission Interceptor chặn *đúng lúc hộp thoại quyền sắp hiện*, gửi nguyên văn thứ đang được xin quyền kèm 4 nút:

```
Agent cần quyền chạy lệnh
   │ PermissionRequest / Approval Hook            bạn ở ngoài 🚶
   ├─▶ 🔐 gửi tool + nội dung + nút ─────────────▶ bạn CHẠM [✅ Cho phép]
   │◀───────────── nhận callback ─────────────────┘   (kiểm from.id ∈ allowlist)
   ▼
trả decision allow/deny về Agent → lệnh chạy / bị chặn
   └─▶ tin đổi thành "✅ Đã cho phép (Sơn)" và bàn phím nút biến mất
```

---

## Lệnh CLI

Hỗ trợ cả lệnh `cc-notify-telegram` và alias `ai-notify-telegram`:

| Lệnh | Việc |
|---|---|
| `npx cc-notify-telegram` *(hoặc `init`)* | Wizard cài đặt / cài lại / đổi config cho các Agent |
| `npx cc-notify-telegram test` | Gửi tin test |
| `npx cc-notify-telegram status` | Doctor: Dashboard matrix kiểm tra sức khỏe của Claude Code, Codex, Antigravity |
| `npx cc-notify-telegram remote on [provider]` | Bật Remote Ask toàn cục hoặc cho riêng từng Agent (`claude`, `antigravity`; Codex Ask cần App Server bridge) |
| `npx cc-notify-telegram remote off [provider]` | Tắt Remote Ask toàn cục hoặc cho riêng từng Agent |
| `npx cc-notify-telegram remote-perm on [provider]` | Bật Remote Permission toàn cục hoặc cho riêng từng Agent |
| `npx cc-notify-telegram remote-perm off [provider]` | Tắt Remote Permission toàn cục hoặc cho riêng từng Agent |
| `npx cc-notify-telegram uninstall` | Gỡ hooks khỏi các Agent (`--purge`: xoá cả config/token, state, block instruction) |

---

## Config

File `~/.config/ai-notify-telegram/config.json` (chmod 600 — chứa token, **không commit đi đâu**):

| Key | Bắt buộc | Default | Ý nghĩa |
|---|---|---|---|
| `botToken` | ✅ | — | Token từ @BotFather |
| `chatId` | ✅ | — | ID group/chat nhận tin (group thường là số âm `-100…`) |
| `threadId` | | — | ID topic mặc định khi group bật Topics (tin vào đúng topic) |
| `providerThreads` | | `{}` | Cấu hình topic ID riêng cho từng Agent (ví dụ: `{ "claude": 12, "codex": 34, "antigravity": 56 }`) |
| `enabledProviders` | | `["claude", "codex", "antigravity"]` | Danh sách Agent đang được kích hoạt |
| `lang` | | `vi` | Ngôn ngữ tin nhắn + snippet instruction (`vi`/`en`) |
| `silent` | | `false` | `true` = tin đến không rung chuông (`disable_notification`) |
| `remote` | | `{"global": false}` | Trạng thái Remote Ask toàn cục & cho từng Agent |
| `remoteAskTimeoutSec` | | `900` | Thời gian chờ reply/bấm nút trước khi nhả về máy (trần 1770) |
| `remotePermission` | | `{"global": false}` | Trạng thái Remote Permission toàn cục & cho từng Agent |
| `allowedUserIds` | | `[]` | Telegram user ID được quyền duyệt permission. **Rỗng = không ai duyệt được** |
| `sessionAllowTtlMin` | | `30` | Hạn của nút "Cho phép tất cả trong session này" (trần 480) |

Env override (ưu tiên hơn file — tiện CI): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_THREAD_ID`, `CC_NOTIFY_REMOTE`, `CC_NOTIFY_REMOTE_PERM`.

---

## Troubleshooting & Bảo mật

- **Token nằm local**: `~/.config/ai-notify-telegram/config.json`, chmod 600, đã ignore mẫu trong `.gitignore`.
- **Phân biệt Agent & Session rõ ràng**: Mọi tin nhắn đều mang Tag `[Agent · Project · Session]`, đảm bảo câu trả lời về đúng phiên làm việc.
- **Fail-Closed Authorization**: `allowedUserIds` kiểm tra Telegram `from.id` (do Telegram server ký, không thể giả mạo). Rỗng = không ai duyệt được từ xa.
- **Fail-Safe Fallback**: Mất mạng / hết hạn chờ / lỗi Telegram → tự động chuyển về giao diện máy local, không bao giờ tự động duyệt.
- **Smart Topic Fallback**: Nếu `threadId` không hợp lệ hoặc Topic bị xóa, tin nhắn tự động fallback về chat chính của Group.
- **`group chat was upgraded to a supergroup chat`**: Telegram đã đổi group thường thành supergroup, nên `chatId` cũ không dùng được nữa. Lỗi Telegram thường kèm `migrate_to_chat_id`; cập nhật `chatId` trong `~/.config/ai-notify-telegram/config.json` sang ID mới dạng `-100...`, rồi chạy lại `npx cc-notify-telegram test`.
- **`The operation was aborted due to timeout` / `fetch failed`**: thường là Telegram API hoặc mạng đang chậm/chặn kết nối. Bản mới dùng timeout 30 giây và báo lỗi rõ hơn. Hãy retry, kiểm tra mạng/VPN/proxy, rồi chạy `npx cc-notify-telegram test`. Nếu dùng bản npm/cache cũ, chạy từ GitHub repo mới nhất: `npx -y github:dangchison/cc-notify-telegram test`.
- **Tin không vào đúng topic**: kiểm tra `providerThreads` có đúng provider key (`claude`, `codex`, `antigravity`) và đúng `message_thread_id`. `threadId` là topic mặc định; `providerThreads.<provider>` sẽ ưu tiên hơn `threadId`.

---

## Gỡ cài đặt

```bash
npx -y github:dangchison/cc-notify-telegram uninstall          # gỡ hooks (giữ config/token)
npx -y github:dangchison/cc-notify-telegram uninstall --purge  # xoá sạch cả config + block instructions
```

---

## English (condensed)

**cc-notify-telegram (ai-notify-telegram)** connects **Claude Code**, **OpenAI Codex**, and **Google Antigravity** to Telegram:
1. **Completion & Escalation Pings**: Sends a condensed summary when an agent finishes a task (via hidden `<!-- AI_NOTIFY_DONE: … -->` or `<!-- CC_NOTIFY_DONE: … -->` markers in `CLAUDE.md`, `CODEX.md`, or `AGENTS.md`) plus a 🛑 ping when an agent is stuck.
2. **Remote Ask**: Intercepts user questions sent by Claude (`AskUserQuestion`) or Antigravity (`ask_question`), forwards them to Telegram tagged `[Agent · Project · Session]`, and feeds your reply ("1A", "2B", free text) back into the session. Codex Ask requires a Codex App Server bridge (`tool/requestUserInput`, experimental).
3. **Remote Permission**: Intercepts command/tool permission dialogs (`PermissionRequest`, command approval, `ask_permission`), sending inline approval buttons (Allow / Deny / Allow-all-for-session / Handle at machine). Only Telegram user IDs in `allowedUserIds` can approve (fail-closed).
4. **Multi-Agent & Per-Provider Controls**: Manage settings globally or per-agent (`npx cc-notify-telegram remote on codex`, `npx cc-notify-telegram remote-perm off claude`). Smart Telegram topic fallback ensures messages are never lost even if a forum thread is deleted.

Install: `npx -y github:dangchison/cc-notify-telegram` (or `npx ai-notify-telegram`). Requires Node ≥ 18; supports macOS, Linux, Windows. Use `--lang en` for English messages and instruction snippets.
