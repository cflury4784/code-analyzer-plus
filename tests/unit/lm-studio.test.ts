import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { callLMStudio } from '../../src/lm-studio.js';
import { generatePromptFixture } from '../utils/fixtures.js';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('callLMStudio', () => {
  it('returns content string from choices[0].message.content', async () => {
    server.use(
      http.post('http://localhost:1234/v1/chat/completions', () => generatePromptFixture('{"ok":true}'))
    );
    const result = await callLMStudio('qwen/qwen3.5-9b', 'prompt', 'http://localhost:1234/v1/chat/completions');
    expect(result).toBe('{"ok":true}');
  });

  it('throws with status code on non-200 response', async () => {
    server.use(
      http.post('http://localhost:1234/v1/chat/completions', () =>
        new HttpResponse('Service Unavailable', { status: 503 })
      )
    );
    await expect(
      callLMStudio('qwen/qwen3.5-9b', 'prompt', 'http://localhost:1234/v1/chat/completions')
    ).rejects.toThrow('503');
  });

  it('sends thinking:disabled and num_ctx in request body', async () => {
    let capturedBody: unknown;
    server.use(
      http.post('http://localhost:1234/v1/chat/completions', async ({ request }) => {
        capturedBody = await request.json();
        return generatePromptFixture('ok');
      })
    );
    await callLMStudio('qwen/qwen3.5-9b', 'prompt', 'http://localhost:1234/v1/chat/completions', undefined, 32000);
    expect(capturedBody).toMatchObject({
      thinking: { type: 'disabled' },
      num_ctx: 32000,
    });
  });

  it('defaults num_ctx to 32000', async () => {
    let capturedBody: unknown;
    server.use(
      http.post('http://localhost:1234/v1/chat/completions', async ({ request }) => {
        capturedBody = await request.json();
        return generatePromptFixture('ok');
      })
    );
    await callLMStudio('qwen/qwen3.5-9b', 'prompt', 'http://localhost:1234/v1/chat/completions');
    expect(capturedBody).toMatchObject({
      thinking: { type: 'disabled' },
      num_ctx: 32000,
    });
  });
});
