## Telegram notify (ai-notify-telegram)

Khi đã hoàn thành TOÀN BỘ yêu cầu của người dùng trong conversation hiện tại, hãy kết thúc
phản hồi cuối bằng marker ẩn trên một dòng riêng, kèm tóm tắt ngắn:

`<!-- AI_NOTIFY_DONE: <ý nhiệm vụ 1> | <ý nhiệm vụ 2> | ... -->`

Không dùng marker cho bước trung gian. Mỗi ý nên ngắn, bao quát, không liệt kê file và không
lặp lại nguyên văn yêu cầu.

Khi thật sự bế tắc và cần người dùng can thiệp mới tiếp tục được, kết thúc bằng một dòng bắt
đầu với `🛑` và thêm marker:

`<!-- AI_NOTIFY_ESCALATE -->`
