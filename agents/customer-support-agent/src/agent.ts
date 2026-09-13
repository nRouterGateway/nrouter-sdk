// LANE L10 owns this file.
import { createMemory } from '@nrouter_ai/sdk';
import type { SupportAgent, SupportAgentConfig, ChatRequest, AgentEvent, ChatTurn, FeedbackInput } from './types.js';
import { resolveConfig } from './config.js';
import { validateChatRequest, validateTrustedContext } from './limits.js';
import { latestQuestion, normalizeQuestion } from './gaps.js';
import { retrieve } from './retrieval.js';
import { scoreConfidence } from './confidence.js';
import { runWebSearch } from './web-search.js';
import { buildCitations, buildSystemPrompt } from './prompt.js';
import { sanitizePageContext } from './page-context.js';
import { runToolPhase } from './tools.js';
import { streamChat } from './client.js';
import { callHook } from './hooks.js';
import { toSafeError } from './errors.js';
import { toSSE } from './sse.js';
import { validateFeedback } from './feedback.js';
import { maskPii, maskMessageContent } from './pii.js';

export function createSupportAgent(config: SupportAgentConfig): SupportAgent {
  const cfg = resolveConfig(config);

  async function* chat(req: unknown, ctx?: import('./types.js').TrustedContext): AsyncIterable<AgentEvent> {
    try {
      const validatedReq = validateChatRequest(req, cfg.limits);
      const validatedCtx = ctx ? validateTrustedContext(ctx) : {};
      const question = latestQuestion(validatedReq.messages);
      
      const chunks = await retrieve(cfg, question, { audiences: validatedCtx.audiences, signal: validatedReq.signal });
      const conf = scoreConfidence(chunks, cfg.confidence);
      
      let webSources;
      let webSearched = false;
      if (conf.level === 'low' && cfg.webSearch) {
        webSearched = true;
        yield { type: 'tool_call', tool: 'web_search', title: 'Searched ' + cfg.webSearch.label, status: 'running' };
        try {
          webSources = await runWebSearch(cfg.webSearch, question, { signal: validatedReq.signal });
          yield { type: 'tool_call', tool: 'web_search', title: 'Searched ' + cfg.webSearch.label, status: 'done' };
        } catch (err) {
          yield { type: 'tool_call', tool: 'web_search', title: 'Searched ' + cfg.webSearch.label, status: 'error' };
        }
      }
      
      const citations = buildCitations(chunks, webSources);
      yield { type: 'confidence', level: conf.level, score: conf.score, webSearched };
      if (citations.length > 0) {
        yield { type: 'citations', citations };
      }
      
      const system = buildSystemPrompt({
        agentName: cfg.agentName,
        instructions: cfg.instructions,
        identity: validatedCtx.identity,
        pageContext: sanitizePageContext(validatedReq.pageContext, cfg.limits.maxPageContextChars),
        chunks,
        webSources
      });
      
      let history: ChatTurn[] = validatedReq.messages;
      let mem;
      if (validatedCtx.sessionId && cfg.memoryStore) {
        mem = createMemory({ store: cfg.memoryStore(validatedCtx.sessionId) });
        const latestUserMsg = validatedReq.messages[validatedReq.messages.length - 1];
        await mem.add(latestUserMsg as unknown as import('@nrouter_ai/sdk').ChatMessage);
        const past = await mem.messages();
        history = past.map(m => ({ role: m.role as 'user'|'assistant', content: m.content as any }));
      }
      
      let fullResponse = '';
      let costEvent;
      
      async function executePhase(sysPrompt: string) {
         let msgs = [{ role: 'system' as const, content: sysPrompt }, ...history];
         if (cfg.maskPii) {
           msgs = msgs.map(m => ({
             ...m,
             content: maskMessageContent(m.content) as any
           }));
         }
         const phaseEvents: AgentEvent[] = [];
         const tResult = await runToolPhase(cfg, msgs as unknown as import('@nrouter_ai/sdk').ChatMessage[], (ev) => {
            phaseEvents.push({ type: 'tool_call', tool: ev.tool, title: ev.title, status: ev.status });
            if (cfg.hooks.onToolCall) callHook(cfg.hooks, 'onToolCall', ev);
         }, validatedReq.signal);
         
         if (cfg.tools && cfg.tools.length > 0) {
           return {
             phaseEvents,
             sResult: {
               chunks: (async function* () {
                 if (tResult.text) yield tResult.text;
               })(),
               cost: tResult.cost
             }
           };
         }
         
         const sResult = await streamChat(cfg.client, {
            model: cfg.model,
            messages: tResult.messages,
            maxTokens: cfg.maxTokens,
            signal: validatedReq.signal,
            maskPii: cfg.maskPii
         });
         
         return { phaseEvents, sResult };
      }

      try {
         const { phaseEvents, sResult } = await executePhase(system);
         for (const ev of phaseEvents) yield ev;
         for await (const chunk of sResult.chunks) {
            fullResponse += chunk;
            yield { type: 'token', text: chunk };
         }
         costEvent = sResult.cost;
      } catch (err: any) {
         const safeErr = toSafeError(err, config.apiKey ? [config.apiKey] : undefined);
         if (safeErr.code === 'guardrail_blocked' && webSearched) {
            const systemRetry = buildSystemPrompt({
              agentName: cfg.agentName,
              instructions: cfg.instructions,
              identity: validatedCtx.identity,
              pageContext: sanitizePageContext(validatedReq.pageContext, cfg.limits.maxPageContextChars),
              chunks,
              webSources: undefined
            });
            try {
               const { phaseEvents, sResult } = await executePhase(systemRetry);
               for (const ev of phaseEvents) yield ev;
               for await (const chunk of sResult.chunks) {
                  fullResponse += chunk;
                  yield { type: 'token', text: chunk };
               }
               costEvent = sResult.cost;
            } catch (retryErr: any) {
               const safeRetryErr = toSafeError(retryErr, config.apiKey ? [config.apiKey] : undefined);
               yield { type: 'error', code: safeRetryErr.code, message: safeRetryErr.message };
               yield { type: 'done' };
               return;
            }
         } else {
            yield { type: 'error', code: safeErr.code, message: safeErr.message };
            yield { type: 'done' };
            return;
         }
      }

      if (costEvent) {
         yield { type: 'cost', costUsd: costEvent.costUsd, status: costEvent.status, requestId: costEvent.requestId };
         if (cfg.hooks.onCost) {
            callHook(cfg.hooks, 'onCost', costEvent);
         }
      }

      if (mem && fullResponse) {
         await mem.add({ role: 'assistant', content: fullResponse });
      }

      if (conf.level === 'low') {
         if (cfg.hooks.onGap) {
            callHook(cfg.hooks, 'onGap', {
               question,
               normalized: normalizeQuestion(question),
               confidence: conf.level,
               webSearched,
               sessionId: validatedCtx.sessionId
            });
         }
      }

      yield { type: 'done' };
    } catch (err: any) {
      const safeErr = toSafeError(err, config.apiKey ? [config.apiKey] : undefined);
      if (safeErr.code === 'aborted') {
         yield { type: 'error', code: 'aborted', message: safeErr.message };
      } else {
         yield { type: 'error', code: safeErr.code, message: safeErr.message };
      }
      yield { type: 'done' };
    }
  }

  function chatSSE(req: unknown, ctx?: import('./types.js').TrustedContext): ReadableStream<Uint8Array> {
    const ac = new AbortController();
    const untrustedReq = (req || {}) as any;
    if (untrustedReq?.signal) {
      if (untrustedReq.signal.aborted) {
        ac.abort(untrustedReq.signal.reason);
      } else {
        untrustedReq.signal.addEventListener('abort', () => ac.abort(untrustedReq.signal.reason), { once: true });
      }
    }
    return toSSE(chat({ ...untrustedReq, signal: ac.signal }, ctx), ac);
  }

  async function feedback(x: unknown): Promise<void> {
    const fb = validateFeedback(x);
    if (cfg.hooks.onFeedback) {
      callHook(cfg.hooks, 'onFeedback', fb);
    }
  }

  return { chat, chatSSE, feedback };
}
