import type { AgentTool } from '@nrouter_ai/sdk';
import type { WebSearchProvider, WebSource } from './types.js';

export const WEB_SEARCH_TOOL_ID = 'web_search';

/** Bounded search: timeout, max results, http(s) URLs only, snippets capped. Failures return []. */
export async function runWebSearch(
  provider: WebSearchProvider,
  query: string,
  opts?: { maxResults?: number; timeoutMs?: number; signal?: AbortSignal },
): Promise<WebSource[]> {
  const maxResults = Math.min(opts?.maxResults ?? 5, 10);
  const timeoutMs = opts?.timeoutMs ?? 8000;

  const abortController = new AbortController();
  const cleanupFns: Array<() => void> = [];
  
  if (opts?.signal) {
    if (opts.signal.aborted) {
      return [];
    }
    const abortHandler = () => abortController.abort();
    opts.signal.addEventListener('abort', abortHandler);
    cleanupFns.push(() => opts.signal?.removeEventListener('abort', abortHandler));
  }

  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);
  cleanupFns.push(() => clearTimeout(timeoutId));

  try {
    const searchPromise = provider.search(query, { maxResults, signal: abortController.signal });
    const timeoutPromise = new Promise<WebSource[]>((_, reject) => {
      const tid = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      cleanupFns.push(() => clearTimeout(tid));
    });

    const results = await Promise.race([searchPromise, timeoutPromise]);
    return results
      .filter(r => r.url.startsWith('http://') || r.url.startsWith('https://'))
      .slice(0, maxResults)
      .map(r => ({
        title: r.title.substring(0, 200),
        url: r.url,
        snippet: r.snippet.substring(0, 500),
      }));
  } catch (err) {
    return [];
  } finally {
    cleanupFns.forEach(fn => fn());
  }
}

export function createWebSearchTool(provider: WebSearchProvider): AgentTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: WEB_SEARCH_TOOL_ID,
        description: 'Search the web for up-to-date information',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' }
          },
          required: ['query']
        }
      }
    },
    execute: async (args: Record<string, unknown>) => {
      const query = typeof args.query === 'string' ? args.query : '';
      return await runWebSearch(provider, query);
    }
  };
}
