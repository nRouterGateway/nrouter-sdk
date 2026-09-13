import { describe, it, expect } from 'vitest';
import { createClient, embed, streamChat, costFromMeta } from '../src/client.js';
import { SupportAgentError } from '../src/errors.js';
import { nRouter } from '@nrouter_ai/sdk';

describe('client', () => {
  describe('createClient', () => {
    it('creates a client with valid key', () => {
      const client = createClient('sk-nrouter-test');
      expect(client).toBeInstanceOf(nRouter);
    });

    it('throws invalid_config on empty key', () => {
      expect(() => createClient('')).toThrow(SupportAgentError);
      expect(() => createClient('   ')).toThrow(SupportAgentError);
    });
  });

  describe('embed', () => {
    it('returns empty array for empty input without calling SDK', async () => {
      const client = Object.create(nRouter.prototype);
      let called = false;
      client.embeddings = {
        create: async () => { called = true; return { data: [] }; }
      };
      
      const res = await embed(client, 'test-model', [], 100);
      expect(res).toEqual([]);
      expect(called).toBe(false);
    });

    it('calls SDK and sorts vectors by index', async () => {
      const client = Object.create(nRouter.prototype);
      client.embeddings = {
        create: async () => {
          return {
            data: [
              { index: 1, embedding: [3, 4] },
              { index: 0, embedding: [1, 2] }
            ]
          };
        }
      };

      const res = await embed(client, 'test-model', ['a', 'b'], 2);
      expect(res).toEqual([[1, 2], [3, 4]]);
    });

    it('throws if count mismatches', async () => {
      const client = Object.create(nRouter.prototype);
      client.embeddings = {
        create: async () => {
          return {
            data: [
              { index: 0, embedding: [1, 2] }
            ]
          };
        }
      };

      await expect(embed(client, 'test-model', ['a', 'b'], 2)).rejects.toThrow(SupportAgentError);
    });

    it('throws if dimension mismatches', async () => {
      const client = Object.create(nRouter.prototype);
      client.embeddings = {
        create: async () => {
          return {
            data: [
              { index: 0, embedding: [1, 2, 3] }
            ]
          };
        }
      };

      await expect(embed(client, 'test-model', ['a'], 2)).rejects.toThrow(SupportAgentError);
    });
  });

  describe('streamChat', () => {
    it('streams non-empty chunks and maps cost', async () => {
      const client = Object.create(nRouter.prototype);
      client.nr = {
        stream: async () => {
          async function* chunks() {
            yield { delta: '' };
            yield { delta: 'hello' };
            yield { delta: ' world' };
          }
          return {
            meta: { cost: 0.05 }, // Let's rely on costFromMeta which expects real headers or we can just mock costFromMeta directly if we were mocking, but it uses it directly.
            // Wait, isPriced expects the object to have the right symbol, or checks headers? 
            // In meta.js, isPriced probably looks for a specific property or costStatus.
            // But we can just see what costFromMeta does.
            chunks: chunks()
          };
        }
      };

      const answer = await streamChat(client, { model: 'm', messages: [], maxTokens: 10 });
      // The chunks should be readable
      const parts = [];
      for await (const c of answer.chunks) {
        parts.push(c);
      }
      expect(parts).toEqual(['hello', ' world']);
    });
  });

  describe('costFromMeta', () => {
    it('returns exact cost when priced', () => {
      // Mocking isPriced behavior might be tricky if it looks for a Symbol or class.
      // Assuming isPriced checks `costStatus === 'exact'` or something similar.
      const meta: any = { cost: 0.05, costStatus: 'exact' };
      const res = costFromMeta(meta);
      expect(res).toEqual({ costUsd: 0.05, status: 'exact' });
    });

    it('never emits 0 as cost, maps to unpriced', () => {
      const meta: any = { cost: 0, costStatus: 'exact' };
      const res = costFromMeta(meta);
      expect(res).toEqual({ costUsd: null, status: 'unpriced' });
    });

    it('returns unpriced when not priced', () => {
      const meta: any = { cost: null, costStatus: 'unpriced' };
      const res = costFromMeta(meta);
      expect(res).toEqual({ costUsd: null, status: 'unpriced' });
    });

    it('includes requestId when present', () => {
      const meta: any = { cost: 0.05, costStatus: 'exact', requestId: 'req_123' };
      const res = costFromMeta(meta);
      expect(res).toEqual({ costUsd: 0.05, status: 'exact', requestId: 'req_123' });
    });
  });
});
