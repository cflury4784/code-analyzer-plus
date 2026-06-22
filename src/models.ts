export interface ModelSpec {
  loadKey: string;         // model key passed to `lms load` (NOT a .gguf path — see note below)
  identifierMatch: RegExp; // matches the identifier `lms ps` reports when the model is loaded
  requiredTotalGB: number; // min total unified memory (os.totalmem, GiB) to load at default ctx
}

/**
 * Keyed by the analyzer's *logical* model name (the value of --model-override or DEFAULT_MODEL).
 *
 * Why `loadKey` is a model key and NOT a .gguf path: loading by the full relative .gguf path
 * (e.g. `unsloth/Qwen3.6-35B-A3B-GGUF/...-Q3_K_S.gguf`) fails with `--yes` ("select a model
 * interactively") because multiple quants share the model folder. The disambiguated model key
 * (`qwen3.6-27b-mtp@q3_k_m`, as reported by `lms ls --json`'s `modelKey`) is the correct load
 * identifier and is also what the loaded model reports as its API identifier.
 *
 * requiredTotalGB is the total unified-memory footprint (weights + KV + runtime). On the target
 * host os.totalmem() === 31.15 GiB (the full box — memory is unified, no boot carveout), so 24
 * passes for the 27B Q3_K_M (14GB weights) and rejects sub-24 GB machines.
 */
export const MODEL_REGISTRY: Record<string, ModelSpec> = {
  'qwen3.6-27b-mtp': {
    loadKey: 'qwen3.6-27b-mtp@q3_k_m',
    identifierMatch: /qwen3\.6-27b-mtp@q3_k_m/i,
    requiredTotalGB: 24,
  },
  'qwen3.6-35b-a3b': {
    loadKey: 'qwen3.6-35b-a3b@q3_k_s',
    identifierMatch: /qwen3\.6-35b-a3b@q3_k_s/i,
    requiredTotalGB: 30,
  },
  'qwen/qwen3.5-9b': {
    loadKey: 'qwen/qwen3.5-9b',
    identifierMatch: /qwen3\.5-9b/i,
    requiredTotalGB: 18,
  },
};

export const DEFAULT_MODEL = 'qwen3.6-35b-a3b';

/**
 * Coarse sanity floor for the resource check. Sampled post-unload/pre-load. Well below the
 * ~21.6 GiB idle freemem on the target host, so it never fires in normal use, but catches a box
 * already heavily consumed by other processes. Precise fit is delegated to llama.cpp auto-fit +
 * the labeled load-failure path, NOT to this floor. Provisional — tune against real usage.
 */
export const FREE_FLOOR_GB = 4.0;

/** Margin (GiB) added to a parsed `--estimate-only` total for unknown overrides (F4). */
export const ESTIMATE_MARGIN_GB = 1.0;
