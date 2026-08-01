import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { AgentProvider, projectName } from './base-provider.mjs';

const NOTIFY_MARKER = '# ai-notify-telegram notify';
const OWNED_NOTIFY_BLOCK_RE = /^# ai-notify-telegram notify\nnotify = \[[^\n]*\]\n?/gm;
const HOOK_DESCRIPTION = 'ai-notify-telegram lifecycle hooks for Codex';
const CODEX_HOOK_ENTRIES = [
  {
    event: 'Stop',
    arg: 'stop',
    timeout: 30,
    statusMessage: 'Sending Telegram completion notification',
  },
  {
    event: 'PermissionRequest',
    arg: 'perm',
    matcher: '*',
    timeout: 1830,
    statusMessage: 'Waiting for Telegram approval',
  },
];

function firstTableLineIndex(lines) {
  const idx = lines.findIndex((line) => /^\s*\[/.test(line));
  return idx === -1 ? lines.length : idx;
}

function upsertRootNotify(config, notifyLine) {
  const withoutOwnedBlock = config.replace(OWNED_NOTIFY_BLOCK_RE, '');
  const lines = withoutOwnedBlock.split('\n');
  if (lines.at(-1) === '') lines.pop();

  const tableIdx = firstTableLineIndex(lines);
  const rootLines = lines.slice(0, tableIdx);
  const tableLines = lines.slice(tableIdx);
  const notifyIdx = rootLines.findIndex((line) => /^\s*notify\s*=/.test(line));
  const block = [NOTIFY_MARKER, notifyLine];

  if (notifyIdx >= 0) {
    rootLines.splice(notifyIdx, 1, ...block);
  } else {
    if (rootLines.length && rootLines.at(-1).trim() !== '') rootLines.push('');
    rootLines.push(...block);
  }

  if (tableLines.length && rootLines.at(-1).trim() !== '') rootLines.push('');
  return [...rootLines, ...tableLines].join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

function backupThenWrite(file, current, next) {
  if (current === next) return;
  if (existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    copyFileSync(file, `${file}.bak-${stamp}`);
  }
  writeFileSync(file, next);
}

function readJsonFile(file) {
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8'));
}

function quoteArg(value) {
  return JSON.stringify(String(value));
}

function hookCommand(nodePath, hookPath, arg) {
  return `${quoteArg(nodePath)} ${quoteArg(hookPath)} ${arg} codex`;
}

function isOwnedHook(hook) {
  const command = String(hook?.command || '');
  return /\s(?:stop|perm|ask|notify)\s+codex(?:\s|$)/.test(command);
}

function withoutOwnedHooks(config) {
  const next = { ...config, hooks: { ...(config.hooks || {}) } };
  for (const event of Object.keys(next.hooks)) {
    const groups = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    const keptGroups = [];
    for (const group of groups) {
      const hooks = Array.isArray(group.hooks) ? group.hooks.filter((hook) => !isOwnedHook(hook)) : [];
      if (hooks.length) keptGroups.push({ ...group, hooks });
    }
    if (keptGroups.length) next.hooks[event] = keptGroups;
    else delete next.hooks[event];
  }
  if (!Object.keys(next.hooks).length) delete next.hooks;
  return next;
}

function withOwnedHooks(config, { nodePath, hookPath }) {
  const next = withoutOwnedHooks(config);
  next.description = next.description || HOOK_DESCRIPTION;
  next.hooks = { ...(next.hooks || {}) };
  for (const spec of CODEX_HOOK_ENTRIES) {
    const groups = Array.isArray(next.hooks[spec.event]) ? [...next.hooks[spec.event]] : [];
    groups.push({
      ...(spec.matcher ? { matcher: spec.matcher } : {}),
      hooks: [
        {
          type: 'command',
          command: hookCommand(nodePath, hookPath, spec.arg),
          timeout: spec.timeout,
          statusMessage: spec.statusMessage,
        },
      ],
    });
    next.hooks[spec.event] = groups;
  }
  return next;
}

function hasOwnedHook(config, event) {
  return (config?.hooks?.[event] || []).some((group) => (group.hooks || []).some(isOwnedHook));
}

export class CodexProvider extends AgentProvider {
  id = 'codex';
  displayName = 'Codex';
  defaultConfigDir = '~/.codex';
  instructionFilename = 'CODEX.md';

  paths(home = homedir()) {
    const dir = join(home, '.codex');
    return {
      dir,
      configFile: join(dir, 'config.toml'),
      hooksFile: join(dir, 'hooks.json'),
      instructionFile: join(dir, this.instructionFilename),
    };
  }

  notifyCommand(nodePath, hookPath) {
    return `[\"${nodePath}\", \"${hookPath}\", \"notify\", \"codex\"]`;
  }

  async registerHooks({ nodePath, hookPath, home = homedir() }) {
    const paths = this.paths(home);
    mkdirSync(paths.dir, { recursive: true });
    const updatedFiles = [];

    const currentHooks = existsSync(paths.hooksFile) ? readFileSync(paths.hooksFile, 'utf8') : '';
    const hooksConfig = readJsonFile(paths.hooksFile);
    const nextHooks = JSON.stringify(withOwnedHooks(hooksConfig, { nodePath, hookPath }), null, 2) + '\n';
    backupThenWrite(paths.hooksFile, currentHooks, nextHooks);
    if (currentHooks !== nextHooks) updatedFiles.push(paths.hooksFile);

    // Migrate the older notify-based Codex registration. Keep user-owned notify lines intact.
    if (existsSync(paths.configFile)) {
      const currentConfig = readFileSync(paths.configFile, 'utf8');
      const nextConfig = currentConfig.replace(OWNED_NOTIFY_BLOCK_RE, '');
      backupThenWrite(paths.configFile, currentConfig, nextConfig);
      if (currentConfig !== nextConfig) updatedFiles.push(paths.configFile);
    }

    return { success: true, updatedFiles: updatedFiles.length ? updatedFiles : [paths.hooksFile] };
  }

  async unregisterHooks({ home = homedir() } = {}) {
    const paths = this.paths(home);
    const removedFiles = [];
    if (existsSync(paths.hooksFile)) {
      const currentHooks = readFileSync(paths.hooksFile, 'utf8');
      const hooksConfig = readJsonFile(paths.hooksFile);
      const nextHooks = JSON.stringify(withoutOwnedHooks(hooksConfig), null, 2) + '\n';
      backupThenWrite(paths.hooksFile, currentHooks, nextHooks);
      if (currentHooks !== nextHooks) removedFiles.push(paths.hooksFile);
    }
    if (existsSync(paths.configFile)) {
      const currentConfig = readFileSync(paths.configFile, 'utf8');
      const nextConfig = currentConfig.replace(OWNED_NOTIFY_BLOCK_RE, '');
      backupThenWrite(paths.configFile, currentConfig, nextConfig);
      if (currentConfig !== nextConfig) removedFiles.push(paths.configFile);
    }
    return { success: true, removedFiles };
  }

  async isInstalled({ home = homedir() } = {}) {
    const paths = this.paths(home);
    let hooksConfig = {};
    try {
      hooksConfig = readJsonFile(paths.hooksFile);
    } catch {
      hooksConfig = {};
    }
    const installed = CODEX_HOOK_ENTRIES.every((spec) => hasOwnedHook(hooksConfig, spec.event));
    return {
      installed,
      details: [
        { ok: existsSync(paths.hooksFile), label: `hooks.json: ${paths.hooksFile}`, fix: 'run init with codex enabled' },
        ...CODEX_HOOK_ENTRIES.map((spec) => ({
          ok: hasOwnedHook(hooksConfig, spec.event),
          label: `Codex lifecycle hook ${spec.event}`,
          fix: 'run init with codex enabled, then review/trust hooks with /hooks',
        })),
      ],
    };
  }

  normalizePayload(raw, event, env = process.env) {
    const action = raw.action || raw.commandActions?.[0] || {};
    const command = raw.command || action.command || raw.item?.command;
    const questions = raw.questions || raw.input?.questions || [];
    return {
      provider: this.id,
      event,
      sessionId: String(raw.threadId || raw.session_id || raw.turnId || ''),
      project: projectName(raw, env),
      cwd: raw.cwd || raw.item?.cwd || process.cwd(),
      transcriptPath: raw.transcriptPath || raw.transcript_path,
      toolName: command ? 'Command' : raw.toolName,
      toolInput: command ? { command, cwd: raw.cwd, reason: raw.reason } : raw.toolInput,
      toolResponse: raw.toolResponse,
      questions,
      message: raw.message || raw.reason,
      rawPayload: raw,
    };
  }

  formatOutput(decision, event) {
    if (event !== 'perm') return null;
    const output =
      decision.behavior === 'deny'
        ? { behavior: 'deny', ...(decision.reason ? { message: decision.reason } : {}) }
        : { behavior: 'allow' };
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: output } });
  }
}
