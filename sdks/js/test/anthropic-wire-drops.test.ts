// The Anthropic Messages wire cannot carry every OpenAI chat field, and this
// file pins the two ways that is allowed to end: a REFUSAL before the request
// leaves, or a TRANSLATION. Never a silent drop.
//
// `toAnthropicMessagesRequest` has always returned a `dropped` list, and `chat`
// has always thrown it away (`toAnthropicMessagesRequest(body).body`). So a
// caller who set `response_format: { type: 'json_object' }` on a Claude model
// received free-form prose, was billed for it, and was told nothing — the same
// fake success the file's own contract forbids for `tools` and for `n`.
//
// The three material fields — response_format, seed, logprobs/top_logprobs —
// change the ANSWER or the DATA RETURNED, not merely the sampling, so they are
// refused the way `n` is refused. `parallel_tool_calls` is different: Anthropic
// HAS the control, spelled `tool_choice.disable_parallel_tool_use`, so it is
// translated rather than refused or dropped.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { refuseUnservableOnMessagesWire, toAnthropicMessagesRequest } = require('../dist/chat');
const { isRetryable } = require('../dist/errors');

/** Every field whose omission on the Messages wire changes what comes back. */
const MATERIAL: Array<[string, unknown]> = [
  ['response_format', { type: 'json_object' }],
  ['seed', 42],
  ['logprobs', true],
  ['top_logprobs', 5],
];

for (const [field, value] of MATERIAL) {
  test(`${field} is refused on the Messages wire, not silently dropped`, () => {
    let raised: any;
    try {
      refuseUnservableOnMessagesWire({ model: 'claude-sonnet-4', [field]: value });
    } catch (e) {
      raised = e;
    }
    assert.ok(raised, `${field} reached the provider silently`);
    assert.match(String(raised.message), new RegExp(field));
    // CONFIGURATION, exactly as `n` is: no retry turns a wire without the
    // field into one that has it, so a generic retry loop must not spin.
    assert.equal(isRetryable(raised), false);
  });
}

test('a body with no material field still passes', () => {
  refuseUnservableOnMessagesWire({
    model: 'claude-sonnet-4',
    temperature: 0.2,
    // Sampling nudges Anthropic cannot carry stay non-fatal.
    frequency_penalty: 0.5,
    user: 'ignored-anyway',
  });
});

test('parallel_tool_calls: false becomes tool_choice.disable_parallel_tool_use', () => {
  const { body, dropped } = toAnthropicMessagesRequest({
    model: 'claude-sonnet-4',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      {
        type: 'function',
        function: { name: 'get_weather', description: 'w', parameters: { type: 'object' } },
      },
    ],
    parallel_tool_calls: false,
  });
  assert.deepEqual(body['tool_choice'], { type: 'auto', disable_parallel_tool_use: true });
  assert.ok(!dropped.includes('parallel_tool_calls'));
});

test('parallel_tool_calls: true is the Anthropic default and adds no switch', () => {
  const { body } = toAnthropicMessagesRequest({
    model: 'claude-sonnet-4',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      {
        type: 'function',
        function: { name: 'get_weather', description: 'w', parameters: { type: 'object' } },
      },
    ],
    parallel_tool_calls: true,
  });
  assert.deepEqual(body['tool_choice'], undefined);
});

test('parallel_tool_calls without tools is reported in dropped', () => {
  const { dropped } = toAnthropicMessagesRequest({
    model: 'claude-sonnet-4',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
    parallel_tool_calls: false,
  });
  assert.ok(
    dropped.includes('parallel_tool_calls'),
    'a tool-less parallel_tool_calls vanished without reaching the diagnostic',
  );
});
