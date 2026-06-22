/**
 * Calculate a safe max-tokens ceiling for an LM Studio call.
 *
 * @param promptLen - Character length of the rendered prompt string.
 * @param numCtx    - Context window size of the loaded model (tokens).
 * @param cap       - Hard ceiling on output tokens for this call.
 * @returns Clamped output token budget (minimum 500).
 */
export function calculateSafeMaxTokens(
  promptLen: number,
  numCtx: number,
  cap: number,
): number {
  const inputTokens = Math.ceil(promptLen / 3.5);
  const available = Math.floor(numCtx * 0.85) - inputTokens;
  return Math.max(500, Math.min(available, cap));
}
