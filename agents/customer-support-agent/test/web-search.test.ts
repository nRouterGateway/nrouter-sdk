import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runWebSearch, createWebSearchTool, WEB_SEARCH_TOOL_ID } from '../src/web-search.js';
import type { WebSearchProvider } from '../src/types.js';

describe('runWebSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns [] on timeout', async () => {
    const provider: WebSearchProvider = {
      label: 'test',
      search: async (q, opts) => {
        return new Promise(resolve => {
          opts.signal?.addEventListener('abort', () => resolve([]));
        });
      }
    };
    
    const p = runWebSearch(provider, 'query', { timeoutMs: 100 });
    vi.advanceTimersByTime(150);
    const result = await p;
    expect(result).toEqual([]);
  });

  it('returns [] if provider hangs', async () => {
    const provider: WebSearchProvider = {
      label: 'test',
      search: async () => new Promise(() => {}) // never resolves
    };
    
    const p = runWebSearch(provider, 'query', { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(100);
    const result = await p;
    expect(result).toEqual([]);
  }, 1000); // bounded test

  it('a provider that rejects after the timeout never becomes an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    // Real timers: the unhandled-rejection event is emitted from Node's own tick queue.
    vi.useRealTimers();
    try {
      const provider: WebSearchProvider = {
        label: 'test',
        search: () => new Promise((_, reject) => setTimeout(() => reject(new Error('late failure')), 60)),
      };
      expect(await runWebSearch(provider, 'query', { timeoutMs: 20 })).toEqual([]);
      await new Promise((r) => setTimeout(r, 150));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }, 1000);

  it('filters non-http(s) urls and truncates text', async () => {
    const provider: WebSearchProvider = {
      label: 'test',
      search: async () => [
        { title: 'A'.repeat(300), url: 'https://example.com', snippet: 'B'.repeat(600) },
        { title: 'Bad', url: 'ftp://example.com', snippet: 'nope' },
        { title: 'Good', url: 'http://example.org', snippet: 'yes' }
      ]
    };
    
    const result = await runWebSearch(provider, 'q');
    expect(result).toHaveLength(2);
    expect(result[0]!.url).toBe('https://example.com');
    expect(result[0]!.title.length).toBe(200);
    expect(result[0]!.snippet.length).toBe(500);
    expect(result[1]!.url).toBe('http://example.org');
  });
});

describe('createWebSearchTool', () => {
  it('creates an agent tool with correct schema', async () => {
    const provider: WebSearchProvider = {
      label: 'test',
      search: async () => [{ title: 't', url: 'https://u', snippet: 's' }]
    };
    const tool = createWebSearchTool(provider);
    expect(tool.definition.function.name).toBe(WEB_SEARCH_TOOL_ID);
    expect(tool.definition.function.parameters?.required).toEqual(['query']);
    
    const result = await tool.execute({ query: 'test' }, {} as any);
    expect(result).toEqual([{ title: 't', url: 'https://u', snippet: 's' }]);
  });
});
