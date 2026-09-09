// CHARACTERIZATION, not a red test. PGSDK-102 claimed a streaming agent on a
// Claude model "receives raw Anthropic frames" because
// `createAnthropicSSETranslator` has no caller in stream.ts. The first half is
// true and DELIBERATE — stream.ts:119-127 documents `raw` as the frame's native
// wire shape, untranslated, with `delta` as the portable field — and the
// implied harm is not: `interpret`/`extractDelta` read Anthropic
// `content_block_delta` natively, so the text path works and the "empty box"
// this file guards against never occurs.
//
// Piping the translator in would REWRITE `raw` for every existing Claude
// streaming consumer, which is a contract change, not a defect fix. These two
// cases pin the behaviour the card assumed was broken so a future wiring change
// has to face them.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { streamChat } = require('../dist/stream');

const encoder = new TextEncoder();

function anthropicRunner(chunks: string[]) {
  const seen: { path?: string } = {};
  return {
    seen,
    open(path: string) {
      seen.path = path;
      return Promise.resolve({
        status: 200,
        headers: {},
        body: (async function* () {
          for (const chunk of chunks) yield encoder.encode(chunk);
        })(),
        text: () => Promise.resolve(''),
      });
    },
  };
}

const TEXT_STREAM = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4","usage":{"input_tokens":9}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

test('a streaming Claude call yields text, not an empty box', async () => {
  const runner = anthropicRunner(TEXT_STREAM);
  const res = await streamChat(runner, { model: 'claude-sonnet-4', prompt: 'hi' });
  assert.equal(runner.seen.path, '/messages');
  assert.equal(await res.text(), 'Hello world');
});

test('an OpenAI-wire model is NOT translated', async () => {
  const openaiFrames = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'plain' } }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  const runner = anthropicRunner(openaiFrames);
  const res = await streamChat(runner, { model: 'gpt-4o-mini', prompt: 'hi' });
  assert.equal(runner.seen.path, '/chat/completions');
  assert.equal(await res.text(), 'plain');
});
