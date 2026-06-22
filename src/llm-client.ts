// src/llm-client.ts

/**
 * All runtime-configurable values for an LLM client.
 * Values must come from environment variables or a config object — never hardcoded.
 */
export interface LLMClientConfig {
  /** Full base URL of the LLM API, e.g. http://localhost:1234/v1/chat/completions */
  baseUrl: string;
  /** Request timeout in milliseconds. Default: 600_000 (10 min) */
  timeoutMs: number;
  /** Context window size in tokens. Default: 32_000 */
  numCtx: number;
  /** Maximum tokens to generate. Undefined = model default. */
  maxTokens?: number;
  /** Temperature (0–2). Undefined = model default. */
  temperature?: number;
}

/** A single LLM completion request. */
export interface LLMRequest {
  model: string;
  prompt: string;
  /** Caller-owned abort signal. The client links this into its internal controller. */
  signal?: AbortSignal;
  /** Per-request overrides on top of LLMClientConfig. */
  overrides?: Partial<Pick<LLMClientConfig, 'maxTokens' | 'numCtx' | 'timeoutMs'>>;
}

/**
 * Unified LLM client interface.
 * Implementations must own the full AbortController lifecycle (via makeAbortPair).
 * No AbortController construction is permitted outside makeAbortPair.
 */
export interface LLMClient {
  complete(request: LLMRequest): Promise<string>;
}

/**
 * Constructs a linked AbortController that:
 * 1. Self-aborts after timeoutMs milliseconds.
 * 2. Forwards abort from an optional external signal.
 *
 * Callers MUST call cleanup() in a finally block to prevent timer leaks.
 *
 * This is the sole site in src/ where new AbortController() is constructed
 * for LLM network requests (T3 / E2 compliance).
 */
export function makeAbortPair(
  timeoutMs: number,
  externalSignal?: AbortSignal,
): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forwardAbort = (): void => { controller.abort(); };
  externalSignal?.addEventListener('abort', forwardAbort);

  const cleanup = (): void => {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', forwardAbort);
  };

  return { controller, cleanup };
}

/**
 * Reads environment config for the LM Studio chat completions client.
 * Call once at startup; pass the result to callLMStudio or a client constructor.
 */
export function readLMStudioConfig(): LLMClientConfig {
  return {
    baseUrl: process.env['LM_STUDIO_URL'] ?? 'http://localhost:1234/v1/chat/completions',
    timeoutMs: Number(process.env['LM_STUDIO_TIMEOUT_MS'] ?? 600_000),
    numCtx: Number(process.env['LM_STUDIO_NUM_CTX'] ?? 32_000),
    maxTokens: process.env['LM_STUDIO_MAX_TOKENS'] !== undefined
      ? Number(process.env['LM_STUDIO_MAX_TOKENS'])
      : undefined,
  };
}

/** Reads environment config for the LMS REST management client. */
export function readLMSRestConfig(): Pick<LLMClientConfig, 'baseUrl' | 'timeoutMs'> {
  return {
    baseUrl: process.env['LMS_API_BASE'] ?? 'http://localhost:1234/api/v1',
    timeoutMs: Number(process.env['LMS_REST_TIMEOUT_MS'] ?? 10_000),
  };
}
