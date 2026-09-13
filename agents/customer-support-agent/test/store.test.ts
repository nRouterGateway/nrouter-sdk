import { describe, it, expect } from 'vitest';
import { cosineSimilarity, createMemoryKnowledgeStore } from '../src/knowledge/store.js';
import type { KnowledgeIndex } from '../src/types.js';

describe('cosineSimilarity', () => {
  it('throws on length mismatch', () => {
    expect(() => cosineSimilarity([1, 2], [1])).toThrow('Embedding dimensions mismatch');
  });

  it('handles zero norm', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 1], [0, 0])).toBe(0);
  });

  it('calculates correctly', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(-1);
  });
});

describe('createMemoryKnowledgeStore', () => {
  const mockIndex: KnowledgeIndex = {
    version: 1,
    embeddingModel: 'test-model',
    dimensions: 2,
    createdAt: new Date().toISOString(),
    chunks: [
      {
        id: 'chunk-2',
        title: 'T2',
        url: 'http://example.com/2',
        content: 'Content 2',
        embedding: [0, 1] // Matches query [0, 1] perfectly
      },
      {
        id: 'chunk-1',
        title: 'T1',
        url: 'http://example.com/1',
        content: 'Content 1',
        embedding: [0, 1] // Tie with chunk-2
      },
      {
        id: 'chunk-3',
        title: 'T3',
        url: 'http://example.com/3',
        content: 'Content 3',
        embedding: [1, 0] // Orthogonal to [0, 1]
      },
      {
        id: 'chunk-4-gated',
        title: 'T4',
        url: 'http://example.com/4',
        content: 'Content 4',
        audiences: ['pro', 'enterprise'],
        embedding: [0, 1]
      }
    ]
  };

  it('validates bounds on topK', async () => {
    const store = createMemoryKnowledgeStore(mockIndex);
    const query = [0, 1];
    
    await expect(store.search(query, { topK: 0 })).rejects.toThrow('topK must be an integer between 1 and 50');
    await expect(store.search(query, { topK: 51 })).rejects.toThrow('topK must be an integer between 1 and 50');
    await expect(store.search(query, { topK: 1.5 })).rejects.toThrow('topK must be an integer between 1 and 50');
  });

  it('validates query dimensions', async () => {
    const store = createMemoryKnowledgeStore(mockIndex);
    await expect(store.search([0], { topK: 5 })).rejects.toThrow('Query length must equal index dimensions');
  });

  it('ranks results correctly and breaks ties by id', async () => {
    const store = createMemoryKnowledgeStore(mockIndex);
    const query = [0, 1];
    const results = await store.search(query, { topK: 5 });

    // chunk-4-gated is excluded by default
    expect(results.length).toBe(3);
    
    // chunk-1 and chunk-2 both have similarity 1
    // Tie breaker should sort by id asc: chunk-1 then chunk-2
    expect(results[0]!.id).toBe('chunk-1');
    expect(results[1]!.id).toBe('chunk-2');
    expect(results[2]!.id).toBe('chunk-3');
    
    expect(results[0]!.similarity).toBe(1);
    expect(results[2]!.similarity).toBe(0);
  });

  it('respects audience filter (default-deny)', async () => {
    const store = createMemoryKnowledgeStore(mockIndex);
    const query = [0, 1];
    
    // With audiences: ['pro']
    const results = await store.search(query, { topK: 5, audiences: ['pro'] });
    expect(results.length).toBe(4);
    
    const ids = results.map(r => r.id);
    expect(ids).toContain('chunk-4-gated');
  });

  it('respects audience filter with multiple opts (no overlap)', async () => {
    const store = createMemoryKnowledgeStore(mockIndex);
    const query = [0, 1];
    
    const results = await store.search(query, { topK: 5, audiences: ['free'] });
    const ids = results.map(r => r.id);
    expect(ids).not.toContain('chunk-4-gated'); // no overlap
  });
});
