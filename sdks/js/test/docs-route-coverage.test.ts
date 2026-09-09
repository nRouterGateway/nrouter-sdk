// PGSDK-123. `docs/routing.md` publishes a provider-to-route table for the
// four TEXT wires only. The gateway's allowlist is stricter and narrower than
// that table implies, and nowhere in these docs is it stated:
//
//   nrouter-rust-gateway/src/sdk/providers/capabilities.rs::supports
//     PublicWire::CountTokens => provider_id == "anthropic"
//     Embeddings | ImageGeneration | AudioSpeech | AudioTranscription
//       | AudioTranslation | VideoGeneration | VideoCollection
//       => matches!(provider_id, "openai" | "codex")
//
// So embeddings, images, all three audio routes and all three video routes are
// served by openai/codex ALONE, and count_tokens by anthropic ALONE. A reader
// of routing.md sees six providers, configures a Bedrock or Vertex fallback for
// an image or audio call, and gets a refusal the docs do not explain — the
// shape already visible in docs/live-sdk-agent-report.md as an unexplained
// refusal.
//
// This test pins the DOCS against the gateway's own route inventory. It cannot
// read capabilities.rs (a published SDK cannot depend on the gateway tree), so
// the constraint is transcribed here with its source cited above, and the
// fifteen-route list is the one gateway rules §2 fixes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const docs = (name: string) =>
  fs.readFileSync(path.join(__dirname, '..', 'docs', name), 'utf8') as string;

/** Gateway rules §2 — the fifteen customer routes, exhaustive. */
const ALL_ROUTES = [
  '/v1/audio/speech',
  '/v1/audio/transcriptions',
  '/v1/audio/translations',
  '/v1/chat/completions',
  '/v1/completions',
  '/v1/embeddings',
  '/v1/images/generations',
  '/v1/messages',
  '/v1/messages/count_tokens',
  '/v1/models',
  '/v1/responses',
  '/v1/videos',
];

test('routing.md names every customer route, not only the four text wires', () => {
  const routing = docs('routing.md');
  const missing = ALL_ROUTES.filter((r) => !routing.includes(r));
  assert.deepEqual(
    missing,
    [],
    `routing.md publishes a route table that omits: ${missing.join(', ')}`,
  );
});

test('routing.md states the openai/codex-only constraint', () => {
  const routing = docs('routing.md');
  assert.match(routing, /OpenAI[^\n]*only/i);
  assert.ok(
    /count_tokens/.test(routing) && /Anthropic/.test(routing),
    'routing.md does not say count_tokens is Anthropic-only',
  );
});

for (const name of ['audio.md', 'images.md', 'video.md']) {
  test(`${name} carries a provider-constraint line`, () => {
    const body = docs(name);
    assert.match(
      body,
      /only provider|OpenAI[^\n]*only|served (only )?by OpenAI/i,
      `${name} does not tell the reader this route is served by openai/codex alone`,
    );
  });
}
