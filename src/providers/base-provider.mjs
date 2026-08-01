import { basename } from 'node:path';

export const PROVIDER_IDS = ['claude', 'codex', 'antigravity'];

export function normalizeProviderId(value) {
  return PROVIDER_IDS.includes(value) ? value : 'claude';
}

export function capText(value, max = 1500) {
  const cps = Array.from(String(value ?? ''));
  return cps.length > max ? cps.slice(0, max).join('') + '…' : cps.join('');
}

export function projectName(payload = {}, env = process.env) {
  const workspace = Array.isArray(payload.workspacePaths) ? payload.workspacePaths[0] : '';
  return basename(env.CLAUDE_PROJECT_DIR || payload.cwd || payload.cwdPath || workspace || '') || 'project';
}

export class AgentProvider {
  id = 'claude';
  displayName = 'Claude';
  defaultConfigDir = '';
  instructionFilename = '';

  async registerHooks() {
    throw new Error(`${this.id}.registerHooks is not implemented`);
  }

  async unregisterHooks() {
    throw new Error(`${this.id}.unregisterHooks is not implemented`);
  }

  async isInstalled() {
    return {
      installed: false,
      details: [{ ok: false, label: `${this.displayName} provider does not implement install checks` }],
    };
  }

  normalizePayload(raw, event, env = process.env) {
    return {
      provider: this.id,
      event,
      sessionId: String(raw.session_id || raw.sessionId || raw.conversationId || raw.threadId || ''),
      project: projectName(raw, env),
      cwd: raw.cwd || raw.cwdPath || raw.workspacePaths?.[0] || process.cwd(),
      transcriptPath: raw.transcript_path || raw.transcriptPath,
      toolName: raw.tool_name || raw.toolName || raw.toolCall?.name,
      toolInput: raw.tool_input || raw.toolInput || raw.toolCall?.args,
      toolResponse: raw.tool_response || raw.toolResponse,
      questions: raw.tool_input?.questions || raw.toolInput?.questions || raw.toolCall?.args?.questions,
      message: raw.message,
      rawPayload: raw,
    };
  }

  formatOutput() {
    return null;
  }
}
