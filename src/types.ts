export type PhaseStatus = 'pending' | 'completed' | 'failed';
export type Phase = 'index' | 'analyze' | 'dedup' | 'aggregate';
export type BatchPhase = 'index' | 'analyze' | 'dedup';

export interface FileEntry {
  path: string;
  size_bytes: number;
  skipped: boolean;
  skip_reason: string | null;
}

export interface BatchEntry {
  id: string;
  files: string[];
  size_bytes: number;
  status: 'pending' | 'completed' | 'failed';
  attempts: number;
  completed_at: string | null;
  output_file: string;
}

export interface Finding {
  description: string;
  files: string[];
  severity: 'high' | 'medium' | 'low';
  severity_rationale: string;
  occurrence_count: number;
}

export interface Candidate {
  name: string;
  rationale: string;
  files: string[];
  proposed_signature?: string;  // LLM always emits this; optional only for legacy outputs pre-prompt-update
}

export interface DedupFinding extends Finding {
  convergence_count: number;
}

export interface DedupOutput {
  duplication_clusters: DedupFinding[];
  ui_inconsistencies: DedupFinding[];
  architecture_inconsistencies: DedupFinding[];
  candidate_shared_components: Candidate[];
  candidate_utility_functions: Candidate[];
}

export interface Manifest {
  version: 1;
  created: string;
  last_run: string;
  project_root: string;
  files: FileEntry[];
  batches: {
    index: BatchEntry[];
    analyze: BatchEntry[];
    dedup: BatchEntry[];
  };
  phases: {
    index: PhaseStatus;
    analyze: PhaseStatus;
    dedup: PhaseStatus;
    aggregate: PhaseStatus;
  };
}

export interface IndexOutput {
  module: string;
  responsibilities: string[];
  ui_patterns: string[];
  data_flow: string[];
  dependencies: string[];
  duplicated_logic_candidates: Array<{ description: string; similar_to: string[] }>;
  inconsistencies: Array<{ type: string; issue: string }>;
}

export interface AnalysisOutput {
  duplication_clusters: Finding[];
  ui_inconsistencies: Finding[];
  architecture_inconsistencies: Finding[];
  candidate_shared_components: Candidate[];
  candidate_utility_functions: Candidate[];
}
