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

/** Map an SDK error class (by identity or by name) to a SupportAgentErrorCode. */
export function mapErrorClass(Cls: unknown): SupportAgentErrorCode {
  const name = typeof Cls === 'function' ? Cls.name : (Cls as { name?: string })?.name;
  if (Cls === nRouterGuardrailBlockedError || name === 'nRouterGuardrailBlockedError') {
    return 'guardrail_blocked';
  }
  if (Cls === nRouterAuthenticationError || name === 'nRouterAuthenticationError') {
    return 'auth_failed';
  }
  if (
    Cls === nRouterCreditError ||
    Cls === nRouterBudgetExceededError ||
    name === 'nRouterCreditError' ||
    name === 'nRouterBudgetExceededError'
  ) {
    return 'insufficient_credit';
  }
  if (Cls === nRouterRateLimitError || name === 'nRouterRateLimitError') {
    return 'rate_limited';
  }
  return 'upstream_error';
}

/** Map any thrown value (SDK error classes, AbortError, unknown) to a redacted SafeError. */
export function toSafeError(err: unknown, secrets?: string[]): SafeError {
  if (err instanceof SupportAgentError) {
    return {
      code: err.code,
      message: redact(err.message, secrets)
    };
  }

  const errName = (err as { name?: string; constructor?: { name?: string } })?.constructor?.name ?? (err as { name?: string })?.name;

  if (err instanceof nRouterAuthenticationError || errName === 'nRouterAuthenticationError') {
    return { code: 'auth_failed', message: redact(err instanceof Error ? err.message : String(err), secrets) };
  }
  if (
    err instanceof nRouterCreditError ||
    err instanceof nRouterBudgetExceededError ||
    errName === 'nRouterCreditError' ||
    errName === 'nRouterBudgetExceededError'
  ) {
    return { code: 'insufficient_credit', message: redact(err instanceof Error ? err.message : String(err), secrets) };
  }
  if (err instanceof nRouterRateLimitError || errName === 'nRouterRateLimitError') {
    return { code: 'rate_limited', message: redact(err instanceof Error ? err.message : String(err), secrets) };
  }
  if (err instanceof nRouterGuardrailBlockedError || errName === 'nRouterGuardrailBlockedError') {
    return { code: 'guardrail_blocked', message: redact(err instanceof Error ? err.message : String(err), secrets) };
  }
  if (err instanceof nRouterError || errName === 'nRouterError') {
    return { code: 'upstream_error', message: redact(err instanceof Error ? err.message : String(err), secrets) };
  }

  if (isAbortError(err)) {
    return { code: 'aborted', message: err instanceof Error ? redact(err.message, secrets) : 'Aborted' };
  }

  if (typeof err === 'object' && err !== null && 'status' in err && typeof (err as Record<string, unknown>).status === 'number') {
    const status = (err as Record<string, unknown>).status as number;
    const message = typeof (err as Record<string, unknown>).message === 'string' ? (err as Record<string, unknown>).message as string : '';
    const code = typeof (err as Record<string, unknown>).code === 'string' ? (err as Record<string, unknown>).code as string : null;
    const Cls = classifyErrorClass(code, message, status);
    const mappedCode = mapErrorClass(Cls);
    return { code: mappedCode, message: redact(message, secrets) };
  }

  return { code: 'internal_error', message: 'An internal error occurred.' };
}
