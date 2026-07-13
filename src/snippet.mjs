// Chèn/gỡ block hướng dẫn marker vào ~/.claude/CLAUDE.md, bọc delimiter để idempotent.

export const BLOCK_START = '<!-- cc-notify-telegram:start -->';
export const BLOCK_END = '<!-- cc-notify-telegram:end -->';

export function upsertBlock(content, block) {
  const wrapped = `${BLOCK_START}\n${block.trim()}\n${BLOCK_END}`;
  const existing = content ?? '';
  const start = existing.indexOf(BLOCK_START);
  const end = existing.indexOf(BLOCK_END);
  if (start >= 0 && end > start) {
    return existing.slice(0, start) + wrapped + existing.slice(end + BLOCK_END.length);
  }
  const sep = existing && !existing.endsWith('\n\n') ? (existing.endsWith('\n') ? '\n' : '\n\n') : '';
  return existing + sep + wrapped + '\n';
}

export function removeBlock(content) {
  const existing = content ?? '';
  const start = existing.indexOf(BLOCK_START);
  const end = existing.indexOf(BLOCK_END);
  if (start < 0 || end <= start) return existing;
  let head = existing.slice(0, start);
  let tail = existing.slice(end + BLOCK_END.length);
  return (head.replace(/\n+$/, '\n') + tail.replace(/^\n+/, '\n')).replace(/^\n$/, '');
}

export function hasBlock(content) {
  return (content ?? '').includes(BLOCK_START);
}
