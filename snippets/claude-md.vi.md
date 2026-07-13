## Telegram notify (cc-notify-telegram)

Khi đã hoàn thành **TOÀN BỘ** việc người dùng yêu cầu trong session hiện tại và không còn gì
để làm (đang bàn giao kết quả cuối cùng), hãy kết thúc tin nhắn cuối bằng marker ẩn, đặt trên
một dòng riêng, **KÈM tóm tắt cô đọng** theo cú pháp:

`<!-- CC_NOTIFY_DONE: <ý nhiệm vụ 1> | <ý nhiệm vụ 2> | ... -->`

KHÔNG gắn marker này cho bước trung gian, câu hỏi làm rõ, hay tiến độ một phần — chỉ khi đã
xong hẳn. Một Stop hook sẽ phát hiện marker, tách phần tóm tắt và gửi Telegram cho người dùng
(mỗi `|` thành một bullet).

Quy tắc viết tóm tắt (đây là nội dung Telegram, marker vẫn ẩn vì là HTML comment):
- **Cô đọng, bao quát** — mỗi nhiệm vụ chính một ý ngắn, cách nhau bằng ` | `.
- **KHÔNG** kèm link/URL; nếu có PR chỉ ghi gọn kiểu `merged #65`.
- **KHÔNG** liệt kê file đã sửa, **KHÔNG** lặp lại yêu cầu của người dùng.

Ví dụ: `<!-- CC_NOTIFY_DONE: Sửa hook gửi tóm tắt cô đọng | merged #65 -->`

Khi BẾ TẮC thật sự — cần người dùng can thiệp mới tiếp tục được (không phải câu hỏi làm rõ
thông thường) — kết thúc tin nhắn bằng một dòng bắt đầu bằng `🛑` mô tả ngắn việc cần người
dùng làm, kèm marker `<!-- CC_NOTIFY_ESCALATE -->` trên dòng riêng.
