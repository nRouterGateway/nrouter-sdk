import { describe, it, expect } from 'vitest';
import { validateFeedback } from '../src/feedback.js';
import { SupportAgentError } from '../src/errors.js';

describe('validateFeedback', () => {
  it('validates a correct payload with only required fields', () => {
    const input = { sessionId: 's1', messageId: 'm1', rating: 'up' };
    const res = validateFeedback(input);
    expect(res).toEqual(input);
  });

  it('validates a correct payload with all fields', () => {
    const input = {
      sessionId: 's1',
      messageId: 'm1',
      rating: 'down',
      question: 'q',
      confidence: 'low',
      webSearched: true,
      reason: 'because'
    };
    const res = validateFeedback(input);
    expect(res).toEqual(input);
  });

  const runInvalid = (input: unknown, errMsg?: string) => {
    try {
      validateFeedback(input);
      expect.fail('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(SupportAgentError);
      expect(e.code).toBe('invalid_request');
      if (errMsg) expect(e.message).toContain(errMsg);
    }
  };

  it('throws on non-object', () => {
    runInvalid(null, 'Invalid feedback payload');
    runInvalid('foo', 'Invalid feedback payload');
  });

  it('throws on invalid sessionId', () => {
    runInvalid({ messageId: 'm1', rating: 'up' }, 'Invalid sessionId');
    runInvalid({ sessionId: '', messageId: 'm1', rating: 'up' }, 'Invalid sessionId');
    runInvalid({ sessionId: 'a'.repeat(129), messageId: 'm1', rating: 'up' }, 'Invalid sessionId');
  });

  it('throws on invalid messageId', () => {
    runInvalid({ sessionId: 's1', rating: 'up' }, 'Invalid messageId');
    runInvalid({ sessionId: 's1', messageId: '', rating: 'up' }, 'Invalid messageId');
    runInvalid({ sessionId: 's1', messageId: 'a'.repeat(129), rating: 'up' }, 'Invalid messageId');
  });

  it('throws on invalid rating', () => {
    runInvalid({ sessionId: 's1', messageId: 'm1' }, 'Invalid rating');
    runInvalid({ sessionId: 's1', messageId: 'm1', rating: 'foo' }, 'Invalid rating');
  });

  it('throws on invalid question', () => {
    runInvalid({ sessionId: 's1', messageId: 'm1', rating: 'up', question: 123 }, 'Invalid question');
    runInvalid({ sessionId: 's1', messageId: 'm1', rating: 'up', question: 'a'.repeat(2001) }, 'Invalid question');
  });

  it('throws on invalid confidence', () => {
    runInvalid({ sessionId: 's1', messageId: 'm1', rating: 'up', confidence: 'foo' }, 'Invalid confidence');
  });

  it('throws on invalid webSearched', () => {
    runInvalid({ sessionId: 's1', messageId: 'm1', rating: 'up', webSearched: 'yes' }, 'Invalid webSearched');
  });

  it('throws on invalid reason', () => {
    runInvalid({ sessionId: 's1', messageId: 'm1', rating: 'up', reason: 123 }, 'Invalid reason');
    runInvalid({ sessionId: 's1', messageId: 'm1', rating: 'up', reason: 'a'.repeat(501) }, 'Invalid reason');
  });
});
