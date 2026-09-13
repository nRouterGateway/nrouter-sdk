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

  it('guardrail refusal with skipBlocked: false re-embeds 1-by-1 and throws naming refused doc', async () => {
    const client = {
      embeddings: {
        create: vi.fn().mockImplementation(async (opts: any) => {
          // If batch contains bad content, throw guardrail error
          if (opts.input.length > 1) {
            const err = new Error('request blocked by a guardrail: PII detected');
            (err as any).status = 400;
            throw err;
          }
          // Individual chunk calls:
          if (opts.input[0] === 'Bad Content') {
            const err = new Error('request blocked by a guardrail: PII detected');
            (err as any).status = 400;
            throw err;
          }
          return { data: [{ index: 0, embedding: [0.5, 0.5] }] };
        })
      }
    } as any;

    const docs = [
      { title: 'Good Doc', url: 'http://example.com/good', content: 'Good Content' },
      { title: 'Bad Doc', url: 'http://example.com/bad', content: 'Bad Content' }
    ];

    await expect(buildKnowledgeIndex({ docs, client, dimensions: 2, skipBlocked: false }))
      .rejects.toThrow('the gateway refused 1 document(s) under a guardrail: http://example.com/bad');
  });

  it('guardrail refusal with skipBlocked: true drops refused doc and calls onSkip', async () => {
    const client = {
      embeddings: {
        create: vi.fn().mockImplementation(async (opts: any) => {
          if (opts.input.length > 1) {
            const err = new Error('request blocked by a guardrail: PII detected');
            (err as any).status = 400;
            throw err;
          }
          if (opts.input[0] === 'Bad Content') {
            const err = new Error('request blocked by a guardrail: PII detected');
            (err as any).status = 400;
            throw err;
          }
          return { data: [{ index: 0, embedding: [0.5, 0.5] }] };
        })
      }
    } as any;

    const docs = [
      { title: 'Good Doc', url: 'http://example.com/good', content: 'Good Content' },
      { title: 'Bad Doc', url: 'http://example.com/bad', content: 'Bad Content' }
    ];

    const skipped: any[] = [];
    const index = await buildKnowledgeIndex({
      docs,
      client,
      dimensions: 2,
      skipBlocked: true,
      onSkip: (d) => skipped.push(d)
    });

    expect(skipped).toEqual([
      {
        title: 'Bad Doc',
        url: 'http://example.com/bad',
        reason: 'request blocked by a guardrail: PII detected'
      }
    ]);
    expect(index.chunks).toHaveLength(1);
    expect(index.chunks[0]?.url).toBe('http://example.com/good');
  });

  it('passes maskPii option to embed calls', async () => {
    let capturedOpts: any;
    const client = {
      embeddings: {
        create: vi.fn().mockImplementation(async (opts: any) => {
          capturedOpts = opts;
          return { data: [{ index: 0, embedding: [0.1, 0.1] }] };
        })
      }
    } as any;

    const docs = [{ title: 'Doc', url: 'http://example.com', content: 'Contact me at test@example.com' }];
    await buildKnowledgeIndex({ docs, client, dimensions: 2, maskPii: false });
    // When maskPii is false, input is not masked
    expect(capturedOpts.input).toEqual(['Contact me at test@example.com']);
  });
});
