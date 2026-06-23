import { MODEL_REGISTRY, type ModelSpec } from '../models.js';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve a logical model name to its ModelSpec and whether it is registered.
 *
 * - Known models: returns the registered ModelSpec.
 * - Unknown models: builds an ad-hoc ModelSpec with regex-escaped identifierMatch.
 *   `requiredTotalGB` is 0 — caller must supply actual requirement at runtime.
 *
 * Pure function — no I/O, no side effects.
 */
export function resolveModelIdentifier(
  modelName: string,
): { spec: ModelSpec; known: boolean } {
  const known = MODEL_REGISTRY[modelName];
  if (known) return { spec: known, known: true };
  return {
    spec: {
      loadKey: modelName,
      identifierMatch: new RegExp(escapeRegex(modelName), 'i'),
      requiredTotalGB: 0,
    },
    known: false,
  };
}
