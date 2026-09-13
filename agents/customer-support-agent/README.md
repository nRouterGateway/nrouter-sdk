# @nrouter_ai/support-agent

An autonomous support agent powered by nRouter, featuring RAG, web search fallback, and streaming chat.

## Installation

```bash
npm install @nrouter_ai/support-agent
```

## Quick Start

1. **Build a knowledge base**
```bash
npx @nrouter_ai/support-agent build-kb --docs ./docs --out index.json
```

2. **Serve the agent (Next.js App Router)**
```typescript
// app/api/chat/route.ts
import { createSupportAgent } from '@nrouter_ai/support-agent';
import { loadKnowledgeIndex } from '@nrouter_ai/support-agent/node';

// Load the index once at startup
const knowledge = await loadKnowledgeIndex('./index.json');

const agent = createSupportAgent({
  apiKey: process.env.NROUTER_API_KEY!,
  model: 'claude-haiku-4-5-20251001',
  knowledge
});

export async function POST(req: Request) {
  // IMPORTANT: The host must authenticate and rate-limit this route.
  const ctx = { identity: { email: 'user@example.com' }, audiences: ['public'] };
  const body = await req.json();
  return new Response(agent.chatSSE(body, ctx), {
    headers: { 'Content-Type': 'text/event-stream' }
  });
}
```

## Configuration

| Option | Description |
|---|---|
| `apiKey` | nRouter virtual key (`sk-nrouter-...`) |
| `model` | The chat model ID |
| `knowledge` | `KnowledgeStore` or `KnowledgeIndex` JSON |
| `webSearch` | Optional web search provider |
| `memoryStore` | Optional `(sessionId) => MemoryStore` from `@nrouter_ai/sdk`. When set and the host passes `ctx.sessionId`, the stored history is authoritative: only the latest user turn from the request is appended, and earlier turns in the request body are ignored |

## Usage

### `chat(req, ctx)`
Returns an `AsyncIterable<AgentEvent>` for custom handling. `req` is the untrusted input (e.g., the JSON request body containing messages). `ctx` is the `TrustedContext` supplied by the host's authentication, containing user identity and audiences.

### `chatSSE(req, ctx)`
Returns a `ReadableStream<Uint8Array>` formatted as Server-Sent Events, directly usable in HTTP responses. Parameters are the same as `chat`.

## Events & Wire Format
The agent streams events as Server-Sent Events (`text/event-stream`). Events include `tool_call`, `confidence`, `citations`, `token`, `cost`, `error`, and `done`.

## Hooks
Configure `hooks` to intercept feedback, gaps (low confidence questions), tool calls, and cost events.

## Knowledge per Organisation
Maintain one index and one agent per organisation. Audiences are entitlement tags from the host's auth via `TrustedContext`, never the body. Audiences are never a tenancy boundary.

## Security
- **API key stays server-side:** the API key is never exposed to the client.
- **Untrusted vs Trusted Input:** `req` is untrusted; `ctx` is trusted. 
- **Fenced Data:** Retrieved and web text is fenced as data.
- **SSRF Guard:** The SSRF guard checks hostnames and IP literals, but it does not resolve DNS. Therefore, run `build-kb` where fetching the configured seed URLs is acceptable.
- **Host Responsibilities:** The host authenticates and rate-limits its route.

## Limits
Defaults: `maxMessages: 12`, `maxMessageChars: 2000`, `maxPageContextChars: 1000`. Customize via `limits` config.
