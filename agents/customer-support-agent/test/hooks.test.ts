import { describe, it, expect, vi } from 'vitest';
import { callHook } from '../src/hooks.js';
import type { SupportAgentHooks } from '../src/types.js';

describe('callHook', () => {
  it('does nothing if hook absent', () => {
    const hooks: SupportAgentHooks = {};
    expect(() => callHook(hooks, 'onGap', {} as any)).not.toThrow();
  });

  it('calls hook successfully', async () => {
    const onGap = vi.fn();
    const hooks: SupportAgentHooks = { onGap };
    callHook(hooks, 'onGap', { question: 'q', normalized: 'q', confidence: 'high', webSearched: false });
    expect(onGap).toHaveBeenCalledWith({ question: 'q', normalized: 'q', confidence: 'high', webSearched: false });
  });

  it('does not throw if hook throws synchronously', () => {
    const onError = vi.fn();
    const hooks: SupportAgentHooks = {
      onGap: () => { throw new Error('boom'); },
      onError
    };
    expect(() => callHook(hooks, 'onGap', {} as any)).not.toThrow();
    expect(onError).toHaveBeenCalledWith({ code: 'internal_error', message: 'hook onGap failed' });
  });

  it('does not throw if hook returns rejected promise', async () => {
    const onError = vi.fn();
    const hooks: SupportAgentHooks = {
      onGap: async () => { throw new Error('boom'); },
      onError
    };
    expect(() => callHook(hooks, 'onGap', {} as any)).not.toThrow();
    // wait a tick for the promise catch to fire
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(onError).toHaveBeenCalledWith({ code: 'internal_error', message: 'hook onGap failed' });
  });

  it('does not throw if onError itself throws', () => {
    const hooks: SupportAgentHooks = {
      onGap: () => { throw new Error('boom'); },
      onError: () => { throw new Error('onError boom'); }
    };
    expect(() => callHook(hooks, 'onGap', {} as any)).not.toThrow();
  });
});
