# cc-notify-telegram

**Claude Code ↔ Telegram** — để Claude Code làm việc, còn bạn đi đâu cũng được.

Tool này cài 4 hook vào Claude Code (cấp user — áp dụng **mọi repo** trên máy) làm 2 việc:

1. **📬 Báo khi xong việc / bế tắc** — Claude hoàn thành TOÀN BỘ task thì bạn nhận một tin
   Telegram tóm tắt cô đọng; Claude bế tắc cần bạn can thiệp thì nhận tin 🛑.
2. **❓ Remote Ask** — khi Claude hỏi (AskUserQuestion) mà bạn đang ở ngoài, câu hỏi được gửi
   qua Telegram; bạn **reply ngay trong Telegram** ("1A", "chọn 2", hay mô tả tự do) và câu
   trả lời quay về đúng session để Claude chạy tiếp. Không cần server, không webhook.

Ví dụ những gì bạn sẽ nhận:

```
✅ packflow
• Sửa hook gửi tóm tắt cô đọng
• merged #65
```

```
❓ [packflow · a1b2] Claude đang hỏi:

1. Chọn database?
   A. Postgres — quen thuộc với team
   B. SQLite — nhẹ, không cần server

↩️ Reply tin này để trả lời (vd: "1A" / "1A, 2B" / mô tả tự do).
Reply "local" nếu muốn trả lời tại máy.
```

Bạn reply `1A` → tin được sửa thành `✅ Đã trả lời qua Telegram: "1A"` và Claude tiếp tục làm.

---

## Yêu cầu

- **Node.js ≥ 18** (bạn cài bằng `npx` nên chắc chắn có).
- **Claude Code** (CLI hoặc desktop app).
- Một **bot Telegram** (miễn phí, tạo trong 1 phút — hướng dẫn ngay dưới).

Hỗ trợ macOS / Linux / Windows (CI chạy test trên cả 3).

## Bước 1 — Tạo bot Telegram

1. Mở Telegram, chat với **@BotFather** → gõ `/newbot` → đặt tên → BotFather trả về **bot token**
   dạng `123456789:AAxxxxxxxx...`. Giữ token này bí mật.
2. **Add bot vào group** mà bạn muốn nhận thông báo (hoặc chat riêng với bot cũng được).
3. Trong group, **mention @tên_bot hoặc reply một tin của bot** một câu bất kỳ — để bot "nhìn thấy"
   group (bot mặc định bật *privacy mode*: chỉ thấy tin mention/reply nó; tool này thiết kế tương
   thích sẵn, **không cần tắt privacy mode**).

## Bước 2 — Cài đặt

```bash
npx -y github:dangchison/cc-notify-telegram
```

Wizard sẽ dẫn từng bước:

1. **Bot token** — dán token từ BotFather (token được xác thực ngay bằng `getMe`).
2. **Chat ID** — không cần biết trước: bấm Enter để wizard **tự dò** các chat bot vừa thấy và
   chọn từ danh sách (hoặc gõ thẳng ID nếu đã biết).
3. Wizard tự làm phần còn lại:
   - ghi config vào `~/.claude/cc-notify-telegram.json` (chmod 600),
   - copy hook runtime vào `~/.claude/hooks/cc-notify-telegram.mjs`,
   - đăng ký 4 hook vào `~/.claude/settings.json` (**backup trước khi sửa**, giữ nguyên mọi
     hook/cấu hình khác của bạn),
   - hỏi trước khi thêm block hướng dẫn marker vào `~/.claude/CLAUDE.md` (bắt buộc để Claude
     biết khi nào cần báo),
   - gửi một **tin test** để xác nhận thông suốt.
4. Mở **session Claude Code mới** (để CLAUDE.md được nạp) — xong.

Nếu trước đó bạn dùng bản hook bash cũ (`notify-telegram.sh`), wizard tự phát hiện, lấy
token/chat ID cũ làm mặc định và đề nghị thay entry cũ bằng bản mới (file cũ giữ nguyên trên đĩa).

### Cài không cần hỏi đáp (non-interactive)

```bash
npx -y github:dangchison/cc-notify-telegram init \
  --token "123456789:AAxxx" --chat-id "-1001234567890" --yes
# tuỳ chọn: --thread-id 42  --lang en  --silent  --no-test  --no-claude-md
```

## Cách hoạt động

**Notify khi xong việc — giao thức marker.** Block hướng dẫn trong `~/.claude/CLAUDE.md` dặn
Claude: *khi (và chỉ khi) xong hẳn toàn bộ việc*, kết thúc tin nhắn cuối bằng một HTML comment
ẩn `<!-- CC_NOTIFY_DONE: ý 1 | ý 2 -->`. Stop hook đọc tin cuối trong transcript, thấy marker
thì tách tóm tắt gửi Telegram (mỗi `|` một bullet). Không có block CLAUDE.md → Claude không
phát marker → **không có notify** (đây là lỗi cài đặt phổ biến nhất — chạy `status` để kiểm).

```
Claude xong việc ─▶ tin cuối chứa <!-- CC_NOTIFY_DONE: … -->
                        │ Stop hook (stop)
                        ▼
                 📬 Telegram: "✅ project • ý 1 • ý 2"
```

**Remote Ask.** Khi bật (`remote on`), hook PreToolUse chặn `AskUserQuestion` *trước khi* UI
hiện, gửi câu hỏi + options qua Telegram rồi đứng chờ reply (long-poll `getUpdates`):

```
Claude gọi AskUserQuestion
   │ PreToolUse hook (ask)                        bạn ở ngoài 🚶
   ├─▶ ❓ gửi câu hỏi lên Telegram ──────────────▶ bạn REPLY "1A"
   │◀───────────── nhận reply ────────────────────┘
   ▼
trả câu trả lời về Claude (deny-reason) → Claude chạy tiếp
   └─▶ tin câu hỏi được sửa thành "✅ Đã trả lời qua Telegram: 1A"
```

Không ai reply trong `remoteAskTimeoutSec` (mặc định 15 phút) → câu hỏi **tự nhả về UI tại
máy** như bình thường, tin Telegram được sửa thành "⏰ … đang chờ tại máy". Bạn bấm chọn tại
máy → hook PostToolUse sửa tin thành `🖥✅ Đã trả lời tại máy: …` — **tin câu hỏi không bao
giờ treo mồ côi**, nhìn group là biết câu nào xử lý rồi, ở kênh nào, đáp án gì.

## Lệnh

| Lệnh | Việc |
|---|---|
| `npx cc-notify-telegram` *(hoặc `init`)* | Wizard cài đặt / cài lại / đổi config |
| `npx cc-notify-telegram test` | Gửi tin test |
| `npx cc-notify-telegram status` | Doctor: kiểm tra cả chuỗi (config, token, hooks, CLAUDE.md) ✓/✗ kèm cách sửa |
| `npx cc-notify-telegram remote on` | Bật Remote Ask (trước khi ra ngoài) |
| `npx cc-notify-telegram remote off` | Tắt Remote Ask (câu hỏi hiện tại máy; câu đang treo nhả về máy trong vài giây) |
| `npx cc-notify-telegram uninstall` | Gỡ 4 hook + file hook (`--purge`: xoá cả config/token, state, block CLAUDE.md) |

> Cài từ GitHub nên thêm `-y github:dangchison/cc-notify-telegram` thay cho `cc-notify-telegram`
> trong các lệnh trên, ví dụ `npx -y github:dangchison/cc-notify-telegram status`.

## Config

File `~/.claude/cc-notify-telegram.json` (chmod 600 — chứa token, **không commit đi đâu**):

| Key | Bắt buộc | Default | Ý nghĩa |
|---|---|---|---|
| `botToken` | ✅ | — | Token từ @BotFather |
| `chatId` | ✅ | — | ID group/chat nhận tin (group thường là số âm `-100…`) |
| `threadId` | | — | ID topic khi group bật Topics (tin vào đúng topic) |
| `lang` | | `vi` | Ngôn ngữ tin nhắn + snippet CLAUDE.md (`vi`/`en`) |
| `silent` | | `false` | `true` = tin đến không rung chuông (`disable_notification`) |
| `remote` | | `false` | Trạng thái Remote Ask (do `remote on/off` ghi) |
| `remoteAskTimeoutSec` | | `900` | Thời gian chờ reply Telegram trước khi nhả câu hỏi về máy (trần 1770) |

Env override (ưu tiên hơn file — tiện CI): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
`TELEGRAM_THREAD_ID`, `CC_NOTIFY_REMOTE`.

## Remote Ask — chi tiết đáng biết

- **Bật/tắt đúng lúc**: `remote on` trước khi rời máy; về máy thì `remote off`. Đang có câu hỏi
  treo mà tắt → nhả về UI local trong vài giây (hook đọc lại config mỗi vòng poll).
- **Luật nhận reply (chống nhận nhầm tin group)**: trong group **phải REPLY đúng tin câu hỏi**
  của bot (tương thích luôn privacy mode); chat riêng với bot thì tin trần cũng tính khi chỉ có
  1 câu chờ, nhiều câu chờ thì bot nhắc bạn reply đúng tin.
- **Nhiều session / nhiều folder song song**: mỗi ASK là một tin riêng có tag
  `[tên-project · mã-session]` — reply tin nào, câu trả lời về đúng session đó (message_id là
  khoá định tuyến; bên dưới là cơ chế single-poller relay + mailbox, tự takeover khi process
  giữ poll chết).
- **Gửi FULL nội dung, không cắt**: nhãn + mô tả mọi lựa chọn được gửi nguyên văn. Câu hỏi quá
  dài vượt giới hạn 4096 ký tự của Telegram thì tự tách thành nhiều tin — reply vào **tin bất kỳ**
  trong nhóm đều nhận đúng.
- **Muốn trả lời tại máy ngay** (đang bật remote mà bạn lại ngồi ở máy): reply `local` vào tin
  câu hỏi, hoặc chạy `remote off`, hoặc chờ hết timeout. (Vì cơ chế hook của Claude Code chặn
  tuần tự nên UI tại máy chỉ hiện SAU khi hook nhả — không có kiểu 2 nơi cùng bấm được.)
- Trả lời dạng token `1A` được tự diễn giải thành nhãn option cho Claude
  (`Câu 1 "Chọn database?" → "Postgres"`); text tự do được chuyển nguyên văn — Claude hiểu cả 2.
- Khi remote bật, hook Notification cũng forward tin "🔐 Claude cần permission…" /
  "⏳ Claude đang chờ input" — **chỉ để biết**, phê duyệt permission từ xa KHÔNG hỗ trợ
  (chủ đích, xem Bảo mật).

## Troubleshooting

| Triệu chứng | Nguyên nhân thường gặp → cách sửa |
|---|---|
| Không nhận tin nào | Chạy `npx -y github:dangchison/cc-notify-telegram status` — nó chỉ đúng chỗ hỏng (token sai, thiếu hook, node bị đổi…) |
| Xong việc mà không có tin ✅ | CLAUDE.md thiếu block marker (chưa đồng ý ở wizard?) hoặc session mở TRƯỚC khi cài → mở session mới; `status` kiểm mục CLAUDE.md |
| Bot không thấy group khi auto-detect | Chưa add bot vào group, hoặc quên **mention/reply bot** (privacy mode) — nhắn lại rồi Enter dò tiếp |
| Câu hỏi không lên Telegram | Quên `remote on` (mặc định off); hoặc kiểm `status` |
| `npx` chạy bản cũ sau khi repo update | `npx -y github:dangchison/cc-notify-telegram` (cờ `-y` ép resolve lại); còn cache cứng: `npm cache clean --force` |
| Đổi Node (nvm install bản mới, xoá bản cũ) | Command hook trỏ node path tuyệt đối đã biến mất → chạy lại `init` (status sẽ báo đúng bệnh này) |
| 2 máy cùng dùng 1 bot | Được — nhưng Remote Ask mỗi lúc chỉ nên bật ở 1 máy (Telegram giới hạn 1 poller `getUpdates`/bot; bật 2 nơi thì máy sau tự nhả câu hỏi về UI local) |

## Bảo mật

- **Token nằm local**: `~/.claude/cc-notify-telegram.json`, chmod 600, đã ignore mẫu trong
  `.gitignore` của repo này. Ai có token là điều khiển được bot → không chia sẻ, không commit,
  không dán vào chat công khai. Lộ token: thu hồi bằng `/revoke` trong @BotFather.
- **Remote Ask chỉ trả lời câu hỏi** (AskUserQuestion). Phê duyệt permission (chạy lệnh, sửa
  file…) từ xa **cố tình không hỗ trợ** ở v1 — trong group ai gõ cũng được, rủi ro quá lớn.
- Hook luôn `exit 0` — Telegram sập/mất mạng không bao giờ chặn hay làm hỏng phiên Claude Code.
- Reply chỉ được nhận từ **đúng `chatId` đã cấu hình**; group đòi reply-đúng-tin; tin backlog cũ
  bị loại theo timestamp.

## Gỡ cài đặt

```bash
npx -y github:dangchison/cc-notify-telegram uninstall          # gỡ hooks (giữ config/token)
npx -y github:dangchison/cc-notify-telegram uninstall --purge  # xoá sạch cả config + block CLAUDE.md
```

`settings.json` luôn được backup (`settings.json.bak-*`) trước mỗi lần tool sửa.

---

## English (condensed)

**cc-notify-telegram** wires Claude Code to Telegram: (1) a Stop hook sends a condensed summary
when Claude *fully finishes* a task (via a hidden `<!-- CC_NOTIFY_DONE: … -->` marker that a
CLAUDE.md snippet teaches Claude to emit — the installer adds it with your consent) plus a 🛑
escalation ping when Claude is stuck; (2) **Remote Ask** — with `remote on`, `AskUserQuestion`
calls are intercepted (PreToolUse), sent to Telegram, and your reply ("1A", "2B", or free text)
is fed back into the session via the official deny-reason mechanism. Unanswered questions fall
back to the local UI after `remoteAskTimeoutSec` (default 15 min); questions answered at the
machine get their Telegram message edited (`🖥✅ Answered at the machine`), so nothing dangles.
Multiple sessions run concurrently — each question is its own message tagged
`[project · session]`, routed by reply-to (single-poller relay + file mailbox under the hood).

Install: `npx -y github:dangchison/cc-notify-telegram` → wizard asks for a BotFather token and
auto-detects the chat ID (mention/reply the bot in your group first — privacy-mode friendly).
Everything is written to user-level `~/.claude/` (config chmod 600, hooks, settings.json with
backups), so it works in **every repo**. Commands: `init` / `test` / `status` / `remote on|off` /
`uninstall [--purge]`. Env overrides: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Remote
permission-approval is deliberately **not** supported in v1. Requires Node ≥ 18; macOS / Linux /
Windows (CI-tested). Use `--lang en` for English messages and CLAUDE.md snippet.
