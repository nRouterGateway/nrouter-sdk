// Public entry: "@nrouter_ai/support-agent". Edge-safe: no node: imports reachable from here.
export * from './types.js';
export { createSupportAgent } from './agent.js';
export { SupportAgentError, toSafeError, redact } from './errors.js';
export { buildKnowledgeIndex, DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_DIMENSIONS } from './knowledge/build.js';
export { createMemoryKnowledgeStore, cosineSimilarity } from './knowledge/store.js';
export { validateIndex } from './knowledge/validate.js';
export { chunkText, chunkDocs } from './knowledge/chunk.js';
export { fetchSeedPages, isSafeUrl } from './knowledge/fetch.js';
export { createWebSearchTool, WEB_SEARCH_TOOL_ID } from './web-search.js';
export { toSSE, encodeEvent } from './sse.js';
export { validateFeedback } from './feedback.js';
