/**
 * Restores process.env entries to their saved state.
 *
 * Pass the snapshot captured *before* the test mutated the environment.
 * Keys whose saved value is `undefined` are deleted; all others are re-set.
 *
 * @param envVars - Map of env-var name → value before the test ran.
 *
 * @example
 * const saved = { DEBUG: process.env['DEBUG'] };
 * process.env['DEBUG'] = '1';
 * // ... run test ...
 * restoreEnvVars(saved);
 */
export function restoreEnvVars(envVars: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(envVars)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
