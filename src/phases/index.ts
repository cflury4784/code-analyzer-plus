import { readManifest, updatePhaseStatus } from '../manifest.js';
import { callLMStudio } from '../lm-studio.js';
import { indexPrompt } from '../prompts/templates.js';
import { getFileStructure } from '../gitnexus.js';
import { extractJson } from '../utils/index.js';
import type { Logger } from '../logger.js';
import type { IndexOutput } from '../types.js';
import type { GitNexusContext } from '../gitnexus.js';
import type { FileSystemService } from '../fs-service.js';
import type { PhaseOrchestrator } from '../phase-orchestrator-types.js';
import { runPhaseBatches } from './phase-runner.js';

export async function runIndexPhase(
  orchestrator: PhaseOrchestrator,
  projectRoot: string,
  model: string,
  logger: Logger,
  fs: FileSystemService,
  lmUrl?: string,
  timeoutMs?: number,
  numCtx?: number,
  signal?: AbortSignal,
  gitNexusCtx?: GitNexusContext | null,
): Promise<void> {
  updatePhaseStatus(projectRoot, 'index', 'pending');

  const manifest = readManifest(projectRoot);
  const total = manifest.batches.index.length;
  const pending = manifest.batches.index.filter(b => b.status !== 'completed').length;
  logger.info('Phase 1 — Indexing', { model, batches: total, pending });

  // fileContents only exists to build the prompt inside trySkip; once prompt is
  // built it is dead weight, so it is NOT carried in the map.
  type IndexPrep = {
    graphData: Awaited<ReturnType<typeof getFileStructure>> | null;
    prompt: string;
  };
  const prepared = new Map<string, IndexPrep>();

  const { failedCount } = await runPhaseBatches<IndexOutput[]>({
    orchestrator,
    projectRoot,
    phase: 'index',
    batches: manifest.batches.index,
    logger,
    successMeta: (batch) => ({ files: batch.files.length }),
    // Missing-files skip + graph prefetch + prompt build + token warn happen ONCE
    // per batch here, before retries — matching the original behavior.
    trySkip: async (batch) => {
      const fileContents = batch.files
        .filter(filePath => {
          if (fs.existsSync(fs.join(projectRoot, filePath))) return true;
          logger.warn(`${batch.id} skipping missing file`, { path: filePath });
          return false;
        })
        .map(filePath => ({
          path: filePath,
          content: fs.readFileSync(fs.join(projectRoot, filePath)),
        }));

      if (fileContents.length === 0) {
        return { logSuffix: ' — all files missing, skipped' };
      }

      // Pre-fetch structural data from GitNexus if available
      const graphData = gitNexusCtx
        ? await getFileStructure(gitNexusCtx, batch.files)
        : null;

      const prompt = indexPrompt(fileContents, graphData);
      const estTokens = Math.ceil(prompt.length / 3.5);
      const ctxForEstimate = numCtx ?? 32000;
      if (estTokens > ctxForEstimate * 0.75) {
        logger.warn(`${batch.id} prompt estimate ~${estTokens} tokens exceeds 75% of ctx=${ctxForEstimate} — consider splitting`, { files: batch.files.length, size_bytes: batch.size_bytes });
      }

      prepared.set(batch.id, { graphData, prompt });
      return null;
    },
    work: async (batch) => {
      // trySkip always populates this for non-skipped batches (it runs first).
      const { graphData, prompt } = prepared.get(batch.id)!;
      const raw = await callLMStudio(model, prompt, lmUrl, timeoutMs, numCtx, signal, 1500);
      const parsed = extractJson(raw) as Partial<IndexOutput>[];

      // Guard: model sometimes returns a flat string[] (e.g. just the responsibilities
      // array) instead of an IndexOutput[]. Throwing here lets the orchestrator retry the batch.
      if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'object' || item === null || !('module' in item))) {
        throw new Error(`model returned invalid schema: expected IndexOutput[], got ${JSON.stringify(parsed).slice(0, 120)}`);
      }

      // Merge graph-sourced structural fields back into each item
      // data_flow is intentionally omitted — import paths are not data flow descriptions;
      // leave it for the LLM to infer from file contents
      const enriched: IndexOutput[] = parsed.map(item => {
        const posixModule = (item.module ?? '').replace(/\\/g, '/');
        const structure = graphData?.get(posixModule);
        if (!structure) return item as IndexOutput;
        return {
          ...item,
          dependencies: structure.imports,
        } as IndexOutput;
      });

      fs.mkdirSync(fs.join(projectRoot, 'code-analysis', 'index'));
      fs.writeFileSync(fs.join(projectRoot, batch.output_file), JSON.stringify(enriched, null, 2));
      return enriched;
    },
  });

  const finalStatus = failedCount > 0 ? 'failed' : 'completed';
  updatePhaseStatus(projectRoot, 'index', finalStatus);
  logger.info(`Phase 1 ${finalStatus}`, { batches: total, failed: failedCount });
}
