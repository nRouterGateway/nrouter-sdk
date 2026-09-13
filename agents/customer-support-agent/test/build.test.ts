import { describe, it, expect, vi } from 'vitest';
import { buildKnowledgeIndex } from '../src/knowledge/build.js';
import type { SourceDoc } from '../src/types.js';

vi.mock('../src/knowledge/chunk.js', () => ({
  chunkDocs: (docs: SourceDoc[]) => docs.map((d, i) => ({
    id: `chunk-${i}`,
    title: d.title,
    url: d.url,
    content: d.content,
    audiences: d.audiences
  }))
}));

describe('buildKnowledgeIndex', () => {
  it('handles zero docs without calling embed', async () => {
    const client = { embeddings: { create: vi.fn() } } as any;
    const index = await buildKnowledgeIndex({ docs: [], client });
    
    expect(client.embeddings.create).not.toHaveBeenCalled();
    expect(index.chunks).toHaveLength(0);
    expect(index.version).toBe(1);
    expect(index.embeddingModel).toBe('text-embedding-3-small');
  });

  it('batches requests according to batchSize', async () => {
    const batches: number[] = [];
    const client = {
      embeddings: {
        create: vi.fn().mockImplementation(async (opts) => {
          batches.push(opts.input.length);
          return {
            data: opts.input.map(() => ({ embedding: [0.1, 0.2] }))
          };
        })
      }
    } as any;

    const docs = Array.from({ length: 5 }, (_, i) => ({
      title: `Doc ${i}`,
      url: `http://example.com/${i}`,
      content: `Content ${i}`
    }));

    const index = await buildKnowledgeIndex({
      docs,
      client,
      batchSize: 2,
      dimensions: 2
    });

    expect(index.chunks).toHaveLength(5);
    expect(batches).toEqual([2, 2, 1]);
  });

  it('propagates abort signal (before embed)', async () => {
    const client = { embeddings: { create: vi.fn() } } as any;
    const controller = new AbortController();
    controller.abort();

    await expect(buildKnowledgeIndex({
      docs: [{ title: 'Doc', url: 'url', content: 'content' }],
      client,
      signal: controller.signal
    })).rejects.toThrow('build aborted');

    expect(client.embeddings.create).not.toHaveBeenCalled();
  });

  it('propagates abort signal (during embed)', async () => {
    const controller = new AbortController();
    const client = {
      embeddings: {
        create: vi.fn().mockImplementation(async () => {
          controller.abort(); // abort during the request
          const err = new Error('AbortError');
          err.name = 'AbortError';
          throw err;
        })
      }
    } as any;

    await expect(buildKnowledgeIndex({
      docs: [{ title: 'Doc', url: 'url', content: 'content' }],
      client,
      signal: controller.signal
    })).rejects.toThrow('build aborted');
  });

  it('throws upstream error if embeddings length mismatches', async () => {
    const client = {
      embeddings: {
        create: vi.fn().mockImplementation(async () => ({
          data: [{ embedding: [0] }] // Only 1 returned for a batch of 2
        }))
      }
    } as any;

    const docs = Array.from({ length: 2 }, (_, i) => ({
      title: `Doc ${i}`,
      url: `http://example.com/${i}`,
      content: `Content ${i}`
    }));

    await expect(buildKnowledgeIndex({ docs, client }))
      .rejects.toThrow('Embedding count mismatch');
  });

  it('assigns correct vector when out-of-order', async () => {
    const client = {
      embeddings: {
        create: vi.fn().mockImplementation(async () => {
          return {
            data: [
              { index: 1, embedding: [0.2, 0.2] },
              { index: 0, embedding: [0.1, 0.1] }
            ]
          };
        })
      }
    } as any;

    const docs = [
      { title: 'Doc 0', url: 'http://0', content: '0' },
      { title: 'Doc 1', url: 'http://1', content: '1' }
    ];

    const index = await buildKnowledgeIndex({ docs, client, batchSize: 2, dimensions: 2 });
    expect(index.chunks[0]?.embedding).toEqual([0.1, 0.1]);
    expect(index.chunks[1]?.embedding).toEqual([0.2, 0.2]);
  });
});
