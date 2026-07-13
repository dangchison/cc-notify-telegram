// Merge 4 hook entry của cc-notify-telegram vào ~/.claude/settings.json (user-level).
// Nguyên tắc: CHỈ đụng entry của mình (nhận diện qua tên file hook trong command),
// giữ nguyên mọi hook/key khác của user; chạy lại bao nhiêu lần cũng ra cùng kết quả.

export const HOOK_FILENAME = 'cc-notify-telegram.mjs';
export const LEGACY_HOOK_FILENAME = 'notify-telegram.sh';

// PreToolUse timeout phải DÀI HƠN remoteAskTimeoutSec (tối đa 1770s) để hook kịp chờ reply.
export const HOOK_ENTRIES = [
  { event: 'Stop', arg: 'stop', timeout: 20 },
  { event: 'PreToolUse', arg: 'ask', matcher: 'AskUserQuestion', timeout: 1830 },
  { event: 'PostToolUse', arg: 'ask-done', matcher: 'AskUserQuestion', timeout: 20 },
  { event: 'Notification', arg: 'notify', timeout: 20 },
];

// Path luôn bọc nháy kép: chịu được khoảng trắng trên cả sh (mac/linux) lẫn cmd (Windows).
export function hookCommand(nodePath, hookPath, arg) {
  return `"${nodePath}" "${hookPath}" ${arg}`;
}

function groupIsOurs(group) {
  return (group?.hooks || []).some((h) => typeof h?.command === 'string' && h.command.includes(HOOK_FILENAME));
}

function groupHasLegacy(group) {
  return (group?.hooks || []).some(
    (h) => typeof h?.command === 'string' && h.command.includes(LEGACY_HOOK_FILENAME)
  );
}

export function findLegacyStopEntries(settings) {
  return (settings?.hooks?.Stop || []).filter(groupHasLegacy);
}

// Trả về settings MỚI (không mutate input) đã có đủ 4 entry; removeLegacy=true thì
// gỡ hook notify-telegram.sh cũ khỏi Stop (chỉ hook đó, giữ hook khác cùng group nếu có).
export function mergeSettings(settings, { nodePath, hookPath, removeLegacy = false }) {
  const next = structuredClone(settings ?? {});
  next.hooks = next.hooks ?? {};

  if (removeLegacy && Array.isArray(next.hooks.Stop)) {
    next.hooks.Stop = next.hooks.Stop
      .map((group) => ({
        ...group,
        hooks: (group.hooks || []).filter(
          (h) => !(typeof h?.command === 'string' && h.command.includes(LEGACY_HOOK_FILENAME))
        ),
      }))
      .filter((group) => (group.hooks || []).length > 0);
  }

  for (const spec of HOOK_ENTRIES) {
    const entry = {
      ...(spec.matcher ? { matcher: spec.matcher } : {}),
      hooks: [
        {
          type: 'command',
          command: hookCommand(nodePath, hookPath, spec.arg),
          timeout: spec.timeout,
        },
      ],
    };
    const arr = Array.isArray(next.hooks[spec.event]) ? next.hooks[spec.event] : [];
    const idx = arr.findIndex(groupIsOurs);
    if (idx >= 0) arr[idx] = entry;
    else arr.push(entry);
    next.hooks[spec.event] = arr;
  }
  return next;
}

// Gỡ sạch entry của mình (uninstall); giữ nguyên mọi thứ khác, kể cả legacy.
export function removeOurEntries(settings) {
  const next = structuredClone(settings ?? {});
  if (!next.hooks) return next;
  for (const event of Object.keys(next.hooks)) {
    if (!Array.isArray(next.hooks[event])) continue;
    next.hooks[event] = next.hooks[event].filter((group) => !groupIsOurs(group));
    if (next.hooks[event].length === 0) delete next.hooks[event];
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return next;
}

export function isInstalled(settings) {
  return HOOK_ENTRIES.every((spec) =>
    (settings?.hooks?.[spec.event] || []).some(groupIsOurs)
  );
}
