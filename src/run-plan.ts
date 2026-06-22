/** Phases that call the local model via LM Studio. `aggregate` uses the Claude CLI, not LM Studio. */
export const MODEL_USING_PHASES = ['index', 'analyze', 'dedup'] as const;

/**
 * Whether a run uses the local model. `phase === undefined` means "run all phases" (which
 * includes model-using ones). A single named phase uses the model only if it is in the set.
 */
export function runUsesModel(phase?: string): boolean {
  if (!phase) return true;
  return (MODEL_USING_PHASES as readonly string[]).includes(phase);
}
