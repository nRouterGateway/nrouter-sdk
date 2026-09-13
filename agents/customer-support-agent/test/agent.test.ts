import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSupportAgent } from '../src/agent.js';
import type { nRouter } from '@nrouter_ai/sdk';
import { nRouterGuardrailBlockedError } from '@nrouter_ai/sdk';
import { SupportAgentError } from '../src/errors.js';

vi.mock('../src/retrieval.js', () => ({ retrieve: vi.fn().mockResolvedValue([]) }));
vi.mock('../src/confidence.js', () => ({ scoreConfidence: vi.fn().mockReturnValue({ level: 'high', score: 0.9 }) }));
vi.mock('../src/prompt.js', () => ({ buildCitations: vi.fn().mockReturnValue([]), buildSystemPrompt: vi.fn().mockReturnValue('sys') }));
vi.mock('../src/page-context.js', () => ({ sanitizePageContext: vi.fn().mockReturnValue(null) }));
vi.mock('../src/gaps.js', () => ({ latestQuestion: vi.fn().mockReturnValue('Q'), normalizeQuestion: vi.fn().mockReturnValue('q') }));
vi.mock('../src/tools.js', () => ({ runToolPhase: vi.fn().mockImplementation(async (c, m, e) => ({ messages: m, ranTools: false })) }));
vi.mock('../src/web-search.js', () => ({ runWebSearch: vi.fn().mockResolvedValue([]) }));
vi.mock('../src/client.js', () => ({
  createClient: vi.fn(),
  streamChat: vi.fn().mockImplementation(async (client, opts) => {
    const res = await client.nr.stream(opts);
    return { cost: res.meta.cost as any, chunks: res.chunks as any };
  })
}));
vi.mock('../src/hooks.js', () => ({ callHook: vi.fn() }));
vi.mock('../src/sse.js', () => ({
  toSSE: vi.fn().mockReturnValue(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('[DONE]')); c.close(); }
  }))
}));
vi.mock('../src/feedback.js', () => ({ validateFeedback: vi.fn().mockReturnValue({ rating: 'up' }) }));

describe('SupportAgent', () => {
  let fakeClient: nRouter;
  let streamGenerator: any;
  const fakeIndex = { version: 1 as const, embeddingModel: 't', dimensions: 2, createdAt: '2026', chunks: [] };

  beforeEach(() => {
    vi.clearAllMocks();
    streamGenerator = async function* () {
      yield 'token1';
      yield 'token2';
    };
    fakeClient = {
      nr: {
        stream: vi.fn().mockImplementation(async () => {
          return { meta: { cost: { costUsd: 0.05, status: 'exact' } }, chunks: streamGenerator() };
        })
      },
      embeddings: {
        create: vi.fn().mockResolvedValue({ data: [{ embedding: [1, 0] }] })
      }
    } as unknown as nRouter;
  });

  it('event ORDER (confidence, citations, tokens, cost, done)', async () => {
    const { scoreConfidence } = await import('../src/confidence.js');
    vi.mocked(scoreConfidence).mockReturnValue({ level: 'high', score: 0.9 });
    
    const { buildCitations } = await import('../src/prompt.js');
    vi.mocked(buildCitations).mockReturnValue([{ title: 'Doc', url: 'http' }]);

    const agent = createSupportAgent({ client: fakeClient, model: 'm', knowledge: fakeIndex });
    const events = [];
    for await (const ev of agent.chat({ messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(ev);
    }
    
    expect(events.map(e => e.type)).toEqual(['confidence', 'citations', 'token', 'token', 'cost', 'done']);
    expect(events[0]).toMatchObject({ level: 'high', score: 0.9, webSearched: false });
    expect(events[1]).toMatchObject({ citations: [{ title: 'Doc', url: 'http' }] });
    expect(events[2]).toMatchObject({ text: 'token1' });
  });

  it('low confidence → onGap called, web search path', async () => {
    const { scoreConfidence } = await import('../src/confidence.js');
    vi.mocked(scoreConfidence).mockReturnValue({ level: 'low', score: 0.1 });
    const { callHook } = await import('../src/hooks.js');

    const agent = createSupportAgent({ 
      client: fakeClient, 
      model: 'm', 
      knowledge: fakeIndex,
      webSearch: { label: 'Google', search: vi.fn() },
      hooks: { onGap: vi.fn() }
    });
    
    const events = [];
    for await (const ev of agent.chat({ messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(ev);
    }
    
    const types = events.map(e => e.type);
    expect(types).toContain('tool_call');
    expect(events.find(e => e.type === 'tool_call' && e.status === 'running')).toBeDefined();
    
    expect(callHook).toHaveBeenCalledWith(expect.anything(), 'onGap', expect.objectContaining({ confidence: 'low', webSearched: true }));
  });

  it('guardrail retry once', async () => {
    const { streamChat } = await import('../src/client.js');
    const { scoreConfidence } = await import('../src/confidence.js');
    vi.mocked(scoreConfidence).mockReturnValue({ level: 'low', score: 0.1 });
    
    let calls = 0;
    vi.mocked(streamChat).mockImplementation(async (client, opts) => {
       calls++;
       if (calls === 1) throw new nRouterGuardrailBlockedError('blocked', {} as any);
       const chunks = async function*() { yield 'retry_ok'; }();
       return { cost: { costUsd: null, status: 'unpriced' }, chunks };
    });

    const agent = createSupportAgent({ 
      client: fakeClient, 
      model: 'm', 
      knowledge: fakeIndex,
      webSearch: { label: 'B', search: vi.fn() }
    });
    
    const events = [];
    for await (const ev of agent.chat({ messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(ev);
    }
    
    expect(calls).toBe(2);
    expect(events.find(e => e.type === 'token' && e.text === 'retry_ok')).toBeDefined();
    expect(events.map(e => e.type)).toContain('done');
    expect(events.map(e => e.type)).not.toContain('error');
  });

  it('error event never contains the api key', async () => {
    const { streamChat } = await import('../src/client.js');
    vi.mocked(streamChat).mockRejectedValue(new SupportAgentError('upstream_error', 'failed sk-nrouter-secret-key'));

    const agent = createSupportAgent({ 
      apiKey: 'sk-nrouter-secret-key',
      model: 'm', 
      knowledge: fakeIndex 
    });
    
    const events = [];
    for await (const ev of agent.chat({ messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(ev);
    }
    
    const errEvent = events.find(e => e.type === 'error') as any;
    expect(errEvent).toBeDefined();
    expect(errEvent.message).not.toContain('sk-nrouter-secret-key');
    expect(errEvent.message).toContain('[redacted]');
  });

  it('abort → aborted + done', async () => {
    const { streamChat } = await import('../src/client.js');
    vi.mocked(streamChat).mockImplementation(async () => {
       const err = new Error('abort');
       err.name = 'AbortError';
       throw err;
    });

    const agent = createSupportAgent({ client: fakeClient, model: 'm', knowledge: fakeIndex });
    
    const events = [];
    const ac = new AbortController();
    for await (const ev of agent.chat({ messages: [{ role: 'user', content: 'hi' }], signal: ac.signal })) {
      events.push(ev);
    }
    
    expect(events.map(e => e.type)).toEqual(['confidence', 'citations', 'error', 'done']);
    expect(events[2]).toMatchObject({ code: 'aborted' });
  });

  it('DOUBLE BILLED CALL: tools configured → exactly ONE model call (streamChat skipped)', async () => {
    const { runToolPhase } = await import('../src/tools.js');
    vi.mocked(runToolPhase).mockResolvedValue({
      messages: [{ role: 'assistant', content: 'tool answer' }] as any,
      ranTools: false,
      text: 'tool answer',
      cost: { costUsd: 0.1, status: 'exact' }
    });
    const { streamChat } = await import('../src/client.js');
    vi.mocked(streamChat).mockClear();

    const agent = createSupportAgent({ 
      client: fakeClient, 
      model: 'm', 
      knowledge: fakeIndex,
      tools: [{ definition: { type: 'function', function: { name: 't1' } }, execute: vi.fn() }] as any
    });
    
    const events = [];
    for await (const ev of agent.chat({ messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(ev);
    }
    
    expect(streamChat).not.toHaveBeenCalled();
    expect(events.find(e => e.type === 'token' && e.text === 'tool answer')).toBeDefined();
  });

  it('TRUSTED CONTEXT: req body with audiences must NOT unlock chunk; ctx.audiences must', async () => {
    const { retrieve } = await import('../src/retrieval.js');
    vi.mocked(retrieve).mockClear();
    
    const agent = createSupportAgent({ client: fakeClient, model: 'm', knowledge: fakeIndex });
    
    // Pass audiences in untrusted req body
    const reqWithAudiences = { messages: [{ role: 'user', content: 'hi' }], audiences: ['gated'] };
    for await (const ev of agent.chat(reqWithAudiences, {})) {
       // iterate
    }
    
    // The retrieve call should NOT have 'gated' in its audiences options
    expect(retrieve).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ audiences: undefined, signal: undefined }));
    
    vi.mocked(retrieve).mockClear();
    
    // Pass audiences in trusted ctx
    for await (const ev of agent.chat({ messages: [{ role: 'user', content: 'hi' }] }, { audiences: ['gated'] })) {
       // iterate
    }
    
    // The retrieve call MUST have 'gated' in its audiences options
    expect(retrieve).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ audiences: ['gated'] }));
  });

  it('chatSSE ends with [DONE]', async () => {
    const agent = createSupportAgent({ client: fakeClient, model: 'm', knowledge: fakeIndex });
    const stream = agent.chatSSE({ messages: [{ role: 'user', content: 'hi' }] });
    const reader = stream.getReader();
    const result = await reader.read();
    expect(new TextDecoder().decode(result.value)).toBe('[DONE]');
  });

  it('MEMORY DUPLICATION: two consecutive turns store holds exactly [user1, assistant1, user2, assistant2]', async () => {
    const { createArrayStore } = await import('@nrouter_ai/sdk');
    const store = createArrayStore();
    
    // We must unmock tools.js and client.js enough so it doesn't crash?
    const { streamChat } = await import('../src/client.js');
    vi.mocked(streamChat).mockImplementation(async (client, opts) => {
      const res = await client.nr.stream(opts);
      return { cost: res.meta.cost as any, chunks: res.chunks as any };
    });
    const agent = createSupportAgent({ 
      client: fakeClient, 
      model: 'm', 
      knowledge: fakeIndex,
      memoryStore: () => store
    });
    
    // Turn 1
    const events1 = [];
    for await (const ev of agent.chat({ messages: [{ role: 'user', content: 'user1' }] }, { sessionId: 'session1' })) {
       events1.push(ev);
    }
    
    // Turn 2
    // A real client would send the full conversation, so messages is [user1, assistant1, user2].
    const events2 = [];
    for await (const ev of agent.chat({ 
       messages: [
         { role: 'user', content: 'user1' }, 
         { role: 'assistant', content: 'token1token2' }, 
         { role: 'user', content: 'user2' }
       ] 
    }, { sessionId: 'session1' })) {
       events2.push(ev);
    }
    console.log(JSON.stringify(events1));
    console.log(JSON.stringify(events2));
    const msgs = await store.load();
    expect(msgs.map(m => m.content)).toEqual(['user1', 'token1token2', 'user2', 'token1token2']);
  });

  it('PII MASKING: masks messages to runToolPhase and passes maskPii to streamChat', async () => {
    const { runToolPhase } = await import('../src/tools.js');
    let capturedToolMessages: any[] = [];
    vi.mocked(runToolPhase).mockImplementation(async (cfg, msgs, cb) => {
      capturedToolMessages = msgs;
      return { messages: msgs, ranTools: false };
    });

    const { streamChat } = await import('../src/client.js');
    let capturedStreamOpts: any = null;
    vi.mocked(streamChat).mockImplementation(async (client, opts) => {
      capturedStreamOpts = opts;
      async function* chunks() { yield 'answer'; }
      return { cost: { costUsd: null, status: 'unpriced' }, chunks: chunks() };
    });

    const agent = createSupportAgent({
      client: fakeClient,
      model: 'm',
      knowledge: fakeIndex,
      maskPii: true
    });

    for await (const _ of agent.chat({
      messages: [{ role: 'user', content: 'Contact me at admin@corp.com or 555-123-4567' }]
    })) {
      // iterate
    }

    // runToolPhase received masked messages
    const userMsgInTool = capturedToolMessages.find(m => m.role === 'user');
    expect(userMsgInTool?.content).toBe('Contact me at [email] or [phone]');

    // streamChat received maskPii: true
    expect(capturedStreamOpts.maskPii).toBe(true);
  });

  it('PII MASKING: masks multi-part array content in tool phase', async () => {
    const { runToolPhase } = await import('../src/tools.js');
    let capturedToolMessages: any[] = [];
    vi.mocked(runToolPhase).mockImplementation(async (cfg, msgs, cb) => {
      capturedToolMessages = msgs;
      return { messages: msgs, ranTools: false };
    });

    const { createArrayStore } = await import('@nrouter_ai/sdk');
    const store = createArrayStore([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'my email is user@domain.com' },
          { type: 'image_url', image_url: { url: 'https://example.com/img.png' } }
        ] as any
      }
    ]);

    const agent = createSupportAgent({
      client: fakeClient,
      model: 'm',
      knowledge: fakeIndex,
      maskPii: true,
      memoryStore: () => store
    });

    for await (const _ of agent.chat({
      messages: [{ role: 'user', content: 'hello' }]
    }, { sessionId: 'sess-1' })) {
      // iterate
    }

    const userMsg = capturedToolMessages.find(m => Array.isArray(m.content));
    expect(userMsg?.content).toEqual([
      { type: 'text', text: 'my email is [email]' },
      { type: 'image_url', image_url: { url: 'https://example.com/img.png' } }
    ]);
  });
});



