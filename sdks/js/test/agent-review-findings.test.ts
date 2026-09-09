// Cross-review findings on the agent surface (gemini-3.8-flash-high, on the
// commit that introduced it). Three HIGHs, and two of them cost the customer
// money on every step of a run:
//
//   1. `systemPrompt` and `images` were left on the options object handed to
//      every step, so the system prompt was prepended AGAIN ahead of the seeded
//      one and the images were appended as a FRESH user turn on each iteration.
//      A three-step run with one image billed that image three times and showed
//      the model a conversation nobody wrote.
//   2. When the loop halted on `maxSteps`, `result.text` was read off the
//      trailing message — which in a tool loop is a `tool` RESULT, not assistant
//      text. The documented contract says `text` is the assistant's answer.
//   3. `tool_choice: 'none'` combined with `parallel_tool_calls: false` was
//      rewritten to `tool_choice: {type:'auto'}` on the Anthropic messages wire,
//      turning an explicit REFUSAL to call tools into permission to call them.
//
// Each assertion below fails on the pre-fix build for its own reason.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runTools } = require('../dist/agent');
const { toAnthropicMessagesRequest } = require('../dist/chat');

function scriptedRunner(bodies: unknown[]) {
  const sent: Record<string, unknown>[] = [];
  let i = 0;
  return {
    sent,
    request(path: string, body: unknown) {
      sent.push(body as Record<string, unknown>);
      const at = Math.min(i, bodies.length - 1);
      i += 1;
      return Promise.resolve({
        status: 200,
        headers: {},
        text: JSON.stringify(bodies[at]),
        contentType: 'application/json',
      });
    },
  };
}

const toolCallBody = (name: string, args: string, id = 'call_1') => ({
  id: 'chatcmpl-x',
  choices: [
    {
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id, type: 'function', function: { name, arguments: args } }],
      },
    },
  ],
});

const PING = {
  definition: {
    type: 'function' as const,
    function: { name: 'ping', description: 'ping', parameters: { type: 'object', properties: {} } },
  },
  execute: async () => 'pong',
};

test('the system prompt is seeded ONCE, not re-prepended on every step', async () => {
  const runner = scriptedRunner([toolCallBody('ping', '{}')]);
  await runTools(runner, {
    // An OPENAI-wire model on purpose: the messages wire hoists `system` into a
    // top-level field and renders tool results as `user` turns, so a Claude
    // model would hide the very shapes these two assertions are about. The
    // defect is in the agent loop, not in either translator.
    model: 'gpt-4o',
    systemPrompt: 'You are terse.',
    prompt: 'ping twice',
    tools: [PING],
    maxSteps: 3,
  });
  assert.ok(runner.sent.length >= 2, 'the fixture is supposed to run more than one step');
  for (const [i, body] of runner.sent.entries()) {
    const messages = body.messages as { role: string; content: unknown }[];
    const systems = messages.filter((m) => m.role === 'system');
    assert.equal(
      systems.length,
      1,
      `step ${i + 1} sent ${systems.length} system turns; the seeded one is the only one`,
    );
  }
});

test('an attached image is sent ONCE, not re-billed on every step', async () => {
  const runner = scriptedRunner([toolCallBody('ping', '{}')]);
  await runTools(runner, {
    // An OPENAI-wire model on purpose: the messages wire hoists `system` into a
    // top-level field and renders tool results as `user` turns, so a Claude
    // model would hide the very shapes these two assertions are about. The
    // defect is in the agent loop, not in either translator.
    model: 'gpt-4o',
    prompt: 'what is this',
    images: ['https://example.invalid/a.png'],
    tools: [PING],
    maxSteps: 3,
  });
  const last = runner.sent[runner.sent.length - 1];
  const messages = last.messages as { role: string; content: unknown }[];
  const serialized = JSON.stringify(messages);
  const occurrences = serialized.split('https://example.invalid/a.png').length - 1;
  assert.equal(
    occurrences,
    1,
    `the final step carried the image ${occurrences} times; each extra copy is billed image tokens`,
  );
  // The image belongs to the question the user asked, and must STAY there. It
  // used to be re-folded by buildMessages on every step, which — once tool
  // turns exist — appends it as a fresh trailing user turn AFTER the tool
  // result, so the model saw the attachment arrive again after each tool call.
  const imageAt = messages.findIndex((m) => JSON.stringify(m.content).includes('example.invalid'));
  assert.equal(
    messages[imageAt].role,
    'user',
    'the image must ride on a user turn',
  );
  assert.ok(
    imageAt < messages.findIndex((m) => m.role === 'tool'),
    'the image was re-appended after the tool result instead of staying on the original question',
  );
});

test('text on a maxSteps halt is assistant text, never a tool result', async () => {
  const runner = scriptedRunner([toolCallBody('ping', '{}')]);
  const result = await runTools(runner, {
    // An OPENAI-wire model on purpose: the messages wire hoists `system` into a
    // top-level field and renders tool results as `user` turns, so a Claude
    // model would hide the very shapes these two assertions are about. The
    // defect is in the agent loop, not in either translator.
    model: 'gpt-4o',
    prompt: 'ping forever',
    tools: [PING],
    maxSteps: 2,
  });
  assert.equal(result.stopReason, 'maxSteps', 'the fixture never stops on its own');
  assert.notEqual(
    result.text,
    'pong',
    'result.text returned the tool RESULT; the contract says it is the assistant answer',
  );
});

test("tool_choice 'none' stays a refusal when parallel_tool_calls is false", () => {
  const { body, dropped } = toAnthropicMessagesRequest({
    // An OPENAI-wire model on purpose: the messages wire hoists `system` into a
    // top-level field and renders tool results as `user` turns, so a Claude
    // model would hide the very shapes these two assertions are about. The
    // defect is in the agent loop, not in either translator.
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [PING.definition],
    tool_choice: 'none',
    parallel_tool_calls: false,
  });
  assert.notDeepEqual(
    body.tool_choice,
    { type: 'auto', disable_parallel_tool_use: true },
    "an explicit tool_choice 'none' was rewritten to 'auto' — the opposite instruction",
  );
  assert.ok(
    body.tool_choice === undefined || (body.tool_choice as { type?: string }).type !== 'auto',
    "'none' must not become 'auto' on the messages wire",
  );
  assert.ok(
    dropped.includes('parallel_tool_calls'),
    'with no tool_choice object to carry it, the switch is dropped and must be reported',
  );
});
