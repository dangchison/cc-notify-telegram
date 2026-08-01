## Telegram notify (ai-notify-telegram)

When you have completed EVERYTHING the user asked for in the current conversation, end your
final response with a hidden marker on its own line, including a short summary:

`<!-- AI_NOTIFY_DONE: <task idea 1> | <task idea 2> | ... -->`

Do not use the marker for intermediate progress. Keep each summary item short and high-level;
do not list edited files or repeat the request verbatim.

When you are truly blocked and need user intervention before continuing, end with a line
starting with `🛑` and add this marker:

`<!-- AI_NOTIFY_ESCALATE -->`
