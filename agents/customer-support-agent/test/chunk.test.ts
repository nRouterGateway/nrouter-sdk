import { describe, it, expect } from 'vitest';
import { chunkText, chunkDocs, stableHash } from '../src/knowledge/chunk.js';

describe('chunkText', () => {
  it('should be deterministic', () => {
    const text = 'A quick brown fox jumps over the lazy dog. '.repeat(100);
    const result1 = chunkText(text);
    const result2 = chunkText(text);
    expect(result1).toEqual(result2);
  });

  it('should drop empty/whitespace chunks and normalize whitespace', () => {
    const text = '   \n\n\n  hello   \t  world  \n\n\n   ';
    const result = chunkText(text);
    expect(result).toEqual(['hello world']);
  });

  it('should never split mid-word when avoidable', () => {
    const text = 'This is a test paragraph';
    const result = chunkText(text, { maxChars: 16, overlap: 5 });
    expect(result[0]).toBe('This is a test');
    expect(result[1]).toBe('test paragraph');
  });

  it('overlap correctness', () => {
    const text = 'aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll';
    const result = chunkText(text, { maxChars: 15, overlap: 5 });
    expect(result.length).toBeGreaterThan(1);
    const overlapStr = 'cccc';
    expect(result[0]).toContain(overlapStr);
    expect(result[1]).toContain(overlapStr);
  });
});

describe('chunkDocs', () => {
  it('should skip empty docs', () => {
    const docs = [
      { title: 'T1', url: 'U1', content: '   ' },
      { title: 'T2', url: 'U2', content: 'Valid' }
    ];
    const chunks = chunkDocs(docs);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.title).toBe('T2');
  });

  it('should carry title/url/audiences', () => {
    const docs = [{ title: 'T', url: 'U', content: 'Content', audiences: ['A'] }];
    const chunks = chunkDocs(docs);
    expect(chunks[0]!.title).toBe('T');
    expect(chunks[0]!.url).toBe('U');
    expect(chunks[0]!.audiences).toEqual(['A']);
  });

  it('ids are stable and different for urls/positions', () => {
    const text = 'a '.repeat(1000);
    const docs1 = [{ title: 'T', url: 'U1', content: text }];
    const chunks1 = chunkDocs(docs1);
    
    const docs2 = [{ title: 'T', url: 'U1', content: text }];
    const chunks2 = chunkDocs(docs2);
    
    expect(chunks1.map(c => c.id)).toEqual(chunks2.map(c => c.id));
    
    const docs3 = [{ title: 'T', url: 'U2', content: text }];
    const chunks3 = chunkDocs(docs3);
    expect(chunks1[0]!.id).not.toBe(chunks3[0]!.id);
    
    expect(chunks1.length).toBeGreaterThan(1);
    expect(chunks1[0]!.id).not.toBe(chunks1[1]!.id);
  });
});

describe('stableHash', () => {
  it('returns a 16-char hex', () => {
    const hash = stableHash('test');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic', () => {
    expect(stableHash('hello world')).toBe(stableHash('hello world'));
    expect(stableHash('hello world 1')).not.toBe(stableHash('hello world'));
  });
});
