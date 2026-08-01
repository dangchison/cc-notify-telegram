import { ProviderRegistry } from '../providers/index.mjs';

const registry = new ProviderRegistry();

export function normalizePayload(raw = {}, event = 'stop', env = process.env) {
  const provider = registry.resolve(raw, event);
  return provider.normalizePayload(raw, event, env);
}

export function formatProviderOutput(providerId, decision, event) {
  return registry.get(providerId).formatOutput(decision, event);
}
