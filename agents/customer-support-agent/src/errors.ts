// LANE L2 owns this file.
import type { SafeError, SupportAgentErrorCode } from './types.js';
import {
  nRouterAuthenticationError,
  nRouterCreditError,
  nRouterBudgetExceededError,
  nRouterRateLimitError,
  nRouterGuardrailBlockedError,
  nRouterError,
  classifyErrorClass,
  isAbortError
} from '@nrouter_ai/sdk';

export class SupportAgentError extends Error {
  readonly code: SupportAgentErrorCode;
  constructor(code: SupportAgentErrorCode, message: string) {
    super(message);
    this.name = 'SupportAgentError';
    this.code = code;
  }
  toSafe(): SafeError {
    return { code: this.code, message: this.message };
  }
}

/** Replace nRouter keys (sk-nrouter-…) and any listed secret strings with a placeholder. */
export function redact(text: string, secrets?: string[]): string {
  let result = text.replace(/sk-nrouter-[A-Za-z0-9_-]+/g, '[redacted]');
  if (secrets) {
    for (const secret of secrets) {
      if (secret.length >= 8) {
        // use split/join to replace all occurrences without escaping regex specials
        result = result.split(secret).join('[redacted]');
      }
    }
  }
  return result;
}

/** Map any thrown value (SDK error classes, AbortError, unknown) to a redacted SafeError. */
export function toSafeError(err: unknown, secrets?: string[]): SafeError {
  if (err instanceof SupportAgentError) {
    return {
      code: err.code,
      message: redact(err.message, secrets)
    };
  }

  if (err instanceof nRouterAuthenticationError) {
    return { code: 'auth_failed', message: redact(err.message, secrets) };
  }
  if (err instanceof nRouterCreditError || err instanceof nRouterBudgetExceededError) {
    return { code: 'insufficient_credit', message: redact(err.message, secrets) };
  }
  if (err instanceof nRouterRateLimitError) {
    return { code: 'rate_limited', message: redact(err.message, secrets) };
  }
  if (err instanceof nRouterGuardrailBlockedError) {
    return { code: 'guardrail_blocked', message: redact(err.message, secrets) };
  }
  if (err instanceof nRouterError) {
    return { code: 'upstream_error', message: redact(err.message, secrets) };
  }

  if (isAbortError(err)) {
    return { code: 'aborted', message: err instanceof Error ? redact(err.message, secrets) : 'Aborted' };
  }

  if (typeof err === 'object' && err !== null && 'status' in err && typeof (err as Record<string, unknown>).status === 'number') {
    const status = (err as Record<string, unknown>).status as number;
    const message = typeof (err as Record<string, unknown>).message === 'string' ? (err as Record<string, unknown>).message as string : '';
    const code = typeof (err as Record<string, unknown>).code === 'string' ? (err as Record<string, unknown>).code as string : null;
    const Cls = classifyErrorClass(code, message, status);
    if (Cls === nRouterGuardrailBlockedError || (Cls as unknown as { kind: string }).kind === 'guardrail_blocked') {
      return { code: 'guardrail_blocked', message: redact(message, secrets) };
    }
    if (Cls === nRouterAuthenticationError || (Cls as unknown as { kind: string }).kind === 'authentication') {
      return { code: 'auth_failed', message: redact(message, secrets) };
    }
    if (
      Cls === nRouterCreditError ||
      Cls === nRouterBudgetExceededError ||
      (Cls as unknown as { kind: string }).kind === 'credit' ||
      (Cls as unknown as { kind: string }).kind === 'budget_exceeded'
    ) {
      return { code: 'insufficient_credit', message: redact(message, secrets) };
    }
    if (Cls === nRouterRateLimitError || (Cls as unknown as { kind: string }).kind === 'rate_limit') {
      return { code: 'rate_limited', message: redact(message, secrets) };
    }
    return { code: 'upstream_error', message: redact(message, secrets) };
  }

  return { code: 'internal_error', message: 'An internal error occurred.' };
}
