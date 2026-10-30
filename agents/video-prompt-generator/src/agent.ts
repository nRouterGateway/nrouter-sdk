import { nRouter } from '@nrouter_ai/sdk';
import { VideoPromptResponseError, VideoPromptValidationError } from './errors.js';
import { findVideoModel, listVideoModels, readSkill } from './skills.js';

/** Model used when neither `options.model` nor `NROUTER_MODEL` is set. */
export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
/** `max_tokens` sent when `options.maxTokens` is not set. */
export const DEFAULT_MAX_TOKENS = 1024;
/** Longest accepted `query`, in UTF-16 code units (JavaScript string length). */
export const MAX_QUERY_LENGTH = 8000;
/** Most prior turns accepted in `conversation`. */
export const MAX_CONVERSATION_TURNS = 50;

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface VideoPromptOptions {
  /** What the video should show. Required; 1..MAX_QUERY_LENGTH characters after trimming. */
  query: string;
  /**
   * Target video tool. Must match a guide in `skills/models/` by slug
   * (`google-veo`) or by human name (`Google Veo`); case, spaces and
   * punctuation are ignored. See `listVideoModels()`.
   */
  videoModel: string;
  /** nRouter model id. Defaults to `NROUTER_MODEL`, then `DEFAULT_MODEL`. */
  model?: string;
  /** `max_tokens` for the reply. Positive integer; defaults to `DEFAULT_MAX_TOKENS`. */
  maxTokens?: number;
  /** nRouter API key. Defaults to `NROUTER_API_KEY` (read by the SDK). Ignored when `deps.client` is given. */
  apiKey?: string;
  /** Earlier turns, oldest first. The `query` is sent after them as the final user turn. */
  conversation?: ConversationTurn[];
}

/** The response shape this package reads from `nr.messages(...)`. */
export interface MessagesResponse {
  body: Record<string, unknown>;
  meta?: { requestId?: string | null };
}

/** The slice of the `nRouter` client this package uses. A real `nRouter` satisfies it. */
export interface MessagesClient {
  nr: {
    messages(body: Record<string, unknown>): Promise<MessagesResponse>;
  };
}

export interface VideoPromptDeps {
  /** Client to call instead of constructing `new nRouter({ apiKey })`. */
  client?: MessagesClient;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTextBlock(value: unknown): value is { type: 'text'; text: string } {
  return isRecord(value) && value['type'] === 'text' && typeof value['text'] === 'string';
}

function isConversationTurn(value: unknown): value is ConversationTurn {
  return (
    isRecord(value) &&
    (value['role'] === 'user' || value['role'] === 'assistant') &&
    typeof value['content'] === 'string'
  );
}

function resolveModel(option: unknown): string {
  if (option !== undefined) {
    if (typeof option !== 'string' || option.trim().length === 0) {
      throw new VideoPromptValidationError('model', 'model must be a non-empty string when provided.');
    }
    return option.trim();
  }
  const fromEnv = process.env['NROUTER_MODEL']?.trim();
  return fromEnv ? fromEnv : DEFAULT_MODEL;
}

function resolveMaxTokens(option: unknown): number {
  if (option === undefined) return DEFAULT_MAX_TOKENS;
  if (typeof option !== 'number' || !Number.isInteger(option) || option <= 0) {
    throw new VideoPromptValidationError('maxTokens', 'maxTokens must be a positive integer.');
  }
  return option;
}

function validateQuery(query: unknown): string {
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new VideoPromptValidationError('query', 'query must be a non-empty string.');
  }
  const trimmed = query.trim();
  if (trimmed.length > MAX_QUERY_LENGTH) {
    throw new VideoPromptValidationError(
      'query',
      `query is ${trimmed.length} characters; the limit is ${MAX_QUERY_LENGTH}.`,
    );
  }
  return trimmed;
}

function validateConversation(conversation: unknown): ConversationTurn[] {
  if (conversation === undefined) return [];
  if (!Array.isArray(conversation) || conversation.length > MAX_CONVERSATION_TURNS) {
    throw new VideoPromptValidationError(
      'conversation',
      `conversation must be an array of at most ${MAX_CONVERSATION_TURNS} turns.`,
    );
  }
  return conversation.map((turn: unknown, index) => {
    if (!isConversationTurn(turn) || turn.content.trim().length === 0) {
      throw new VideoPromptValidationError(
        'conversation',
        `conversation[${index}] must be { role: "user" | "assistant", content: non-empty string }.`,
      );
    }
    if (turn.content.length > MAX_QUERY_LENGTH) {
      throw new VideoPromptValidationError(
        'conversation',
        `conversation[${index}].content exceeds ${MAX_QUERY_LENGTH} characters.`,
      );
    }
    return { role: turn.role, content: turn.content };
  });
}

function resolveVideoModelGuide(videoModel: unknown): string {
  const found = typeof videoModel === 'string' ? findVideoModel(videoModel) : undefined;
  if (!found) {
    const allowed = listVideoModels()
      .map((m) => `${m.slug} ("${m.name}")`)
      .join(', ');
    throw new VideoPromptValidationError(
      'videoModel',
      `Unknown videoModel ${JSON.stringify(videoModel)}. Allowed values: ${allowed}.`,
    );
  }
  return found.text;
}

function extractText(response: MessagesResponse): string {
  const content = response.body['content'];
  const texts = Array.isArray(content)
    ? content
        .filter(isTextBlock)
        .map((block) => block.text.trim())
        .filter((text) => text.length > 0)
    : [];
  if (texts.length === 0) {
    throw new VideoPromptResponseError(
      'The response contained no text content.',
      response.meta?.requestId ?? null,
    );
  }
  return texts.join('\n\n');
}

/**
 * Generate a video prompt brief for `options.videoModel`.
 *
 * Throws `VideoPromptValidationError` before sending anything when the input
 * is invalid, `VideoPromptResponseError` when the reply has no text, and lets
 * every `@nrouter_ai/sdk` error (`nRouterError` and subclasses) propagate
 * unchanged.
 */
export async function generateVideoPrompt(
  options: VideoPromptOptions,
  deps: VideoPromptDeps = {},
): Promise<string> {
  const query = validateQuery(options.query);
  const conversation = validateConversation(options.conversation);
  const model = resolveModel(options.model);
  const maxTokens = resolveMaxTokens(options.maxTokens);
  const modelGuide = resolveVideoModelGuide(options.videoModel);

  const system = [readSkill('instructions.md'), readSkill('brand.md'), modelGuide]
    .map((part) => part.trim())
    .join('\n\n');

  const client: MessagesClient = deps.client ?? new nRouter({ apiKey: options.apiKey });

  const response = await client.nr.messages({
    model,
    system,
    messages: [...conversation, { role: 'user', content: query }],
    max_tokens: maxTokens,
  });

  return extractText(response);
}
