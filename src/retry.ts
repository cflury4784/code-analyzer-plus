export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  onAttemptError: (attempt: number, err: unknown) => void,
  signal?: AbortSignal,
): Promise<{ value: T; attempts: number } | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) return null;
    try {
      return { value: await fn(), attempts: attempt };
    } catch (err) {
      if (signal?.aborted) return null;
      onAttemptError(attempt, err);
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  }
  return null;
}
