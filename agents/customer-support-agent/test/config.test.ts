import { describe, it, expect } from 'vitest';
import { resolveConfig, DEFAULT_LIMITS, DEFAULT_CONFIDENCE } from '../src/config.js';
import { SupportAgentError } from '../src/errors.js';
import type { SupportAgentConfig, KnowledgeStore, KnowledgeIndex } from '../src/types.js';

describe('resolveConfig', () => {
  const dummyKnowledgeStore: KnowledgeStore = {
    embeddingModel: 'test',
    dimensions: 10,
    search: async () => []
  };

  const dummyKnowledgeIndex: KnowledgeIndex = {
    version: 1,
    embeddingModel: 'test',
    dimensions: 10,
    createdAt: new Date().toISOString(),
    chunks: []
  };

  const validBaseConfig: SupportAgentConfig = {
    model: 'claude-haiku',
    apiKey: 'sk-nrouter-test',
    knowledge: dummyKnowledgeStore
  };

  it('resolves valid config with defaults', () => {
    const resolved = resolveConfig(validBaseConfig);
    expect(resolved.model).toBe('claude-haiku');
    expect(resolved.agentName).toBe('Support');
    expect(resolved.limits).toEqual(DEFAULT_LIMITS);
    expect(resolved.confidence).toEqual(DEFAULT_CONFIDENCE);
    expect(resolved.store).toBe(dummyKnowledgeStore);
    expect(resolved.client).toBeDefined();
  });

  it('rejects missing model', () => {
    expect(() => resolveConfig({ ...validBaseConfig, model: '' })).toThrowError(SupportAgentError);
  });

  it('rejects missing knowledge', () => {
    const cfg = { ...validBaseConfig } as any;
    delete cfg.knowledge;
    expect(() => resolveConfig(cfg)).toThrowError(SupportAgentError);
  });

  it('rejects missing apiKey when client not provided', () => {
    const cfg = { ...validBaseConfig } as any;
    delete cfg.apiKey;
    expect(() => resolveConfig(cfg)).toThrowError(SupportAgentError);
  });

  it('rejects apiKey not starting with sk-nrouter-', () => {
    expect(() => resolveConfig({ ...validBaseConfig, apiKey: 'sk-other-key' })).toThrowError(SupportAgentError);
  });

  it('accepts config without apiKey if client is provided', () => {
    const dummyClient = {} as any;
    const resolved = resolveConfig({ model: 'test', knowledge: dummyKnowledgeStore, client: dummyClient });
    expect(resolved.client).toBe(dummyClient);
  });

  it('converts knowledge index to store', () => {
    const resolved = resolveConfig({ ...validBaseConfig, knowledge: dummyKnowledgeIndex });
    expect(resolved.store).toBeDefined();
    expect(typeof resolved.store.search).toBe('function');
  });

  it('merges limits and confidence', () => {
    const resolved = resolveConfig({
      ...validBaseConfig,
      limits: { maxMessages: 50 },
      confidence: { high: 0.8 }
    });
    expect(resolved.limits.maxMessages).toBe(50);
    expect(resolved.limits.maxMessageChars).toBe(DEFAULT_LIMITS.maxMessageChars);
    expect(resolved.confidence.high).toBe(0.8);
    expect(resolved.confidence.medium).toBe(DEFAULT_CONFIDENCE.medium);
  });

  it('validates limits numbers', () => {
    expect(() => resolveConfig({ ...validBaseConfig, limits: { maxMessages: 0 } })).toThrowError(SupportAgentError);
    expect(() => resolveConfig({ ...validBaseConfig, limits: { maxMessageChars: -1 } })).toThrowError(SupportAgentError);
    expect(() => resolveConfig({ ...validBaseConfig, limits: { maxMessages: 1.5 } })).toThrowError(SupportAgentError);
  });

  it('validates confidence numbers', () => {
    expect(() => resolveConfig({ ...validBaseConfig, confidence: { high: 1.5 } })).toThrowError(SupportAgentError);
    expect(() => resolveConfig({ ...validBaseConfig, confidence: { medium: 0 } })).toThrowError(SupportAgentError);
    expect(() => resolveConfig({ ...validBaseConfig, confidence: { high: 0.3, medium: 0.4 } })).toThrowError(SupportAgentError);
  });

  it('handles webSearch false/undefined', () => {
    let resolved = resolveConfig({ ...validBaseConfig, webSearch: false });
    expect(resolved.webSearch).toBeNull();
    
    resolved = resolveConfig({ ...validBaseConfig, webSearch: undefined });
    expect(resolved.webSearch).toBeNull();
    
    const ws = { label: 'test', search: async () => [] };
    resolved = resolveConfig({ ...validBaseConfig, webSearch: ws });
    expect(resolved.webSearch).toBe(ws);
  });

  // NEW TESTS FOR CONFIG VALIDATION
  it('validates topK is between 1 and 50', () => {
    expect(() => resolveConfig({ ...validBaseConfig, topK: 51 })).toThrowError(/topK/);
    expect(() => resolveConfig({ ...validBaseConfig, topK: 0 })).toThrowError(/topK/);
    const resolved = resolveConfig({ ...validBaseConfig, topK: 50 });
    expect(resolved.topK).toBe(50);
  });

  it('validates KnowledgeStore shape', () => {
    // Missing search
    expect(() => resolveConfig({ ...validBaseConfig, knowledge: { embeddingModel: 'a', dimensions: 10 } as any })).toThrowError(/knowledge/);
    // Bad search
    expect(() => resolveConfig({ ...validBaseConfig, knowledge: { embeddingModel: 'a', dimensions: 10, search: 'not-a-func' } as any })).toThrowError(/knowledge/);
    // Bad model
    expect(() => resolveConfig({ ...validBaseConfig, knowledge: { embeddingModel: '', dimensions: 10, search: async () => [] } })).toThrowError(/knowledge/);
    // Bad dimensions
    expect(() => resolveConfig({ ...validBaseConfig, knowledge: { embeddingModel: 'a', dimensions: -1, search: async () => [] } })).toThrowError(/knowledge/);
    expect(() => resolveConfig({ ...validBaseConfig, knowledge: { embeddingModel: 'a', dimensions: 1.5, search: async () => [] } })).toThrowError(/knowledge/);
  });
});
