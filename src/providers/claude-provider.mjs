import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { AgentProvider } from './base-provider.mjs';
import { HOOK_ENTRIES, isInstalled, mergeSettings, removeOurEntries } from '../settings.mjs';

export class ClaudeProvider extends AgentProvider {
  id = 'claude';
  displayName = 'Claude';
  defaultConfigDir = '~/.claude';
  instructionFilename = 'CLAUDE.md';

  paths(home = homedir()) {
    const claude = join(home, '.claude');
    return {
      dir: claude,
      hookFile: join(claude, 'hooks', 'cc-notify-telegram.mjs'),
      settingsFile: join(claude, 'settings.json'),
      instructionFile: join(claude, this.instructionFilename),
    };
  }

  readSettings(file) {
    if (!existsSync(file)) return {};
    return JSON.parse(readFileSync(file, 'utf8'));
  }

  async registerHooks({ nodePath, hookPath, home = homedir(), flags = {} }) {
    const paths = this.paths(home);
    mkdirSync(join(paths.dir, 'hooks'), { recursive: true });
    const settings = this.readSettings(paths.settingsFile);
    const next = mergeSettings(settings, {
      nodePath,
      hookPath: hookPath || paths.hookFile,
      removeLegacy: flags.removeLegacy === true,
    });
    writeFileSync(paths.settingsFile, JSON.stringify(next, null, 2) + '\n');
    return { success: true, updatedFiles: [paths.settingsFile] };
  }

  async unregisterHooks({ home = homedir() } = {}) {
    const paths = this.paths(home);
    if (!existsSync(paths.settingsFile)) return { success: true, removedFiles: [] };
    const settings = this.readSettings(paths.settingsFile);
    const next = removeOurEntries(settings);
    writeFileSync(paths.settingsFile, JSON.stringify(next, null, 2) + '\n');
    return { success: true, removedFiles: [paths.settingsFile] };
  }

  async isInstalled({ home = homedir() } = {}) {
    const paths = this.paths(home);
    let settings = {};
    try {
      settings = this.readSettings(paths.settingsFile);
    } catch {
      return {
        installed: false,
        details: [{ ok: false, label: `Cannot parse ${paths.settingsFile}`, fix: 'Fix JSON or run init again' }],
      };
    }
    const details = [
      { ok: existsSync(paths.hookFile), label: `Hook file: ${paths.hookFile}`, fix: 'run init' },
      ...HOOK_ENTRIES.map((spec) => ({
        ok: (settings?.hooks?.[spec.event] || []).some((group) =>
          (group.hooks || []).some((hook) => String(hook.command || '').includes('cc-notify-telegram.mjs'))
        ),
        label: `settings.json hook ${spec.event}`,
        fix: 'run init',
      })),
    ];
    return { installed: isInstalled(settings) && existsSync(paths.hookFile), details };
  }

  formatOutput(decision, event) {
    if (event === 'ask') {
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: decision.behavior === 'deny' ? 'deny' : 'allow',
          ...(decision.reason ? { permissionDecisionReason: decision.reason } : {}),
        },
      });
    }
    if (event === 'perm') {
      const output =
        decision.behavior === 'deny'
          ? { behavior: 'deny', ...(decision.message ? { message: decision.message } : {}) }
          : { behavior: 'allow' };
      return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: output } });
    }
    return null;
  }
}
