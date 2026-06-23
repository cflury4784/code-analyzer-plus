export interface PipelineOptions {
  model: string;
  maxBatchSize: number;
  phase: string | undefined;
  resume: boolean;
  timeoutMs: number;
  numCtx: number;
  skipPreflight: boolean;
  gitNexusCtx: import('./gitnexus.js').GitNexusContext | null;
}

export interface PhaseOrchestrator {
  maxAttempts: number;
  runWithRetry<T>(fn: () => Promise<T>, onAttemptError: (attempt: number, err: unknown) => void): Promise<{ value: T; attempts: number } | null>;
  readPhaseStatus(phase: import('./types.js').Phase): import('./types.js').PhaseStatus;
  writePhaseStatus(phase: import('./types.js').Phase, status: import('./types.js').PhaseStatus): void;
}
