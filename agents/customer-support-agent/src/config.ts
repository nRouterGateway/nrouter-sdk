// LANE L1 owns this file. Contract: see lane brief.
import type { PayloadLimits, ConfidenceThresholds, ResolvedConfig, SupportAgentConfig, KnowledgeStore, KnowledgeIndex } from './types.js';
import { SupportAgentError } from './errors.js';
import { createClient } from './client.js';
import { createMemoryKnowledgeStore } from './knowledge/store.js';

export const DEFAULT_LIMITS: PayloadLimits = { maxMessages: 12, maxMessageChars: 2000, maxPageContextChars: 1000 };
export const DEFAULT_CONFIDENCE: ConfidenceThresholds = { high: 0.55, medium: 0.4 };
export const DEFAULT_TOP_K = 5;
export const DEFAULT_MAX_TOKENS = 1024;
export const DEFAULT_MAX_TOOL_STEPS = 4;
export const DEFAULT_AGENT_NAME = 'Support';

function isKnowledgeIndex(k: KnowledgeStore | KnowledgeIndex): k is KnowledgeIndex {
  return 'version' in k && 'chunks' in k && k.version === 1;
}

/** Apply defaults and validate. Throws SupportAgentError('invalid_config') naming the field, never a value. */
export function resolveConfig(config: SupportAgentConfig): ResolvedConfig {
  if (!config.model || typeof config.model !== 'string') {
    throw new SupportAgentError('invalid_config', 'model is required and must be a non-empty string');
  }

  let client = config.client;
  if (!client) {
    if (!config.apiKey || typeof config.apiKey !== 'string' || !config.apiKey.startsWith('sk-nrouter-')) {
      throw new SupportAgentError('invalid_config', 'apiKey is required and must start with sk-nrouter-');
    }
    client = createClient(config.apiKey, config.baseURL);
  }

  if (!config.knowledge) {
    throw new SupportAgentError('invalid_config', 'knowledge is required');
  }

  let store: KnowledgeStore;
  if (isKnowledgeIndex(config.knowledge)) {
    store = createMemoryKnowledgeStore(config.knowledge);
  } else {
    store = config.knowledge;
  }

  if (typeof store.search !== 'function' || !store.embeddingModel || typeof store.embeddingModel !== 'string' || !Number.isInteger(store.dimensions) || store.dimensions <= 0) {
    throw new SupportAgentError('invalid_config', 'invalid knowledge store shape');
  }

  const limits = { ...DEFAULT_LIMITS, ...config.limits };
  if (!Number.isInteger(limits.maxMessages) || limits.maxMessages <= 0) {
    throw new SupportAgentError('invalid_config', 'limits.maxMessages must be a positive integer');
  }
  if (!Number.isInteger(limits.maxMessageChars) || limits.maxMessageChars <= 0) {
    throw new SupportAgentError('invalid_config', 'limits.maxMessageChars must be a positive integer');
  }
  if (!Number.isInteger(limits.maxPageContextChars) || limits.maxPageContextChars <= 0) {
    throw new SupportAgentError('invalid_config', 'limits.maxPageContextChars must be a positive integer');
  }

  const confidence = { ...DEFAULT_CONFIDENCE, ...config.confidence };
  if (!Number.isFinite(confidence.high) || !Number.isFinite(confidence.medium)) {
    throw new SupportAgentError('invalid_config', 'confidence thresholds must be finite numbers');
  }
  if (confidence.medium <= 0 || confidence.high < confidence.medium || confidence.high > 1) {
    throw new SupportAgentError('invalid_config', 'confidence thresholds must satisfy 0 < medium <= high <= 1');
  }

  const topK = config.topK !== undefined ? config.topK : DEFAULT_TOP_K;
  if (!Number.isInteger(topK) || topK <= 0 || topK > 50) {
    throw new SupportAgentError('invalid_config', 'topK must be a positive integer <= 50');
  }

  const maxTokens = config.maxTokens !== undefined ? config.maxTokens : DEFAULT_MAX_TOKENS;
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new SupportAgentError('invalid_config', 'maxTokens must be a positive integer');
  }

  const maxToolSteps = config.maxToolSteps !== undefined ? config.maxToolSteps : DEFAULT_MAX_TOOL_STEPS;
  if (!Number.isInteger(maxToolSteps) || maxToolSteps <= 0) {
    throw new SupportAgentError('invalid_config', 'maxToolSteps must be a positive integer');
  }

  if (config.maskPii !== undefined && typeof config.maskPii !== 'boolean') {
    throw new SupportAgentError('invalid_config', 'maskPii must be a boolean');
  }
  const maskPii = config.maskPii !== false;

  return {
    client,
    model: config.model,
    store,
    agentName: config.agentName ?? DEFAULT_AGENT_NAME,
    instructions: config.instructions ?? '',
    topK,
    maxTokens,
    confidence,
    limits,
    tools: config.tools ?? [],
    maxToolSteps,
    webSearch: config.webSearch === false || config.webSearch === undefined ? null : config.webSearch,
    memoryStore: config.memoryStore ?? null,
    hooks: config.hooks ?? {},
    maskPii,
  };
}
