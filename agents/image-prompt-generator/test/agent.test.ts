import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  nRouter,
  nRouterAuthenticationError,
  nRouterConfigurationError,
  nRouterCreditError,
  nRouterRateLimitError,
  nRouterServiceError,
} from '@nrouter_ai/sdk';
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  ImagePromptError,
  ImagePromptInputError,
  ImagePromptResponseError,
  MAX_QUERY_LENGTH,
  generateImagePrompt,
  loadSystemPrompt,
  type MessagesClient,
} from '../src/index.js';

// Compile-time proof that the real SDK client satisfies the injectable seam:
// if `nRouter['nr']['messages']` ever drifts from `MessagesClient`, typecheck fails.
const realClientFits: nRouter extends MessagesClient ? true : false = true;
void realClientFits;

const BRAND = readFileSync(new URL('../skills/brand.md', import.meta.url), 'utf8');
const INSTRUCTIONS = readFileSync(new URL('../skills/instructions.md', import.meta.url), 'utf8');

interface Call {
  body: Record<string, unknown>;
}

function fakeClient(reply: unknown | (() => Promise<unknown>)): { client: MessagesClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: MessagesClient = {
    nr: {
      async messages(body: Record<string, unknown>) {
        calls.push({ body });
        if (typeof reply === 'function') {
          return { body: (await (reply as () => Promise<unknown>)()) as Record<string, unknown>, meta: {} };
        }
        return { body: reply as Record<string, unknown>, meta: {} };
      },
    },
  };
  return { client, calls };
}

const TEXT_REPLY = {
  content: [{ type: 'text', text: 'A geometric obsidian gateway with mint light paths.' }],
  stop_reason: 'end_turn',
};

function onlyCall(calls: Call[]): Record<string, unknown> {
  expect(calls).toHaveLength(1);
  const first = calls[0];
  if (!first) throw new Error('no call recorded');
  return first.body;
}

describe('generateImagePrompt', () => {
  let savedModel: string | undefined;

  beforeEach(() => {
    savedModel = process.env.NROUTER_MODEL;
    delete process.env.NROUTER_MODEL;
  });

  afterEach(() => {
    if (savedModel === undefined) delete process.env.NROUTER_MODEL;
    else process.env.NROUTER_MODEL = savedModel;
  });

  it('returns the text of the reply', async () => {
    const { client } = fakeClient(TEXT_REPLY);
    await expect(generateImagePrompt({ query: 'routing hero' }, { client })).resolves.toBe(
      'A geometric obsidian gateway with mint light paths.',
    );
  });

  it('joins multiple text blocks and skips non-text blocks', async () => {
    const { client } = fakeClient({
      content: [
        { type: 'thinking', thinking: 'internal' },
        { type: 'text', text: 'First part.' },
        { type: 'tool_use', id: 'x', name: 'y', input: {} },
        { type: 'text', text: 'Second part.' },
      ],
    });
    await expect(generateImagePrompt({ query: 'q' }, { client })).resolves.toBe('First part.\nSecond part.');
  });

  it('sends the brand rules AND the instructions in the system prompt', async () => {
    const { client, calls } = fakeClient(TEXT_REPLY);
    await generateImagePrompt({ query: 'q' }, { client });
    const body = onlyCall(calls);
    expect(typeof body.system).toBe('string');
    const system = body.system as string;
    expect(system).toContain(INSTRUCTIONS.trim());
    expect(system).toContain(BRAND.trim());
    // Brand invariants that must survive any tidy-up of the skill files.
    expect(system).toContain('#90FCA6');
    expect(system).toContain('#0a0a0b');
    expect(system).toMatch(/NEVER as an AI model/);
  });

  it('sends the trimmed query as the only user message', async () => {
    const { client, calls } = fakeClient(TEXT_REPLY);
    await generateImagePrompt({ query: '  launch banner  ' }, { client });
    expect(onlyCall(calls).messages).toEqual([{ role: 'user', content: 'launch banner' }]);
  });

  describe('model resolution', () => {
    it('uses options.model first', async () => {
      process.env.NROUTER_MODEL = 'env-model';
      const { client, calls } = fakeClient(TEXT_REPLY);
      await generateImagePrompt({ query: 'q', model: 'option-model' }, { client });
      expect(onlyCall(calls).model).toBe('option-model');
    });

    it('falls back to NROUTER_MODEL', async () => {
      process.env.NROUTER_MODEL = 'env-model';
      const { client, calls } = fakeClient(TEXT_REPLY);
      await generateImagePrompt({ query: 'q' }, { client });
      expect(onlyCall(calls).model).toBe('env-model');
    });

    it('treats an empty NROUTER_MODEL as unset', async () => {
      process.env.NROUTER_MODEL = '   ';
      const { client, calls } = fakeClient(TEXT_REPLY);
      await generateImagePrompt({ query: 'q' }, { client });
      expect(onlyCall(calls).model).toBe(DEFAULT_MODEL);
    });

    it('falls back to DEFAULT_MODEL', async () => {
      const { client, calls } = fakeClient(TEXT_REPLY);
      await generateImagePrompt({ query: 'q' }, { client });
      expect(onlyCall(calls).model).toBe(DEFAULT_MODEL);
    });

    it('rejects an empty options.model', async () => {
      const { client, calls } = fakeClient(TEXT_REPLY);
      await expect(generateImagePrompt({ query: 'q', model: ' ' }, { client })).rejects.toMatchObject({
        name: 'ImagePromptInputError',
        field: 'model',
      });
      expect(calls).toHaveLength(0);
    });

    it('rejects a non-string options.model', async () => {
      const { client, calls } = fakeClient(TEXT_REPLY);
      const options = { query: 'q', model: 123 as unknown as string };
      await expect(generateImagePrompt(options, { client })).rejects.toMatchObject({
        name: 'ImagePromptInputError',
        field: 'model',
      });
      expect(calls).toHaveLength(0);
    });
  });

  describe('maxTokens', () => {
    it('defaults to DEFAULT_MAX_TOKENS', async () => {
      const { client, calls } = fakeClient(TEXT_REPLY);
      await generateImagePrompt({ query: 'q' }, { client });
      expect(onlyCall(calls).max_tokens).toBe(DEFAULT_MAX_TOKENS);
    });

    it('passes options.maxTokens through', async () => {
      const { client, calls } = fakeClient(TEXT_REPLY);
      await generateImagePrompt({ query: 'q', maxTokens: 256 }, { client });
      expect(onlyCall(calls).max_tokens).toBe(256);
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects maxTokens=%s', async (maxTokens) => {
      const { client, calls } = fakeClient(TEXT_REPLY);
      await expect(generateImagePrompt({ query: 'q', maxTokens }, { client })).rejects.toMatchObject({
        name: 'ImagePromptInputError',
        field: 'maxTokens',
      });
      expect(calls).toHaveLength(0);
    });

    it('rejects a non-number options.maxTokens', async () => {
      const { client, calls } = fakeClient(TEXT_REPLY);
      const options = { query: 'q', maxTokens: '256' as unknown as number };
      await expect(generateImagePrompt(options, { client })).rejects.toMatchObject({
        name: 'ImagePromptInputError',
        field: 'maxTokens',
      });
      expect(calls).toHaveLength(0);
    });
  });

  describe('input validation', () => {
    it.each(['', '   ', '\n\t'])('rejects blank query %j without calling the gateway', async (query) => {
      const { client, calls } = fakeClient(TEXT_REPLY);
      const err = await generateImagePrompt({ query }, { client }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ImagePromptInputError);
      expect(err).toBeInstanceOf(ImagePromptError);
      expect((err as ImagePromptInputError).field).toBe('query');
      expect(calls).toHaveLength(0);
    });

    it('rejects a non-string query from untyped callers', async () => {
      const { client } = fakeClient(TEXT_REPLY);
      const options = { query: 42 } as unknown as { query: string };
      await expect(generateImagePrompt(options, { client })).rejects.toBeInstanceOf(ImagePromptInputError);
    });

    it('rejects null or undefined query from untyped callers', async () => {
      const { client } = fakeClient(TEXT_REPLY);
      const options = { query: null as unknown as string };
      await expect(generateImagePrompt(options, { client })).rejects.toMatchObject({
        name: 'ImagePromptInputError',
        field: 'query',
      });
    });

    it('accepts a query of exactly MAX_QUERY_LENGTH characters', async () => {
      const { client, calls } = fakeClient(TEXT_REPLY);
      await generateImagePrompt({ query: 'a'.repeat(MAX_QUERY_LENGTH) }, { client });
      expect(calls).toHaveLength(1);
    });

    it('rejects a query longer than MAX_QUERY_LENGTH', async () => {
      const { client, calls } = fakeClient(TEXT_REPLY);
      await expect(
        generateImagePrompt({ query: 'a'.repeat(MAX_QUERY_LENGTH + 1) }, { client }),
      ).rejects.toMatchObject({ name: 'ImagePromptInputError', field: 'query' });
      expect(calls).toHaveLength(0);
    });
  });

  describe('empty responses', () => {
    it.each([
      ['no content array', {}],
      ['empty content', { content: [] }],
      ['only non-text blocks', { content: [{ type: 'tool_use', id: 'x', name: 'y', input: {} }] }],
      ['blank text', { content: [{ type: 'text', text: '   ' }] }],
      ['text that is not a string', { content: [{ type: 'text', text: 7 }] }],
    ])('throws ImagePromptResponseError for %s', async (_label, reply) => {
      const { client } = fakeClient(reply);
      await expect(generateImagePrompt({ query: 'q' }, { client })).rejects.toBeInstanceOf(
        ImagePromptResponseError,
      );
    });

    it('reports stop_reason and request id on an empty response', async () => {
      const client: MessagesClient = {
        nr: {
          async messages() {
            return {
              body: { content: [], stop_reason: 'max_tokens' },
              meta: { requestId: 'req_123' },
            };
          },
        },
      };
      const err = await generateImagePrompt({ query: 'q' }, { client }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ImagePromptResponseError);
      expect((err as ImagePromptResponseError).stopReason).toBe('max_tokens');
      expect((err as ImagePromptResponseError).requestId).toBe('req_123');
      expect((err as Error).message).toContain('max_tokens');
    });
  });

  describe('SDK errors', () => {
    it('propagates an SDK error unchanged', async () => {
      const sdkError = new nRouterRateLimitError('rate limited', { status: 429 });
      const { client } = fakeClient(() => Promise.reject(sdkError));
      const err = await generateImagePrompt({ query: 'q' }, { client }).catch((e: unknown) => e);
      expect(err).toBe(sdkError);
    });

    it('propagates an authentication error unchanged', async () => {
      const sdkError = new nRouterAuthenticationError('bad key', { status: 401 });
      const { client } = fakeClient(() => Promise.reject(sdkError));
      await expect(generateImagePrompt({ query: 'q' }, { client })).rejects.toBe(sdkError);
    });

    it('surfaces the SDK configuration error when no API key is available', async () => {
      const savedKey = process.env.NROUTER_API_KEY;
      delete process.env.NROUTER_API_KEY;
      try {
        await expect(generateImagePrompt({ query: 'q' })).rejects.toBeInstanceOf(nRouterConfigurationError);
      } finally {
        if (savedKey !== undefined) process.env.NROUTER_API_KEY = savedKey;
      }
    });

    it('passes apiKey and baseUrl to the SDK client (rejected offline by its constructor)', async () => {
      const savedKey = process.env.NROUTER_API_KEY;
      delete process.env.NROUTER_API_KEY;
      try {
        // apiKey reaches the client: otherwise the SDK would report a missing key.
        // baseUrl reaches the client as baseURL: the SDK refuses a non-http(s) scheme.
        const err = await generateImagePrompt({
          query: 'q',
          apiKey: 'sk-nrouter-offline-test',
          baseUrl: 'ftp://gateway.example.com',
        }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(nRouterConfigurationError);
        expect((err as Error).message).toMatch(/scheme/);
        expect((err as Error).message).not.toContain('offline-test');
      } finally {
        if (savedKey !== undefined) process.env.NROUTER_API_KEY = savedKey;
      }
    });

    it('propagates a credit error unchanged', async () => {
      const sdkError = new nRouterCreditError('insufficient funds', { status: 402 });
      const { client } = fakeClient(() => Promise.reject(sdkError));
      await expect(generateImagePrompt({ query: 'q' }, { client })).rejects.toBe(sdkError);
    });

    it('propagates a 500 service error unchanged', async () => {
      const sdkError = new nRouterServiceError('internal gateway failure', { status: 500 });
      const { client } = fakeClient(() => Promise.reject(sdkError));
      await expect(generateImagePrompt({ query: 'q' }, { client })).rejects.toBe(sdkError);
    });

    it('never puts the API key in an error message', async () => {
      const apiKey = 'not-a-valid-key-SECRET-VALUE';
      const err = await generateImagePrompt({ query: 'q', apiKey }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain('SECRET-VALUE');
    });
  });
});

describe('loadSystemPrompt', () => {
  it('loads and combines instructions and brand rules in order', async () => {
    const prompt = await loadSystemPrompt();
    expect(prompt).toContain(INSTRUCTIONS.trim());
    expect(prompt).toContain(BRAND.trim());
    expect(prompt.indexOf(INSTRUCTIONS.trim())).toBeLessThan(prompt.indexOf(BRAND.trim()));
  });
});

describe('error classes', () => {
  it('ImagePromptError sets name and preserves cause', () => {
    const cause = new Error('root cause');
    const err = new ImagePromptError('failed', { cause });
    expect(err.name).toBe('ImagePromptError');
    expect(err.message).toBe('failed');
    expect(err.cause).toBe(cause);
    expect(err).toBeInstanceOf(Error);
  });

  it('ImagePromptResponseError defaults requestId and stopReason to null', () => {
    const err = new ImagePromptResponseError('empty');
    expect(err.name).toBe('ImagePromptResponseError');
    expect(err.requestId).toBeNull();
    expect(err.stopReason).toBeNull();
    expect(err).toBeInstanceOf(ImagePromptError);
  });
});
