import { ClaudeProvider } from './claude-provider.mjs';
import { CodexProvider } from './codex-provider.mjs';
import { AntigravityProvider } from './antigravity-provider.mjs';
import { normalizeProviderId, PROVIDER_IDS } from './base-provider.mjs';

export class ProviderRegistry {
  constructor(providers = [new ClaudeProvider(), new CodexProvider(), new AntigravityProvider()]) {
    this.providers = providers;
  }

  getAll() {
    return this.providers;
  }

  get(id = 'claude') {
    return this.providers.find((provider) => provider.id === normalizeProviderId(id)) || this.providers[0];
  }

  resolve(raw = {}, event = 'stop') {
    const id = raw.provider || raw.providerId || raw.agentProvider || raw.aiProvider || 'claude';
    return this.get(id === 'google-antigravity' ? 'antigravity' : id);
  }

  validate(id) {
    return PROVIDER_IDS.includes(id);
  }
}

export { ClaudeProvider } from './claude-provider.mjs';
export { CodexProvider } from './codex-provider.mjs';
export { AntigravityProvider } from './antigravity-provider.mjs';
export { PROVIDER_IDS, normalizeProviderId } from './base-provider.mjs';
