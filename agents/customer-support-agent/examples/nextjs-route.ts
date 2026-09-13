import { createSupportAgent } from '@nrouter_ai/support-agent';
import { loadKnowledgeIndex } from '@nrouter_ai/support-agent/node';

// Load the index once at startup
const knowledge = await loadKnowledgeIndex('./knowledge.json');

const agent = createSupportAgent({
  apiKey: process.env.NROUTER_API_KEY!,
  model: 'claude-haiku-4-5-20251001',
  knowledge
});

// Placeholder for your actual authentication logic
async function getSessionFromYourAuth(req: Request) {
  return { identity: { email: 'user@example.com' }, audiences: ['public'] };
}

export async function POST(req: Request) {
  // IMPORTANT: The host must authenticate and rate-limit this route.
  const ctx = await getSessionFromYourAuth(req);
  
  // Forward the untrusted request body and the trusted context.
  const body = await req.json();
  
  return new Response(agent.chatSSE(body, ctx), {
    headers: { 'Content-Type': 'text/event-stream' }
  });
}
