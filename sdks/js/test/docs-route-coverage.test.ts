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

/**
 * Gateway rules §2 — the fifteen customer routes, exhaustive.
 *
 * The three parameterized routes are load-bearing members of this list, not
 * decoration. They were omitted while the comment still said "fifteen", so the
 * array pinned TWELVE: routing.md could lose its `/v1/videos/{id}`,
 * `/v1/videos/{id}/content` and `/v1/models/{model_id}` rows and this test
 * stayed green — proven by deleting those rows and watching it pass. A reader
 * building a video chain would then find the retrieval and content routes
 * documented nowhere, which is the omission this file exists to catch.
 */
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
  '/v1/models/{model_id}',
  '/v1/responses',
  '/v1/videos',
  '/v1/videos/{id}',
  '/v1/videos/{id}/content',
];

test('the route list this file pins is the exhaustive fifteen', () => {
  // The defect was a silent arithmetic one: a list labelled "fifteen" holding
  // twelve entries. Counting it here makes the next omission fail loudly rather
  // than quietly narrowing what the coverage test above can see.
  assert.equal(
    ALL_ROUTES.length,
    15,
    'gateway rules §2 fixes FIFTEEN customer routes — a shorter list silently ' +
      'narrows the coverage assertion below without failing anything',
  );
});

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

/**
 * PGSDK-123 follow-up. The paragraph that introduces the route table
 * generalised about the table itself: it claimed all FOUR text rows list
 * several providers each. `/v1/completions` lists OpenAI alone — the gateway's
 * `LEGACY_COMPLETIONS_PROVIDERS` is `["openai", "codex"]`, one provider family.
 * On a public doc that reads as "every text wire has somewhere to fail over
 * to", which is exactly the wrong inference for a legacy-completions chain:
 * every non-OpenAI entry in it is skipped and the request fails while the chain
 * looks configured.
 *
 * So this derives the count FROM THE TABLE rather than pinning a sentence.
 * Widen the `/v1/completions` row to a second provider and the derived count
 * moves, and the prose has to move with it or this fails.
 */
const TEXT_ROUTES = [
  '/v1/chat/completions',
  '/v1/responses',
  '/v1/messages',
  '/v1/completions',
];

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four'];

const providersFor = (routing: string, route: string): string[] => {
  const row = routing.split('\n').find((l: string) => l.startsWith(`| \`${route}\` |`));
  assert.ok(row, `routing.md has no route-table row for ${route}`);
  return String(row)
    .split('|')[2]
    .split(',')
    .map((s: string) => s.trim())
    .filter(Boolean);
};

test('the prose counts the multi-provider TEXT rows the way the table does', () => {
  const routing = docs('routing.md');
  const multi = TEXT_ROUTES.filter((r) => providersFor(routing, r).length > 1);
  const single = TEXT_ROUTES.filter((r) => providersFor(routing, r).length === 1);

  assert.equal(
    multi.length + single.length,
    TEXT_ROUTES.length,
    'every text route must have a parseable provider cell',
  );

  assert.match(
    routing,
    new RegExp(`${NUMBER_WORDS[multi.length]} of the four text rows`, 'i'),
    `the table gives ${multi.length} text row(s) naming several providers; ` +
      `${single.join(', ') || 'none'} name(s) exactly one. The prose must say ` +
      `"${NUMBER_WORDS[multi.length]} of the four text rows", not a different count`,
  );

  for (const route of single) {
    // Same LINE, deliberately. Allowing the match to run onto the next line
    // lets the table itself satisfy this: the `/v1/completions` row is
    // immediately followed by `| /v1/messages/count_tokens | **Anthropic
    // only** |`, so a two-line window passes with no prose written at all.
    assert.match(
      routing,
      new RegExp(`\`${route}\`[^\\n]*(only|alone)`, 'i'),
      `${route} is served by ONE provider family, and the prose never says so — ` +
        'a reader builds a cross-provider fallback chain for it that can never fire',
    );
  }
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
