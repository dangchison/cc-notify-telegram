## Telegram notify (ai-notify-telegram)

Khi đã hoàn thành TOÀN BỘ yêu cầu của người dùng trong session hiện tại, hãy kết thúc
tin nhắn cuối bằng marker ẩn trên một dòng riêng, kèm tóm tắt ngắn:

`<!-- AI_NOTIFY_DONE: <ý nhiệm vụ 1> | <ý nhiệm vụ 2> | ... -->`

Không dùng marker này cho tiến độ trung gian hoặc câu hỏi làm rõ. Mỗi ý trong tóm tắt nên
ngắn, đủ bao quát, không liệt kê file đã sửa, không lặp lại nguyên văn yêu cầu.

Khi thật sự bế tắc và cần người dùng can thiệp mới tiếp tục được, kết thúc tin nhắn bằng
một dòng bắt đầu bằng `🛑` mô tả việc cần xử lý, kèm marker:

`<!-- AI_NOTIFY_ESCALATE -->`
