import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { AgentProvider, projectName } from './base-provider.mjs';

const HOOK_NAME = 'ai-notify-telegram';

export class AntigravityProvider extends AgentProvider {
  id = 'antigravity';
  displayName = 'Antigravity';
  defaultConfigDir = '~/.agents';
  instructionFilename = 'AGENTS.md';

  paths(home = homedir()) {
    const dir = join(home, '.agents');
    return {
      dir,
      hooksFile: join(dir, 'hooks.json'),
      instructionFile: join(dir, this.instructionFilename),
    };
  }

  readHooks(file) {
    if (!existsSync(file)) return {};
    return JSON.parse(readFileSync(file, 'utf8'));
  }

  hookCommand(nodePath, hookPath, arg) {
    return `"${nodePath}" "${hookPath}" ${arg} antigravity`;
  }

  buildHookConfig(nodePath, hookPath) {
    return {
      enabled: true,
      Stop: [{ type: 'command', command: this.hookCommand(nodePath, hookPath, 'stop'), timeout: 20 }],
      PreToolUse: [
        {
          matcher: 'ask_question',
          hooks: [{ type: 'command', command: this.hookCommand(nodePath, hookPath, 'ask'), timeout: 1830 }],
        },
        {
          matcher: 'ask_permission|run_command|edit_file|write_file',
          hooks: [{ type: 'command', command: this.hookCommand(nodePath, hookPath, 'perm'), timeout: 1830 }],
        },
      ],
      PostToolUse: [
        {
          matcher: 'ask_question',
          hooks: [{ type: 'command', command: this.hookCommand(nodePath, hookPath, 'ask-done'), timeout: 20 }],
        },
      ],
    };
  }

  async registerHooks({ nodePath, hookPath, home = homedir() }) {
    const paths = this.paths(home);
    mkdirSync(paths.dir, { recursive: true });
    const hooks = this.readHooks(paths.hooksFile);
    hooks[HOOK_NAME] = this.buildHookConfig(nodePath, hookPath);
    writeFileSync(paths.hooksFile, JSON.stringify(hooks, null, 2) + '\n');
    return { success: true, updatedFiles: [paths.hooksFile] };
  }

  async unregisterHooks({ home = homedir() } = {}) {
    const paths = this.paths(home);
    const hooks = this.readHooks(paths.hooksFile);
    if (!hooks[HOOK_NAME]) return { success: true, removedFiles: [] };
    delete hooks[HOOK_NAME];
    writeFileSync(paths.hooksFile, JSON.stringify(hooks, null, 2) + '\n');
    return { success: true, removedFiles: [paths.hooksFile] };
  }

  async isInstalled({ home = homedir() } = {}) {
    const paths = this.paths(home);
    const hooks = this.readHooks(paths.hooksFile);
    const entry = hooks[HOOK_NAME];
    const installed = entry?.enabled !== false && Boolean(entry?.Stop && entry?.PreToolUse);
    return {
      installed,
      details: [
        { ok: existsSync(paths.hooksFile), label: `hooks.json: ${paths.hooksFile}`, fix: 'run init with antigravity enabled' },
        { ok: installed, label: 'ai-notify-telegram Antigravity hook entry', fix: 'run init with antigravity enabled' },
      ],
    };
  }

  normalizePayload(raw, event, env = process.env) {
    const toolName = raw.toolCall?.name || raw.tool_name;
    const toolInput = raw.toolCall?.args || raw.tool_input;
    const questions = (toolInput?.questions || []).map((q) => ({
      question: q.question,
      multiSelect: q.is_multi_select ?? q.multiSelect,
      options: q.options,
    }));
    return {
      provider: this.id,
      event: toolName === 'ask_question' ? 'ask' : event,
      sessionId: String(raw.conversationId || raw.session_id || ''),
      project: projectName(raw, env),
      cwd: raw.workspacePaths?.[0] || raw.cwd || process.cwd(),
      transcriptPath: raw.transcriptPath || raw.transcript_path,
      toolName,
      toolInput: questions.length ? { ...toolInput, questions } : toolInput,
      toolResponse: raw.toolResponse || raw.tool_response,
      questions,
      message: raw.message,
      rawPayload: raw,
    };
  }

  formatOutput(decision, event) {
    if (event === 'perm') {
      if (decision.behavior === 'allow') return JSON.stringify({ decision: 'allow' });
      return JSON.stringify({ decision: 'deny', ...(decision.reason ? { reason: decision.reason } : {}) });
    }
    if (event === 'ask' && decision.reason) {
      return JSON.stringify({ decision: 'deny', reason: decision.reason });
    }
    return null;
  }
}
