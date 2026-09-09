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
// and case (i) goes red; drop it from the client's string-path branch and
// case (ii) goes red.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { chat } = require('../dist/chat');
const { nRouterError, isRetryable } = require('../dist/errors');

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
