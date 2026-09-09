// The four absences of the agent surface (PGSDK-100/101/105/107).
//
// Each one made every author hand-roll something that is easy to get subtly
// wrong and expensive to get wrong at all: the bounded tool loop that stops a
// looping model burning credits, the validation of a structured response on a
// wire that may have silently dropped the schema, a way to reach the mounted
// `/mcp` routes at all, and a cost accumulator across the many calls of one run
// that does not fold an UNPRICED step to zero.
//
// The runner here is a fake — every assertion is about the SDK's own control
// flow and arithmetic, and a live provider would make the loop bound
// unobservable.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runTools } = require('../dist/agent');
const { CostAccumulator } = require('../dist/meta');
const { NRouterMCP } = require('../dist/mcp');
const { parsed } = require('../dist/chat');

/** A ChatRunner that replays a scripted list of completion bodies. */
function scriptedRunner(bodies: unknown[], headers: Record<string, string>[] = []) {
  const sent: Record<string, unknown>[] = [];
  let i = 0;
  return {
    sent,
    request(path: string, body: unknown) {
      sent.push(body as Record<string, unknown>);
      const at = Math.min(i, bodies.length - 1);
      const hdr = headers.length > 0 ? headers[Math.min(i, headers.length - 1)] : {};
      i += 1;
      return Promise.resolve({
        status: 200,
        headers: hdr,
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
      message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: args } }] },
    },
  ],
});

const finalBody = (text: string) => ({
  id: 'chatcmpl-y',
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }],
});

const WEATHER = {
  definition: {
    type: 'function' as const,
    function: { name: 'get_weather', parameters: { type: 'object', properties: {} } },
  },
  execute: () => ({ tempC: 21 }),
};

// --- PGSDK-100: the bounded multi-turn loop -------------------------------

test('runTools drives the tool loop and returns the final text', async () => {
  const runner = scriptedRunner([toolCallBody('get_weather', '{"city":"Paris"}'), finalBody('It is 21C.')]);
  const result = await runTools(runner, { model: 'm', prompt: 'weather?', tools: [WEATHER] });

  assert.equal(result.text, 'It is 21C.');
  assert.equal(result.steps, 2);
  assert.equal(result.stopReason, 'stop');
  // The tool RESULT must be appended as a `tool` turn bound by tool_call_id,
  // or the second request asks the same question with no answer in hand.
  const second = result.messages.filter((m: any) => m.role === 'tool');
  assert.equal(second.length, 1);
  assert.equal(second[0].tool_call_id, 'call_1');
  assert.equal(JSON.parse(second[0].content as string).tempC, 21);
});

test('PGSDK-100: maxSteps BOUNDS a model that loops forever', async () => {
  // A model that only ever asks for the tool again. Without a step cap this is
  // an unbounded billed loop — the whole reason the bound belongs in the SDK
  // rather than in every author's hand-rolled `while (true)`.
  const runner = scriptedRunner([toolCallBody('get_weather', '{}')]);
  const result = await runTools(runner, {
    model: 'm',
    prompt: 'weather?',
    tools: [WEATHER],
    maxSteps: 3,
  });
  assert.equal(result.steps, 3);
  assert.equal(result.stopReason, 'maxSteps');
  assert.equal(runner.sent.length, 3, 'the loop made more provider calls than maxSteps allowed');
  // `result.text` is the documented ASSISTANT answer, and asserting only the
  // counters above let a real leak pass silently: the last turn of a
  // maxSteps halt is the `tool` RESULT, so reading the tail returned the tool's
  // own JSON return value — `{"tempC":21}` — as the model's speech. Every
  // assistant turn this fixture produces is a bare tool call, so the run
  // genuinely produced no assistant text.
  assert.equal(result.text, '', `result.text leaked a non-assistant value: ${JSON.stringify(result.text)}`);
});

test('PGSDK-100: maxSteps below 1 is REFUSED, never clamped', async () => {
  const runner = scriptedRunner([finalBody('hi')]);
  await assert.rejects(
    () => runTools(runner, { model: 'm', prompt: 'p', tools: [WEATHER], maxSteps: 0 }),
    /maxSteps/,
  );
});

test('PGSDK-100: stopWhen ends the run before the cap', async () => {
  const runner = scriptedRunner([toolCallBody('get_weather', '{}')]);
  const result = await runTools(runner, {
    model: 'm',
    prompt: 'p',
    tools: [WEATHER],
    maxSteps: 10,
    stopWhen: (state: any) => state.steps >= 2,
  });
  assert.equal(result.stopReason, 'stopWhen');
  assert.equal(result.steps, 2);
});

test('PGSDK-100: an unknown tool name is reported to the model, not thrown', async () => {
  // The model, not the caller, chose the name. Throwing here discards a paid
  // turn; handing the error back as the tool result lets it correct itself.
  const runner = scriptedRunner([toolCallBody('no_such_tool', '{}'), finalBody('sorry')]);
  const result = await runTools(runner, { model: 'm', prompt: 'p', tools: [WEATHER] });
  const toolTurn = result.messages.find((m: any) => m.role === 'tool');
  assert.match(String(toolTurn.content), /no_such_tool/);
});

// --- PGSDK-107: cost across the many calls of one run ---------------------

test('PGSDK-107: CostAccumulator sums priced steps and counts unpriced separately', () => {
  const acc = new CostAccumulator();
  acc.add({ cost: 0.002, costStatus: 'exact' });
  acc.add({ cost: null, costStatus: 'unpriced' });
  acc.add({ cost: 0.003, costStatus: 'exact' });

  assert.equal(acc.steps, 3);
  assert.equal(acc.priced, 2);
  assert.equal(acc.unpriced, 1);
  assert.ok(Math.abs(acc.total - 0.005) < 1e-12);
  assert.equal(acc.complete, false, 'a run with an unpriced step is NOT a complete cost');
});

test('PGSDK-107: a cost paired with costStatus unpriced is NOT summed', () => {
  // The two headers contradict each other; `isPriced` already refuses this
  // pair, and the accumulator must not be the laxer reader.
  const acc = new CostAccumulator();
  acc.add({ cost: 99, costStatus: 'unpriced' });
  assert.equal(acc.total, 0);
  assert.equal(acc.unpriced, 1);
  assert.equal(acc.complete, false);
});

test('PGSDK-107: runTools reports the run cost, never a naive sum', async () => {
  const runner = scriptedRunner(
    [toolCallBody('get_weather', '{}'), finalBody('done')],
    [
      { 'x-nr-request-cost': '0.001', 'x-nr-cost-status': 'exact' },
      { 'x-nr-cost-status': 'unpriced' },
    ],
  );
  const result = await runTools(runner, { model: 'm', prompt: 'p', tools: [WEATHER] });
  assert.equal(result.cost.steps, 2);
  assert.equal(result.cost.unpriced, 1);
  assert.equal(result.cost.complete, false);
  assert.ok(Math.abs(result.cost.total - 0.001) < 1e-12);
});

// --- PGSDK-101: validate the structured response --------------------------

test('PGSDK-101: parsed() returns the decoded object for a conforming reply', () => {
  const res = {
    body: { choices: [{ message: { role: 'assistant', content: '{"name":"Ada","age":36}' } }] },
    meta: {},
  };
  const out = parsed(res);
  assert.deepEqual(out, { name: 'Ada', age: 36 });
});

test('PGSDK-101: parsed() REFUSES prose rather than throwing a bare SyntaxError', () => {
  // A non-conforming 200 is a billed answer in the wrong shape, whatever wire
  // served it. The failure must be typed and carry the request id, not a bare
  // SyntaxError.
  const res = {
    body: { choices: [{ message: { role: 'assistant', content: 'Sure! Here you go:' } }] },
    meta: { requestId: 'req_1' },
  };
  const err = (() => {
    try {
      parsed(res);
      return null;
    } catch (e) {
      return e as any;
    }
  })();
  assert.ok(err, 'parsed() accepted prose as a structured response');
  assert.equal(err.kind, 'configuration');
  assert.match(String(err.message), /JSON/i);
});

// `parsed()` is wire-agnostic — it reads a decoded response and has no idea
// which wire served it. It used to hand every caller an Anthropic-specific
// diagnostic saying a `jsonSchema` request "is sent there with the schema
// dropped, so the model was never constrained". That is now false in BOTH
// directions: `refuseUnservableOnMessagesWire` refuses such a request before it
// leaves, so nothing is sent with the schema dropped; and on an OpenAI-wire
// model — where this failure actually lands — it sends the caller looking for
// an Anthropic drop that never happened while the real cause (a model that did
// not comply with a schema it WAS given) goes unnamed.
test('parsed() does not blame a wire it cannot see for a non-conforming reply', () => {
  const res = {
    body: { choices: [{ message: { role: 'assistant', content: 'Sure! Here you go:' } }] },
    meta: { requestId: 'req_2' },
  };
  const err = (() => {
    try {
      parsed(res);
      return null;
    } catch (e) {
      return e as any;
    }
  })();
  assert.ok(err, 'parsed() accepted prose as a structured response');
  const message = String(err.message);
  assert.doesNotMatch(message, /Anthropic/i, `parsed() blames Anthropic: ${message}`);
  assert.doesNotMatch(message, /schema dropped/i, `parsed() claims a drop: ${message}`);
  // It must still say what was received, which is the part that debugs.
  assert.match(message, /Sure! Here you go/);
});

// --- PGSDK-105: the /mcp surface ------------------------------------------

test('PGSDK-105: mcp.list reaches the ROOT-mounted /mcp, not /v1/mcp', async () => {
  const runner = scriptedRunner([{ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 't' }] } }]);
  const seen: string[] = [];
  const wrapped = {
    request(path: string, body: unknown) {
      seen.push(path);
      return runner.request(path, body);
    },
  };
  const mcp = new NRouterMCP(wrapped);
  const tools = await mcp.list();
  assert.deepEqual(tools, [{ name: 't' }]);
  // `/../mcp` is how models.ts already reaches the root-mounted /capabilities
  // past a baseURL whose suffix is /v1. A bare '/mcp' resolves to /v1/mcp, 404.
  assert.equal(seen[0], '/../mcp');
  assert.equal((runner.sent[0] as any).method, 'tools/list');
});

test('PGSDK-105: mcp.list(serverId) targets that server', async () => {
  const runner = scriptedRunner([{ jsonrpc: '2.0', id: 1, result: { tools: [] } }]);
  const seen: string[] = [];
  const mcp = new NRouterMCP({
    request(path: string, body: unknown) {
      seen.push(path);
      return runner.request(path, body);
    },
  });
  await mcp.list('github');
  assert.equal(seen[0], '/../mcp/github');
});

test('PGSDK-105: mcp.call sends tools/call and returns the result', async () => {
  const runner = scriptedRunner([{ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }] } }]);
  const mcp = new NRouterMCP(runner);
  const out = await mcp.call('github', 'list_issues', { repo: 'x' });
  assert.deepEqual(out, { content: [{ type: 'text', text: 'ok' }] });
  const body = runner.sent[0] as any;
  assert.equal(body.method, 'tools/call');
  assert.deepEqual(body.params, { name: 'list_issues', arguments: { repo: 'x' } });
});

test('PGSDK-105: a JSON-RPC error envelope becomes a typed nRouter error', async () => {
  const runner = scriptedRunner([
    { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } },
  ]);
  const mcp = new NRouterMCP(runner);
  await assert.rejects(() => mcp.call('github', 'nope', {}), /Method not found/);
});

// A single-server deployment mounts one MCP server at the ROOT `/mcp`, and
// `mcp.list()` already reaches it — `serverId` is optional there and on
// `mcp.rpc`. `mcp.call` declared it REQUIRED, so the one deployment shape that
// cannot name a server was the one shape that could list tools and never
// invoke one. A caller forced to invent an id does not get a 404 they can
// read: they get `/../mcp/<whatever-they-typed>`.
test('PGSDK-105: mcp.call reaches the ROOT-mounted /mcp when no server is named', async () => {
  const runner = scriptedRunner([
    { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }] } },
  ]);
  const seen: string[] = [];
  const mcp = new NRouterMCP({
    request(path: string, body: unknown) {
      seen.push(path);
      return runner.request(path, body);
    },
  });
  const out = await mcp.call(undefined, 'list_issues', { repo: 'x' });
  assert.equal(seen[0], '/../mcp');
  assert.deepEqual(out, { content: [{ type: 'text', text: 'ok' }] });
  assert.deepEqual((runner.sent[0] as any).params, {
    name: 'list_issues',
    arguments: { repo: 'x' },
  });
});
