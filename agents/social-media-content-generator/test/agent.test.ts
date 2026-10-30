import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_META,
  nRouterConfigurationError,
  nRouterCreditError,
  type NRouterResponse,
} from '@nrouter_ai/sdk';
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  MAX_HISTORY_ITEM_LENGTH,
  MAX_HISTORY_ITEMS,
  MAX_TOPIC_LENGTH,
  SUPPORTED_PLATFORMS,
  SocialMediaAgentError,
  SocialMediaInputError,
  SocialMediaResponseError,
  generateSocialMediaContent,
  type MessagesClient,
  type SocialMediaOptions,
} from '../src/index.js';

type Body = Record<string, unknown>;

interface FakeClient extends MessagesClient {
  calls: Body[];
}

function fakeClient(
  respond: (body: Body) => Body | Promise<Body> = () => ({
    content: [{ type: 'text', text: 'Hook. Problem. Mechanism.' }],
    stop_reason: 'end_turn',
  }),
): FakeClient {
  const calls: Body[] = [];
  return {
    calls,
    nr: {
      async messages(body: Body): Promise<NRouterResponse<Body>> {
        calls.push(body);
        return { body: await respond(body), meta: EMPTY_META };
      },
    },
  };
}

function only<T>(items: T[]): T {
  expect(items).toHaveLength(1);
  return items[0] as T;
}

function userText(body: Body): string {
  const messages = body['messages'];
  if (!Array.isArray(messages)) throw new Error('messages missing');
  const first: unknown = messages[0];
  if (typeof first !== 'object' || first === null) throw new Error('bad message');
  const content: unknown = (first as Record<string, unknown>)['content'];
  if (typeof content !== 'string') throw new Error('content is not a string');
  return content;
}

const skill = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../skills/${name}`, import.meta.url)), 'utf8').trim();

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('generateSocialMediaContent — request', () => {
  it('returns the text of the response', async () => {
    const client = fakeClient();
    await expect(generateSocialMediaContent({ topic: 'gateway failover' }, { client })).resolves.toBe(
      'Hook. Problem. Mechanism.',
    );
  });

  it('puts both skill files in the system prompt', async () => {
    const client = fakeClient();
    await generateSocialMediaContent({ topic: 'gateway failover' }, { client });
    const system = only(client.calls)['system'];
    expect(typeof system).toBe('string');
    expect(system).toContain(skill('instructions.md'));
    expect(system).toContain(skill('brand.md'));
  });

  it('sends the trimmed topic as the user message', async () => {
    const client = fakeClient();
    await generateSocialMediaContent({ topic: '  p99 latency under failover \n' }, { client });
    const body = only(client.calls);
    expect(userText(body)).toContain('Topic: p99 latency under failover');
    expect(body['messages']).toHaveLength(1);
  });

  it('resolves the model: option, then NROUTER_MODEL, then the default', async () => {
    vi.stubEnv('NROUTER_MODEL', 'env-model');
    const client = fakeClient();
    await generateSocialMediaContent({ topic: 't', model: 'option-model' }, { client });
    await generateSocialMediaContent({ topic: 't' }, { client });
    vi.stubEnv('NROUTER_MODEL', '');
    await generateSocialMediaContent({ topic: 't' }, { client });
    expect(client.calls.map((b) => b['model'])).toEqual(['option-model', 'env-model', DEFAULT_MODEL]);
  });

  it('sends maxTokens as max_tokens, defaulting to DEFAULT_MAX_TOKENS', async () => {
    const client = fakeClient();
    await generateSocialMediaContent({ topic: 't', maxTokens: 300 }, { client });
    await generateSocialMediaContent({ topic: 't' }, { client });
    expect(client.calls.map((b) => b['max_tokens'])).toEqual([300, DEFAULT_MAX_TOKENS]);
  });

  it('joins multiple text blocks and ignores non-text blocks', async () => {
    const client = fakeClient(() => ({
      content: [
        { type: 'thinking', thinking: 'internal' },
        { type: 'text', text: 'Part one.' },
        { type: 'text', text: ' Part two.' },
      ],
    }));
    await expect(generateSocialMediaContent({ topic: 't' }, { client })).resolves.toBe('Part one. Part two.');
  });
});

describe('generateSocialMediaContent — history', () => {
  it('lists every history item in the prompt as a topic to avoid', async () => {
    const client = fakeClient();
    await generateSocialMediaContent(
      { topic: 'mTLS sidecars', history: ['retry storms', 'token budgets'] },
      { client },
    );
    const text = userText(only(client.calls));
    expect(text).toContain('- retry storms');
    expect(text).toContain('- token budgets');
    expect(text).toMatch(/do not repeat/i);
  });

  it('omits the history section when history is empty or absent', async () => {
    const client = fakeClient();
    await generateSocialMediaContent({ topic: 't', history: [] }, { client });
    await generateSocialMediaContent({ topic: 't' }, { client });
    for (const body of client.calls) expect(userText(body)).not.toMatch(/do not repeat/i);
  });

  it(`rejects more than ${MAX_HISTORY_ITEMS} history items without sending`, async () => {
    const client = fakeClient();
    const history = Array.from({ length: MAX_HISTORY_ITEMS + 1 }, (_, i) => `topic ${i}`);
    const err = await generateSocialMediaContent({ topic: 't', history }, { client }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SocialMediaInputError);
    expect((err as SocialMediaInputError).field).toBe('history');
    expect(client.calls).toHaveLength(0);
  });

  it('accepts exactly MAX_HISTORY_ITEMS items', async () => {
    const client = fakeClient();
    const history = Array.from({ length: MAX_HISTORY_ITEMS }, (_, i) => `topic ${i}`);
    await generateSocialMediaContent({ topic: 't', history }, { client });
    expect(client.calls).toHaveLength(1);
  });

  it(`rejects a history item longer than ${MAX_HISTORY_ITEM_LENGTH} characters`, async () => {
    const client = fakeClient();
    const history = ['ok', 'x'.repeat(MAX_HISTORY_ITEM_LENGTH + 1)];
    await expect(generateSocialMediaContent({ topic: 't', history }, { client })).rejects.toMatchObject({
      name: 'SocialMediaInputError',
      field: 'history',
    });
    expect(client.calls).toHaveLength(0);
  });

  it('rejects blank or non-string history items', async () => {
    const client = fakeClient();
    await expect(generateSocialMediaContent({ topic: 't', history: ['  '] }, { client })).rejects.toBeInstanceOf(
      SocialMediaInputError,
    );
    const notStrings = [42] as unknown as string[];
    await expect(generateSocialMediaContent({ topic: 't', history: notStrings }, { client })).rejects.toBeInstanceOf(
      SocialMediaInputError,
    );
    expect(client.calls).toHaveLength(0);
  });

  it('rejects a non-array history value', async () => {
    const client = fakeClient();
    const notArray = 'single-topic' as unknown as string[];
    await expect(generateSocialMediaContent({ topic: 't', history: notArray }, { client })).rejects.toMatchObject({
      name: 'SocialMediaInputError',
      field: 'history',
    });
    expect(client.calls).toHaveLength(0);
  });

  it(`accepts a history item of exactly ${MAX_HISTORY_ITEM_LENGTH} characters`, async () => {
    const client = fakeClient();
    const history = ['x'.repeat(MAX_HISTORY_ITEM_LENGTH)];
    await generateSocialMediaContent({ topic: 't', history }, { client });
    expect(client.calls).toHaveLength(1);
  });
});

describe('generateSocialMediaContent — platform', () => {
  it('documents x and linkedin as the supported platforms', () => {
    expect([...SUPPORTED_PLATFORMS]).toEqual(['x', 'linkedin']);
  });

  it('asks for a single platform when one is given', async () => {
    const client = fakeClient();
    await generateSocialMediaContent({ topic: 't', platform: 'linkedin' }, { client });
    await generateSocialMediaContent({ topic: 't', platform: 'x' }, { client });
    const [linkedin, x] = client.calls.map(userText);
    expect(linkedin).toMatch(/Platform: LinkedIn/);
    expect(x).toMatch(/Platform: X/);
  });

  it('asks for every variant when no platform is given', async () => {
    const client = fakeClient();
    await generateSocialMediaContent({ topic: 't' }, { client });
    expect(userText(only(client.calls))).not.toMatch(/Platform:/);
  });

  it('rejects an unsupported platform without sending', async () => {
    const client = fakeClient();
    const platform = 'myspace' as unknown as 'x';
    const err = await generateSocialMediaContent({ topic: 't', platform }, { client }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SocialMediaInputError);
    expect((err as SocialMediaInputError).field).toBe('platform');
    expect((err as Error).message).toContain('x, linkedin');
    expect(client.calls).toHaveLength(0);
  });

  it.each([[''], ['X'], ['LINKEDIN'], ['facebook']])(
    'rejects invalid platform %j without sending',
    async (platform) => {
      const client = fakeClient();
      const err = await generateSocialMediaContent(
        { topic: 't', platform: platform as unknown as 'x' },
        { client },
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SocialMediaInputError);
      expect((err as SocialMediaInputError).field).toBe('platform');
      expect(client.calls).toHaveLength(0);
    },
  );
});

describe('generateSocialMediaContent — validation', () => {
  it.each([[null], [undefined], ['string'], [42]])('rejects non-object options %j', async (options) => {
    const client = fakeClient();
    await expect(
      generateSocialMediaContent(options as unknown as SocialMediaOptions, { client }),
    ).rejects.toMatchObject({
      name: 'SocialMediaInputError',
      field: 'topic',
    });
    expect(client.calls).toHaveLength(0);
  });

  it.each([[''], ['   \n\t ']])('rejects an empty topic %j', async (topic) => {
    const client = fakeClient();
    const err = await generateSocialMediaContent({ topic }, { client }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SocialMediaInputError);
    expect(err).toBeInstanceOf(SocialMediaAgentError);
    expect((err as SocialMediaInputError).field).toBe('topic');
    expect(client.calls).toHaveLength(0);
  });

  it.each([[undefined], [null], [42], [true], [{}]])('rejects non-string topic %j', async (topic) => {
    const client = fakeClient();
    await expect(
      generateSocialMediaContent({ topic: topic as unknown as string }, { client }),
    ).rejects.toMatchObject({
      name: 'SocialMediaInputError',
      field: 'topic',
    });
  });

  it(`rejects a topic longer than ${MAX_TOPIC_LENGTH} characters`, async () => {
    const client = fakeClient();
    await expect(
      generateSocialMediaContent({ topic: 'a'.repeat(MAX_TOPIC_LENGTH + 1) }, { client }),
    ).rejects.toMatchObject({ field: 'topic' });
    await generateSocialMediaContent({ topic: 'a'.repeat(MAX_TOPIC_LENGTH) }, { client });
    expect(client.calls).toHaveLength(1);
  });

  it.each([[0], [-1], [1.5], [Number.NaN]])('rejects maxTokens %s', async (maxTokens) => {
    const client = fakeClient();
    await expect(generateSocialMediaContent({ topic: 't', maxTokens }, { client })).rejects.toMatchObject({
      field: 'maxTokens',
    });
    expect(client.calls).toHaveLength(0);
  });

  it('rejects a blank model option', async () => {
    const client = fakeClient();
    await expect(generateSocialMediaContent({ topic: 't', model: ' ' }, { client })).rejects.toMatchObject({
      field: 'model',
    });
  });

  it('never includes the API key in an error', async () => {
    const apiKey = 'sk-nrouter-do-not-leak-0123456789';
    const err = await generateSocialMediaContent({ topic: ' ', apiKey }, { client: fakeClient() }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SocialMediaInputError);
    expect(String(err)).not.toContain(apiKey);
    expect(JSON.stringify(err)).not.toContain(apiKey);
  });
});

describe('generateSocialMediaContent — responses and errors', () => {
  it.each([
    ['no content', {}],
    ['empty content', { content: [] }],
    ['only a tool_use block', { content: [{ type: 'tool_use', id: 'x', name: 'n', input: {} }] }],
    ['a text block without a string', { content: [{ type: 'text', text: 7 }] }],
    ['whitespace text', { content: [{ type: 'text', text: '  \n' }] }],
  ])('throws SocialMediaResponseError on %s', async (_label, body) => {
    const client = fakeClient(() => body);
    await expect(generateSocialMediaContent({ topic: 't' }, { client })).rejects.toBeInstanceOf(
      SocialMediaResponseError,
    );
  });

  it('reports the stop reason on an empty response', async () => {
    const client = fakeClient(() => ({ content: [], stop_reason: 'max_tokens' }));
    const err = await generateSocialMediaContent({ topic: 't' }, { client }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SocialMediaResponseError);
    expect((err as SocialMediaResponseError).stopReason).toBe('max_tokens');
    expect((err as Error).message).toContain('max_tokens');
  });

  it('propagates SDK errors unchanged', async () => {
    const sdkError = new nRouterCreditError('Insufficient credit', { status: 402 });
    const client = fakeClient(() => {
      throw sdkError;
    });
    const err = await generateSocialMediaContent({ topic: 't' }, { client }).catch((e: unknown) => e);
    expect(err).toBe(sdkError);
  });

  it('builds a real nRouter client when none is injected, surfacing its configuration error', async () => {
    vi.stubEnv('NROUTER_API_KEY', '');
    await expect(generateSocialMediaContent({ topic: 't' })).rejects.toBeInstanceOf(nRouterConfigurationError);
  });

  it('validates input before building a client, so no key is needed to see an input error', async () => {
    vi.stubEnv('NROUTER_API_KEY', '');
    await expect(generateSocialMediaContent({ topic: '' })).rejects.toBeInstanceOf(SocialMediaInputError);
  });
});
