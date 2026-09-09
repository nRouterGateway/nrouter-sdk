// Case 13 — SSE framing.
//
// Every bug this file guards against reproduces only under a SPECIFIC byte
// split, which is exactly what a fake runner can produce on demand and a live
// call cannot:
//
//   * an event straddling two network chunks must reassemble, not be dropped
//     and not be parsed twice;
//   * `data: [DONE]` terminates the stream, and is not a malformed frame;
//   * a non-JSON `data:` line must NOT kill the stream — it is almost always a
//     buffering proxy's keep-alive, and throwing there discards tokens the
//     customer has already been billed for;
//   * an abort must actually stop the iteration, and must never be reported as
//     a retryable failure (retrying re-sends a request the caller abandoned,
//     which on a billed endpoint is a second charge).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspect } = require('node:util');

const { parseSSE, streamChat, isAbortError } = require('../dist/stream');
const { nRouterError, isRetryable, transportError, nRouterRateLimitError, nRouterServiceError } = require('../dist/errors');

const encoder = new TextEncoder();

/** A StreamRunner whose body yields exactly the chunks given, in order. */
function chunkRunner(
  chunks: string[],
  init: { status?: number; headers?: Record<string, string>; text?: string } = {}
) {
  const seen: { path?: string; body?: Record<string, unknown>; signal?: AbortSignal } = {};
  return {
    seen,
    open(path: string, body: unknown, signal?: AbortSignal) {
      seen.path = path;
      seen.body = body as Record<string, unknown>;
      seen.signal = signal;
      return Promise.resolve({
        status: init.status ?? 200,
        headers: init.headers ?? {},
        body:
          init.status !== undefined && (init.status < 200 || init.status >= 300)
            ? null
            : (async function* () {
                for (const chunk of chunks) {
                  yield encoder.encode(chunk);
                }
              })(),
        text: () => Promise.resolve(init.text ?? ''),
      });
    },
  };
}

const frame = (text: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

async function collect(chunks: AsyncIterable<{ delta: string }>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of chunks) out.push(chunk.delta);
  return out;
}

async function rejection(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection, got a resolved promise');
}

// ---------------------------------------------------------------------------
// parseSSE — the framing primitive.
// ---------------------------------------------------------------------------

test('parseSSE reads data, event and multi-line data', () => {
  assert.deepEqual(parseSSE('data: hello\n\n'), [{ data: 'hello' }]);
  assert.deepEqual(parseSSE('event: error\ndata: boom\n\n'), [{ event: 'error', data: 'boom' }]);
  // Several data lines in one event join with a newline, per the SSE spec.
  assert.deepEqual(parseSSE('data: a\ndata: b\n\n'), [{ data: 'a\nb' }]);
});

test('parseSSE strips exactly ONE leading space after the colon', () => {
  // A second space belongs to the payload; stripping it corrupts indented text.
  assert.deepEqual(parseSSE('data:  indented\n\n'), [{ data: ' indented' }]);
  assert.deepEqual(parseSSE('data:tight\n\n'), [{ data: 'tight' }]);
});

test('parseSSE drops comment keep-alives and fields it cannot act on', () => {
  // `: keep-alive` from a proxy, and `id:`/`retry:` — the gateway does not
  // resume streams, so an id there is noise.
  assert.deepEqual(parseSSE(': keep-alive\n\ndata: real\n\n'), [{ data: 'real' }]);
  assert.deepEqual(parseSSE('id: 7\nretry: 100\ndata: real\n\n'), [{ data: 'real' }]);
});

test('parseSSE keeps a trailing event a server closed without a blank line', () => {
  // Dropping it loses the last token, or the `[DONE]` that says the answer is
  // complete.
  assert.deepEqual(parseSSE('data: a\n\ndata: [DONE]'), [{ data: 'a' }, { data: '[DONE]' }]);
});

test('parseSSE handles all three line endings', () => {
  for (const [lf, blank] of [
    ['\n', '\n\n'],
    ['\r\n', '\r\n\r\n'],
    ['\r', '\r\r'],
  ]) {
    assert.deepEqual(
      parseSSE(`event: x${lf}data: y${blank}`),
      [{ event: 'x', data: 'y' }],
      `line ending ${JSON.stringify(lf)}`
    );
  }
});

// ---------------------------------------------------------------------------
// Chunk boundaries.
// ---------------------------------------------------------------------------

// Every OpenAI-protocol stream ends with this, and the gateway relays it
// (nrouter-rust-gateway chat_completions.rs:783). A stream that stops without
// it is truncated, and the SDK now refuses it — so a test that omits it is
// testing a failure mode, not the one it means to.
const DONE = 'data: [DONE]\n\n';

test('an event SPLIT ACROSS TWO NETWORK CHUNKS reassembles', async () => {
  const whole = frame('hello world') + DONE;
  const cut = Math.floor(whole.length / 2);
  const res = await streamChat(chunkRunner([whole.slice(0, cut), whole.slice(cut)]), {
    model: 'm',
    prompt: 'hi',
  });
  assert.deepEqual(await collect(res.chunks), ['hello world']);
});

test('a split at EVERY offset of a two-event stream still yields both', async () => {
  // The strong form: a buffer that is flushed rather than carried forward
  // fails at exactly one of these offsets, which is why a single hand-picked
  // split proves very little.
  const whole = frame('alpha') + frame('beta') + 'data: [DONE]\n\n';
  for (let cut = 1; cut < whole.length; cut += 1) {
    const res = await streamChat(chunkRunner([whole.slice(0, cut), whole.slice(cut)]), {
      model: 'm',
      prompt: 'hi',
    });
    assert.deepEqual(await collect(res.chunks), ['alpha', 'beta'], `split at offset ${cut}`);
  }
});

test('a CRLF split between the \\r and the \\n does not merge two events', async () => {
  // Treating a dangling `\r` as a line end merges the events when the next
  // chunk opens with `\n`.
  const whole = `data: {"choices":[{"delta":{"content":"a"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"b"}}]}\r\n\r\n${DONE}`;
  const cut = whole.indexOf('\r\n\r\n') + 3; // between the second \r and its \n
  const res = await streamChat(chunkRunner([whole.slice(0, cut), whole.slice(cut)]), {
    model: 'm',
    prompt: 'hi',
  });
  assert.deepEqual(await collect(res.chunks), ['a', 'b']);
});

test('a multi-byte character split across chunks is not mojibake', async () => {
  // One TextDecoder for the whole stream, always with { stream: true }. A
  // per-chunk decoder emits U+FFFD for the half it sees — the classic bug that
  // only appears under load, when chunks get small.
  const whole = frame('héllo — ok') + DONE;
  const bytes = encoder.encode(whole);
  // Split inside the em-dash's UTF-8 sequence.
  const dash = whole.indexOf('—');
  const byteCut = encoder.encode(whole.slice(0, dash)).length + 1;
  const runner = {
    open() {
      return Promise.resolve({
        status: 200,
        headers: {},
        body: (async function* () {
          yield bytes.slice(0, byteCut);
          yield bytes.slice(byteCut);
        })(),
      });
    },
  };
  const res = await streamChat(runner, { model: 'm', prompt: 'hi' });
  assert.deepEqual(await collect(res.chunks), ['héllo — ok']);
});

// ---------------------------------------------------------------------------
// [DONE] and unparseable data lines.
// ---------------------------------------------------------------------------

test('data: [DONE] TERMINATES the stream', async () => {
  const res = await streamChat(
    chunkRunner([frame('a'), 'data: [DONE]\n\n', frame('never')]),
    { model: 'm', prompt: 'hi' }
  );
  assert.deepEqual(
    await collect(res.chunks),
    ['a'],
    'nothing after the terminator may be yielded'
  );
});

test('[DONE] is not reported as a malformed frame', async () => {
  const res = await streamChat(chunkRunner(['data: [DONE]\n\n']), { model: 'm', prompt: 'hi' });
  assert.equal(await res.text(), '');
});

test('a NON-JSON data: line does not kill the stream', async () => {
  // Tokens already delivered are already billed; throwing over a proxy's
  // cosmetic frame discards a paid-for answer.
  const res = await streamChat(
    chunkRunner([frame('a'), 'data: not-json-at-all\n\n', frame('b'), 'data: [DONE]\n\n']),
    { model: 'm', prompt: 'hi' }
  );
  assert.deepEqual(await collect(res.chunks), ['a', 'b']);
});

test('an in-band `event: error` frame DOES stop the stream, typed', async () => {
  // Streaming takes the status line away from an output guardrail, so this
  // frame is the ONLY signal that the answer was withheld. Ending quietly
  // hands back a truncated response that looks complete.
  const res = await streamChat(
    chunkRunner([
      frame('partial'),
      'event: error\ndata: {"error":{"type":"guardrail_blocked","message":"denied"}}\n\n',
    ]),
    { model: 'm', prompt: 'hi' }
  );
  const err = await rejection(collect(res.chunks));
  assert.ok(err instanceof nRouterError, `expected an nRouterError, got ${err}`);
  assert.equal(err.name, 'nRouterGuardrailBlockedError');
});

test('a failure during iteration is re-thrown by text(), never swallowed', async () => {
  const res = await streamChat(
    chunkRunner([
      frame('partial'),
      'event: error\ndata: {"error":{"type":"guardrail_blocked","message":"denied"}}\n\n',
    ]),
    { model: 'm', prompt: 'hi' }
  );
  const err = await rejection(res.text());
  assert.ok(err instanceof nRouterError, 'a truncated answer that looks complete is worse than an error');
});

// ---------------------------------------------------------------------------
// Metadata and non-2xx.
// ---------------------------------------------------------------------------

test('stream metadata is read from the headers before the body is touched', async () => {
  const res = await streamChat(
    chunkRunner([frame('a'), 'data: [DONE]\n\n'], {
      headers: { 'x-nr-request-id': 'nrouter-stream', 'x-nr-cost-status': 'unpriced' },
    }),
    { model: 'm', prompt: 'hi' }
  );
  assert.equal(res.meta.requestId, 'nrouter-stream');
  assert.equal(res.meta.cost, null, 'a stream has no settled cost yet; 0 would claim a free request');
  assert.equal(await res.text(), 'a');
});

test('streamChat sets stream: true itself and never lets the caller unset it', async () => {
  const runner = chunkRunner(['data: [DONE]\n\n']);
  await streamChat(runner, { model: 'm', prompt: 'hi' });
  assert.equal(runner.seen.body?.stream, true);
  assert.equal(runner.seen.path, '/chat/completions', 'the base URL already carries /v1');
});

test('a non-2xx throws a typed error BEFORE any streaming begins', async () => {
  const err = await rejection(
    streamChat(
      chunkRunner([], {
        status: 402,
        headers: { 'x-nr-request-id': 'nrouter-402' },
        text: JSON.stringify({ error: { code: 'insufficient_credits', message: 'top up' } }),
      }),
      { model: 'm', prompt: 'hi' }
    )
  );
  assert.ok(err instanceof nRouterError);
  assert.equal(err.name, 'nRouterCreditError');
  assert.equal(err.requestId, 'nrouter-402');
  assert.equal(err.status, 402, 'the response arrived; status must not read as "never sent"');
});

// ---------------------------------------------------------------------------
// Abort.
// ---------------------------------------------------------------------------

test('an ALREADY-aborted signal refuses before the runner is called', async () => {
  const controller = new AbortController();
  controller.abort();
  const runner = chunkRunner([frame('a')]);
  const err = await rejection(streamChat(runner, { model: 'm', prompt: 'hi' }, controller.signal));
  assert.equal(isAbortError(err) || err?.name === 'AbortError', true, `got ${err}`);
  assert.equal(runner.seen.path, undefined, 'nothing may be sent for a request already abandoned');
});

test('aborting MID-STREAM actually stops the iteration', async () => {
  const controller = new AbortController();
  // A runner that keeps producing after the abort lands, which is what a
  // queue-backed or buffered iterable really does.
  const runner = {
    open() {
      return Promise.resolve({
        status: 200,
        headers: {},
        body: (async function* () {
          for (let i = 0; i < 100; i += 1) {
            yield encoder.encode(frame(`t${i}`));
          }
        })(),
      });
    },
  };
  const res = await streamChat(runner, { model: 'm', prompt: 'hi' }, controller.signal);

  const seen: string[] = [];
  const err = await rejection(
    (async () => {
      for await (const chunk of res.chunks) {
        seen.push(chunk.delta);
        if (seen.length === 3) controller.abort();
      }
    })()
  );

  assert.equal(isAbortError(err) || err?.name === 'AbortError', true, `got ${err}`);
  assert.ok(seen.length < 100, `the abort did not stop iteration: ${seen.length} chunks decoded`);
});

test('an abort is never retryable', async () => {
  // The caller asked to stop. A retry re-sends a request they abandoned, and
  // on a billed endpoint that is a second charge.
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  assert.equal(isAbortError(abort), true);
  assert.equal(isRetryable(abort), false, 'a bare abort is not an nRouterError and is not retryable');

  const { nRouterTransportError } = require('../dist/errors');
  assert.equal(isRetryable(new nRouterTransportError('gave up', { cause: abort })), false);
});

// A stream that stops mid-answer without its sentinel is TRUNCATED, and the
// request was billed. Returning the partial text as if it were whole is the
// same silently-wrong-and-confident failure the buffered path refuses.
test('a stream that ends without [DONE] is refused, not reported complete', async () => {
  const res = await streamChat(chunkRunner([frame('half an ans')]), { model: 'm', prompt: 'hi' });
  await assert.rejects(
    async () => {
      for await (const _ of res.chunks) { /* drain */ }
    },
    (err: unknown) => {
      assert.ok(err instanceof nRouterError, 'a typed error');
      assert.equal(isRetryable(err), false, 'retrying issues a new billed request, so it must not auto-retry');
      assert.match((err as Error).message, /\[DONE\]/);
      assert.match((err as Error).message, /Retrying issues a NEW billed request/);
      return true;
    },
  );
});

test('...and text() re-throws rather than handing back the truncated answer', async () => {
  const res = await streamChat(chunkRunner([frame('half an ans')]), { model: 'm', prompt: 'hi' });
  await assert.rejects(async () => { for await (const _ of res.chunks) { /* drain */ } });
  await assert.rejects(() => res.text(), /\[DONE\]/);
});

// Rule #5: a fetch failure commonly holds the originating Request — headers
// included — so a RAW cause makes console.error(err) print the Authorization
// value. Neither toJSON nor message redaction covers that path.
test('a sanitized cause cannot carry the Authorization header into a log', () => {
  const leaky: Error & { request?: unknown } = new Error('socket hang up');
  leaky.name = 'AbortError';
  leaky.request = { headers: { authorization: 'Bearer sk-nrouter-secrettail1234' } };

  const err = transportError('the stream failed', { cause: leaky });
  const rendered = inspect(err, { depth: 10 });
  assert.ok(!rendered.includes('secrettail1234'), `the key leaked:\n${rendered}`);
  assert.ok(!rendered.includes('Bearer'), `an Authorization header leaked:\n${rendered}`);
  // ...and the abort is still recognisable, which is what the name is for.
  assert.equal(isRetryable(err), false, 'an abort must stay non-retryable through a sanitized cause');
});

// The buffered and media paths honour Retry-After; the streaming path returned
// null for it, so a caller could not respect the backoff the gateway asked for.
test('a streaming 429 carries its Retry-After', async () => {
  const runner = {
    open: async () => ({
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '42' },
      body: null,
      text: async () => JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'slow' } }),
    }),
  };
  await assert.rejects(
    () => streamChat(runner as never, { model: 'm', prompt: 'x' }),
    (err: unknown) => {
      assert.equal((err as { retryAfter?: number | null }).retryAfter, 42);
      return true;
    },
  );
});

// A socket that dies WHILE the body is being read. Rethrowing it raw meant
// nr.stream() left the advertised nRouterError hierarchy entirely: isRetryable
// answered false and the status and request id were lost, for a request that
// DID reach the gateway and was billed for what it delivered.
test('a raw failure out of the body iterator is normalized, not leaked', async () => {
  const runner = {
    open: async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'x-nr-request-id': 'nrouter-cut' },
      body: (async function* () {
        yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"par"}}]}\n\n');
        throw new Error('ECONNRESET');
      })(),
    }),
  };
  const res = await streamChat(runner as never, { model: 'm', prompt: 'x' });
  await assert.rejects(
    async () => {
      for await (const _ of res.chunks) { /* drain */ }
    },
    (err: unknown) => {
      assert.ok(err instanceof nRouterError, 'must stay inside the nRouterError hierarchy');
      const e = err as { status?: number | null; requestId?: string | null };
      assert.equal(e.status, 200, 'the response DID arrive');
      assert.equal(e.requestId, 'nrouter-cut', 'the request id must survive');
      assert.equal(isRetryable(err), true, 'a dropped socket can succeed on a retry');
      return true;
    },
  );
});

// AbortController.abort() with no argument yields an AbortError; abort(reason)
// propagates the reason VERBATIM — a generic Error the name check missed. It
// was then wrapped as a retryable transport failure, so a retry loop could
// resend a billed request the caller had explicitly cancelled.
test('a CUSTOM abort reason is still a cancellation, not a retryable failure', async () => {
  const controller = new AbortController();
  const runner = {
    open: async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: (async function* () {
        yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
        controller.abort(new Error('the user navigated away'));
        yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"b"}}]}\n\n');
      })(),
    }),
  };
  const res = await streamChat(runner as never, { model: 'm', prompt: 'x' }, controller.signal);
  await assert.rejects(
    async () => {
      for await (const _ of res.chunks) { /* drain */ }
    },
    (err: unknown) => {
      assert.equal(isRetryable(err), false, 'a cancelled request must never be resent — it was billed');
      return true;
    },
  );
});

test('a socket failure caused by abort is normalized to an AbortError (PGSDK-112)', async () => {
  const controller = new AbortController();
  const runner = {
    open: async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: (async function* () {
        yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
        controller.abort();
        // Emulate socket drop upon abort (e.g. node fetch or undici socket hang up)
        throw new Error('socket hang up');
      })(),
    }),
  };
  const res = await streamChat(runner as never, { model: 'm', prompt: 'x' }, controller.signal);
  await assert.rejects(
    async () => {
      for await (const _ of res.chunks) { /* drain */ }
    },
    (err: unknown) => {
      assert.equal(isAbortError(err), true, 'socket hang up on aborted signal must be recognized as abort');
      assert.equal(isRetryable(err), false, 'an aborted request is never retryable');
      const cause = (err as Error & { cause?: unknown }).cause;
      assert.ok(cause instanceof Error, 'underlying socket error preserved as cause');
      assert.equal((cause as Error).message, 'socket hang up');
      return true;
    },
  );
});

test('a stream cut off mid-answer preserves requestId and meta on the truncation error (PGSDK-112)', async () => {
  const runner = {
    open: async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'x-nr-request-id': 'req-trunc-456' },
      body: (async function* () {
        yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"part"}}]}\n\n');
        // connection closes without [DONE]
      })(),
    }),
  };
  const res = await streamChat(runner as never, { model: 'm', prompt: 'x' });
  await assert.rejects(
    async () => {
      for await (const _ of res.chunks) { /* drain */ }
    },
    (err: unknown) => {
      assert.ok(err instanceof nRouterError);
      assert.equal((err as nRouterError).kind, 'other');
      assert.equal((err as nRouterError).requestId, 'req-trunc-456');
      assert.ok((err as nRouterError).meta);
      assert.equal((err as nRouterError).meta?.requestId, 'req-trunc-456');
      assert.equal(isRetryable(err), false, 'retrying issues a new billed request, so it must not auto-retry');
      return true;
    },
  );
});

test('an abort error preserves the original custom reason without mutating caller reason (PGSDK-112)', async () => {
  const controller = new AbortController();
  const customReason = new Error('caller cancelled');
  const runner = {
    open: async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'x-nr-request-id': 'req-abort-789' },
      body: (async function* () {
        yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
        controller.abort(customReason);
        // Throw a real runtime AbortError (DOMException) as runtime fetch would
        const abortErr =
          typeof DOMException !== 'undefined'
            ? new DOMException('The operation was aborted', 'AbortError')
            : Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
        throw abortErr;
      })(),
    }),
  };
  const res = await streamChat(runner as never, { model: 'm', prompt: 'x' }, controller.signal);
  await assert.rejects(
    async () => {
      for await (const _ of res.chunks) { /* drain */ }
    },
    (err: unknown) => {
      assert.equal(isAbortError(err), true, 'must be recognised as AbortError');
      assert.equal(isRetryable(err), false, 'an abort is never retryable');
      assert.equal((err as Error).message, 'caller cancelled');
      const cause = (err as Error & { cause?: unknown }).cause;
      assert.ok(cause instanceof Error);
      assert.equal((cause as Error).message, 'caller cancelled');
      assert.equal((cause as Error).name, 'Error');
      assert.equal(customReason.name, 'Error', 'caller reason must not be mutated');
      assert.equal(Object.prototype.propertyIsEnumerable.call(err, 'cause'), false, 'cause must not be enumerable own property');
      assert.equal((err as { requestId?: string }).requestId, 'req-abort-789', 'requestId preserved on abort error');
      return true;
    },
  );
});

test('an abort with structured object reason preserves object in cause (PGSDK-112)', async () => {
  const controller = new AbortController();
  const structuredReason = { code: 'USER_NAVIGATED', view: '/chat' };
  const runner = {
    open: async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: (async function* () {
        yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
        controller.abort(structuredReason);
        throw new Error('stream dropped');
      })(),
    }),
  };
  const res = await streamChat(runner as never, { model: 'm', prompt: 'x' }, controller.signal);
  await assert.rejects(
    async () => {
      for await (const _ of res.chunks) { /* drain */ }
    },
    (err: unknown) => {
      assert.equal(isAbortError(err), true);
      const cause = (err as Error & { cause?: unknown }).cause;
      assert.deepEqual(cause, structuredReason, 'structured object reason preserved in cause');
      return true;
    },
  );
});

test('a retryable in-band nRouterError becomes non-retryable and preserves metadata when signal is aborted (PGSDK-112)', async () => {
  const controller = new AbortController();
  const runner = {
    open: async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'x-nr-request-id': 'req-retry-rate-limit' },
      body: (async function* () {
        // Unterminated event delivered in tail buffer, aborted as body ends
        yield new TextEncoder().encode(
          'event: error\ndata: {"error":{"code":"rate_limit_exceeded","message":"rate limit hit"}}',
        );
        controller.abort();
      })(),
    }),
  };
  const res = await streamChat(runner as never, { model: 'm', prompt: 'x' }, controller.signal);
  await assert.rejects(
    async () => {
      for await (const _ of res.chunks) { /* drain */ }
    },
    (err: unknown) => {
      assert.ok(err instanceof nRouterError, 'must stay inside nRouterError hierarchy');
      assert.equal((err as nRouterError).kind, 'rate_limit', 'must preserve classified kind');
      assert.equal((err as nRouterError).requestId, 'req-retry-rate-limit', 'requestId preserved');
      assert.equal(isRetryable(err), false, 'aborted stream must NOT be retryable even on rate_limit');
      return true;
    },
  );
});

test('a standard abort preserves requestId and metadata without mutating caller signal (PGSDK-112)', async () => {
  const controller = new AbortController();
  const runner = {
    open: async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'x-nr-request-id': 'req-std-abort' },
      body: (async function* () {
        yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
        controller.abort();
        throw new Error('connection severed');
      })(),
    }),
  };
  const res = await streamChat(runner as never, { model: 'm', prompt: 'x' }, controller.signal);
  await assert.rejects(
    async () => {
      for await (const _ of res.chunks) { /* drain */ }
    },
    (err: unknown) => {
      assert.equal(isAbortError(err), true);
      assert.equal((err as { requestId?: string }).requestId, 'req-std-abort');
      assert.equal((err as { status?: number }).status, 200);
      assert.equal(isRetryable(err), false);
      const cause = (err as Error & { cause?: unknown }).cause;
      assert.ok(cause instanceof Error);
      assert.equal((cause as Error).message, 'connection severed');
      assert.equal((controller.signal.reason as { requestId?: unknown })?.requestId, undefined, 'signal.reason must not be mutated');
      assert.equal((controller.signal as { requestId?: unknown }).requestId, undefined, 'signal must not be mutated');
      return true;
    },
  );
});

test('a custom AbortError reason message is preserved on transport failure (PGSDK-112)', async () => {
  const controller = new AbortController();
  const customAbort = new DOMException('custom timeout error', 'AbortError');
  const runner = {
    open: async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: (async function* () {
        yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
        controller.abort(customAbort);
        throw new Error('socket hang up');
      })(),
    }),
  };
  const res = await streamChat(runner as never, { model: 'm', prompt: 'x' }, controller.signal);
  await assert.rejects(
    async () => {
      for await (const _ of res.chunks) { /* drain */ }
    },
    (err: unknown) => {
      assert.equal(isAbortError(err), true);
      assert.equal((err as Error).message, 'custom timeout error', 'custom AbortError message preserved');
      const cause = (err as Error & { cause?: unknown }).cause;
      assert.ok(cause instanceof Error);
      assert.equal((cause as Error).message, 'custom timeout error');
      assert.equal((cause as Error).name, 'AbortError');
      assert.equal((customAbort as { cause?: unknown }).cause, undefined, 'caller custom abort was not mutated');
      return true;
    },
  );
});

test('a standard fetch DOMException abort carries metadata without mutating signal.reason (PGSDK-112)', async () => {
  const controller = new AbortController();
  const runner = {
    open: async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'x-nr-request-id': 'req-fetch-abort' },
      body: (async function* () {
        controller.abort();
        throw controller.signal.reason;
      })(),
    }),
  };
  const res = await streamChat(runner as never, { model: 'm', prompt: 'x' }, controller.signal);
  await assert.rejects(
    async () => {
      for await (const _ of res.chunks) { /* drain */ }
    },
    (err: unknown) => {
      assert.equal(isAbortError(err), true);
      assert.equal((err as { requestId?: string }).requestId, 'req-fetch-abort', 'standard fetch abort carries requestId');
      assert.equal((err as { status?: number }).status, 200, 'standard fetch abort carries status');
      assert.equal(isRetryable(err), false);
      const cause = (err as Error & { cause?: unknown }).cause;
      assert.ok(cause instanceof Error);
      assert.equal((cause as Error).name, 'AbortError');
      assert.equal((controller.signal.reason as { requestId?: unknown })?.requestId, undefined, 'caller signal.reason was not mutated');
      return true;
    },
  );
});

test('an explicit abort during stream drain takes precedence over truncation error (PGSDK-112)', async () => {
  const controller = new AbortController();
  const runner = {
    open: async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: (async function* () {
        yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"chunk"}}]}\n\n');
        controller.abort();
        // Stream terminates normally here without sending [DONE]
      })(),
    }),
  };
  const res = await streamChat(runner as never, { model: 'm', prompt: 'x' }, controller.signal);
  await assert.rejects(
    async () => {
      for await (const _ of res.chunks) { /* drain */ }
    },
    (err: unknown) => {
      assert.equal(isAbortError(err), true, 'caller abort must take precedence over truncation');
      assert.equal(isRetryable(err), false, 'an abort is never retryable');
      return true;
    },
  );
});

test('a DOMException AbortError preserves error name and message in cause (PGSDK-112)', async () => {
  const controller = new AbortController();
  const domErr = new DOMException('The user aborted a request.', 'AbortError');
  const runner = {
    open: async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: (async function* () {
        yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
        controller.abort(domErr);
        throw domErr;
      })(),
    }),
  };
  const res = await streamChat(runner as never, { model: 'm', prompt: 'x' }, controller.signal);
  await assert.rejects(
    async () => {
      for await (const _ of res.chunks) { /* drain */ }
    },
    (err: unknown) => {
      const cause = (err as Error & { cause?: unknown }).cause;
      assert.ok(cause instanceof Error);
      assert.equal((cause as Error).name, 'AbortError');
      assert.equal((cause as Error).message, 'The user aborted a request.');
      assert.equal(isAbortError(err), true);
      assert.equal(isRetryable(err), false);
      assert.equal((domErr as { requestId?: unknown }).requestId, undefined, 'caller DOMException not mutated');
      return true;
    },
  );
});

test('an aborted stream sanitizes leaky cause to prevent Authorization header leak (Rule #5, PGSDK-112)', async () => {
  const controller = new AbortController();
  const leaky: Error & { request?: unknown } = new Error('socket hang up');
  leaky.request = { headers: { authorization: 'Bearer sk-nrouter-secrettail1234' } };

  const runner = {
    open: async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: (async function* () {
        controller.abort();
        throw leaky;
      })(),
    }),
  };
  const res = await streamChat(runner as never, { model: 'm', prompt: 'x' }, controller.signal);
  await assert.rejects(
    async () => {
      for await (const _ of res.chunks) { /* drain */ }
    },
    (err: unknown) => {
      assert.equal(isAbortError(err), true);
      const rendered = inspect(err, { depth: 10 });
      assert.ok(!rendered.includes('secrettail1234'), `secret leaked:\n${rendered}`);
      assert.ok(!rendered.includes('Bearer'), `Bearer leaked:\n${rendered}`);
      return true;
    },
  );
});

test('APIUserAbortError preserves constructor abort name and non-retryability (PGSDK-112)', async () => {
  class APIUserAbortError extends Error {
    constructor() {
      super('Request was aborted.');
      this.name = 'Error'; // OpenAI client leaves name as 'Error'
    }
  }

  const runner = {
    open: async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: (async function* () {
        throw new APIUserAbortError();
      })(),
    }),
  };
  const res = await streamChat(runner as never, { model: 'm', prompt: 'x' });
  await assert.rejects(
    async () => {
      for await (const _ of res.chunks) { /* drain */ }
    },
    (err: unknown) => {
      assert.equal(isAbortError(err), true);
      assert.equal((err as Error).name, 'APIUserAbortError');
      assert.equal(isRetryable(err), false);
      return true;
    },
  );
});

test('transport abort error with generic Error name preserves AbortError name and non-retryability (PGSDK-112)', async () => {
  const runner = {
    open: async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: (async function* () {
        const err = new Error('The user aborted a request.');
        err.name = 'Error';
        (err as any).code = 20;
        throw err;
      })(),
    }),
  };
  const res = await streamChat(runner as never, { model: 'm', prompt: 'x' });
  await assert.rejects(
    async () => {
      for await (const _ of res.chunks) { /* drain */ }
    },
    (err: unknown) => {
      assert.equal(isAbortError(err), true);
      assert.equal((err as Error).name, 'AbortError');
      assert.equal(isRetryable(err), false);
      return true;
    },
  );
});

test('aborting with an nRouterRateLimitError reason preserves nRouterError hierarchy and non-retryability (PGSDK-112)', async () => {
  const controller = new AbortController();
  const callerError = new nRouterRateLimitError('too fast');
  const runner = {
    open: async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: (async function* () {
        controller.abort(callerError);
        throw controller.signal.reason;
      })(),
    }),
  };
  const res = await streamChat(runner as never, { model: 'm', prompt: 'x' }, controller.signal);
  await assert.rejects(
    async () => {
      for await (const _ of res.chunks) { /* drain */ }
    },
    (err: unknown) => {
      assert.ok(err instanceof nRouterRateLimitError, 'preserves nRouterRateLimitError hierarchy');
      assert.equal(isRetryable(err), false, 'wasAborted causes isRetryable to return false');
      assert.equal((callerError as { cause?: unknown }).cause, undefined, 'caller error must not be mutated');
      const cause = (err as Error & { cause?: unknown }).cause;
      assert.ok(cause instanceof Error);
      assert.equal((cause as Error).name, 'AbortError');
      return true;
    },
  );
});

test('in-band nRouterError preserves structured object reason and pre-existing cause chain (PGSDK-112)', async () => {
  const controller = new AbortController();
  const structuredReason = { code: 'CLIENT_ABORT', detail: 'user closed dialog' };
  const upstreamCause = new Error('circuit breaker open');
  const classifiedErr = new nRouterServiceError('upstream unavailable', { cause: upstreamCause });
  const initialCause = classifiedErr.cause;

  const runner = {
    open: async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: (async function* () {
        controller.abort(structuredReason);
        throw classifiedErr;
      })(),
    }),
  };
  const res = await streamChat(runner as never, { model: 'm', prompt: 'x' }, controller.signal);
  await assert.rejects(
    async () => {
      for await (const _ of res.chunks) { /* drain */ }
    },
    (err: unknown) => {
      assert.ok(err instanceof nRouterServiceError);
      assert.equal(isRetryable(err), false);
      assert.equal(classifiedErr.cause, initialCause, 'in-band error cause must not be mutated');
      assert.equal((classifiedErr.cause as Error).message, 'circuit breaker open');
      const marker = (err as Error & { cause?: any }).cause;
      assert.equal(marker?.name, 'AbortError');
      assert.deepEqual(marker?.reason, structuredReason, 'structured reason preserved');
      assert.ok(marker?.cause instanceof Error, 'upstream cause preserved as Error');
      assert.equal((marker?.cause as Error).message, 'circuit breaker open');
      assert.equal((marker?.cause as Error).name, 'Error');
      return true;
    },
  );
});

test('a custom abort message redacts embedded API keys (Rule #5, PGSDK-112)', async () => {
  const controller = new AbortController();
  const runner = {
    open: async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: (async function* () {
        controller.abort(new Error('cancelled token sk-nrouter-leakedsecret123'));
        throw controller.signal.reason;
      })(),
    }),
  };
  const res = await streamChat(runner as never, { model: 'm', prompt: 'x' }, controller.signal);
  await assert.rejects(
    async () => {
      for await (const _ of res.chunks) { /* drain */ }
    },
    (err: unknown) => {
      assert.equal(isAbortError(err), true);
      const rendered = inspect(err, { depth: 10 });
      assert.ok(!rendered.includes('leakedsecret123'), `secret leaked:\n${rendered}`);
      assert.ok((err as Error).message.includes('sk-nrouter-***'), 'token must be masked');
      return true;
    },
  );
});

test('in-band nRouterError with Error abort reason never mutates caller signal.reason and chains causes (PGSDK-112)', async () => {
  const controller = new AbortController();
  const callerError = new Error('caller abort reason');
  const upstreamCause = new Error('upstream failure');
  const classifiedErr = new nRouterServiceError('service failure', { cause: upstreamCause });
  const initialCause = classifiedErr.cause;

  const runner = {
    open: async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: (async function* () {
        controller.abort(callerError);
        throw classifiedErr;
      })(),
    }),
  };
  const res = await streamChat(runner as never, { model: 'm', prompt: 'x' }, controller.signal);
  await assert.rejects(
    async () => {
      for await (const _ of res.chunks) { /* drain */ }
    },
    (err: unknown) => {
      assert.ok(err instanceof nRouterServiceError);
      assert.equal(isRetryable(err), false);
      assert.equal((callerError as { cause?: unknown }).cause, undefined, 'caller error must not be mutated');
      assert.equal(classifiedErr.cause, initialCause, 'in-band error cause must not be mutated');
      assert.equal((classifiedErr.cause as Error).message, 'upstream failure');

      const marker = (err as Error & { cause?: any; reason?: any }).cause;
      assert.equal(marker?.name, 'AbortError');
      assert.ok(marker?.reason instanceof Error, 'abort reason attached to marker.reason');
      assert.equal(marker?.reason?.message, 'caller abort reason');
      assert.ok(marker?.cause instanceof Error, 'upstream cause preserved as cause');
      assert.equal(marker?.cause?.message, 'upstream failure');
      return true;
    },
  );
});

test('structured abort reasons strip sensitive keys case-insensitively and preserve sanitized arrays and nested errors (Rule #5, PGSDK-112)', async () => {
  const controller = new AbortController();
  const sharedTagObj = { name: 'shared-tag-value' };
  const structuredReason = {
    Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThisJWT',
    SECRET: 'topsecret',
    access_token: 'opaque-access-token-1234',
    accessToken: 'camel-access-token-1234',
    client_secret: 'oauth-client-secret-5678',
    clientSecret: 'camel-client-secret-5678',
    auth_token: 'raw-auth-token-9012',
    authToken: 'camel-auth-token-9012',
    refresh_token: 'refresh-token-3456',
    refreshToken: 'camel-refresh-token-3456',
    private_key: 'private-key-material',
    privateKey: 'camel-private-key',
    apiKey: 'camel-api-key',
    session_token: 'sess-token-7890',
    sessionToken: 'camel-session-token',
    requestId: 'req-allowed-1234',
    request_id: 'req-allowed-5678',
    tags: ['allowed-tag', 'key sk-nrouter-leakedarraytoken'],
    counts: [1, 2, 3],
    nestedError: new Error('nested failure sk-nrouter-nestedleak'),
    nestedBearerError: new Error('nested bearer Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.nestedJWTSecret'),
    matrix: [['matrix-item', 'Bearer opaque-matrix-token']],
    abortedAt: new Date('2026-09-08T20:00:00.000Z'),
    refA: sharedTagObj,
    refB: sharedTagObj,
  };

  const runner = {
    open: async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: (async function* () {
        controller.abort(structuredReason);
        throw controller.signal.reason;
      })(),
    }),
  };
  const res = await streamChat(runner as never, { model: 'm', prompt: 'x' }, controller.signal);
  await assert.rejects(
    async () => {
      for await (const _ of res.chunks) { /* drain */ }
    },
    (err: unknown) => {
      assert.equal(isAbortError(err), true);
      const rendered = inspect(err, { depth: 10 });
      assert.ok(!rendered.includes('doNotLeakThisJWT'), `JWT leaked:\n${rendered}`);
      assert.ok(!rendered.includes('nestedJWTSecret'), `nested JWT leaked:\n${rendered}`);
      assert.ok(!rendered.includes('topsecret'), `SECRET leaked:\n${rendered}`);
      assert.ok(!rendered.includes('opaque-access-token-1234'), `access_token leaked:\n${rendered}`);
      assert.ok(!rendered.includes('camel-access-token-1234'), `accessToken leaked:\n${rendered}`);
      assert.ok(!rendered.includes('oauth-client-secret-5678'), `client_secret leaked:\n${rendered}`);
      assert.ok(!rendered.includes('camel-client-secret-5678'), `clientSecret leaked:\n${rendered}`);
      assert.ok(!rendered.includes('raw-auth-token-9012'), `auth_token leaked:\n${rendered}`);
      assert.ok(!rendered.includes('camel-auth-token-9012'), `authToken leaked:\n${rendered}`);
      assert.ok(!rendered.includes('refresh-token-3456'), `refresh_token leaked:\n${rendered}`);
      assert.ok(!rendered.includes('camel-refresh-token-3456'), `refreshToken leaked:\n${rendered}`);
      assert.ok(!rendered.includes('private-key-material'), `private_key leaked:\n${rendered}`);
      assert.ok(!rendered.includes('camel-private-key'), `privateKey leaked:\n${rendered}`);
      assert.ok(!rendered.includes('camel-api-key'), `apiKey leaked:\n${rendered}`);
      assert.ok(!rendered.includes('sess-token-7890'), `session_token leaked:\n${rendered}`);
      assert.ok(!rendered.includes('camel-session-token'), `sessionToken leaked:\n${rendered}`);
      assert.ok(!rendered.includes('leakedarraytoken'), `array token leaked:\n${rendered}`);
      assert.ok(!rendered.includes('nestedleak'), `nested error token leaked:\n${rendered}`);
      assert.ok(!rendered.includes('opaque-matrix-token'), `matrix bearer leaked:\n${rendered}`);
      assert.ok(rendered.includes('sk-nrouter-***'), 'token in array must be masked');
      assert.ok(rendered.includes('allowed-tag'), 'non-sensitive array element preserved');
      assert.ok(rendered.includes('matrix-item'), 'non-sensitive matrix element preserved');
      assert.ok(rendered.includes('2026-09-08T20:00:00.000Z'), 'Date serialized as ISO string');
      const cause = (err as Error & { cause?: Record<string, any> }).cause;
      assert.equal(cause?.refA?.name, 'shared-tag-value');
      assert.equal(cause?.refB?.name, 'shared-tag-value', 'repeated reference preserved across siblings');
      assert.equal(cause?.requestId, 'req-allowed-1234', 'requestId preserved');
      assert.equal(cause?.request_id, 'req-allowed-5678', 'request_id preserved');
      return true;
    },
  );
});

test('top-level array and Date abort reasons are sanitized without object corruption (PGSDK-112)', async () => {
  // Test top-level array
  const controllerArray = new AbortController();
  const runnerArray = {
    open: async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: (async function* () {
        controllerArray.abort(['top-item', 'Bearer secret-bearer-token', 'sk-nrouter-leakedarray3']);
        throw controllerArray.signal.reason;
      })(),
    }),
  };
  const resArray = await streamChat(runnerArray as never, { model: 'm', prompt: 'x' }, controllerArray.signal);
  await assert.rejects(
    async () => {
      for await (const _ of resArray.chunks) { /* drain */ }
    },
    (err: unknown) => {
      assert.equal(isAbortError(err), true);
      const cause = (err as Error & { cause?: unknown }).cause;
      assert.ok(Array.isArray(cause), 'top-level array preserved as Array');
      assert.equal((cause as any[])[0], 'top-item');
      assert.equal((cause as any[])[1], 'Bearer [REDACTED]');
      assert.equal((cause as any[])[2], 'sk-nrouter-***');
      return true;
    },
  );

  // Test top-level Date
  const controllerDate = new AbortController();
  const dateVal = new Date('2026-09-08T21:00:00.000Z');
  const runnerDate = {
    open: async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: (async function* () {
        controllerDate.abort(dateVal);
        throw controllerDate.signal.reason;
      })(),
    }),
  };
  const resDate = await streamChat(runnerDate as never, { model: 'm', prompt: 'x' }, controllerDate.signal);
  await assert.rejects(
    async () => {
      for await (const _ of resDate.chunks) { /* drain */ }
    },
    (err: unknown) => {
      assert.equal(isAbortError(err), true);
      const cause = (err as Error & { cause?: unknown }).cause;
      assert.equal(cause, '2026-09-08T21:00:00.000Z', 'top-level Date serialized as ISO string');
      return true;
    },
  );
});

test('cloneNRouterError preserves non-enumerable requestId, status, and meta on aborted stream (PGSDK-112)', async () => {
  const controller = new AbortController();
  const runner = {
    open: async () => ({
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'x-nr-request-id': 'req-runner-header-ignore',
        'x-nr-model': 'runner-model-ignore',
      },
      body: (async function* () {
        controller.abort(new Error('client canceled mid-flight'));
        const err = new nRouterServiceError('gateway error', {
          requestId: 'req-clone-1234',
          status: 503,
          meta: { model: 'gpt-4o', provider: 'azure' },
        });
        Object.defineProperty(err, 'customNonEnum', {
          value: 'preserved-custom-marker',
          writable: true,
          enumerable: false,
          configurable: true,
        });
        throw err;
      })(),
    }),
  };
  const res = await streamChat(runner as never, { model: 'm', prompt: 'x' }, controller.signal);
  await assert.rejects(
    async () => {
      for await (const _ of res.chunks) { /* drain */ }
    },
    (err: unknown) => {
      assert.ok(err instanceof nRouterServiceError);
      assert.equal((err as nRouterServiceError).requestId, 'req-clone-1234', 'requestId preserved on clone from err');
      assert.equal((err as nRouterServiceError).status, 503, 'status preserved on clone from err');
      assert.equal((err as nRouterServiceError).meta?.model, 'gpt-4o', 'meta preserved on clone from err');
      assert.equal((err as any).customNonEnum, 'preserved-custom-marker', 'custom non-enumerable property preserved on clone');
      assert.equal(isRetryable(err), false);
      return true;
    },
  );
});

test('sanitizeStructuredReason preserves nested objects up to depth limit without premature doubling (PGSDK-112)', async () => {
  const controller = new AbortController();
  // Nesting 5 levels deep: obj.l1.l2.l3.l4.deepProperty
  const nestedReason = {
    l1: {
      l2: {
        l3: {
          l4: {
            deepProperty: 'deepVal',
          },
        },
      },
    },
  };
  const runner = {
    open: async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: (async function* () {
        controller.abort(nestedReason);
        throw controller.signal.reason;
      })(),
    }),
  };
  const res = await streamChat(runner as never, { model: 'm', prompt: 'x' }, controller.signal);
  await assert.rejects(
    async () => {
      for await (const _ of res.chunks) { /* drain */ }
    },
    (err: unknown) => {
      assert.equal(isAbortError(err), true);
      const cause = (err as Error & { cause?: any }).cause;
      assert.ok(cause?.l1?.l2?.l3?.l4?.deepProperty, 'level 4 nested object preserved');
      assert.equal(cause.l1.l2.l3.l4.deepProperty, 'deepVal');
      return true;
    },
  );
});

test('un-aborted stream failures with non-Error throws are wrapped as transportError not AbortError (PGSDK-112)', async () => {
  const runner = {
    open: async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: (async function* () {
        throw 'raw socket dropped string';
      })(),
    }),
  };
  const res = await streamChat(runner as never, { model: 'm', prompt: 'x' });
  await assert.rejects(
    async () => {
      for await (const _ of res.chunks) { /* drain */ }
    },
    (err: unknown) => {
      assert.equal(isAbortError(err), false, 'non-abort string throw must not be classified as AbortError');
      assert.ok(err instanceof nRouterError, 'wrapped in nRouterError');
      assert.ok((err as Error).message.includes('raw socket dropped string'));
      return true;
    },
  );
});

test('empty error abort reason falls back to default message rather than empty string (PGSDK-112)', async () => {
  const controller = new AbortController();
  const runner = {
    open: async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: (async function* () {
        controller.abort(new Error(''));
        throw controller.signal.reason;
      })(),
    }),
  };
  const res = await streamChat(runner as never, { model: 'm', prompt: 'x' }, controller.signal);
  await assert.rejects(
    async () => {
      for await (const _ of res.chunks) { /* drain */ }
    },
    (err: unknown) => {
      assert.equal(isAbortError(err), true);
      assert.equal((err as Error).message, 'the request was aborted');
      return true;
    },
  );
});


// HTTP header names are case-insensitive on the wire, and a hand-written
// runner returning a plain object reasonably spells it `Retry-After`. An exact
// lowercase lookup missed it, so the caller retried immediately against the
// limit that had just refused them.
test('Retry-After is found whatever case the runner spells it in', async () => {
  for (const spelling of ['retry-after', 'Retry-After', 'RETRY-AFTER']) {
    const runner = {
      open: async () => ({
        status: 429,
        headers: { 'content-type': 'application/json', [spelling]: '42' },
        body: null,
        text: async () => JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'slow' } }),
      }),
    };
    await assert.rejects(
      () => streamChat(runner as never, { model: 'm', prompt: 'x' }),
      (err: unknown) => {
        assert.equal((err as { retryAfter?: number | null }).retryAfter, 42, `spelling: ${spelling}`);
        return true;
      },
    );
  }
});

// errors.ts already treats TimeoutError and APIUserAbortError as aborts. This
// exported helper recognised only 'AbortError', so the same package answered
// two different things about the same cancellation and a caller using this one
// to decide whether to retry took the wrong branch.
test('isAbortError knows every name a runtime gives a cancellation', () => {
  for (const name of ['AbortError', 'TimeoutError', 'APIUserAbortError']) {
    const err = new Error('cancelled');
    err.name = name;
    assert.equal(isAbortError(err), true, `should recognise ${name}`);
  }
  const other = new Error('ECONNRESET');
  other.name = 'TypeError';
  assert.equal(isAbortError(other), false, 'must not swallow a real failure');
});

// ---------------------------------------------------------------------------
// THE ANTHROPIC WIRE, STREAMED — and the missing usage opt-in.
//
// Two defects, both measured, both silent:
//
//  1. `streamChat` hardcoded `/chat/completions`. The gateway declares
//     `chat_completions: None` for Anthropic and Bedrock, so `nr.stream()`
//     404'd on every Claude id in a package whose own keywords advertise them.
//
//  2. Anthropic's Messages stream has NO `data: [DONE]` sentinel — it ends on
//     `event: message_stop`. Reaching the end of the body without `[DONE]` is
//     this module's truncation refusal, so even once the path was right every
//     COMPLETE Claude stream would end by throwing "the answer is truncated"
//     over an answer that was whole.
//
//  3. (P1) The playground sends `stream_options: {include_usage: true}` on
//     every OpenAI stream and writes down why: the gateway injects it for
//     credit settlement, but a client that depends on that injection shows `-`
//     for every token count the day a rebuilt payload drops the usage chunk.
//     This SDK sent it nowhere. It must NOT go to Anthropic, which rejects the
//     key outright — "stream_options: Extra inputs are not permitted" is a
//     live 400 the app recorded.
// ---------------------------------------------------------------------------

/** The Anthropic Messages SSE sequence for a complete two-token answer. */
const ANTHROPIC_STREAM = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":9}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

test('a streamed Claude request opens /messages with a translated body', async () => {
  const runner = chunkRunner(ANTHROPIC_STREAM);
  const result = await streamChat(runner, {
    model: 'claude-sonnet-4-5',
    systemPrompt: 'be brief',
    prompt: 'hi',
  });
  await result.text();

  assert.equal(runner.seen.path, '/messages');
  const body = runner.seen.body as any;
  assert.equal(body.stream, true);
  assert.equal(body.system, 'be brief', 'system must leave `messages`');
  assert.equal(body.max_tokens, 1024, 'Anthropic requires max_tokens');
  assert.equal(
    body.stream_options,
    undefined,
    'Anthropic 400s on stream_options: "Extra inputs are not permitted"',
  );
});

test('message_stop ends a Claude stream WITHOUT the truncation refusal', async () => {
  const runner = chunkRunner(ANTHROPIC_STREAM);
  const result = await streamChat(runner, { model: 'claude-sonnet-4-5', prompt: 'hi' });
  // The empty-box case: tokens billed, nothing rendered.
  assert.equal(await result.text(), 'Hello');
});

test('response.completed ends a Responses stream WITHOUT the truncation refusal', async () => {
  const runner = chunkRunner([
    'data: {"choices":[{"text":"Hello completions"}]}\n\n',
    'data: {"type":"response.completed"}\n\n',
  ]);
  const result = await streamChat(runner, { model: 'gpt-4o', prompt: 'hi' });
  assert.equal(await result.text(), 'Hello completions');
});

test('a Claude stream cut before message_stop is still reported as truncated', async () => {
  // The refusal must narrow to Anthropic's real terminator, not disappear:
  // a dropped upstream still hands back a partial answer that reads as whole.
  const runner = chunkRunner(ANTHROPIC_STREAM.slice(0, 3));
  const result = await streamChat(runner, { model: 'claude-sonnet-4-5', prompt: 'hi' });
  const err = await rejection(result.text());
  assert.ok(err instanceof nRouterError);
  assert.match(err.message, /truncated/);
  assert.equal(err.code, 'stream_truncated', 'must carry stream_truncated code');
  assert.equal(isRetryable(err), false);
});

test('an OpenAI stream asks for the usage chunk it would otherwise never get', async () => {
  const runner = chunkRunner([frame('hi'), 'data: [DONE]\n\n']);
  const result = await streamChat(runner, { model: 'gpt-4o-mini', prompt: 'hi' });
  await result.text();

  assert.equal(runner.seen.path, '/chat/completions');
  assert.deepEqual((runner.seen.body as any).stream_options, { include_usage: true });
});

test('a caller-supplied stream_options is never overwritten', async () => {
  // `extra` is the escape hatch for a gateway or provider field this SDK does
  // not model. Stamping our default over it would make the hatch a lie.
  const runner = chunkRunner([frame('hi'), 'data: [DONE]\n\n']);
  const result = await streamChat(runner, {
    model: 'gpt-4o-mini',
    prompt: 'hi',
    extra: { stream_options: { include_usage: false } },
  });
  await result.text();
  assert.deepEqual((runner.seen.body as any).stream_options, { include_usage: false });
});

test('n > 1 on a streamed Claude request is refused before the socket opens', async () => {
  const runner = chunkRunner(ANTHROPIC_STREAM);
  const err = await rejection(
    streamChat(runner, { model: 'claude-sonnet-4-5', prompt: 'hi', extra: { n: 3 } }),
  );
  assert.equal(err.name, 'nRouterConfigurationError');
  assert.equal(isRetryable(err), false);
  assert.equal(runner.seen.path, undefined, 'the refusal must precede the billed call');
});

test('an in-band Anthropic error frame still cuts the stream', async () => {
  // `message_stop` must not be read so eagerly that the guardrail cut ahead of
  // it is skipped — that frame is the only signal the answer was withheld.
  const runner = chunkRunner([
    ANTHROPIC_STREAM[0],
    ANTHROPIC_STREAM[1],
    'event: error\ndata: {"type":"error","error":{"type":"guardrail_blocked","message":"withheld"}}\n\n',
    ANTHROPIC_STREAM[4],
  ]);
  const result = await streamChat(runner, { model: 'claude-sonnet-4-5', prompt: 'hi' });
  const err = await rejection(result.text());
  assert.equal(err.name, 'nRouterGuardrailBlockedError');
});

// ---------------------------------------------------------------------------
// PGSDK-116 — an explicit `error: null` is NOT an in-band error.
// ---------------------------------------------------------------------------

test('a frame carrying an explicit error: null is content, not an in-band error', async () => {
  // Some upstreams stamp `"error": null` on every chunk. `!== undefined` takes
  // the error branch on it and discards a billed answer mid-flight.
  const withNullError =
    `data: ${JSON.stringify({ error: null, choices: [{ delta: { content: 'hi' } }] })}\n\n`;
  const result = await streamChat(chunkRunner([withNullError, DONE]), { model: 'm', prompt: 'hi' });
  assert.equal(await result.text(), 'hi');
});

test('a frame carrying an explicit error: false is content, not an in-band error', async () => {
  // `false != null` is TRUE in JavaScript, so the nullish guard took the error
  // branch on a frame that reported NO error, discarding a billed answer
  // mid-flight and handing the caller the whole raw frame as the message.
  const withFalseError =
    `data: ${JSON.stringify({ error: false, choices: [{ delta: { content: 'hi' } }] })}\n\n`;
  const result = await streamChat(chunkRunner([withFalseError, DONE]), { model: 'm', prompt: 'hi' });
  assert.equal(await result.text(), 'hi');
});

test('a frame carrying a REAL error object still stops the stream', async () => {
  const withError =
    `data: ${JSON.stringify({ error: { type: 'guardrail_blocked', message: 'denied' } })}\n\n`;
  const result = await streamChat(chunkRunner([withError, DONE]), { model: 'm', prompt: 'hi' });
  const err = await rejection(result.text());
  assert.ok(err instanceof nRouterError, `expected a typed error, got ${inspect(err)}`);
});

// ---------------------------------------------------------------------------
// PGSDK-117 — usage / finishReason / toolCalls, normalized across both wires.
// ---------------------------------------------------------------------------

test('usage(), finishReason() and toolCalls() read the OPENAI wire', async () => {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'hel' } }] })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"city":' } }] } }],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }, finish_reason: 'tool_calls' }],
    })}\n\n`,
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })}\n\n`,
    DONE,
  ];
  const result = await streamChat(chunkRunner(frames), { model: 'm', prompt: 'hi' });
  await result.text();

  assert.deepEqual(await result.usage(), { promptTokens: 11, completionTokens: 7, totalTokens: 18 });
  assert.equal(await result.finishReason(), 'tool_calls');
  assert.deepEqual(await result.toolCalls(), [
    { id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
  ]);
});

test('OPENAI tool-call fragments that omit index join ONE call, never shard', async () => {
  // Some OpenAI-compatible upstreams omit `index` entirely. The fallback was
  // `state.toolCalls.size`, which is 0 for the first fragment and 1 for the
  // second — so ONE call's arguments landed in two slots as two un-parseable
  // halves, the second with a null id and a null name. A caller cannot invoke
  // that, and `JSON.parse` on either half throws.
  const frames = [
    `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ id: 'call_1', function: { name: 'get_weather', arguments: '{"city":' } }] } }],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ function: { arguments: '"Paris"}' } }] }, finish_reason: 'tool_calls' }],
    })}\n\n`,
    DONE,
  ];
  const result = await streamChat(chunkRunner(frames), { model: 'm', prompt: 'hi' });
  await result.text();

  assert.deepEqual(await result.toolCalls(), [
    { id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
  ]);
});

test('an unindexed fragment carrying a NEW id opens the NEXT tool-call slot', async () => {
  // Joining is only correct for fragments of the SAME call. Without an index
  // the id is the one boundary the wire gives us, so a fragment announcing a
  // different id must not be concatenated onto the previous call's arguments.
  const frames = [
    `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ id: 'call_1', function: { name: 'a', arguments: '{"x":1}' } }] } }],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ id: 'call_2', function: { name: 'b', arguments: '{"y":2}' } }] } }],
    })}\n\n`,
    DONE,
  ];
  const result = await streamChat(chunkRunner(frames), { model: 'm', prompt: 'hi' });
  await result.text();

  assert.deepEqual(await result.toolCalls(), [
    { id: 'call_1', name: 'a', arguments: '{"x":1}' },
    { id: 'call_2', name: 'b', arguments: '{"y":2}' },
  ]);
});

test('usage(), finishReason() and toolCalls() read the ANTHROPIC wire', async () => {
  const frames = [
    `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 11 } } })}\n\n`,
    `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather' } })}\n\n`,
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city":' } })}\n\n`,
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"Paris"}' } })}\n\n`,
    `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } })}\n\n`,
    `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ];
  const result = await streamChat(chunkRunner(frames), { model: 'm', prompt: 'hi' });
  await result.text();

  assert.deepEqual(await result.usage(), { promptTokens: 11, completionTokens: 7, totalTokens: 18 });
  assert.equal(await result.finishReason(), 'tool_use');
  assert.deepEqual(await result.toolCalls(), [
    { id: 'toolu_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
  ]);
});

test('a stream that reported no usage says null, never zero', async () => {
  const result = await streamChat(chunkRunner([frame('hi'), DONE]), { model: 'm', prompt: 'hi' });
  await result.text();
  assert.equal(await result.usage(), null, 'zero tokens would be a measurement we never took');
  assert.equal(await result.finishReason(), null);
  assert.deepEqual(await result.toolCalls(), []);
});

// ---------------------------------------------------------------------------
// Review round — the four sentinels, the placeholder count, and the two
// unindexed fragment paths.
// ---------------------------------------------------------------------------

test('a frame carrying an explicit error: 0 is content, not an in-band error', async () => {
  // `0` is the THIRD way an upstream says "no error on this chunk" (errno 0),
  // and `0 != null && 0 !== false` is TRUE, so the sentinel guard cut a billed
  // stream on a frame that reported success.
  const withZeroError =
    `data: ${JSON.stringify({ error: 0, choices: [{ delta: { content: 'hi' } }] })}\n\n`;
  const result = await streamChat(chunkRunner([withZeroError, DONE]), { model: 'm', prompt: 'hi' });
  assert.equal(await result.text(), 'hi');
});

test('a frame carrying an explicit empty error string is content, not an in-band error', async () => {
  // The FOURTH sentinel: an empty `error` string carries no verdict to report,
  // so building an error from it discards a paid-for answer and hands the
  // caller a message with nothing in it.
  const withEmptyError =
    `data: ${JSON.stringify({ error: '', choices: [{ delta: { content: 'hi' } }] })}\n\n`;
  const result = await streamChat(chunkRunner([withEmptyError, DONE]), { model: 'm', prompt: 'hi' });
  assert.equal(await result.text(), 'hi');
});

test("a REAL error carried as a non-empty STRING still stops the stream", async () => {
  // The positive control for the two tests above: narrowing the sentinel set
  // must not stop a genuine error being reported.
  const withError = `data: ${JSON.stringify({ error: 'guardrail_blocked' })}\n\n`;
  const result = await streamChat(chunkRunner([withError, DONE]), { model: 'm', prompt: 'hi' });
  const err = await rejection(result.text());
  assert.ok(err instanceof nRouterError, `expected a typed error, got ${inspect(err)}`);
});

test("Anthropic message_start's placeholder output_tokens is not a completion count", async () => {
  // Anthropic's `message_start` carries `usage: {input_tokens: N,
  // output_tokens: 1}` — the 1 is a placeholder, not a measurement. Recorded,
  // a stream whose `message_delta` never arrives reports completionTokens: 1
  // instead of null: a confident wrong figure where we took no reading.
  const frames = [
    `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 11, output_tokens: 1 } } })}\n\n`,
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } })}\n\n`,
    `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })}\n\n`,
    `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ];
  const result = await streamChat(chunkRunner(frames), { model: 'm', prompt: 'hi' });
  await result.text();

  assert.deepEqual(await result.usage(), {
    promptTokens: 11,
    completionTokens: null,
    totalTokens: null,
  });
});

test("Anthropic message_delta's output_tokens IS still recorded", async () => {
  // The positive control: ignoring the message_start placeholder must not
  // discard the real figure the terminal frame reports.
  const frames = [
    `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 11, output_tokens: 1 } } })}\n\n`,
    `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } })}\n\n`,
    `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ];
  const result = await streamChat(chunkRunner(frames), { model: 'm', prompt: 'hi' });
  await result.text();

  assert.deepEqual(await result.usage(), { promptTokens: 11, completionTokens: 7, totalTokens: 18 });
});

test('an unindexed fragment carrying an id opens the NEXT slot even when the open one has none', async () => {
  // The open slot's id being null does not make the next id the SAME call's:
  // it means the wire never named the open call. Joining across that boundary
  // concatenates two calls into one un-parseable argument string and renames
  // the first call to the second's name.
  const frames = [
    `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ function: { name: 'a', arguments: '{"x":1}' } }] } }],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ id: 'call_2', function: { name: 'b', arguments: '{"y":2}' } }] } }],
    })}\n\n`,
    DONE,
  ];
  const result = await streamChat(chunkRunner(frames), { model: 'm', prompt: 'hi' });
  await result.text();

  assert.deepEqual(await result.toolCalls(), [
    { id: null, name: 'a', arguments: '{"x":1}' },
    { id: 'call_2', name: 'b', arguments: '{"y":2}' },
  ]);
});

test('an unindexed input_json_delta joins the block that opened, never vanishes', async () => {
  // `content_block_start` already falls back to a slot when the wire omits
  // `index`; the delta branch required one, so every argument fragment of an
  // unindexed block was dropped in silence — a tool call with a name and no
  // arguments, which reads as a call that took none.
  const frames = [
    `data: ${JSON.stringify({ type: 'content_block_start', content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather' } })}\n\n`,
    `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"city":' } })}\n\n`,
    `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '"Paris"}' } })}\n\n`,
    `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ];
  const result = await streamChat(chunkRunner(frames), { model: 'm', prompt: 'hi' });
  await result.text();

  assert.deepEqual(await result.toolCalls(), [
    { id: 'toolu_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
  ]);
});

test('an input_json_delta for a block that never STARTED is still dropped', async () => {
  // The positive control for the fallback above: joining onto "whatever was
  // opened last" must not invent a slot when nothing opened at all.
  const frames = [
    `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"city":"Paris"}' } })}\n\n`,
    `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ];
  const result = await streamChat(chunkRunner(frames), { model: 'm', prompt: 'hi' });
  await result.text();

  assert.deepEqual(await result.toolCalls(), []);
});
