/**
 * Errors this package raises itself. Errors from `@nrouter_ai/sdk`
 * (`nRouterError` and its subclasses) are never wrapped: they reach the caller
 * unchanged so their `code`, `status` and `requestId` stay intact.
 *
 * No error built here ever includes the API key.
 */

/** Base class for every error this package raises. */
export class VideoPromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The input was rejected before any request was sent. */
export class VideoPromptValidationError extends VideoPromptError {
  /** The option that failed validation. */
  readonly field: 'query' | 'videoModel' | 'model' | 'maxTokens' | 'conversation';

  constructor(field: VideoPromptValidationError['field'], message: string) {
    super(message);
    this.field = field;
  }
}

/** The gateway answered, but the response carried no usable text. */
export class VideoPromptResponseError extends VideoPromptError {
  /** The gateway request id (`x-nr-request-id`), when the response carried one. */
  readonly requestId: string | null;

  constructor(message: string, requestId: string | null) {
    super(message);
    this.requestId = requestId;
  }
}
