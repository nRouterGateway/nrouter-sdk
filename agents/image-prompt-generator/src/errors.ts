/**
 * Errors raised by the image prompt generator itself.
 *
 * Errors from the nRouter gateway or the SDK (authentication, credit, rate
 * limit, guardrail refusals, transport failures, a missing API key) are NOT
 * wrapped: they propagate unchanged as the SDK's `nRouterError` subclasses, so
 * callers can classify them with the SDK's own helpers.
 */

/** Base class for every error this package throws on its own. */
export class ImagePromptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The caller's options were rejected before any request was sent. */
export class ImagePromptInputError extends ImagePromptError {
  /** The option that failed validation, e.g. `query` or `maxTokens`. */
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

/** The gateway answered, but the reply carried no usable text. */
export class ImagePromptResponseError extends ImagePromptError {
  /** The gateway request id, when the response reported one. */
  readonly requestId: string | null;
  /** The model's `stop_reason`, when the response reported one. */
  readonly stopReason: string | null;

  constructor(message: string, details: { requestId?: string | null; stopReason?: string | null } = {}) {
    super(message);
    this.requestId = details.requestId ?? null;
    this.stopReason = details.stopReason ?? null;
  }
}
