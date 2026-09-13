import { describe, it, expect } from 'vitest';
import { validateChatRequest, validateTrustedContext } from '../src/limits.js';
import { DEFAULT_LIMITS } from '../src/config.js';
import { SupportAgentError } from '../src/errors.js';

describe('validateChatRequest', () => {
  it('strips untrusted fields from chat request', () => {
    const req = {
      messages: [{ role: 'user', content: 'hello' }],
      pageContext: 'context',
      identity: { name: 'John' },
      audiences: ['dev'],
      sessionId: 'sess-123'
    };
    const validated = validateChatRequest(req, DEFAULT_LIMITS);
    expect((validated as any).identity).toBeUndefined();
    expect((validated as any).audiences).toBeUndefined();
    expect((validated as any).sessionId).toBeUndefined();
  });

  it('truncates pageContext to maxPageContextChars, rejecting if >10x', () => {
    const limits = { ...DEFAULT_LIMITS, maxPageContextChars: 10 };
    const longContext = 'a'.repeat(15);
    const validated = validateChatRequest({ messages: [{ role: 'user', content: 'hi' }], pageContext: longContext }, limits);
    expect(validated.pageContext).toBe('aaaaaaaaaa'); // truncated to 10
    
    const tooLongContext = 'a'.repeat(101); // > 10 * 10
    expect(() => validateChatRequest({ messages: [{ role: 'user', content: 'hi' }], pageContext: tooLongContext }, limits)).toThrowError(SupportAgentError);
  });

  it('rejects whitespace-only message content', () => {
    expect(() => validateChatRequest({ messages: [{ role: 'user', content: '   ' }] }, DEFAULT_LIMITS)).toThrowError(SupportAgentError);
    expect(() => validateChatRequest({ messages: [{ role: 'user', content: '\n\t\n' }] }, DEFAULT_LIMITS)).toThrowError(SupportAgentError);
  });

  it('validates a correct request', () => {
    const req = {
      messages: [{ role: 'user', content: 'hello' }],
      pageContext: 'context'
    };
    const validated = validateChatRequest(req, DEFAULT_LIMITS);
    expect(validated.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(validated.pageContext).toBe('context');
  });

  it('rejects non-object', () => {
    expect(() => validateChatRequest(null, DEFAULT_LIMITS)).toThrowError(SupportAgentError);
    expect(() => validateChatRequest('string', DEFAULT_LIMITS)).toThrowError(SupportAgentError);
  });

  it('rejects missing or empty messages', () => {
    expect(() => validateChatRequest({}, DEFAULT_LIMITS)).toThrowError(SupportAgentError);
    expect(() => validateChatRequest({ messages: [] }, DEFAULT_LIMITS)).toThrowError(SupportAgentError);
  });

  it('rejects more messages than maxMessages', () => {
    const messages = Array(DEFAULT_LIMITS.maxMessages + 1).fill({ role: 'user', content: 'hi' });
    expect(() => validateChatRequest({ messages }, DEFAULT_LIMITS)).toThrowError(SupportAgentError);
  });

  it('rejects invalid message formats', () => {
    expect(() => validateChatRequest({ messages: [{}] }, DEFAULT_LIMITS)).toThrowError(SupportAgentError);
    expect(() => validateChatRequest({ messages: [{ role: 'system', content: 'hi' }] }, DEFAULT_LIMITS)).toThrowError(SupportAgentError);
    expect(() => validateChatRequest({ messages: [{ role: 'user', content: '' }] }, DEFAULT_LIMITS)).toThrowError(SupportAgentError);
    expect(() => validateChatRequest({ messages: [{ role: 'user', content: 123 }] }, DEFAULT_LIMITS)).toThrowError(SupportAgentError);
  });

  it('rejects if last message is not user', () => {
    const req = {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' }
      ]
    };
    expect(() => validateChatRequest(req, DEFAULT_LIMITS)).toThrowError(SupportAgentError);
  });
});

describe('validateTrustedContext', () => {
  it('handles null/undefined to empty object', () => {
    expect(validateTrustedContext(undefined)).toEqual({});
    expect(validateTrustedContext(null)).toEqual({});
  });

  it('rejects non-plain object', () => {
    expect(() => validateTrustedContext('string')).toThrowError(SupportAgentError);
    expect(() => validateTrustedContext([])).toThrowError(SupportAgentError);
  });

  it('validates identity', () => {
    const ctx = { identity: { name: 'John', email: 'j@example.com', plan: 'pro' } };
    expect(validateTrustedContext(ctx)).toEqual(ctx);

    const longStr = 'a'.repeat(201);
    expect(() => validateTrustedContext({ identity: { name: longStr } })).toThrowError(SupportAgentError);
  });

  it('validates audiences', () => {
    const ctx = { audiences: ['dev', 'admin'] };
    expect(validateTrustedContext(ctx)).toEqual(ctx);

    const many = Array(21).fill('aud');
    expect(() => validateTrustedContext({ audiences: many })).toThrowError(SupportAgentError);
    
    const long = 'a'.repeat(65);
    expect(() => validateTrustedContext({ audiences: [long] })).toThrowError(SupportAgentError);
    
    expect(() => validateTrustedContext({ audiences: [''] })).toThrowError(SupportAgentError); // non-empty
  });

  it('validates sessionId', () => {
    expect(validateTrustedContext({ sessionId: '123' })).toEqual({ sessionId: '123' });
    expect(() => validateTrustedContext({ sessionId: '' })).toThrowError(SupportAgentError);
    expect(() => validateTrustedContext({ sessionId: 'a'.repeat(129) })).toThrowError(SupportAgentError);
  });
});
