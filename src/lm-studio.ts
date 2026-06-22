interface StreamChunk {
  choices: Array<{ delta: { content?: string }; finish_reason: string | null }>;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_NUM_CTX = 32000;

async function readStream(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  try {
    while (true) {
      if (signal.aborted) throw new Error('LM Studio request cancelled');
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6).trim();
        if (data === '[DONE]') return content;
        try {
          const chunk = JSON.parse(data) as StreamChunk;
          content += chunk.choices[0]?.delta?.content ?? '';
        } catch { /* skip malformed SSE lines */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return content;
}

export async function callLMStudio(
  model: string,
  prompt: string,
  url: string = 'http://localhost:1234/v1/chat/completions',
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  numCtx: number = DEFAULT_NUM_CTX,
  signal?: AbortSignal,
  maxTokens?: number,
): Promise<string> {
  if (signal?.aborted) throw new Error('LM Studio request cancelled');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Forward external cancellation (SIGINT/SIGTERM) into our controller.
  const forwardAbort = () => controller.abort();
  signal?.addEventListener('abort', forwardAbort);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        thinking: { type: 'disabled' },
        reasoning_effort: 'none',
        num_ctx: numCtx,
        ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
        cache_prompt: true,
        stream: true,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      if (signal?.aborted) throw new Error('LM Studio request cancelled');
      throw new Error(`LM Studio request timed out after ${timeoutMs / 1000}s`);
    }
    if (err instanceof Error) {
      const cause = (err as NodeJS.ErrnoException).cause;
      const causeMsg = cause instanceof Error ? ` (${cause.message})` : '';
      throw new Error(`LM Studio connection failed${causeMsg} — is LM Studio running on ${url}?`);
    }
    throw err;
  }

  if (!res.ok) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
    throw new Error(`LM Studio returned ${res.status}: ${await res.text()}`);
  }

  try {
    const raw = await readStream(res.body!, controller.signal);
    // Strip markdown code fences and any trailing content after closing fence
    let cleaned = raw.trim();
    const fenceMatch = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenceMatch) {
      cleaned = fenceMatch[1].trim();
    }
    return cleaned;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      if (signal?.aborted) throw new Error('LM Studio request cancelled');
      throw new Error(`LM Studio request timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}
