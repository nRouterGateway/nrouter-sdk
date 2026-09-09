// Tool calling must be a FIRST-CLASS, TYPED option — not a reach through the
// untyped `extra` escape hatch (PGSDK-098), and the tool calls that come back
// must be typed at the public boundary (PGSDK-104).
//
// Two halves, and both are needed:
//
//   * a COMPILE-TIME half. `tools`, `toolChoice`, `ChatTool`, `ChatToolChoice`
//     and `ToolCall` are types; Node strips types rather than checking them, so
//     an `import type` in a test erases to nothing and proves nothing. The only
//     way to observe a type is to compile against it, so this shells out to the
//     real `tsc` against `dist/index.d.ts` — the declaration file npm publishes
//     — exactly as `test/audio-exports.test.ts` does, and for the same reason.
//
//   * a RUNTIME half. A type that compiles and never reaches the wire is worse
//     than no type: the caller believes the model was given tools and gets a
//     normal-looking answer that ignored them. So `buildChatBody` is called
//     directly and the emitted body inspected.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildChatBody } = require('../dist/options');

const DIST_ENTRY = path.join(__dirname, '..', 'dist', 'index');
const TSC_JS = path.join(path.dirname(require.resolve('typescript')), '..', 'bin', 'tsc');

function typecheck(source: string): { status: number; output: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nrouter-sdk-tools-'));
  try {
    const specifier = DIST_ENTRY.split(path.sep).join('/');
    fs.writeFileSync(path.join(dir, 'fixture.ts'), source.replace(/__SDK__/g, specifier), 'utf8');
    fs.writeFileSync(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2020',
          module: 'CommonJS',
          moduleResolution: 'node',
          lib: ['ES2020', 'DOM'],
          types: [],
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        files: ['fixture.ts'],
      }),
      'utf8',
    );
    const run = spawnSync(process.execPath, [TSC_JS, '-p', path.join(dir, 'tsconfig.json')], {
      encoding: 'utf8',
    });
    return {
      status: run.status === null ? 1 : run.status,
      output: `${run.stdout ?? ''}${run.stderr ?? ''}`,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the typecheck harness reports a missing export as a failure', () => {
  // Without this control every compile-time assertion below is vacuous.
  const result = typecheck(
    `import type { ThisNameIsNotExportedByTheSdk } from '__SDK__';\n` +
      `declare const v: ThisNameIsNotExportedByTheSdk;\nexport const used = v;\n`,
  );
  assert.notEqual(result.status, 0, `harness cannot detect a missing export:\n${result.output}`);
});

test('PGSDK-098: tools and toolChoice are typed options, not `extra`', () => {
  const result = typecheck(
    `import type { NRouterCallOptions, ChatTool, ChatToolChoice } from '__SDK__';\n` +
      `const tool: ChatTool = {\n` +
      `  type: 'function',\n` +
      `  function: { name: 'get_weather', description: 'w', parameters: { type: 'object' } },\n` +
      `};\n` +
      `const choice: ChatToolChoice = { type: 'function', function: { name: 'get_weather' } };\n` +
      `export const opts: NRouterCallOptions = {\n` +
      `  model: 'm', prompt: 'p', tools: [tool], toolChoice: choice,\n` +
      `};\n`,
  );
  assert.equal(
    result.status,
    0,
    'NRouterCallOptions still has no typed `tools`/`toolChoice`, so every agent ' +
      `author reaches through the untyped \`extra\` hatch:\n${result.output}`,
  );
});

test('PGSDK-104: tool_calls is ToolCall[], so .function.name compiles', () => {
  const result = typecheck(
    `import type { ChatMessage, ToolCall } from '__SDK__';\n` +
      `const call: ToolCall = { id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } };\n` +
      `const msg: ChatMessage = { role: 'assistant', tool_calls: [call] };\n` +
      `export const name: string = (msg.tool_calls ?? [])[0].function.name;\n`,
  );
  assert.equal(
    result.status,
    0,
    `tool_calls is still unknown[] at the public boundary:\n${result.output}`,
  );
});

test('buildChatBody puts tools and tool_choice on the wire', () => {
  const body = buildChatBody(
    {
      model: 'gpt-4o',
      prompt: 'what is the weather',
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', parameters: { type: 'object', properties: {} } },
        },
      ],
      toolChoice: 'auto',
    },
    {},
  );
  assert.deepEqual(body.tools, [
    {
      type: 'function',
      function: { name: 'get_weather', parameters: { type: 'object', properties: {} } },
    },
  ]);
  assert.equal(body.tool_choice, 'auto');
});

test('an empty tools array is REFUSED, never sent', () => {
  // `tools: []` is what an uninitialised caller state produces. Several
  // providers reject a zero-length tool list outright, and the ones that do not
  // answer as if no tools were offered — a fake success the caller pays for.
  assert.throws(
    () => buildChatBody({ model: 'm', prompt: 'p', tools: [] }, {}),
    /tools/,
  );
});

test('toolChoice without tools is REFUSED', () => {
  // Naming a function the request does not carry is a guaranteed provider 400.
  assert.throws(
    () => buildChatBody({ model: 'm', prompt: 'p', toolChoice: 'required' }, {}),
    /toolChoice/,
  );
});

test('PGSDK-101: jsonSchema becomes response_format on the wire', () => {
  const body = buildChatBody(
    {
      model: 'gpt-4o',
      prompt: 'extract',
      jsonSchema: {
        name: 'person',
        schema: { type: 'object', properties: { name: { type: 'string' } } },
      },
    },
    {},
  );
  assert.deepEqual(body.response_format, {
    type: 'json_schema',
    json_schema: {
      name: 'person',
      strict: true,
      schema: { type: 'object', properties: { name: { type: 'string' } } },
    },
  });
});

test('PGSDK-105: mcp.call is reachable on a single-server deployment', () => {
  // A COMPILE-TIME assertion, because the runtime already works: `rpc` builds
  // `/../mcp` whenever `serverId` is falsy, so `mcp.call(undefined, …)` reaches
  // the root mount today. What refused it was the TYPE — `serverId: string` —
  // and a type that forbids the only shape a single-server deployment can
  // express is the same defect as a missing route. `list` and `rpc` already
  // take it as optional; `call` was the outlier.
  const result = typecheck(
    `import type { NRouterMCP, MCPCallResult } from '__SDK__';\n` +
      `declare const mcp: NRouterMCP;\n` +
      `export const out: Promise<MCPCallResult> = mcp.call(undefined, 'list_issues', { repo: 'x' });\n` +
      `export const named: Promise<MCPCallResult> = mcp.call('github', 'list_issues');\n`,
  );
  assert.equal(
    result.status,
    0,
    'mcp.call still requires a serverId, so a single MCP server mounted at the ' +
      `root /mcp can be listed but never invoked:\n${result.output}`,
  );
});
