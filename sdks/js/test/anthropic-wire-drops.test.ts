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

// --- tool_choice: 'none' -----------------------------------------------------
//
// `'none'` is documented (types.ts, ChatToolChoice) as "offers the tools without
// permitting a call this turn", and it is how an author forces a final natural
// language answer at the last step of a bounded loop. Anthropic has no `none`
// arm on the version of the wire this SDK targets, so `toolChoiceToAnthropic`
// returns undefined for it — and an Anthropic body carrying `tools` with NO
// `tool_choice` defaults to `auto`. The caller's refusal became permission, on
// a request they were billed for.
test("tool_choice: 'none' does not become permission to call tools", () => {
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
    tool_choice: 'none',
  });
  const choice: any = body['tool_choice'];
  const permits = body['tools'] !== undefined && (choice === undefined || choice.type === 'auto' || choice.type === 'any');
  assert.equal(
    permits,
    false,
    "tool_choice 'none' left the model free to call a tool: " +
      `tools=${JSON.stringify(body['tools'])} tool_choice=${JSON.stringify(choice)}`,
  );
});

test("tool_choice: 'none' with parallel_tool_calls: false is still a refusal", () => {
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
    tool_choice: 'none',
    parallel_tool_calls: false,
  });
  assert.notEqual((body['tool_choice'] as any)?.type, 'auto');
});

// --- role alternation --------------------------------------------------------
//
// Anthropic's Messages wire rejects adjacent same-role turns. This SDK
// MANUFACTURES them in two ordinary ways: a `tool` result replays as a `user`
// turn, so two parallel tool results become two adjacent user turns, and
// `buildMessages` appends a trailing user turn for `images` when the
// conversation ends on a tool result (PGSDK-111). Both are a 400 the caller did
// not write.
test('adjacent tool results become ONE user turn, not two', () => {
  const { body } = toAnthropicMessagesRequest({
    model: 'claude-sonnet-4',
    max_tokens: 16,
    messages: [
      { role: 'user', content: 'weather in two cities?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'w', arguments: '{"c":"NY"}' } },
          { id: 'call_b', type: 'function', function: { name: 'w', arguments: '{"c":"LA"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_a', content: '21' },
      { role: 'tool', tool_call_id: 'call_b', content: '28' },
    ],
  });
  const roles = (body['messages'] as any[]).map((m) => m.role);
  const adjacent = roles.filter((r, i) => i > 0 && r === roles[i - 1]);
  assert.deepEqual(adjacent, [], `adjacent same-role turns on the wire: ${roles.join(',')}`);
  const last: any = (body['messages'] as any[])[roles.length - 1];
  assert.equal(last.content.length, 2, 'both tool_result blocks must ride one user turn');
});

test('a trailing image turn after a tool result does not double the user role', () => {
  const { body } = toAnthropicMessagesRequest({
    model: 'claude-sonnet-4',
    max_tokens: 16,
    messages: [
      { role: 'user', content: 'look' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'w', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_a', content: 'done' },
      { role: 'user', content: [{ type: 'text', text: 'and this photo' }] },
    ],
  });
  const roles = (body['messages'] as any[]).map((m) => m.role);
  const adjacent = roles.filter((r, i) => i > 0 && r === roles[i - 1]);
  assert.deepEqual(adjacent, [], `adjacent same-role turns on the wire: ${roles.join(',')}`);
});

// --- the refusal must fire on a REQUEST, never on a default ------------------
//
// `logprobs: false` and `seed: null` are the values an OpenAI-shaped caller
// writes to say "I am NOT asking for this". Refusing them names a feature the
// caller declined and blocks a request the wire can serve exactly as asked.
test('explicitly-declined material fields are not refused', () => {
  refuseUnservableOnMessagesWire({
    model: 'claude-sonnet-4',
    logprobs: false,
    seed: null,
    top_logprobs: null,
    response_format: null,
  });
});
