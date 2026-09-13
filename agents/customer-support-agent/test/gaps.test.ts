import { describe, it, expect } from 'vitest';
import { normalizeQuestion, latestQuestion } from '../src/gaps.js';
import type { ChatTurn } from '../src/types.js';

describe('normalizeQuestion', () => {
  it('lowercases, strips punctuation, collapses whitespace, trims, and caps at 500', () => {
    expect(normalizeQuestion('   What is   the WEATHER?! ')).toBe('what is the weather');
    
    const longQ = 'A'.repeat(600);
    expect(normalizeQuestion(longQ)).toBe('a'.repeat(500));
  });
});

describe('latestQuestion', () => {
  it('returns the last user turn content, trimmed', () => {
    const msgs: ChatTurn[] = [
      { role: 'user', content: ' first   ' },
      { role: 'assistant', content: ' hello ' },
      { role: 'user', content: '   second   ' },
      { role: 'assistant', content: ' hey ' }
    ];
    expect(latestQuestion(msgs)).toBe('second');
  });

  it('returns empty string when no user turn exists', () => {
    const msgs: ChatTurn[] = [
      { role: 'assistant', content: ' hey ' }
    ];
    expect(latestQuestion(msgs)).toBe('');
  });

  it('returns empty string when messages is empty', () => {
    expect(latestQuestion([])).toBe('');
  });
});
