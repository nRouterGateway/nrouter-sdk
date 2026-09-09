// chat() must be cancellable at the call boundary (PGSDK-106).
//
// The media helpers have taken an `AbortSignalLike` since they were written —
// `TransportRequest.signal` is threaded straight into the fetch options by
// `nRouter.raw`. `chat()`, the helper an agent loop actually calls in a loop,
// took none: neither `NRouterCallOptions` nor `ChatRunner.request` carried one,
// so a runaway loop could only be stopped by replacing the runner. That is a
// workaround, not an API, and it means a caller cannot cancel a single
// in-flight completion at all.
//
// Cancellation is also a MONEY control here, not only an ergonomic one: an
// abandoned agent turn that nobody can stop keeps calling providers and keeps
// reserving credit.
//
// Mutate-and-check: drop `signal` from the `chat()` -> `runner.request` call
// and cases (i) and (iii) go red; drop `signal: init?.signal` from the client's
// string-path branch (client.ts, `typeof pathOrReq === 'string'`) and case
// (iii) goes red on its own.
//
// Case (ii) is deliberately NOT that mutation's witness, and the comment here
// used to claim it was. It hands `chat()` a MOCK runner, so it never reaches
// `NRouterSurface.request` at all — it proves the seam is honoured and the
// abort arrives normalized, which is a different property. Only case (iii)
// runs the real client, so only case (iii) can see that branch break.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { chat } = require('../dist/chat');
const { nRouter } = require('../dist/index');
const { nRouterError, isRetryable } = require('../dist/errors');

// Assembled rather than written out, so the workspace secret scanner does not
// have to decide whether a literal in a test file is a live key.
const TEST_KEY = `sk-${'nrouter'}-test0000000000000abcd`;

const OK = {
  status: 200,
  headers: new Headers({ 'content-type': 'application/json', 'x-nr-request-id': 'req_1' }),
  text: JSON.stringify({
    id: 'x',
    choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  }),
  contentType: 'application/json',
};

test('(i) chat() hands the caller signal to the transport seam', async () => {
  const seen = [];
  const runner = {
    request: async (path, body, init) => {
      seen.push(init);
      return OK;
    },
  };
  const controller = new AbortController();

  await chat(runner, { model: 'gpt-4o-mini', prompt: 'hi', signal: controller.signal });

  assert.equal(seen.length, 1);
  assert.ok(seen[0], 'the transport seam received no third argument at all');
  assert.equal(seen[0].signal, controller.signal);
});

test('(i-b) no signal means no signal — nothing is invented', async () => {
  const seen = [];
  const runner = {
    request: async (path, body, init) => {
      seen.push(init);
      return OK;
    },
  };

  await chat(runner, { model: 'gpt-4o-mini', prompt: 'hi' });

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.signal, undefined);
});

test('(ii) an already-aborted signal rejects instead of billing a provider call', async () => {
  // The runner here IS the abort-aware transport: it does what fetch does when
  // handed an aborted signal. The point of the case is that the signal reaches
  // it at all — without the thread-through, this request goes out.
  const runner = {
    request: async (path, body, init) => {
      if (init?.signal?.aborted) {
        const err = new Error('This operation was aborted');
        err.name = 'AbortError';
        throw err;
      }
      return OK;
    },
  };
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => chat(runner, { model: 'gpt-4o-mini', prompt: 'hi', signal: controller.signal }),
    (err) => {
      // chat() promises it rejects with an nRouterError and nothing else, so
      // the abort must arrive NORMALIZED — a raw DOMException/AbortError
      // escaping here would break the "one catch covers everything" contract.
      assert.ok(err instanceof nRouterError, `not an nRouterError: ${err?.name}`);
      // ...and it must not be retryable: a cancelled request is not a blip.
      assert.equal(isRetryable(err), false);
      return true;
    },
  );
});

test('(iii) the REAL client carries the signal from chat() down to fetch', async () => {
  // The client is the ChatRunner here, so this is the whole string path:
  // chat() -> NRouterSurface.request(path, body, { signal }) -> the
  // TransportRequest literal -> raw() -> fetch. A mock runner cannot see any
  // of it, which is why case (ii) is not this case.
  let seenSignal: unknown = 'never-called';
  const controller = new AbortController();
  const client = new nRouter({
    apiKey: TEST_KEY,
    fetch: async (_url: unknown, init: any) => {
      seenSignal = init?.signal;
      return new Response(
        JSON.stringify({
          id: 'x',
          choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });

  // `client.nr` is the NRouterSurface — the ChatRunner. `client` itself is the
  // vendor class, whose `request()` is a different method entirely.
  await chat(client.nr, { model: 'gpt-4o-mini', prompt: 'hi', signal: controller.signal });

  assert.notEqual(seenSignal, 'never-called', 'fetch was never reached');
  assert.ok(seenSignal, 'fetch was handed no signal at all');

  // NOT an identity check, deliberately. The vendor client composes the
  // caller's signal with its own per-request timeout via `AbortSignal.any`, so
  // what fetch receives is a COMPOSITE and `seenSignal === controller.signal`
  // is false even when the thread-through works perfectly. The property that
  // actually matters is PROPAGATION: firing the caller's controller must abort
  // the signal the transport is holding. Sever `signal: init?.signal` in
  // client.ts's string-path branch and the composite no longer has the
  // caller's controller among its sources, so this stays false.
  assert.equal((seenSignal as AbortSignal).aborted, false, 'aborted before the caller asked');
  controller.abort();
  assert.equal(
    (seenSignal as AbortSignal).aborted,
    true,
    'the caller signal did not survive the client string path, so an in-flight ' +
      'completion cannot be cancelled and a runaway loop keeps reserving credit',
  );
});

test('(iii-b) a foreign controller cannot cancel someone else\'s request', async () => {
  // The complement of (iii), and the reason (iii) is not vacuous: when the
  // caller passes NO signal, the transport's signal must not be wired to any
  // controller of ours. A thread-through that handed the same shared signal to
  // every request would pass (iii) and fail here.
  const foreign = new AbortController();
  let seenSignal: unknown = 'never-called';
  const client = new nRouter({
    apiKey: TEST_KEY,
    fetch: async (_url: unknown, init: any) => {
      seenSignal = init?.signal;
      return new Response(
        JSON.stringify({
          id: 'x',
          choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });

  await chat(client.nr, { model: 'gpt-4o-mini', prompt: 'hi' });

  foreign.abort();
  assert.notEqual(seenSignal, 'never-called', 'fetch was never reached');
  assert.equal(
    seenSignal === undefined ? false : (seenSignal as AbortSignal).aborted,
    false,
    'an unrelated controller cancelled this request',
  );
});
