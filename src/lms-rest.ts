import { runLms, estimateTotalGB } from './lms.js';
import type { LoadedModel, LoadOpts, RunLms, Lms } from './lms.js';

const API_BASE = 'http://localhost:1234/api/v1';

interface ApiInstance {
  id: string;
  config: { context_length: number };
}

interface ApiModel {
  type: 'llm' | 'embedding';
  key: string;
  loaded_instances: ApiInstance[];
}

async function apiFetch(
  path: string,
  init: RequestInit = {},
  timeoutMs = 10_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init.headers as Record<string, string> },
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`LMS REST ${path} timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function getModels(): Promise<ApiModel[]> {
  const res = await apiFetch('/models');
  if (!res.ok) throw new Error(`GET /api/v1/models returned ${res.status}`);
  const data = await res.json() as { models: ApiModel[] };
  return data.models ?? [];
}

export async function serverStatus(
  _deps?: { runLms: RunLms },
): Promise<{ running: boolean; port: number }> {
  try {
    const res = await apiFetch('/models', {}, 3000);
    return { running: res.ok, port: 1234 };
  } catch {
    return { running: false, port: 0 };
  }
}

export async function startServer(
  deps?: { runLms: RunLms; serverStatus(_d?: { runLms: RunLms }): Promise<{ running: boolean; port: number }> },
  pollBudgetMs = 30_000,
  pollIntervalMs = 1_000,
): Promise<void> {
  await (deps?.runLms ?? runLms)(['server', 'start']);
  const deadline = Date.now() + pollBudgetMs;
  while (Date.now() < deadline) {
    const s = deps ? await deps.serverStatus() : await serverStatus();
    if (s.running) return;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`LMS server did not report running within ${pollBudgetMs / 1000}s`);
}

export async function listLoaded(
  _deps?: { runLms: RunLms },
): Promise<LoadedModel[]> {
  const models = await getModels();
  return models
    .filter((m) => m.loaded_instances.length > 0)
    .flatMap((m) =>
      m.loaded_instances.map((inst) => ({
        identifier: m.key,
        instance_id: inst.id,
      } as LoadedModel)),
    );
}

export async function unloadAll(_deps?: { runLms: RunLms }): Promise<void> {
  const models = await getModels();
  const instanceIds = models.flatMap((m) => m.loaded_instances.map((i) => i.id));
  await Promise.all(
    instanceIds.map((instance_id) =>
      apiFetch('/models/unload', {
        method: 'POST',
        body: JSON.stringify({ instance_id }),
      }),
    ),
  );
}

const DEFAULT_LOAD_TIMEOUT_MS = 10 * 60 * 1000;

export async function load(
  loadKey: string,
  opts: LoadOpts,
  _deps?: { runLms: RunLms },
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;
  const res = await apiFetch(
    '/models/load',
    {
      method: 'POST',
      body: JSON.stringify({ model: loadKey, context_length: opts.contextLength }),
    },
    timeoutMs,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    throw new Error(`LMS load failed (${res.status}): ${body}`);
  }
}

export const lmsRest: Lms = {
  serverStatus,
  startServer,
  listLoaded,
  unloadAll,
  estimateTotalGB,
  load,
};
