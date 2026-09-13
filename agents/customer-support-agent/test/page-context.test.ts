import { describe, it, expect } from 'vitest';
import { sanitizePageContext } from '../src/page-context.js';

describe('sanitizePageContext', () => {
  it('returns null for non-strings', () => {
    expect(sanitizePageContext(null, 100)).toBeNull();
    expect(sanitizePageContext({}, 100)).toBeNull();
    expect(sanitizePageContext(123, 100)).toBeNull();
  });

  it('strips control chars except newline and tab', () => {
    const input = 'hello\u0000world\nfoo\tbar\u001Fbaz';
    const result = sanitizePageContext(input, 100);
    // Depending on collapse whitespace, \n and \t might become spaces, but they MUST NOT be stripped without a trace
    expect(result).not.toContain('\u0000');
    expect(result).not.toContain('\u001F');
    // If collapsed to space:
    expect(result).toBe('helloworld foo barbaz');
  });

  it('collapses whitespace and trims', () => {
    expect(sanitizePageContext('  a   b\n c ', 100)).toBe('a b c');
  });

  it('caps at maxChars', () => {
    expect(sanitizePageContext('a b c d e f', 5)).toBe('a b c');
  });

  it('returns null if empty after sanitization', () => {
    expect(sanitizePageContext('   \u0000  ', 100)).toBeNull();
  });
});
