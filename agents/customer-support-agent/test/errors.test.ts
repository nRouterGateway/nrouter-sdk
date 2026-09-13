import { describe, it, expect } from 'vitest';
import { SupportAgentError, redact, toSafeError } from '../src/errors.js';
import {
  nRouterAuthenticationError,
  nRouterCreditError,
  nRouterBudgetExceededError,
  nRouterRateLimitError,
  nRouterGuardrailBlockedError,
  nRouterError
} from '@nrouter_ai/sdk';

class FakeAbortError extends Error {
  name = 'AbortError';
}

describe('errors', () => {
  describe('SupportAgentError', () => {
    it('creates an error with a code and safe form', () => {
      const err = new SupportAgentError('invalid_config', 'test msg');
      expect(err.code).toBe('invalid_config');
      expect(err.message).toBe('test msg');
      expect(err.toSafe()).toEqual({ code: 'invalid_config', message: 'test msg' });
    });
  });

  describe('redact', () => {
    it('redacts nrouter keys', () => {
      expect(redact('failed auth for sk-nrouter-abc123_test')).toBe('failed auth for [redacted]');
    });
    
    it('redacts provided secrets that are >= 8 chars', () => {
      expect(redact('my secret123 is here', ['secret123', 'short'])).toBe('my [redacted] is here');
    });

    it('does not redact short secrets', () => {
      expect(redact('my short is here', ['short'])).toBe('my short is here');
    });
  });

  describe('toSafeError', () => {
    it('handles SupportAgentError', () => {
      const err = new SupportAgentError('invalid_index', 'bad index sk-nrouter-abc');
      expect(toSafeError(err)).toEqual({ code: 'invalid_index', message: 'bad index [redacted]' });
    });

    it('handles nRouterAuthenticationError', () => {
      // nRouter error classes take (status, error, message, headers) - actually the signature might vary, let's just mock it or pass undefined
      // wait, `new nRouterAuthenticationError(401, {}, "bad key sk-nrouter-foo", undefined)`
      // Let's check constructor signature or just cast.
      const err = Object.create(nRouterAuthenticationError.prototype);
      err.message = 'bad key sk-nrouter-foo';
      expect(toSafeError(err)).toEqual({ code: 'auth_failed', message: 'bad key [redacted]' });
    });

    it('handles nRouterCreditError', () => {
      const err = Object.create(nRouterCreditError.prototype);
      err.message = 'no money';
      expect(toSafeError(err)).toEqual({ code: 'insufficient_credit', message: 'no money' });
    });

    it('handles nRouterBudgetExceededError', () => {
      const err = Object.create(nRouterBudgetExceededError.prototype);
      err.message = 'budget out';
      expect(toSafeError(err)).toEqual({ code: 'insufficient_credit', message: 'budget out' });
    });

    it('handles nRouterRateLimitError', () => {
      const err = Object.create(nRouterRateLimitError.prototype);
      err.message = 'too fast';
      expect(toSafeError(err)).toEqual({ code: 'rate_limited', message: 'too fast' });
    });

    it('handles nRouterGuardrailBlockedError', () => {
      const err = Object.create(nRouterGuardrailBlockedError.prototype);
      err.message = 'blocked sk-nrouter-bar';
      expect(toSafeError(err)).toEqual({ code: 'guardrail_blocked', message: 'blocked [redacted]' });
    });

    it('handles other nRouterError', () => {
      const err = Object.create(nRouterError.prototype);
      err.message = 'upstream failed';
      expect(toSafeError(err)).toEqual({ code: 'upstream_error', message: 'upstream failed' });
    });

    it('handles AbortError', () => {
      const err = new FakeAbortError('user aborted');
      expect(toSafeError(err)).toEqual({ code: 'aborted', message: 'user aborted' });
    });

    it('handles unknown errors', () => {
      const err = new Error('some internals sk-nrouter-123');
      expect(toSafeError(err)).toEqual({ code: 'internal_error', message: 'An internal error occurred.' });
    });
  });
});
