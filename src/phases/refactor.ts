import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { readManifest, writeManifest, updateBatchStatus, updatePhaseStatus } from '../manifest.js';
import { callLMStudio } from '../lm-studio.js';
import { withRetry } from '../retry.js';
import { refactorPrompt } from '../prompts/templates.js';
import type { Logger } from '../logger.js';
import type { BatchEntry, IndexOutput, RefactorPlanEntry } from '../types.js';

const MAX_ATTEMPTS = 3;
const MAX_FILE_BYTES = 100 * 1024;
const MAX_CONTENT_BUDGET = 28 * 1024;
const DEFAULT_NUM_CTX = 32000;

function safeMaxTokens(promptLen: number, numCtx: number, cap: number): number {
  const inputTokens = Math.ceil(promptLen / 3.5);
  const available = Math.floor(numCtx * 0.85) - inputTokens;
  return Math.max(500, Math.min(available, cap));
}

const VALID_ESCAPES = new Set(['"', "'", '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);

function sanitizeRaw(raw: string): string {
  let s = raw.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();

  let result = '';
  let inString = false;
  let delim = '"';
  let i = 0;

  while (i < s.length) {
    const ch = s[i];
    if (inString) {
      if (ch === '\\') {
        const next = s[i + 1];
        if (next !== undefined && VALID_ESCAPES.has(next)) {
          if (next === 'u') {
            result += s.slice(i, i + 6);
            i += 6;
          } else {
            result += next === "'" ? "'" : ch + next;
            i += 2;
          }
        } else {
          result += '\\\\' + (next ?? '');
          i += 2;
        }
      } else if (ch === delim) {
        inString = false;
        result += '"';
        i++;
      } else if (ch === '"' && delim === "'") {
        result += '\\"';
        i++;
      } else if (ch.charCodeAt(0) < 0x20) {
        result += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
        i++;
      } else {
        result += ch;
        i++;
      }
    } else {
      if (ch === '"' || ch === "'") {
        inString = true;
        delim = ch;
        result += '"';
      } else {
        result += ch;
      }
      i++;
    }
  }
  return result;
}

function buildRefactorGroups(projectRoot: string, logger: Logger): {
  batches: BatchEntry[];
  groups: IndexOutput[][];
  fileContentMaps: Map<string, string>[];
} {
  const manifest = readManifest(projectRoot);
  const dirMap = new Map<string, IndexOutput[]>();

  for (const batch of manifest.batches.index) {
    if (batch.status === 'completed') {
      const items = JSON.parse(readFileSync(join(projectRoot, batch.output_file), 'utf8')) as IndexOutput[];
      for (const item of items) {
        if (!item) continue;
        const topDir = (item.module ?? '.').split('/')[0];
        if (!dirMap.has(topDir)) dirMap.set(topDir, []);
        dirMap.get(topDir)!.push(item);
      }
    }
  }

  const batches: BatchEntry[] = [];
  const groups: IndexOutput[][] = [];
  const fileContentMaps: Map<string, string>[] = [];
  let num = 1;

  const pushPlan = (planItems: IndexOutput[], contentMap: Map<string, string>) => {
    const id = `plan-${String(num).padStart(3, '0')}`;
    batches.push({
      id,
      files: [],
      size_bytes: JSON.stringify(planItems).length,
      status: 'pending',
      attempts: 0,
      completed_at: null,
      output_file: `code-analysis/refactor/${id}.md`,
    });
    groups.push(planItems);
    fileContentMaps.push(contentMap);
    num++;
  };

  for (const [, items] of dirMap) {
    // Load full file content — skip files over MAX_FILE_BYTES.
    const loaded: Array<{ item: IndexOutput; content: string }> = [];
    const noContent: IndexOutput[] = [];

    for (const item of items) {
      try {
        const content = readFileSync(join(projectRoot, item.module), 'utf8');
        if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
          logger.debug('skipping large file', { path: item.module });
          noContent.push(item);
        } else {
          loaded.push({ item, content });
        }
      } catch {
        logger.debug('skipping unreadable file', { path: item.module });
        noContent.push(item);
      }
    }

    // Split into sub-batches so no plan exceeds MAX_CONTENT_BUDGET.
    let subItems: IndexOutput[] = [];
    let subMap = new Map<string, string>();
    let subBytes = 0;

    for (const { item, content } of loaded) {
      if (subBytes + content.length > MAX_CONTENT_BUDGET && subItems.length > 0) {
        pushPlan(subItems, subMap);
        subItems = [];
        subMap = new Map();
        subBytes = 0;
      }
      subItems.push(item);
      subMap.set(item.module, content);
      subBytes += content.length;
    }

    // Attach index-only items (no file on disk) to the last sub-batch.
    subItems.push(...noContent);
    if (subItems.length > 0) pushPlan(subItems, subMap);
  }

  return { batches, groups, fileContentMaps };
}

export function toMarkdown(entries: RefactorPlanEntry[]): string {
  return entries.map(p => {
    if ('verdict' in p) {
      const checks = p.checks_performed.join(', ');
      const notePart = p.note ? `— ${p.note} ` : '';
      return `## ${p.file}\n\n✓ No violations ${notePart}(confidence: ${p.confidence} | checks: ${checks})`;
    }
    const beforeLines = p.before_lines ? ` (lines ${p.before_lines})` : '';
    return `## ${p.file}\n\n**Change:** ${p.change}\n\n**Before**${beforeLines}:\n\`\`\`\n${p.before}\n\`\`\`\n\n**After:**\n\`\`\`\n${p.after}\n\`\`\`\n\n**Dependencies:** ${p.dependencies_impacted.join(', ') || 'none'}\n\n**Tests:** ${p.tests_to_validate.join('; ') || 'none'}`;
  }).join('\n\n---\n\n');
}

export async function runRefactorPhase(
  projectRoot: string,
  model: string,
  logger: Logger,
  lmUrl?: string,
  timeoutMs?: number,
  numCtx?: number,
  signal?: AbortSignal,
): Promise<void> {
  let manifest = readManifest(projectRoot);
  const { batches: computedBatches, groups, fileContentMaps } = buildRefactorGroups(projectRoot, logger);

  if (manifest.batches.refactor.length === 0) {
    manifest.batches.refactor = computedBatches;
    writeManifest(projectRoot, manifest);
    manifest = readManifest(projectRoot);
  }

  const total = manifest.batches.refactor.length;
  const pending = manifest.batches.refactor.filter(b => b.status !== 'completed').length;
  logger.info('Phase 4 — Refactor Planning', { model, plans: total, pending });
  const standardsMd = readFileSync(join(projectRoot, 'code-analysis', 'aggregate', 'standards.md'), 'utf8');
  let failedCount = 0;
  let doneCount = total - pending;

  for (let i = 0; i < manifest.batches.refactor.length; i++) {
    const batch = manifest.batches.refactor[i];
    if (batch.status === 'completed') continue;

    const moduleItems = groups[i] ?? [];
    const contentMap = fileContentMaps[i] ?? new Map<string, string>();

    const result = await withRetry(
      async () => {
        const prompt = refactorPrompt(standardsMd, moduleItems, contentMap);
        const maxTokens = safeMaxTokens(prompt.length, numCtx ?? DEFAULT_NUM_CTX, 4000);
        const raw = await callLMStudio(model, prompt, lmUrl, timeoutMs, numCtx, signal, maxTokens);
        logger.debug(`${batch.id} raw`, { preview: raw.slice(0, 300) });
        const parsed = JSON.parse(sanitizeRaw(raw)) as RefactorPlanEntry[];
        if (parsed.length === 0) {
          parsed.push({
            file: moduleItems.map(m => m.module).join(', ') || batch.id,
            verdict: 'no_violations',
            checks_performed: [],
            confidence: 'low',
            note: 'model returned no violations',
          });
        }
        mkdirSync(join(projectRoot, 'code-analysis', 'refactor'), { recursive: true });
        writeFileSync(join(projectRoot, batch.output_file), toMarkdown(parsed), 'utf8');
        return parsed;
      },
      MAX_ATTEMPTS,
      (attempt, err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`${batch.id} failed (attempt ${attempt}/${MAX_ATTEMPTS})`, { error: msg });
      },
      signal,
    );

    if (result) {
      doneCount++;
      updateBatchStatus(projectRoot, 'refactor', batch.id, 'completed', result.attempts);
      logger.info(`${batch.id} done (${doneCount}/${total})`);
    } else {
      updateBatchStatus(projectRoot, 'refactor', batch.id, 'failed', MAX_ATTEMPTS);
      failedCount++;
    }
  }

  const finalStatus = failedCount > 0 ? 'failed' : 'completed';
  updatePhaseStatus(projectRoot, 'refactor', finalStatus);
  logger.info(`Phase 4 ${finalStatus}`, { plans: total, failed: failedCount });
}
