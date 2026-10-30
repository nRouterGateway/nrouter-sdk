/**
 * Errors raised by this agent itself.
 *
 * Failures from the nRouter gateway (authentication, credit, rate limit,
 * guardrail blocks, transport) are NOT wrapped: they reach the caller as the
 * `@nrouter_ai/sdk` error classes (`nRouterError` and its subclasses), with
 * their status, code and request id intact.
 *
 * No error raised here ever carries the API key.
 */

/** Base class for every error this package raises on its own. */
export class SocialMediaAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The options were rejected before any request was sent. Nothing was billed. */
export class SocialMediaInputError extends SocialMediaAgentError {
  /** The option that failed validation, e.g. `topic`, `history`, `platform`. */
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

/**
 * The gateway answered successfully but the response held no usable text
 * (no `text` content block, or only whitespace). The request WAS sent and may
 * have been billed.
 */
export class SocialMediaResponseError extends SocialMediaAgentError {
  /** `stop_reason` from the response body, when it carried one. */
  readonly stopReason: string | null;

  constructor(message: string, stopReason: string | null = null) {
    super(message);
    this.stopReason = stopReason;
  }
}
