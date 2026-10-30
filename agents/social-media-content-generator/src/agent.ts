import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nRouter, type NRouterSurface } from '@nrouter_ai/sdk';
import { SocialMediaInputError, SocialMediaResponseError } from './errors.js';

/** Model used when neither `options.model` nor `NROUTER_MODEL` is set. */
export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
/** `max_tokens` sent when `options.maxTokens` is not set. */
export const DEFAULT_MAX_TOKENS = 1024;
/** Longest accepted topic, in characters, after trimming. */
export const MAX_TOPIC_LENGTH = 2000;
/** Most history entries accepted. More is rejected, never silently truncated. */
export const MAX_HISTORY_ITEMS = 20;
/** Longest accepted history entry, in characters, after trimming. */
export const MAX_HISTORY_ITEM_LENGTH = 280;
/** Platforms `options.platform` accepts. */
export const SUPPORTED_PLATFORMS = ['x', 'linkedin'] as const;

export type SocialPlatform = (typeof SUPPORTED_PLATFORMS)[number];

const PLATFORM_LABELS: Record<SocialPlatform, string> = {
  x: 'X (Twitter)',
  linkedin: 'LinkedIn',
};

const SKILL_FILES = ['instructions.md', 'brand.md'] as const;

/**
 * Resolved relative to this compiled module: `dist/agent.js` and
 * `src/agent.ts` both sit one level below the package root, beside `skills/`.
 */
const SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');

export interface SocialMediaOptions {
  /** What the post is about. Required; 1..MAX_TOPIC_LENGTH characters after trimming. */
  topic: string;
  /**
   * Topics of previous posts, so the agent avoids repeating their angle.
   * At most MAX_HISTORY_ITEMS entries of 1..MAX_HISTORY_ITEM_LENGTH characters each.
   */
  history?: string[];
  /** Write for one platform only. Omitted: every variant the skill describes. */
  platform?: SocialPlatform;
  /** Model id. Falls back to `NROUTER_MODEL`, then DEFAULT_MODEL. */
  model?: string;
  /** Positive integer sent as `max_tokens`. Defaults to DEFAULT_MAX_TOKENS. */
  maxTokens?: number;
  /** nRouter API key. Falls back to `NROUTER_API_KEY` (read by the SDK). Ignored when `deps.client` is given. */
  apiKey?: string;
}

/** The part of an `nRouter` client this agent uses: `client.nr.messages(...)`. */
export interface MessagesClient {
  nr: Pick<NRouterSurface, 'messages'>;
}

export interface SocialMediaDeps {
  /** A client to call instead of constructing `new nRouter({ apiKey })`. */
  client?: MessagesClient;
}

interface ValidatedOptions {
  topic: string;
  history: string[];
  platform: SocialPlatform | null;
  model: string;
  maxTokens: number;
}

/**
 * Draft social media posts about `options.topic` through the nRouter gateway
 * (`POST /v1/messages`).
 *
 * @throws SocialMediaInputError when the options are invalid (nothing is sent).
 * @throws SocialMediaResponseError when the response holds no text.
 * @throws nRouterError (from `@nrouter_ai/sdk`) for every gateway or
 *   configuration failure, unchanged.
 */
export async function generateSocialMediaContent(
  options: SocialMediaOptions,
  deps: SocialMediaDeps = {},
): Promise<string> {
  const input = validate(options);
  const system = await loadSystemPrompt();
  const client: MessagesClient = deps.client ?? new nRouter(options.apiKey ? { apiKey: options.apiKey } : {});

  const response = await client.nr.messages({
    model: input.model,
    max_tokens: input.maxTokens,
    system,
    messages: [{ role: 'user', content: buildUserMessage(input) }],
  });

  return extractText(response.body);
}

function validate(options: SocialMediaOptions): ValidatedOptions {
  if (typeof options !== 'object' || options === null) {
    throw new SocialMediaInputError('topic', 'options must be an object with a topic.');
  }

  if (typeof options.topic !== 'string' || options.topic.trim() === '') {
    throw new SocialMediaInputError('topic', 'topic must be a non-empty string.');
  }
  const topic = options.topic.trim();
  if (topic.length > MAX_TOPIC_LENGTH) {
    throw new SocialMediaInputError(
      'topic',
      `topic is ${topic.length} characters; the limit is ${MAX_TOPIC_LENGTH}.`,
    );
  }

  const history = validateHistory(options.history);

  let platform: SocialPlatform | null = null;
  if (options.platform !== undefined) {
    if (!isPlatform(options.platform)) {
      throw new SocialMediaInputError(
        'platform',
        `platform must be one of: ${SUPPORTED_PLATFORMS.join(', ')}.`,
      );
    }
    platform = options.platform;
  }

  if (options.model !== undefined && (typeof options.model !== 'string' || options.model.trim() === '')) {
    throw new SocialMediaInputError('model', 'model must be a non-empty string when given.');
  }
  const model = options.model?.trim() || process.env['NROUTER_MODEL']?.trim() || DEFAULT_MODEL;

  const maxTokens = options.maxTokens === undefined ? DEFAULT_MAX_TOKENS : options.maxTokens;
  if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens < 1) {
    throw new SocialMediaInputError('maxTokens', 'maxTokens must be a positive integer.');
  }

  return { topic, history, platform, model, maxTokens };
}

function validateHistory(history: unknown): string[] {
  if (history === undefined) return [];
  if (!Array.isArray(history)) {
    throw new SocialMediaInputError('history', 'history must be an array of strings.');
  }
  if (history.length > MAX_HISTORY_ITEMS) {
    throw new SocialMediaInputError(
      'history',
      `history has ${history.length} entries; the limit is ${MAX_HISTORY_ITEMS}. Pass the most recent ones.`,
    );
  }
  return history.map((item: unknown, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new SocialMediaInputError('history', `history[${index}] must be a non-empty string.`);
    }
    const trimmed = item.trim();
    if (trimmed.length > MAX_HISTORY_ITEM_LENGTH) {
      throw new SocialMediaInputError(
        'history',
        `history[${index}] is ${trimmed.length} characters; the limit is ${MAX_HISTORY_ITEM_LENGTH}.`,
      );
    }
    return trimmed;
  });
}

function isPlatform(value: unknown): value is SocialPlatform {
  return typeof value === 'string' && (SUPPORTED_PLATFORMS as readonly string[]).includes(value);
}

async function loadSystemPrompt(): Promise<string> {
  const parts = await Promise.all(
    SKILL_FILES.map(async (file) => (await readFile(path.join(SKILLS_DIR, file), 'utf8')).trim()),
  );
  return parts.join('\n\n');
}

function buildUserMessage(input: ValidatedOptions): string {
  const lines = [`Topic: ${input.topic}`];
  if (input.platform !== null) {
    lines.push(
      '',
      `Platform: ${PLATFORM_LABELS[input.platform]}. Write only the variant for this platform.`,
    );
  }
  if (input.history.length > 0) {
    lines.push(
      '',
      'Previously covered topics. Do not repeat their angle, hook or examples:',
      ...input.history.map((item) => `- ${item}`),
    );
  }
  return lines.join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTextBlock(value: unknown): value is { type: 'text'; text: string } {
  return isRecord(value) && value['type'] === 'text' && typeof value['text'] === 'string';
}

function extractText(body: Record<string, unknown>): string {
  const content = body['content'];
  const text = Array.isArray(content)
    ? content
        .filter(isTextBlock)
        .map((block) => block.text)
        .join('')
    : '';

  if (text.trim() === '') {
    const stop = body['stop_reason'];
    const stopReason = typeof stop === 'string' ? stop : null;
    throw new SocialMediaResponseError(
      `The response contained no text${stopReason ? ` (stop_reason: ${stopReason})` : ''}.`,
      stopReason,
    );
  }
  return text.trim();
}
