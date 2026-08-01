import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { AgentProvider, projectName } from './base-provider.mjs';

const NOTIFY_MARKER = '# ai-notify-telegram notify';
const OWNED_NOTIFY_BLOCK_RE = /^# ai-notify-telegram notify\nnotify = \[[^\n]*\]\n?/gm;

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
      instructionFile: join(dir, this.instructionFilename),
    };
  }

  notifyCommand(nodePath, hookPath) {
    return `[\"${nodePath}\", \"${hookPath}\", \"notify\", \"codex\"]`;
  }

  async registerHooks({ nodePath, hookPath, home = homedir() }) {
    const paths = this.paths(home);
    mkdirSync(paths.dir, { recursive: true });
    const current = existsSync(paths.configFile) ? readFileSync(paths.configFile, 'utf8') : '';
    const next = upsertRootNotify(current, `notify = ${this.notifyCommand(nodePath, hookPath)}`);
    backupThenWrite(paths.configFile, current, next);
    return { success: true, updatedFiles: [paths.configFile] };
  }

  async unregisterHooks({ home = homedir() } = {}) {
    const paths = this.paths(home);
    if (!existsSync(paths.configFile)) return { success: true, removedFiles: [] };
    const current = readFileSync(paths.configFile, 'utf8');
    const next = current.replace(OWNED_NOTIFY_BLOCK_RE, '');
    backupThenWrite(paths.configFile, current, next);
    return { success: true, removedFiles: [paths.configFile] };
  }

  async isInstalled({ home = homedir() } = {}) {
    const paths = this.paths(home);
    const config = existsSync(paths.configFile) ? readFileSync(paths.configFile, 'utf8') : '';
    const installed = config.includes('# ai-notify-telegram notify') && config.includes('notify = ');
    return {
      installed,
      details: [
        { ok: existsSync(paths.configFile), label: `config.toml: ${paths.configFile}`, fix: 'run init with codex enabled' },
        {
          ok: installed,
          label: 'Codex notify command configured',
          fix: 'run init with codex enabled; ask/permission requires a Codex app-server bridge',
        },
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
    const value = decision.behavior === 'allow'
      ? (decision.session ? 'acceptForSession' : 'accept')
      : 'decline';
    return JSON.stringify({ decision: value, ...(decision.reason ? { reason: decision.reason } : {}) });
  }
}
