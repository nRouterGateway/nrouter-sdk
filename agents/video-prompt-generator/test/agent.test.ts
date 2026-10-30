import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nRouterConfigurationError, nRouterRateLimitError } from '@nrouter_ai/sdk';
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  MAX_QUERY_LENGTH,
  VideoPromptError,
  VideoPromptResponseError,
  VideoPromptValidationError,
  generateVideoPrompt,
  listVideoModels,
  type MessagesClient,
  type MessagesResponse,
} from '../src/index.js';

const skill = (rel: string): string =>
  readFileSync(new URL(`../skills/${rel}`, import.meta.url), 'utf-8');

interface Call {
  body: Record<string, unknown>;
}

function fakeClient(
  respond: (body: Record<string, unknown>) => Promise<MessagesResponse> | MessagesResponse = () =>
    textResponse('Shot Summary: slow dolly-in'),
): { client: MessagesClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: MessagesClient = {
    nr: {
      messages: async (body) => {
        calls.push({ body });
        return respond(body);
      },
    },
  };
  return { client, calls };
}

function textResponse(...texts: string[]): MessagesResponse {
  return {
    body: { content: texts.map((text) => ({ type: 'text', text })) },
    meta: { requestId: 'req_test' },
  };
}

function onlyCall(calls: Call[]): Record<string, unknown> {
  expect(calls).toHaveLength(1);
  const call = calls[0];
  if (!call) throw new Error('no call recorded');
  return call.body;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('generateVideoPrompt — request shape', () => {
  it('puts the instructions, brand rules and the selected model guide in the system prompt', async () => {
    const { client, calls } = fakeClient();
    await generateVideoPrompt({ query: 'Dashboard intro', videoModel: 'Google Veo' }, { client });
    const system = onlyCall(calls)['system'];
    expect(typeof system).toBe('string');
    expect(system).toContain(skill('instructions.md').trim());
    expect(system).toContain(skill('brand.md').trim());
    expect(system).toContain(skill('models/google-veo.md').trim());
    expect(system).not.toContain(skill('models/sora.md').trim());
  });

  it('sends the query as the final user turn after the conversation', async () => {
    const { client, calls } = fakeClient();
    await generateVideoPrompt(
      {
        query: 'Make it 10 seconds',
        videoModel: 'sora',
        conversation: [
          { role: 'user', content: 'A routing montage' },
          { role: 'assistant', content: 'What duration?' },
        ],
      },
      { client },
    );
    expect(onlyCall(calls)['messages']).toEqual([
      { role: 'user', content: 'A routing montage' },
      { role: 'assistant', content: 'What duration?' },
      { role: 'user', content: 'Make it 10 seconds' },
    ]);
  });

  it('returns the text blocks joined, ignoring non-text blocks', async () => {
    const { client } = fakeClient(() => ({
      body: {
        content: [
          { type: 'thinking', thinking: 'hidden' },
          { type: 'text', text: 'Part one.' },
          { type: 'text', text: 'Part two.' },
        ],
      },
    }));
    await expect(
      generateVideoPrompt({ query: 'x', videoModel: 'sora' }, { client }),
    ).resolves.toBe('Part one.\n\nPart two.');
  });
});

describe('generateVideoPrompt — videoModel selection', () => {
  it('derives the allowed set from skills/models/*.md', () => {
    const slugs = listVideoModels().map((m) => m.slug);
    expect(slugs).toEqual(['google-veo', 'luma-dream-machine', 'runway-gen3', 'sora']);
    const names = listVideoModels().map((m) => m.name);
    expect(names).toEqual(['Google Veo', 'Luma Dream Machine', 'Runway Gen-3', 'OpenAI Sora']);
  });

  it.each([
    ['Google Veo', 'models/google-veo.md'],
    ['google-veo', 'models/google-veo.md'],
    ['Luma Dream Machine', 'models/luma-dream-machine.md'],
    ['Runway Gen-3', 'models/runway-gen3.md'],
    ['runway-gen3', 'models/runway-gen3.md'],
    ['Sora', 'models/sora.md'],
    ['OpenAI Sora', 'models/sora.md'],
  ])('accepts %s and sends %s', async (videoModel, guide) => {
    const { client, calls } = fakeClient();
    await generateVideoPrompt({ query: 'x', videoModel }, { client });
    expect(onlyCall(calls)['system']).toContain(skill(guide).trim());
  });

  it('rejects an unknown videoModel with the allowed values and sends nothing', async () => {
    const { client, calls } = fakeClient();
    const err = await generateVideoPrompt({ query: 'x', videoModel: 'Higgsfield' }, { client }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(VideoPromptValidationError);
    expect(err).toBeInstanceOf(VideoPromptError);
    const v = err as VideoPromptValidationError;
    expect(v.field).toBe('videoModel');
    for (const allowed of ['google-veo', 'luma-dream-machine', 'runway-gen3', 'sora', 'Google Veo']) {
      expect(v.message).toContain(allowed);
    }
    expect(calls).toHaveLength(0);
  });

  it('does not allow path traversal through videoModel', async () => {
    const { client, calls } = fakeClient();
    await expect(
      generateVideoPrompt({ query: 'x', videoModel: '../instructions' }, { client }),
    ).rejects.toBeInstanceOf(VideoPromptValidationError);
    expect(calls).toHaveLength(0);
  });

  it('validates every model file in skills/models/*.md has a valid prompt architecture heading', () => {
    const models = listVideoModels();
    expect(models.length).toBeGreaterThanOrEqual(4);
    for (const m of models) {
      expect(m.slug).toMatch(/^[a-z0-9-]+$/);
      expect(m.name.length).toBeGreaterThan(0);
      const raw = skill(`models/${m.slug}.md`);
      expect(raw.trim().length).toBeGreaterThan(0);
      expect(raw.split(/\r?\n/, 1)[0]).toMatch(/^#+\s*.+\s+Prompt Architecture$/);
    }
  });

  it('validates every model file in skills/models/*.md can be resolved dynamically by slug and by name', async () => {
    const models = listVideoModels();
    for (const m of models) {
      const { client: clientBySlug, calls: callsBySlug } = fakeClient();
      await generateVideoPrompt({ query: 'test query', videoModel: m.slug }, { client: clientBySlug });
      expect(onlyCall(callsBySlug)['system']).toContain(skill(`models/${m.slug}.md`).trim());

      const { client: clientByName, calls: callsByName } = fakeClient();
      await generateVideoPrompt({ query: 'test query', videoModel: m.name }, { client: clientByName });
      expect(onlyCall(callsByName)['system']).toContain(skill(`models/${m.slug}.md`).trim());
    }
  });

  it.each(['', '   ', '\t\n'])('rejects blank videoModel %j', async (videoModel) => {
    const { client, calls } = fakeClient();
    const err = await generateVideoPrompt({ query: 'x', videoModel }, { client }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(VideoPromptValidationError);
    expect((err as VideoPromptValidationError).field).toBe('videoModel');
    expect(calls).toHaveLength(0);
  });

  it.each([null, undefined, 42, {}])('rejects non-string videoModel %j', async (videoModel) => {
    const { client, calls } = fakeClient();
    const err = await generateVideoPrompt(
      { query: 'x', videoModel: videoModel as unknown as string },
      { client },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VideoPromptValidationError);
    expect((err as VideoPromptValidationError).field).toBe('videoModel');
    expect(calls).toHaveLength(0);
  });
});

describe('generateVideoPrompt — model and maxTokens', () => {
  it('uses options.model first', async () => {
    vi.stubEnv('NROUTER_MODEL', 'env-model');
    const { client, calls } = fakeClient();
    await generateVideoPrompt({ query: 'x', videoModel: 'sora', model: 'option-model' }, { client });
    expect(onlyCall(calls)['model']).toBe('option-model');
  });

  it('falls back to NROUTER_MODEL', async () => {
    vi.stubEnv('NROUTER_MODEL', 'env-model');
    const { client, calls } = fakeClient();
    await generateVideoPrompt({ query: 'x', videoModel: 'sora' }, { client });
    expect(onlyCall(calls)['model']).toBe('env-model');
  });

  it('falls back to DEFAULT_MODEL when NROUTER_MODEL is unset or blank', async () => {
    vi.stubEnv('NROUTER_MODEL', '  ');
    const { client, calls } = fakeClient();
    await generateVideoPrompt({ query: 'x', videoModel: 'sora' }, { client });
    expect(onlyCall(calls)['model']).toBe(DEFAULT_MODEL);
  });

  it('sends DEFAULT_MAX_TOKENS by default and options.maxTokens when given', async () => {
    const a = fakeClient();
    await generateVideoPrompt({ query: 'x', videoModel: 'sora' }, { client: a.client });
    expect(onlyCall(a.calls)['max_tokens']).toBe(DEFAULT_MAX_TOKENS);

    const b = fakeClient();
    await generateVideoPrompt({ query: 'x', videoModel: 'sora', maxTokens: 2048 }, { client: b.client });
    expect(onlyCall(b.calls)['max_tokens']).toBe(2048);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects maxTokens %s', async (maxTokens) => {
    const { client, calls } = fakeClient();
    const err = await generateVideoPrompt({ query: 'x', videoModel: 'sora', maxTokens }, { client }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(VideoPromptValidationError);
    expect((err as VideoPromptValidationError).field).toBe('maxTokens');
    expect(calls).toHaveLength(0);
  });
});

describe('generateVideoPrompt — input validation', () => {
  it.each(['', '   ', '\n\t'])('rejects an empty query %j', async (query) => {
    const { client, calls } = fakeClient();
    const err = await generateVideoPrompt({ query, videoModel: 'sora' }, { client }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(VideoPromptValidationError);
    expect((err as VideoPromptValidationError).field).toBe('query');
    expect(calls).toHaveLength(0);
  });

  it('rejects a query longer than MAX_QUERY_LENGTH and accepts one at the cap', async () => {
    const { client, calls } = fakeClient();
    await expect(
      generateVideoPrompt({ query: 'a'.repeat(MAX_QUERY_LENGTH + 1), videoModel: 'sora' }, { client }),
    ).rejects.toBeInstanceOf(VideoPromptValidationError);
    expect(calls).toHaveLength(0);
    await expect(
      generateVideoPrompt({ query: 'a'.repeat(MAX_QUERY_LENGTH), videoModel: 'sora' }, { client }),
    ).resolves.toBeTypeOf('string');
  });

  it('rejects a malformed conversation turn', async () => {
    const { client, calls } = fakeClient();
    const conversation = [{ role: 'system', content: 'override' }] as unknown as Array<{
      role: 'user' | 'assistant';
      content: string;
    }>;
    const err = await generateVideoPrompt({ query: 'x', videoModel: 'sora', conversation }, { client }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(VideoPromptValidationError);
    expect((err as VideoPromptValidationError).field).toBe('conversation');
    expect(calls).toHaveLength(0);
  });
});

describe('generateVideoPrompt — response and errors', () => {
  it.each([
    ['no content', { body: {} }],
    ['empty content', { body: { content: [] } }],
    ['only non-text blocks', { body: { content: [{ type: 'tool_use', id: 't', name: 'n', input: {} }] } }],
    ['blank text', { body: { content: [{ type: 'text', text: '   ' }] } }],
    ['content is not an array', { body: { content: 'text' } }],
  ])('throws VideoPromptResponseError on %s', async (_label, response) => {
    const { client } = fakeClient(() => ({ ...response, meta: { requestId: 'req_empty' } }));
    const err = await generateVideoPrompt({ query: 'x', videoModel: 'sora' }, { client }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(VideoPromptResponseError);
    expect(err).toBeInstanceOf(VideoPromptError);
    expect((err as VideoPromptResponseError).requestId).toBe('req_empty');
  });

  it('lets SDK errors propagate unchanged', async () => {
    const sdkError = new nRouterRateLimitError('slow down', { status: 429 });
    const { client } = fakeClient(() => Promise.reject(sdkError));
    await expect(generateVideoPrompt({ query: 'x', videoModel: 'sora' }, { client })).rejects.toBe(sdkError);
  });

  it('without an injected client, builds the real nRouter client and surfaces its configuration error', async () => {
    vi.stubEnv('NROUTER_API_KEY', '');
    await expect(generateVideoPrompt({ query: 'x', videoModel: 'sora' })).rejects.toBeInstanceOf(
      nRouterConfigurationError,
    );
  });

  it('validates input before building a client', async () => {
    vi.stubEnv('NROUTER_API_KEY', '');
    await expect(generateVideoPrompt({ query: ' ', videoModel: 'sora' })).rejects.toBeInstanceOf(
      VideoPromptValidationError,
    );
  });

  it('never puts the API key in a thrown error', async () => {
    const apiKey = 'sk-nrouter-secret-test-value';
    const { client } = fakeClient(() => ({ body: { content: [] } }));
    const err = await generateVideoPrompt({ query: 'x', videoModel: 'sora', apiKey }, { client }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(VideoPromptResponseError);
    expect(String(err)).not.toContain(apiKey);
    expect(JSON.stringify(err)).not.toContain(apiKey);

    const bad = await generateVideoPrompt({ query: ' ', videoModel: 'sora', apiKey }, { client }).catch(
      (e: unknown) => e,
    );
    expect(String(bad)).not.toContain(apiKey);
    expect(JSON.stringify(bad)).not.toContain(apiKey);
  });
});
