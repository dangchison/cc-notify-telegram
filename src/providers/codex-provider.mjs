import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { AgentProvider, projectName } from './base-provider.mjs';

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
    const marker = '# ai-notify-telegram notify';
    const line = `${marker}\nnotify = ${this.notifyCommand(nodePath, hookPath)}\n`;
    const next = current.includes(marker)
      ? current.replace(new RegExp(`${marker}[\\s\\S]*?(?=\\n\\[[^\\n]+\\]|\\n# |\\n?$)`), line.trim())
      : `${current}${current && !current.endsWith('\n') ? '\n' : ''}${line}`;
    writeFileSync(paths.configFile, next.endsWith('\n') ? next : `${next}\n`);
    return { success: true, updatedFiles: [paths.configFile] };
  }

  async unregisterHooks({ home = homedir() } = {}) {
    const paths = this.paths(home);
    if (!existsSync(paths.configFile)) return { success: true, removedFiles: [] };
    const current = readFileSync(paths.configFile, 'utf8');
    const next = current.replace(/# ai-notify-telegram notify\nnotify = \[[^\n]*\]\n?/g, '');
    writeFileSync(paths.configFile, next);
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
