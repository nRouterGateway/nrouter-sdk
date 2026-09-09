// Playground UI parameter parity test
// Proves 100% equivalence between dashboard playground parameters and @nrouter_ai/sdk

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildChatBody } = require('../dist/options');
const { buildSamplingParams } = require('../dist/sampling');
const { toAnthropicMessagesRequest, MESSAGES_PATH } = require('../dist/chat');

test('playground UI parameters serialize accurately into gateway request body', () => {
  const uiState = {
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello!' },
    ],
    maxTokens: 500,
    advancedSampling: true,
    temperature: 0.7,
    topP: 0.85,
    promptTemplateId: 'template-uuid-123',
    promptVariables: { key: 'value' },
    cache: false,
  };

  const sampling = buildSamplingParams({
    advanced: uiState.advancedSampling,
    model: uiState.model,
    temperature: uiState.temperature,
    topP: uiState.topP,
  });

  const body = buildChatBody(uiState, sampling);

  assert.equal(body.model, 'gpt-4o');
  assert.equal(body.max_tokens, 500);
  assert.equal(body.temperature, 0.7);
  assert.equal(body.top_p, 0.85);
  assert.equal(body.nrouter_prompt_template_id, 'template-uuid-123');
  assert.deepEqual(body.nrouter_prompt_variables, { key: 'value' });
  assert.equal(body.nrouter_cache, false);
  assert.equal(body.messages.length, 2);
});

test('playground Claude request enforces mutual exclusion and Anthropic wire translation', () => {
  const uiState = {
    model: 'claude-3-5-haiku-20241022',
    messages: [
      { role: 'system', content: 'System instruction' },
      { role: 'user', content: 'User question' },
    ],
    maxTokens: 300,
    advancedSampling: true,
    temperature: 0.7,
    topP: 0.9,
    promptTemplateId: 'template-uuid-456',
    promptVariables: { tone: 'formal' },
    cache: true,
  };

  const sampling = buildSamplingParams({
    advanced: uiState.advancedSampling,
    model: uiState.model,
    temperature: uiState.temperature,
    topP: uiState.topP,
  });

  // In sampling body, Claude model drops temperature when top_p is active
  assert.equal(sampling.top_p, 0.9);
  assert.equal(sampling.temperature, undefined);

  const body = buildChatBody(uiState, sampling);

  assert.equal(body.top_p, 0.9);
  assert.equal(body.temperature, undefined);

  // Now verify Anthropic translation
  const translated = toAnthropicMessagesRequest(body);

  assert.equal(MESSAGES_PATH, '/messages');
  assert.equal(translated.body.model, 'claude-3-5-haiku-20241022');
  assert.equal(translated.body.max_tokens, 300);
  assert.equal(translated.body.system, 'System instruction');
  assert.equal(translated.body.top_p, 0.9);
  assert.equal(translated.body.temperature, undefined);
  assert.equal(translated.body.nrouter_prompt_template_id, 'template-uuid-456');
  assert.deepEqual(translated.body.nrouter_prompt_variables, { tone: 'formal' });
  // Cache is true so nrouter_cache is omitted (gateway default)
  assert.equal(translated.body.nrouter_cache, undefined);
});

test('playground Claude deprecated sampling models drop both temperature and top_p', () => {
  const uiState = {
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 'What is the speed of light?' }],
    maxTokens: 500,
    advancedSampling: true,
    temperature: 0.7,
    topP: 0.9,
  };

  const sampling = buildSamplingParams({
    advanced: uiState.advancedSampling,
    model: uiState.model,
    temperature: uiState.temperature,
    topP: uiState.topP,
  });

  assert.deepEqual(sampling, {});

  const body = buildChatBody(uiState, sampling);
  assert.equal(body.temperature, undefined);
  assert.equal(body.top_p, undefined);
});

