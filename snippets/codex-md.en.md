## Telegram notify (ai-notify-telegram)

When you have completed EVERYTHING the user asked for in the current session, end your final
message with a hidden marker on its own line, including a short summary:

`<!-- AI_NOTIFY_DONE: <task idea 1> | <task idea 2> | ... -->`

Do not use this marker for intermediate progress or clarifying questions. Keep each summary
item short and high-level; do not list edited files or repeat the request verbatim.

When you are truly blocked and need user intervention before you can continue, end your
message with a line starting with `🛑` plus this marker:

`<!-- AI_NOTIFY_ESCALATE -->`
