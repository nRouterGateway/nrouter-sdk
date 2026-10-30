import { readFile } from 'node:fs/promises';
import { nRouter } from '@nrouter_ai/sdk';
import { ImagePromptInputError, ImagePromptResponseError } from './errors.js';

/** Model used when neither `options.model` nor `NROUTER_MODEL` is set. */
export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

/** `max_tokens` sent when `options.maxTokens` is not set. */
export const DEFAULT_MAX_TOKENS = 1024;

/** Longest accepted `query`, in characters (after trimming). */
export const MAX_QUERY_LENGTH = 4000;

/** Skill files concatenated, in this order, into the system prompt. */
export const SKILL_FILES = ['instructions.md', 'brand.md'] as const;

export interface ImagePromptOptions {
  /** What the image should show. Required; trimmed; at most `MAX_QUERY_LENGTH` characters. */
  query: string;
  /** Model id. Defaults to `NROUTER_MODEL`, then `DEFAULT_MODEL`. */
  model?: string;
  /** Upper bound on generated tokens. A positive integer; defaults to `DEFAULT_MAX_TOKENS`. */
  maxTokens?: number;
  /** nRouter API key. Defaults to `NROUTER_API_KEY`. Ignored when `deps.client` is given. */
  apiKey?: string;
  /** Gateway base URL, passed to the SDK client as `baseURL`. Ignored when `deps.client` is given. */
  baseUrl?: string;
}

/** The successful result of the one SDK call this agent makes. */
export interface MessagesResult {
  body: Record<string, unknown>;
  meta?: { requestId?: string | null } | null;
}

/**
 * The slice of the `nRouter` client this agent uses: `client.nr.messages(body)`
 * (POST /v1/messages). The real client satisfies it; tests inject a fake.
 */
export interface MessagesClient {
  nr: {
    messages(body: Record<string, unknown>): Promise<MessagesResult>;
  };
}

export interface ImagePromptDeps {
  /** A client to use instead of constructing `new nRouter({ apiKey, baseURL })`. */
  client?: MessagesClient;
}

const SKILLS_DIR = new URL('../skills/', import.meta.url);

/**
 * Turn a short description into a brand-compliant prompt for an image model.
 *
 * Throws `ImagePromptInputError` for invalid options (before any request),
 * `ImagePromptResponseError` when the reply has no text, and lets every SDK
 * error (`nRouterError` subclasses) propagate unchanged.
 */
export async function generateImagePrompt(
  options: ImagePromptOptions,
  deps: ImagePromptDeps = {},
): Promise<string> {
  const query = validateQuery(options.query);
  const model = resolveModel(options.model);
  const maxTokens = resolveMaxTokens(options.maxTokens);
  const system = await loadSystemPrompt();
  const client = deps.client ?? createClient(options);

  const response = await client.nr.messages({
    model,
    system,
    messages: [{ role: 'user', content: query }],
    max_tokens: maxTokens,
  });

  return extractText(response);
}

/** The system prompt: every skill file, in `SKILL_FILES` order. */
export async function loadSystemPrompt(): Promise<string> {
  const parts = await Promise.all(
    SKILL_FILES.map(async (file) => (await readFile(new URL(file, SKILLS_DIR), 'utf8')).trim()),
  );
  return parts.join('\n\n');
}

function createClient(options: ImagePromptOptions): MessagesClient {
  const clientOptions: { apiKey?: string; baseURL?: string } = {};
  if (options.apiKey !== undefined) clientOptions.apiKey = options.apiKey;
  if (options.baseUrl !== undefined) clientOptions.baseURL = options.baseUrl;
  return new nRouter(clientOptions);
}

function validateQuery(query: unknown): string {
  if (typeof query !== 'string') {
    throw new ImagePromptInputError('query', 'query must be a string.');
  }
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    throw new ImagePromptInputError('query', 'query must not be empty.');
  }
  if (trimmed.length > MAX_QUERY_LENGTH) {
    throw new ImagePromptInputError(
      'query',
      `query is ${trimmed.length} characters; the limit is ${MAX_QUERY_LENGTH}.`,
    );
  }
  return trimmed;
}

function resolveModel(model: unknown): string {
  if (model !== undefined) {
    if (typeof model !== 'string' || model.trim().length === 0) {
      throw new ImagePromptInputError('model', 'model must be a non-empty string.');
    }
    return model.trim();
  }
  const fromEnv = process.env.NROUTER_MODEL?.trim();
  return fromEnv ? fromEnv : DEFAULT_MODEL;
}

function resolveMaxTokens(maxTokens: unknown): number {
  if (maxTokens === undefined) return DEFAULT_MAX_TOKENS;
  if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new ImagePromptInputError('maxTokens', 'maxTokens must be a positive integer.');
  }
  return maxTokens;
}

interface TextBlock {
  type: 'text';
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTextBlock(value: unknown): value is TextBlock {
  return isRecord(value) && value.type === 'text' && typeof value.text === 'string';
}

function extractText(response: MessagesResult): string {
  const body: unknown = response.body;
  const content = isRecord(body) && Array.isArray(body.content) ? body.content : [];
  const text = content
    .filter(isTextBlock)
    .map((block) => block.text.trim())
    .filter((part) => part.length > 0)
    .join('\n');

  if (text.length > 0) return text;

  const stopReason = isRecord(body) && typeof body.stop_reason === 'string' ? body.stop_reason : null;
  const requestId = typeof response.meta?.requestId === 'string' ? response.meta.requestId : null;
  const detail = [
    stopReason ? `stop_reason=${stopReason}` : null,
    requestId ? `request id ${requestId}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(', ');
  throw new ImagePromptResponseError(
    `The model returned no text content${detail ? ` (${detail})` : ''}.`,
    { stopReason, requestId },
  );
}
