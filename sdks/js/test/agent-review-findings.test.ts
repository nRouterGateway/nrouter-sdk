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
  // `notEqual` alone passes on '' and on the JSON-encoded tool envelope alike,
  // so it cannot tell "correctly said nothing" from "returned something else
  // wrong". Pin the value: every assistant turn this fixture produces is a bare
  // tool call with `content: null`, so the run genuinely produced no assistant
  // text and '' is the only honest answer.
  assert.equal(result.text, '', `result.text was ${JSON.stringify(result.text)}`);
  // ...and the tail of the conversation really is the tool result, which is
  // what made reading `messages[length - 1]` wrong in the first place.
  assert.equal(result.messages[result.messages.length - 1].role, 'tool');
});

test("tool_choice 'none' stays a refusal when parallel_tool_calls is false", () => {
  const { body, dropped } = toAnthropicMessagesRequest({
    // The model id is inert here: this test calls the Anthropic TRANSLATOR
    // directly, so nothing routes on it. The defect this pins lives in
    // `toAnthropicMessagesRequest` (chat.ts), NOT in the agent loop — the
    // three tests above use an OpenAI-wire id for the opposite reason, to keep
    // the translator out of what they are measuring, and this comment was
    // copied down from them.
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

// --- the walk-back must not reach BEHIND this run ----------------------------
//
// The maxSteps walk-back scans backwards for the last assistant turn carrying
// text, skipping the tool-call-only turns whose `content` is null. That is
// right inside the run and wrong the moment it walks past the SEED: a caller
// who passes `messages` (a resumed conversation, an agent replaying history)
// has assistant turns of their own in that array, and the scan happily returns
// one of them. `result.text` then reports, as this run's answer, a sentence
// this run never produced and the customer was never billed for — and it reads
// as a model that answered the wrong question.
//
// '' is the honest value for "this bounded run produced no assistant text".
test('a maxSteps halt never reports SEEDED history as the run answer', async () => {
  const runner = scriptedRunner([toolCallBody('ping', '{}')]);
  const result = await runTools(runner, {
    model: 'gpt-4o',
    messages: [
      { role: 'user', content: 'what did we decide last week?' },
      { role: 'assistant', content: 'We decided to ship on Friday.' },
      { role: 'user', content: 'now ping forever' },
    ],
    tools: [PING],
    maxSteps: 2,
  });
  assert.equal(result.stopReason, 'maxSteps', 'the fixture never stops on its own');
  assert.notEqual(
    result.text,
    'We decided to ship on Friday.',
    'result.text returned an assistant turn the CALLER supplied, presented as ' +
      'the answer this run produced',
  );
  assert.equal(result.text, '', 'a run that produced no assistant text must say so');
});

test('the walk-back still finds THIS run\'s earlier assistant text', async () => {
  // The complement, and what stops the fix above from degrading to `text = ''`
  // unconditionally: a partial answer the caller paid for on step 1 is still
  // theirs when step 2 halts on a bare tool call.
  const spoke = {
    id: 'chatcmpl-x',
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: 'Checking the weather now.',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'ping', arguments: '{}' } }],
        },
      },
    ],
  };
  const runner = scriptedRunner([spoke, toolCallBody('ping', '{}', 'call_2')]);
  const result = await runTools(runner, {
    model: 'gpt-4o',
    prompt: 'ping forever',
    tools: [PING],
    maxSteps: 2,
  });
  assert.equal(result.stopReason, 'maxSteps');
  assert.equal(result.text, 'Checking the weather now.');
});
