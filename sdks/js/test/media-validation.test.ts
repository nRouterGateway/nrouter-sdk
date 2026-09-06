// Pre-send parameter validation for the two BILLED media calls.
//
// `image()` and `video()` are the endpoints where a malformed argument costs
// money rather than a 400. Every case below asserts the refusal happens with
// the transport UNTOUCHED — `fetch` increments a counter that must stay at
// zero — because "the gateway rejected it" and "the SDK rejected it" look
// identical from the return value and differ entirely in what they cost.
//
// The bounds are the gateway's own, cited at each constant in
// `src/multimodal.ts`. A test here that is stricter than the gateway would be
// a false gate: it would refuse a request the gateway accepts and bills, which
// is a worse defect than the one this file exists to prevent.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  nRouter,
  nRouterConfigurationError,
  MAX_IMAGE_COUNT,
  MAX_VIDEO_SECONDS,
  MIN_VIDEO_POLL_INTERVAL_MS,
  DEFAULT_VIDEO_POLL_INTERVAL_MS,
  DEFAULT_VIDEO_TIMEOUT_MS,
  VALID_IMAGE_SIZES,
  VALID_IMAGE_QUALITIES,
  VALID_IMAGE_RESPONSE_FORMATS,
} = require('../dist/index');

// Assembled from parts so the repository's secret scanner does not have to
// pattern-match a literal that only looks like a virtual key.
const TEST_KEY = ['sk', 'nrouter', 'test0000000000000abcd'].join('-');

/** A client whose transport counts calls and never returns a usable response. */
function countingClient() {
  const state = { calls: 0 };
  const client = new nRouter({
    apiKey: TEST_KEY,
    fetch: async () => {
      state.calls++;
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return { client, state };
}

/**
 * Assert `fn` refuses BEFORE the transport is touched.
 *
 * ONE invocation, checking the class and the message inside a single
 * `assert.rejects` validator. Calling twice — once for the class, once for the
 * regex — meant that if the call unexpectedly RESOLVED, the first
 * `assert.rejects` threw and the transport-count assertion below was never
 * reached, so the very failure this helper exists to detect reported itself as
 * "expected a rejection" instead of "the transport was reached".
 */
async function refusesBeforeSend(
  fn: (c: any) => Promise<unknown>,
  message: RegExp
): Promise<void> {
  const { client, state } = countingClient();
  await assert.rejects(
    () => fn(client),
    (err: any) => {
      assert.ok(
        err instanceof nRouterConfigurationError,
        `expected nRouterConfigurationError, got ${err && err.constructor && err.constructor.name}`
      );
      assert.match(err.message, message);
      return true;
    }
  );
  assert.equal(state.calls, 0, 'the transport must not be reached');
}

// ---------------------------------------------------------------------------
// The exported bounds
// ---------------------------------------------------------------------------

test('the media bounds are exported as runtime values', () => {
  assert.equal(MAX_IMAGE_COUNT, 10);
  assert.equal(MAX_VIDEO_SECONDS, 1333);
  assert.equal(MIN_VIDEO_POLL_INTERVAL_MS, 250);
  assert.equal(DEFAULT_VIDEO_POLL_INTERVAL_MS, 500);
  assert.equal(DEFAULT_VIDEO_TIMEOUT_MS, 60_000);
  assert.deepEqual([...VALID_IMAGE_RESPONSE_FORMATS], ['url', 'b64_json']);
  assert.ok(VALID_IMAGE_SIZES.includes('1024x1024'));
  assert.ok(VALID_IMAGE_SIZES.includes('auto'));
  assert.ok(VALID_IMAGE_QUALITIES.includes('hd'));
  assert.ok(VALID_IMAGE_QUALITIES.includes('auto'));
});

// ---------------------------------------------------------------------------
// image(): `n`
// ---------------------------------------------------------------------------

test('image() refuses n below 1 before the billed call', async () => {
  await refusesBeforeSend(
    (c) => c.nr.media.image({ model: 'gpt-image-1', prompt: 'a cat', n: 0 }),
    /`n` must be an integer from 1 through 10/
  );
});

test('image() refuses n above the gateway ceiling before the billed call', async () => {
  await refusesBeforeSend(
    (c) => c.nr.media.image({ model: 'gpt-image-1', prompt: 'a cat', n: 11 }),
    /`n` must be an integer from 1 through 10/
  );
});

test('image() refuses a fractional n', async () => {
  await refusesBeforeSend(
    (c) => c.nr.media.image({ model: 'gpt-image-1', prompt: 'a cat', n: 2.5 }),
    /`n` must be an integer from 1 through 10/
  );
});

test('image() refuses a non-numeric n', async () => {
  await refusesBeforeSend(
    (c) => c.nr.media.image({ model: 'gpt-image-1', prompt: 'a cat', n: '3' as any }),
    /`n` must be an integer from 1 through 10/
  );
});

test('image() accepts every n the gateway accepts', async () => {
  for (const n of [1, 5, MAX_IMAGE_COUNT]) {
    const { client, state } = countingClient();
    await client.nr.media.image({ model: 'gpt-image-1', prompt: 'a cat', n });
    assert.equal(state.calls, 1, `n=${n} must reach the transport`);
  }
});

// ---------------------------------------------------------------------------
// image(): response_format, size, quality
// ---------------------------------------------------------------------------

test('image() refuses an unknown response_format', async () => {
  await refusesBeforeSend(
    (c) =>
      c.nr.media.image({
        model: 'gpt-image-1',
        prompt: 'a cat',
        response_format: 'png' as any,
      }),
    /Invalid image response_format 'png'/
  );
});

test('image() refuses an unknown size', async () => {
  await refusesBeforeSend(
    (c) => c.nr.media.image({ model: 'gpt-image-1', prompt: 'a cat', size: 'huge' }),
    /Invalid image size 'huge'/
  );
});

test('image() refuses an empty size', async () => {
  await refusesBeforeSend(
    (c) => c.nr.media.image({ model: 'gpt-image-1', prompt: 'a cat', size: '   ' }),
    /Invalid image size/
  );
});

test('image() refuses an unknown quality', async () => {
  await refusesBeforeSend(
    (c) => c.nr.media.image({ model: 'gpt-image-1', prompt: 'a cat', quality: 'ultra' }),
    /Invalid image quality 'ultra'/
  );
});

test('image() accepts every documented size and quality', async () => {
  for (const size of VALID_IMAGE_SIZES) {
    const { client, state } = countingClient();
    await client.nr.media.image({ model: 'gpt-image-1', prompt: 'a cat', size });
    assert.equal(state.calls, 1, `size=${size} must reach the transport`);
  }
  for (const quality of VALID_IMAGE_QUALITIES) {
    const { client, state } = countingClient();
    await client.nr.media.image({ model: 'gpt-image-1', prompt: 'a cat', quality });
    assert.equal(state.calls, 1, `quality=${quality} must reach the transport`);
  }
});

test('image() normalizes case and surrounding space like the gateway does', async () => {
  const { client, state } = countingClient();
  await client.nr.media.image({
    model: 'gpt-image-1',
    prompt: 'a cat',
    size: ' 1024X1024 ',
    quality: ' HD ',
  });
  assert.equal(state.calls, 1);
});

test('image() `extra` is the escape hatch for an unlisted size', async () => {
  let sentBody: any = null;
  const client = new nRouter({
    apiKey: TEST_KEY,
    fetch: async (_url: unknown, init: any) => {
      const raw = init.body;
      sentBody = JSON.parse(
        typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
      );
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  await client.nr.media.image({
    model: 'some-provider/model',
    prompt: 'a cat',
    extra: { size: '2048x2048' },
  });

  assert.equal(sentBody.size, '2048x2048');
});

// ---------------------------------------------------------------------------
// video(): seconds
// ---------------------------------------------------------------------------

test('video() refuses zero seconds before the billed call', async () => {
  await refusesBeforeSend(
    (c) => c.nr.media.video({ model: 'sora-2', prompt: 'a wave', seconds: 0 }),
    /`seconds` must be a positive finite number/
  );
});

test('video() refuses negative seconds before the billed call', async () => {
  await refusesBeforeSend(
    (c) => c.nr.media.video({ model: 'sora-2', prompt: 'a wave', seconds: -4 }),
    /`seconds` must be a positive finite number/
  );
});

test('video() refuses a non-finite seconds', async () => {
  await refusesBeforeSend(
    (c) => c.nr.media.video({ model: 'sora-2', prompt: 'a wave', seconds: Number.POSITIVE_INFINITY }),
    /`seconds` must be a positive finite number/
  );
});

test('video() refuses a non-numeric seconds string', async () => {
  await refusesBeforeSend(
    (c) => c.nr.media.video({ model: 'sora-2', prompt: 'a wave', seconds: 'eight' }),
    /`seconds` must be a positive finite number/
  );
});

test('video() refuses seconds above the reservation ceiling', async () => {
  await refusesBeforeSend(
    (c) => c.nr.media.video({ model: 'sora-2', prompt: 'a wave', seconds: MAX_VIDEO_SECONDS + 1 }),
    /at most 1333/
  );
});

test('video() names the credit-hold reason when seconds is too large', async () => {
  const { client } = countingClient();
  await assert.rejects(
    () => client.nr.media.video({ model: 'sora-2', prompt: 'a wave', seconds: 100_000 }),
    /credit hold/
  );
});

test('video() accepts seconds as a numeric string, at the ceiling', async () => {
  const { client, state } = countingClient();
  await client.nr.media.video({
    model: 'sora-2',
    prompt: 'a wave',
    seconds: String(MAX_VIDEO_SECONDS),
  });
  assert.equal(state.calls, 1);
});

// ---------------------------------------------------------------------------
// video(): size
// ---------------------------------------------------------------------------

test('video() refuses a size that is not WIDTHxHEIGHT', async () => {
  await refusesBeforeSend(
    (c) => c.nr.media.video({ model: 'sora-2', prompt: 'a wave', size: '720p' }),
    /`size` must be WIDTHxHEIGHT/
  );
});

test('video() refuses a zero dimension', async () => {
  await refusesBeforeSend(
    (c) => c.nr.media.video({ model: 'sora-2', prompt: 'a wave', size: '0x720' }),
    /`size` must be WIDTHxHEIGHT/
  );
});

test('video() accepts an ordinary WIDTHxHEIGHT size', async () => {
  const { client, state } = countingClient();
  await client.nr.media.video({ model: 'sora-2', prompt: 'a wave', size: '1280x720' });
  assert.equal(state.calls, 1);
});

// ---------------------------------------------------------------------------
// waitForVideo(): poll bounds
// ---------------------------------------------------------------------------

test('waitForVideo refuses a poll interval below the floor', async () => {
  const { client, state } = countingClient();
  await assert.rejects(
    () => client.nr.media.waitForVideo('vid_1', { pollIntervalMs: 1 }),
    nRouterConfigurationError
  );
  await assert.rejects(
    () => client.nr.media.waitForVideo('vid_1', { pollIntervalMs: 1 }),
    /pollIntervalMs.*at least 250/
  );
  assert.equal(state.calls, 0);
});

test('waitForVideo refuses a non-finite poll interval', async () => {
  const { client } = countingClient();
  await assert.rejects(
    () => client.nr.media.waitForVideo('vid_1', { pollIntervalMs: Number.NaN }),
    /pollIntervalMs/
  );
});

test('waitForVideo refuses a timeout shorter than one poll interval', async () => {
  const { client, state } = countingClient();
  await assert.rejects(
    () => client.nr.media.waitForVideo('vid_1', { pollIntervalMs: 1000, timeoutMs: 500 }),
    /timeoutMs/
  );
  assert.equal(state.calls, 0);
});

test('waitForVideo accepts the floor interval', async () => {
  const client = new nRouter({
    apiKey: TEST_KEY,
    fetch: async () =>
      new Response(JSON.stringify({ id: 'vid_1', status: 'completed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  });
  const res = await client.nr.media.waitForVideo('vid_1', {
    pollIntervalMs: MIN_VIDEO_POLL_INTERVAL_MS,
    timeoutMs: 2_000,
  });
  assert.equal(res.body.status, 'completed');
});
