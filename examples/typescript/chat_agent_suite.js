#!/usr/bin/env node
/**
 * Mock-gateway certification for examples/typescript/chat-agent.
 *
 * The example under test spends real money against a real gateway, which makes
 * it exactly the kind of code nobody exercises in CI. So the gateway is stood
 * up locally instead: a `node:http` server that speaks the four TEXT wires the
 * chat loop uses — buffered, streamed, repeated and free — and stamps the same
 * `x-nr-*` headers a real one does.
 *
 * Every assertion below is about a property that costs money if it is wrong.
 * The three that no single-wire suite can reach:
 *
 *  - a STREAMED call reports `unpriced` with no amount BY DESIGN, so it must be
 *    counted as streamed and settled server-side — never as an unpriceable
 *    model, and never summed. Run 5 sends a stream that DOES carry an exact
 *    cost, which today's gateway does not do, precisely so that "excluded by
 *    construction" is a tested property rather than an accident of the fixture.
 *  - a FREE call (`count_tokens`) reports no cost header, and THERE that
 *    absence means zero. Folding it into the unpriced bucket reports a healthy
 *    session as incomplete.
 *  - a cache HIT is a served, BILLED response. The mock prices the hit
 *    differently from the miss so a summation that credited the wrong call
 *    cannot still produce the right total.
 *
 * No network, no key, no credits. Runs in a few seconds.
 *
 *   node examples/typescript/chat_agent_suite.js
 *
 * Requires the JS SDK to be built first (the example imports its dist):
 *
 *   (cd sdks/js && npm run build)
 */

// COMMONJS, in a `.js` file, deliberately — the same shape as every sibling
// suite in this directory, and what `tests/demo-e2e-record.test.sh` invokes.
// That is only safe because NO `package.json` exists at the repository root,
// at `examples/`, or at `examples/typescript/`. Adding one anywhere on that
// path with `"type": "module"` would break `require` and `__dirname` here and
// in every sibling suite at once; if that ever becomes desirable, rename all
// of them to `.cjs` together rather than one at a time.
'use strict';

const http = require('node:http');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const EXAMPLE = path.resolve(__dirname, 'chat-agent', 'chat-agent.mjs');
const SDK_DIST = path.resolve(__dirname, '..', '..', 'sdks', 'js', 'dist', 'index.mjs');

// The mock's price list. Deliberately FIVE different numbers: a single shared
// cost would let a summation bug that counted the wrong call still produce the
// right total. `cacheHit` differs from `chat` for exactly that reason — the two
// are the same wire and the same body, so only the amount can tell them apart.
const COST = {
  messages: 0.003120,
  chat: 0.001210,
  responses: 0.000470,
  cacheHit: 0.000190,
  stream: 0.000777, // only ever sent in run 5, and never summed
};

// `x-nr-latency-ms` — what the GATEWAY measured, as opposed to what the client
// timed around its own call. Distinct per wire for the same reason the costs
// are: a record that copied the wrong call's latency would still assert green.
const GATEWAY_MS = {
  messages: 640,
  chat: 305,
  responses: 412,
  stream: 88,
  cache: 12,
  count: 7,
};

const CACHE_AGE_SECONDS = 34;

// USD per MILLION tokens, handed to the example as the operator's own rates.
// Deliberately not round and not equal, so a recomputation that swapped the two
// counters, or dropped one, produces a different number.
const RATE_IN_PER_MTOK = 0.4;
const RATE_OUT_PER_MTOK = 1.6;
const STREAM_INPUT_TOKENS = 55;
const STREAM_OUTPUT_TOKENS = 25;

// What the gateway SETTLED a streamed call at, server-side. Deliberately NOT
// equal to the client-side recompute (55/1e6*0.4 + 25/1e6*1.6 = $0.000062):
// a settled figure that matched the estimate exactly could not tell a real
// read-back from an example that just echoed its own arithmetic back.
const SETTLED_STREAM_USD = 0.000071;

// A shaped placeholder, never a key: the mock only checks the `sk-nrouter-` prefix.
const DEMO_KEY = `sk-nrouter-${'chatagentsuite'.padEnd(38, '0')}`;

/**
 * A gateway that bills.
 *
 * Options, each one a real gateway state this example must read correctly:
 *
 *   unpriceResponses    the /v1/responses call answers `unpriced` with NO cost
 *                       header — the real shape for a model the gateway cannot
 *                       price. It is never a `0` on the wire.
 *   refuseChatWith429   the first buffered chat call answers 429 carrying
 *                       `x-nr-limit-source`, which names the limit that
 *                       measured it.
 *   cacheDisabled       the deployment never opted into response caching, so
 *                       NO `x-nr-response-cache` header is sent at all and
 *                       `meta.responseCache` is null. This is the default state
 *                       of a plane that has not consented; it is not a miss.
 *   omitStreamUsage     no final usage frame, so the streamed call reports no
 *                       token counts anywhere.
 *   omitStreamLatency   no `x-nr-latency-ms` on the stream. Absent is null,
 *                       never 0.
 *   streamCarriesCost   the stream's HEADERS carry `exact` and an amount.
 *                       Today's gateway cannot do this; the example must still
 *                       refuse to sum it.
 */
function startMock(options = {}) {
  const {
    unpriceResponses = false,
    refuseChatWith429 = false,
    cacheDisabled = false,
    dropChatConnection = false,
    omitStreamUsage = false,
    omitStreamLatency = false,
    streamCarriesCost = false,
  } = options;

  let requests = 0;
  let expectedPricedTotal = 0;
  const seenChatBodies = new Set();
  // requestId -> the spend row the DASHBOARD mock will serve for it. The
  // gateway records what it settled; the dashboard hands it back. That split is
  // the point: a streamed call's figure exists only here, never in the
  // response the client saw.
  const ledger = new Map();
  const counts = {
    messages: 0,
    chatCompletionsBuffered: 0,
    chatCompletionsStreamed: 0,
    responses: 0,
    countTokens: 0,
    cacheHits: 0,
    cacheMisses: 0,
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const auth = req.headers['authorization'] || '';
      if (!auth.startsWith('Bearer sk-nrouter-')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'unauthorized' } }));
        return;
      }

      requests += 1;
      const requestId = `req-chat-${requests}`;
      const url = (req.url || '').split('?')[0];
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body = {};
      try {
        body = JSON.parse(rawBody || '{}');
      } catch {
        body = {};
      }

      // ------------------------------------------------------ /v1/messages
      // The Anthropic wire. The gateway serves Anthropic here and NOWHERE
      // else, so a run that reached /v1/chat/completions with a Claude id
      // would be a documented 404 for a real customer.
      // nrouter-doc-wire: messages
      if (url === '/v1/messages') {
        counts.messages += 1;
        expectedPricedTotal += COST.messages;
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-nr-request-id': requestId,
          'x-nr-model': 'mock-claude-1',
          'x-nr-request-cost': COST.messages.toFixed(6),
          'x-nr-cost-status': 'exact',
          'x-nr-latency-ms': String(GATEWAY_MS.messages),
          'x-nr-guardrails': 'pass',
          'x-nr-input-tokens': '55',
          'x-nr-output-tokens': '25',
          'x-nr-total-tokens': '80',
        });
        ledger.set(requestId, {
          call_type: 'messages',
          model: 'mock-claude-1',
          spend: COST.messages,
          cost_status: 'exact',
          prompt_tokens: 55,
          completion_tokens: 25,
          stream: false,
        });
        res.end(
          JSON.stringify({
            id: `msg-chat-${counts.messages}`,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: `Mock messages reply ${counts.messages}.` }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 55, output_tokens: 25 },
          }),
        );
        return;
      }

      // ---------------------------------------------- /v1/messages/count_tokens
      // FREE. No cost header and no cost status: here, absence means ZERO.
      if (url === '/v1/messages/count_tokens') {
        counts.countTokens += 1;
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-nr-request-id': requestId,
          'x-nr-model': 'mock-claude-1',
          'x-nr-latency-ms': String(GATEWAY_MS.count),
        });
        res.end(JSON.stringify({ input_tokens: 61 }));
        return;
      }

      // ----------------------------------------------------- /v1/responses
      if (url === '/v1/responses') {
        counts.responses += 1;
        const headers = {
          'content-type': 'application/json',
          'x-nr-request-id': requestId,
          'x-nr-model': 'mock-responses-1',
          'x-nr-cost-status': unpriceResponses ? 'unpriced' : 'exact',
          'x-nr-latency-ms': String(GATEWAY_MS.responses),
          'x-nr-guardrails': 'pass',
          'x-nr-input-tokens': '40',
          'x-nr-output-tokens': '18',
          'x-nr-total-tokens': '58',
        };
        // ABSENT, not zero, when unpriced.
        if (!unpriceResponses) {
          headers['x-nr-request-cost'] = COST.responses.toFixed(6);
          expectedPricedTotal += COST.responses;
        }
        ledger.set(requestId, {
          call_type: 'responses',
          model: 'mock-responses-1',
          // NULL when unpriced, never 0 — the spend row and the response header
          // agree about that, which is the invariant under test.
          spend: unpriceResponses ? null : COST.responses,
          cost_status: unpriceResponses ? 'unpriced' : 'exact',
          prompt_tokens: 40,
          completion_tokens: 18,
          stream: false,
        });
        res.writeHead(200, headers);
        res.end(
          JSON.stringify({
            id: `resp-chat-${counts.responses}`,
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: `Mock responses reply ${counts.responses}.` }],
              },
            ],
            usage: { input_tokens: 40, output_tokens: 18, total_tokens: 58 },
          }),
        );
        return;
      }

      // ---------------------------------------------- /v1/chat/completions
      if (url === '/v1/chat/completions') {
        if (body.stream === true) {
          counts.chatCompletionsStreamed += 1;
          const headers = {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'x-nr-request-id': requestId,
            'x-nr-model': 'mock-chat-1',
            // A STREAM'S COST HEADERS ARE WRITTEN BEFORE THE FIRST TOKEN
            // EXISTS. `unpriced` with no amount is the permanent, correct state
            // for the response — not a race to re-read later.
            'x-nr-cost-status': streamCarriesCost ? 'exact' : 'unpriced',
            // Guardrails ARE reported on a stream. Its absence would read as
            // "no guardrail applied", which is the explicit `none`, not null.
            'x-nr-guardrails': 'pass',
          };
          // BYPASS, not miss. A cache stores a complete response; a stream is
          // relayed as it is produced, so it is never a cache candidate at all.
          if (!cacheDisabled) headers['x-nr-response-cache'] = 'bypass';
          if (streamCarriesCost) headers['x-nr-request-cost'] = COST.stream.toFixed(6);
          if (!omitStreamLatency) headers['x-nr-latency-ms'] = String(GATEWAY_MS.stream);
          // THE FIGURE THE RESPONSE NEVER CARRIES. It exists only on the spend
          // row, which is why the join is the only way a client ever sees it.
          ledger.set(requestId, {
            call_type: 'chat_completions',
            model: 'mock-chat-1',
            spend: SETTLED_STREAM_USD,
            cost_status: 'exact',
            prompt_tokens: STREAM_INPUT_TOKENS,
            completion_tokens: STREAM_OUTPUT_TOKENS,
            stream: true,
          });
          res.writeHead(200, headers);

          const frames = [
            { choices: [{ index: 0, delta: { role: 'assistant' } }] },
            { choices: [{ index: 0, delta: { content: 'Mock streamed ' } }] },
            { choices: [{ index: 0, delta: { content: 'reply.' } }] },
          ];
          if (!omitStreamUsage) {
            // The final usage frame the gateway asks the provider for via
            // `stream_options: { include_usage: true }`. It is the ONLY place
            // a streamed call's token counts appear — the headers carry none.
            frames.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
            // THE TERMINAL USAGE FRAME, WITH AN EMPTY `choices` ARRAY. The
            // gateway forces `stream_options.include_usage` on this wire, so
            // this frame always arrives — and a reader that indexes
            // `choices[0]` to find the usage throws on it.
            frames.push({ choices: [], usage: { prompt_tokens: 55, completion_tokens: 25, total_tokens: 80 } });
          } else {
            frames.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
          }
          for (const frame of frames) {
            res.write(`data: ${JSON.stringify(frame)}\n\n`);
          }
          res.end('data: [DONE]\n\n');
          return;
        }

        // NO ANSWER AT ALL. The socket dies with the request already delivered,
        // which is the shape of a transport failure or a timeout: the gateway
        // may well have received it and billed it, and the client cannot know.
        // This is the ONLY way to produce `sentToGateway: null`.
        if (dropChatConnection && counts.chatCompletionsBuffered === 0) {
          counts.chatCompletionsBuffered += 1;
          req.socket.destroy();
          return;
        }

        if (refuseChatWith429 && counts.chatCompletionsBuffered === 0) {
          counts.chatCompletionsBuffered += 1;
          // The gateway's own envelope shape: `error.type`, no top-level
          // `code`. Nothing was served, so nothing is added to the expected
          // total. `x-nr-limit-source` names WHICH limit measured it — without
          // it a customer is sent to raise the wrong one.
          res.writeHead(429, {
            'content-type': 'application/json',
            'x-nr-request-id': requestId,
            'x-nr-limit-source': 'key',
            'retry-after': '3',
          });
          res.end(
            JSON.stringify({
              error: { type: 'rate_limit_exceeded', message: 'per-key RPM limit reached' },
            }),
          );
          return;
        }

        counts.chatCompletionsBuffered += 1;
        // THE CACHE. Keyed on the exact request body, which is what the real
        // one keys on (plus the tenant, which a single-key mock cannot vary).
        const repeated = seenChatBodies.has(rawBody);
        seenChatBodies.add(rawBody);
        const cost = repeated ? COST.cacheHit : COST.chat;
        expectedPricedTotal += cost;

        const headers = {
          'content-type': 'application/json',
          'x-nr-request-id': requestId,
          'x-nr-model': 'mock-chat-1',
          // A CACHE HIT IS STILL BILLED. It skips the provider call and nothing
          // else, so it still carries a settled cost and a spend row.
          'x-nr-request-cost': cost.toFixed(6),
          'x-nr-cost-status': 'exact',
          'x-nr-latency-ms': String(repeated ? GATEWAY_MS.cache : GATEWAY_MS.chat),
          'x-nr-guardrails': 'pass',
          'x-nr-input-tokens': '55',
          'x-nr-output-tokens': '25',
          'x-nr-total-tokens': '80',
        };
        if (!cacheDisabled) {
          headers['x-nr-response-cache'] = repeated ? 'hit' : 'miss';
          // Age on HITS only — a miss produced nothing to be old.
          if (repeated) headers['x-nr-response-cache-age'] = String(CACHE_AGE_SECONDS);
          if (repeated) counts.cacheHits += 1;
          else counts.cacheMisses += 1;
        }
        ledger.set(requestId, {
          call_type: 'chat_completions',
          model: 'mock-chat-1',
          spend: cost,
          cost_status: 'exact',
          prompt_tokens: 55,
          completion_tokens: 25,
          stream: false,
          cache_hit: repeated,
        });
        res.writeHead(200, headers);
        res.end(
          JSON.stringify({
            id: `chatcmpl-chat-${counts.chatCompletionsBuffered}`,
            choices: [
              { message: { role: 'assistant', content: `Mock chat reply ${counts.chatCompletionsBuffered}.` } },
            ],
            usage: { prompt_tokens: 55, completion_tokens: 25, total_tokens: 80 },
          }),
        );
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `no mock route for ${url}` } }));
    });
  });

  return {
    server,
    counts: () => ({ ...counts, requests }),
    expectedPricedTotal: () => expectedPricedTotal,
    ledger,
  };
}

/**
 * The DASHBOARD app, on its OWN port.
 *
 * A second server, not a second path on the gateway mock, because the example
 * must read `NROUTER_DASHBOARD_URL` and not derive the host from
 * `NROUTER_BASE_URL`. Deriving one from the other is wrong in both directions
 * in production, and a single-server fixture could not tell the two apart.
 *
 *   pendingStreams          every streamed id answers `{"log":null,"total":0}`,
 *                           the shape a row that has not landed yet returns —
 *                           and the same shape a foreign or unknown id returns.
 *   divergeBufferedSettled  the spend row for a buffered call disagrees with
 *                           the cost its own response header reported.
 */
function startDashboardMock(ledger, { pendingStreams = false, divergeBufferedSettled = false } = {}) {
  const lookups = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://dashboard.invalid');
    const auth = req.headers['authorization'] || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';

    // A master-shaped key is refused here exactly as the real route refuses it.
    // The example must never get this far with one — it refuses before the
    // first call — but a fixture that ACCEPTED one could not prove that.
    if (!bearer.startsWith('sk-nrouter-') || /^sk-nrouter-master|^sk-master-|^sk-admin-/i.test(bearer)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_api_key' }));
      return;
    }

    if (url.pathname !== '/api/nrouter-proxy/spend/by-key') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `no dashboard route for ${url.pathname}` } }));
      return;
    }

    const requestId = url.searchParams.get('request_id') || '';
    lookups.push(requestId);
    const row = ledger.get(requestId);

    // A foreign id, an unknown id and a row that has not landed all answer the
    // SAME thing with HTTP 200. The route reveals nothing about ids outside the
    // caller's organization.
    if (!row || (pendingStreams && row.stream)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ log: null, total: 0 }));
      return;
    }

    const spend =
      divergeBufferedSettled && !row.stream && typeof row.spend === 'number' ? row.spend + 0.000005 : row.spend;

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        log: {
          request_id: requestId,
          call_type: row.call_type,
          model: row.model,
          model_group: row.model,
          spend,
          spend_unpriced: spend === null,
          cost_status: row.cost_status,
          prompt_tokens: row.prompt_tokens,
          completion_tokens: row.completion_tokens,
          total_tokens: row.prompt_tokens + row.completion_tokens,
          startTime: '2026-09-06T00:00:00.000Z',
          endTime: '2026-09-06T00:00:01.000Z',
          request_duration_ms: 1000,
          completionStartTime: '2026-09-06T00:00:00.300Z',
          cache_hit: row.cache_hit ?? false,
          status: 'success',
          metadata: {
            nrouter_units: 'tokens',
            nrouter_cost: spend,
            nrouter_modality: 'text',
            nrouter_stream: row.stream,
            tags: [],
          },
        },
        total: 1,
      }),
    );
  });

  return { server, lookups: () => [...lookups] };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/**
 * Run the example against the mock in an isolated working directory.
 *
 * ASYNCHRONOUS on purpose. `spawnSync` blocks this process's event loop, and
 * the mock gateway lives in THIS process — a synchronous spawn deadlocks the
 * child on its first request and the suite reports a hang as a failure of the
 * example.
 */
async function runExample({ port, turns, workDir, dashboardPort = null, extraEnv = {} }) {
  const logPath = path.join(workDir, 'chat-agent.log.jsonl');

  // Start from the ambient environment MINUS every NROUTER_* variable. A
  // developer's real key or base URL leaking in here would point this suite at
  // the production gateway and bill it.
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('NROUTER_')) env[key] = value;
  }
  Object.assign(env, {
    NROUTER_API_KEY: DEMO_KEY,
    NROUTER_BASE_URL: `http://127.0.0.1:${port}/v1`,
    // A Claude-family id, so the SDK's own wire selection is what is under
    // test rather than a hand-picked path. nrouter-doc-wire: messages
    NROUTER_MESSAGES_MODEL: 'claude-mock-haiku-4-5',
    NROUTER_CHAT_MODEL: 'mock-gpt-chat',
    NROUTER_RESPONSES_MODEL: 'mock-gpt-responses',
    NROUTER_TURNS: String(turns),
    NROUTER_CHAT_LOG: logPath,
  });
  if (dashboardPort !== null) {
    // A DIFFERENT port from the gateway. If the example derived this host from
    // NROUTER_BASE_URL instead of reading its own variable, every lookup would
    // 404 against the gateway mock and this suite would say so.
    env.NROUTER_DASHBOARD_URL = `http://127.0.0.1:${dashboardPort}`;
    // The real route is rate limited to 60 lookups/minute per key; the poll
    // delay is shortened here so the pending case does not add seconds.
    env.NROUTER_SETTLED_POLL_MS = '10';
  }
  Object.assign(env, extraEnv);

  const child = await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [EXAMPLE], { env, cwd: workDir });
    let stdout = '';
    let stderr = '';
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => (stdout += chunk));
    proc.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`the example did not finish within 30s\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 30_000);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });

  const records = fs.existsSync(logPath)
    ? fs
        .readFileSync(logPath, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line))
    : [];

  return { child, records, logPath };
}

function summaryNumber(stdout, field) {
  // Anchored to the start of a summary line so `calls` cannot match inside
  // `pricedCalls`, `streamedCalls`, `freeCalls`, `unpricedCalls` or
  // `failedCalls`.
  // Anchored at the START only: a summary line may carry a trailing caveat
  // (`streamRecomputedUsd 0.00012400   <- ESTIMATE, ...`), and an end-anchor
  // would silently fail to find it.
  const match = new RegExp(`^\\s*${field}\\s+([0-9]+(?:\\.[0-9]+)?)(?:\\s|$)`, 'm').exec(stdout);
  assert.ok(match, `summary line for ${field} not found in:\n${stdout}`);
  return Number(match[1]);
}

function fail(name, child, extra) {
  console.error(`\n--- ${name} FAILED ---`);
  console.error(`exit=${child.status} signal=${child.signal}`);
  console.error(`stdout:\n${child.stdout}`);
  console.error(`stderr:\n${child.stderr}`);
  if (extra) console.error(extra);
}

/** The six calls of one turn, in loop order. */
const TURN_STEPS = ['messages', 'chat', 'responses', 'stream', 'cache', 'count'];

/** The wire each step is documented to take — asserted against the mock's counters too. */
const TURN_WIRES = [
  '/v1/messages',
  '/v1/chat/completions',
  '/v1/responses',
  '/v1/chat/completions (stream)',
  '/v1/chat/completions',
  '/v1/messages/count_tokens',
];

async function main() {
  console.log('======================================================================');
  console.log('nRouter chat-agent example — mock gateway certification');
  console.log('======================================================================');

  assert.ok(
    fs.existsSync(SDK_DIST),
    `the JS SDK is not built: ${SDK_DIST} is missing. Run: (cd sdks/js && npm run build)`,
  );

  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nrouter-chat-agent-'));

  try {
    // ---------------------------------------------------------------- run 1
    console.log('\n[1/11] Fully priced session, cache miss then hit (2 turns)...');
    const green = startMock();
    const greenPort = await listen(green.server);
    const workA = path.join(workRoot, 'green');
    fs.mkdirSync(workA);
    const a = await runExample({
      port: greenPort,
      turns: 2,
      workDir: workA,
      // Rates the OPERATOR supplies. No rate card is shipped in the example, so
      // this is the only way the recomputation path runs at all.
      extraEnv: {
        NROUTER_STREAM_RATE_IN_PER_MTOK: String(RATE_IN_PER_MTOK),
        NROUTER_STREAM_RATE_OUT_PER_MTOK: String(RATE_OUT_PER_MTOK),
      },
    });
    green.server.close();

    if (a.child.status !== 0) {
      fail('run 1', a.child);
      throw new Error(`example exited ${a.child.status}, expected 0`);
    }

    assert.deepEqual(
      a.records.map((r) => r.step),
      [...TURN_STEPS, ...TURN_STEPS],
      'the JSONL log must carry one record per call, in loop order',
    );
    assert.deepEqual(
      a.records.map((r) => r.wire),
      [...TURN_WIRES, ...TURN_WIRES],
      'each record must name the wire its call took',
    );

    for (const record of a.records) {
      // A record with no request id cannot be joined to a spend row, which is
      // the only reason this log exists — and on the STREAMED call it is the
      // only way to reach the settled cost at all.
      assert.ok(
        typeof record.requestId === 'string' && record.requestId.length > 0,
        `record without a requestId: ${JSON.stringify(record)}`,
      );
      assert.equal(record.ok, true);
      assert.ok(typeof record.ts === 'string' && record.ts.length > 0);
      assert.ok(typeof record.model === 'string' && record.model.length > 0);
      assert.ok(Number.isInteger(record.latencyMs), `no client latency: ${JSON.stringify(record)}`);
      // Integer or null, NEVER 0 for "absent". A zero claims a measurement was
      // taken and came back instant.
      assert.ok(
        record.gatewayMs === null || Number.isInteger(record.gatewayMs),
        `gatewayMs must be an integer or null: ${JSON.stringify(record)}`,
      );
    }

    // --- the three accounting classes, one assertion each ------------------
    const streamRecords = a.records.filter((r) => r.step === 'stream');
    assert.equal(streamRecords.length, 2);
    for (const rec of streamRecords) {
      assert.equal(rec.streamed, true, 'a streamed call must be marked streamed');
      // The property the whole example exists to demonstrate.
      assert.equal(rec.priced, false, 'a streamed call is unpriced by construction');
      assert.equal(rec.costStatus, 'unpriced');
      assert.equal(rec.cost, null, 'a streamed call must log a null cost, never 0');
      assert.equal(rec.gatewayMs, GATEWAY_MS.stream);
      // The token counts came from the final usage FRAME, not the headers, and
      // the record says so. A usage number whose provenance is unrecorded is a
      // number nobody can check.
      assert.equal(rec.usageFrom, 'stream-usage-frame');
      assert.equal(rec.inputTokens, STREAM_INPUT_TOKENS);
      assert.equal(rec.outputTokens, STREAM_OUTPUT_TOKENS);
      assert.equal(rec.totalTokens, STREAM_INPUT_TOKENS + STREAM_OUTPUT_TOKENS);
      // BYPASS, not miss and not null. A stream is never a cache candidate;
      // reporting it as a miss would claim a lookup that never happened.
      assert.equal(rec.responseCache, 'bypass', 'a stream reports bypass, not miss');
      assert.equal(rec.responseCacheAge, null);
      // Guardrails ARE reported on a stream.
      assert.equal(rec.guardrails, 'pass');
      // The client-side estimate: OUR arithmetic from the operator's rates,
      // carried in its own field and never in `cost`.
      assert.equal(rec.cost, null, 'the estimate must never be written into cost');
      const expectedRecomputed =
        (STREAM_INPUT_TOKENS / 1e6) * RATE_IN_PER_MTOK + (STREAM_OUTPUT_TOKENS / 1e6) * RATE_OUT_PER_MTOK;
      assert.ok(
        Math.abs(rec.recomputedUsd - expectedRecomputed) < 1e-12,
        `recomputed ${rec.recomputedUsd} != ${expectedRecomputed}`,
      );
      // Swapping the two rates would give a different number, which is what
      // makes the assertion above capable of catching a swapped counter.
      assert.ok(
        Math.abs(expectedRecomputed -
          ((STREAM_OUTPUT_TOKENS / 1e6) * RATE_IN_PER_MTOK + (STREAM_INPUT_TOKENS / 1e6) * RATE_OUT_PER_MTOK)) > 1e-12,
        'the fixture cannot distinguish input from output rates',
      );
    }
    assert.ok(
      /RECOMPUTED, NOT the gateway/.test(a.child.stdout),
      'a client-side estimate must be labelled as one, never printed as the settled cost',
    );
    // The estimate is reported on its OWN line and is NOT part of pricedTotalUsd.
    const recomputedTotal = summaryNumber(a.child.stdout, 'streamRecomputedUsd');
    assert.ok(recomputedTotal > 0, 'the recomputed estimate was not summarised');
    assert.ok(
      /streamRecomputedUsd .*ESTIMATE, excluded from the total above/.test(a.child.stdout),
      'the estimate must say it is excluded from the settled total',
    );

    const freeRecords = a.records.filter((r) => r.step === 'count');
    assert.equal(freeRecords.length, 2);
    for (const rec of freeRecords) {
      assert.equal(rec.free, true, 'count_tokens is free and must be marked so');
      assert.equal(rec.priced, false);
      assert.equal(rec.cost, null);
      assert.equal(rec.costStatus, null, 'a free route sends no cost status at all');
    }

    // --- the cache, miss then hit, both billed ----------------------------
    const firstChat = a.records.find((r) => r.step === 'chat');
    const firstRepeat = a.records.find((r) => r.step === 'cache');
    assert.equal(firstChat.responseCache, 'miss');
    assert.equal(firstChat.responseCacheAge, null, 'a miss produced nothing to be old');
    assert.equal(firstRepeat.responseCache, 'hit');
    assert.equal(firstRepeat.responseCacheAge, CACHE_AGE_SECONDS);
    assert.equal(firstRepeat.priced, true, 'a cache HIT is still billed and metered');
    assert.equal(firstRepeat.cost, COST.cacheHit);
    assert.equal(firstChat.guardrails, 'pass', 'the guardrail posture must reach the log');
    assert.ok(
      /hit is still billed and metered/i.test(a.child.stdout),
      'the honesty line from docs/cost.md is not printed',
    );

    // --- the money -------------------------------------------------------
    // 3 buffered wires x 2 turns = the 6 first-visit priced calls...
    const sixWireCalls = 2 * (COST.messages + COST.chat + COST.responses);
    // ...plus the 2 cache repeats, which are served responses and ARE billed.
    // Neither the 2 streamed nor the 2 free calls appear in either figure.
    const expectedTotal = sixWireCalls + 2 * COST.cacheHit;
    assert.equal(
      expectedTotal.toFixed(8),
      green.expectedPricedTotal().toFixed(8),
      'the suite and the mock disagree about what was billed',
    );
    const reportedTotal = summaryNumber(a.child.stdout, 'pricedTotalUsd');
    assert.equal(
      reportedTotal.toFixed(8),
      expectedTotal.toFixed(8),
      `pricedTotalUsd ${reportedTotal} != mock total ${expectedTotal}`,
    );
    // Prove the exclusions are OBSERVABLE rather than coincidental: had the
    // streamed or free calls been summed at their mock cost, or at 0 with a
    // non-zero mock cost, the total would differ.
    assert.ok(COST.cacheHit !== COST.chat, 'the hit and the miss must be distinguishable');

    assert.equal(summaryNumber(a.child.stdout, 'calls'), 12);
    assert.equal(summaryNumber(a.child.stdout, 'pricedCalls'), 8);
    assert.equal(summaryNumber(a.child.stdout, 'streamedCalls'), 2);
    assert.equal(summaryNumber(a.child.stdout, 'freeCalls'), 2);
    assert.equal(summaryNumber(a.child.stdout, 'unpricedCalls'), 0);
    assert.equal(summaryNumber(a.child.stdout, 'failedCalls'), 0);
    assert.equal(summaryNumber(a.child.stdout, 'cacheHits'), 2);
    assert.equal(summaryNumber(a.child.stdout, 'cacheMisses'), 2);
    assert.ok(
      !a.child.stdout.includes('TOTAL INCOMPLETE'),
      'a session whose only unpriced calls are streamed-by-design must not be incomplete',
    );
    // NROUTER_DASHBOARD_URL is unset in this run, so the join must be SKIPPED
    // and said to be skipped — not silently absent, which reads as "there was
    // nothing to settle".
    assert.ok(!/SETTLED JOIN/.test(a.child.stdout), 'no join may run without a dashboard URL');
    assert.ok(
      /settledTotalUsd {2}—.*set NROUTER_DASHBOARD_URL/.test(a.child.stdout),
      'a skipped join must say so, and say what would enable it',
    );
    for (const rec of a.records) {
      // ALL FOUR, not just the amount: a bug that wrote `settledFound` or
      // `settledBasisKnown` without `settledUsd` would slip past a one-field
      // check while still claiming a lookup had happened.
      for (const field of ['settledFound', 'settledUsd', 'settledCostStatus', 'settledBasisKnown']) {
        // Absent, not null: a `null` here could not be told apart from a lookup
        // that ran and found nothing.
        assert.ok(!(field in rec), `a skipped join must write no ${field}: ${JSON.stringify(rec)}`);
      }
      // Every record carries the send verdict, whether or not the join ran.
      assert.equal(rec.sentToGateway, true, `a served call reached the gateway: ${JSON.stringify(rec)}`);
      assert.equal(rec.billed, true);
    }

    // --- the wires, proven by the SERVER rather than by the record ---------
    // The record's `wire` is the example's CLAIM. These counters are the mock's
    // own observation, and they are what makes the claim checkable.
    const greenCounts = green.counts();
    assert.equal(greenCounts.messages, 2, 'an Anthropic-family id must take the /v1/messages wire');
    assert.equal(greenCounts.responses, 2);
    assert.equal(greenCounts.chatCompletionsBuffered, 4, '2 chat + 2 cache repeats');
    assert.equal(greenCounts.chatCompletionsStreamed, 2);
    assert.equal(greenCounts.countTokens, 2);
    assert.equal(greenCounts.cacheHits, 2);
    assert.equal(greenCounts.cacheMisses, 2);

    // The per-call line the operator actually reads.
    for (const step of TURN_STEPS) {
      assert.ok(
        new RegExp(`\\[${step}\\] turn=`).test(a.child.stdout),
        `no per-call [${step}] line printed:\n${a.child.stdout}`,
      );
    }
    assert.ok(new RegExp(`gw=${GATEWAY_MS.messages}ms`).test(a.child.stdout), 'no gateway latency printed');
    assert.ok(/client=\d+ms/.test(a.child.stdout), 'no client latency printed');
    assert.ok(/cache=hit\(34s\)/.test(a.child.stdout), 'the cache state and age are not printed');
    assert.ok(/Mock streamed reply\./.test(a.child.stdout), 'the streamed text was not concatenated');

    console.log(
      `      calls=${a.records.length} pricedCalls=8 streamedCalls=2 freeCalls=2 ` +
        `pricedTotalUsd=${reportedTotal.toFixed(8)} (mock ${expectedTotal.toFixed(8)})`,
    );

    // ---------------------------------------------------------------- run 2
    // One BUFFERED call comes back unpriced. The session still succeeds —
    // unpriced is a served request, not an error — but the total is INCOMPLETE
    // and must say so rather than silently under-reporting by one call.
    console.log('\n[2/11] One unpriced buffered call (1 turn)...');
    const mixed = startMock({ unpriceResponses: true });
    const mixedPort = await listen(mixed.server);
    const workB = path.join(workRoot, 'unpriced');
    fs.mkdirSync(workB);
    const b = await runExample({ port: mixedPort, turns: 1, workDir: workB });
    mixed.server.close();

    if (b.child.status !== 0) {
      fail('run 2', b.child);
      throw new Error(`example exited ${b.child.status}, expected 0 (unpriced is not a failure)`);
    }

    const unpricedRecord = b.records.find((r) => r.step === 'responses');
    assert.equal(unpricedRecord.costStatus, 'unpriced');
    assert.equal(unpricedRecord.cost, null, 'an unpriced call must log a null cost, never 0');
    assert.equal(unpricedRecord.priced, false);
    assert.equal(unpricedRecord.streamed, false, 'this one is NOT a stream — the confusion under test');
    assert.equal(unpricedRecord.free, false);
    assert.ok(unpricedRecord.requestId, 'an unpriced call still reaches a spend row');

    // The bucket separation is the whole assertion: 1 unpriced, and the
    // streamed and free calls still in their own buckets rather than swept in.
    assert.equal(summaryNumber(b.child.stdout, 'unpricedCalls'), 1);
    assert.equal(summaryNumber(b.child.stdout, 'streamedCalls'), 1);
    assert.equal(summaryNumber(b.child.stdout, 'freeCalls'), 1);
    assert.equal(summaryNumber(b.child.stdout, 'pricedCalls'), 3, 'messages + chat + the cache repeat');
    assert.ok(
      b.child.stdout.includes('TOTAL INCOMPLETE'),
      'a session with an unpriced call must be reported as TOTAL INCOMPLETE',
    );
    assert.ok(/SERVED without a price/.test(b.child.stdout));

    const mixedReported = summaryNumber(b.child.stdout, 'pricedTotalUsd');
    assert.equal(
      mixedReported.toFixed(8),
      mixed.expectedPricedTotal().toFixed(8),
      `pricedTotalUsd ${mixedReported} != mock priced total`,
    );
    // The sum EXCLUDES the unpriced call rather than adding 0 for it, and the
    // two are only distinguishable because the mock's responses price is not 0.
    assert.ok(COST.responses > 0);
    assert.ok(
      Math.abs(mixedReported - (mixed.expectedPricedTotal() + COST.responses)) > 1e-12,
      'the assertion above cannot distinguish summed from excluded',
    );

    console.log(
      `      calls=${b.records.length} unpricedCalls=1 pricedTotalUsd=${mixedReported.toFixed(8)} (TOTAL INCOMPLETE)`,
    );

    // ---------------------------------------------------------------- run 3
    // A 429 mid-session. Three properties, and the last two are the ones that
    // are easy to lose: the process must exit NON-ZERO so a scripted caller
    // notices, it must print WHICH limit measured it, and it must still report
    // the money it had already spent before the refusal.
    console.log('\n[3/11] A rate-limited chat call mid-session (1 turn)...');
    const limited = startMock({ refuseChatWith429: true });
    const limitedPort = await listen(limited.server);
    const workC = path.join(workRoot, 'limited');
    fs.mkdirSync(workC);
    const c = await runExample({ port: limitedPort, turns: 1, workDir: workC });
    limited.server.close();

    assert.equal(c.child.status, 1, 'a refused call must exit non-zero');
    assert.ok(/rate_limit/.test(c.child.stderr), `the error kind was not reported:\n${c.child.stderr}`);
    // WHICH limit. Without it a customer is sent to raise the wrong one.
    assert.ok(
      /limitSource: 'key'/.test(c.child.stderr),
      `x-nr-limit-source did not reach the operator:\n${c.child.stderr}`,
    );

    // The /v1/messages call happened BEFORE the refusal and was billed. It must
    // still be in the log and in the total.
    assert.deepEqual(c.records.map((r) => r.step), ['messages', 'chat']);
    const failedRecord = c.records[1];
    assert.equal(failedRecord.ok, false);
    assert.equal(failedRecord.priced, false);
    assert.ok(
      typeof failedRecord.error === 'string' && failedRecord.error.length > 0,
      'a failed call must log why',
    );
    assert.ok(failedRecord.requestId, 'a refusal still carries a request id to join on');
    // The gateway ANSWERED, so this one reached it and is billed per its own
    // rules — the opposite of the local refusal in run 10.
    assert.equal(failedRecord.sentToGateway, true);
    assert.equal(failedRecord.billed, true);

    // Failure is its OWN bucket: a refused call was not "served without a
    // price", and telling the operator it was sends them to the wrong page.
    assert.equal(summaryNumber(c.child.stdout, 'failedCalls'), 1);
    assert.equal(summaryNumber(c.child.stdout, 'unpricedCalls'), 0);
    assert.ok(c.child.stdout.includes('TOTAL INCOMPLETE'));
    assert.ok(/FAILED and may still have been billed/.test(c.child.stdout));

    const limitedReported = summaryNumber(c.child.stdout, 'pricedTotalUsd');
    assert.equal(
      limitedReported.toFixed(8),
      limited.expectedPricedTotal().toFixed(8),
      'the money already spent before the refusal must still be reported',
    );
    assert.ok(limitedReported > 0, 'one call was billed before the refusal');

    console.log(
      `      exit=1 calls=${c.records.length} limitSource=key pricedTotalUsd=${limitedReported.toFixed(8)}`,
    );

    // ---------------------------------------------------------------- run 4
    // A deployment that never opted into response caching, and a provider that
    // sent no usage frame. NULL is not `miss` and NULL is not `0`: three
    // absences that a careless reader turns into three measurements.
    console.log('\n[4/11] Caching off, no stream usage frame, no stream latency (1 turn)...');
    const bare = startMock({ cacheDisabled: true, omitStreamUsage: true, omitStreamLatency: true });
    const barePort = await listen(bare.server);
    const workD = path.join(workRoot, 'bare');
    fs.mkdirSync(workD);
    const d = await runExample({
      port: barePort,
      turns: 1,
      workDir: workD,
      // Rates ARE supplied here, so "no estimate" can only be caused by the
      // absent usage frame — which is the property under test.
      extraEnv: {
        NROUTER_STREAM_RATE_IN_PER_MTOK: String(RATE_IN_PER_MTOK),
        NROUTER_STREAM_RATE_OUT_PER_MTOK: String(RATE_OUT_PER_MTOK),
      },
    });
    bare.server.close();

    if (d.child.status !== 0) {
      fail('run 4', d.child);
      throw new Error(`example exited ${d.child.status}, expected 0`);
    }

    for (const rec of d.records) {
      assert.equal(
        rec.responseCache,
        null,
        `caching off must log null, never "miss" and never "bypass": ${JSON.stringify(rec)}`,
      );
      assert.equal(rec.responseCacheAge, null);
    }
    const bareStream = d.records.find((r) => r.step === 'stream');
    assert.equal(bareStream.gatewayMs, null, 'an absent x-nr-latency-ms must log null, never 0');
    assert.equal(bareStream.usageFrom, null, 'no usage frame means no usage provenance');
    assert.equal(bareStream.recomputedUsd, null, 'no token counts means no estimate — never a 0');
    assert.equal(bareStream.inputTokens, null, 'absent token counts are null, never 0');
    assert.equal(bareStream.outputTokens, null);
    assert.equal(summaryNumber(d.child.stdout, 'cacheHits'), 0);
    assert.equal(summaryNumber(d.child.stdout, 'cacheMisses'), 0);
    assert.equal(summaryNumber(d.child.stdout, 'unpricedCalls'), 0, 'caching off is not an unpriced call');
    assert.ok(!d.child.stdout.includes('TOTAL INCOMPLETE'));
    assert.ok(
      /No cache hit was observed/.test(d.child.stdout),
      'a run with no cache hit must say so rather than implying caching failed',
    );
    assert.ok(/gw=—ms/.test(d.child.stdout), 'an unreported gateway latency must render as —, not 0');
    assert.ok(/cache=—/.test(d.child.stdout), 'an absent cache header must render as —, not "miss"');
    assert.ok(
      /streamRecomputedUsd —/.test(d.child.stdout),
      'with no token counts the estimate must be absent, never 0.00000000',
    );
    assert.ok(/no usage frames carried token counts/.test(d.child.stdout));

    console.log(`      calls=${d.records.length} responseCache=null everywhere, cacheHits=0`);

    // ---------------------------------------------------------------- run 5
    // A stream whose HEADERS carry an exact cost. Today's gateway cannot do
    // this — which is exactly why it is worth testing: the exclusion must hold
    // by construction, not because the fixture happened to omit the header.
    console.log('\n[5/11] A stream carrying an exact cost header (1 turn)...');
    const oddStream = startMock({ streamCarriesCost: true });
    const oddPort = await listen(oddStream.server);
    const workE = path.join(workRoot, 'stream-cost');
    fs.mkdirSync(workE);
    const e = await runExample({ port: oddPort, turns: 1, workDir: workE });
    oddStream.server.close();

    if (e.child.status !== 0) {
      fail('run 5', e.child);
      throw new Error(`example exited ${e.child.status}, expected 0`);
    }

    const oddRecord = e.records.find((r) => r.step === 'stream');
    assert.equal(oddRecord.costStatus, 'exact', 'the mock DID send an exact cost status');
    assert.equal(typeof oddRecord.cost, 'number', 'the mock DID send a cost header');
    assert.equal(oddRecord.priced, false, 'a streamed call must never be summed, whatever it reports');
    assert.equal(oddRecord.streamed, true);
    assert.equal(summaryNumber(e.child.stdout, 'streamedCalls'), 1);
    assert.equal(summaryNumber(e.child.stdout, 'unpricedCalls'), 0, 'it is streamed, not unpriceable');

    const oddReported = summaryNumber(e.child.stdout, 'pricedTotalUsd');
    // The mock's expected total never included the stream, so equality here IS
    // the exclusion...
    assert.equal(oddReported.toFixed(8), oddStream.expectedPricedTotal().toFixed(8));
    // ...and this proves the equality can tell summed from excluded.
    assert.ok(
      Math.abs(oddReported - (oddStream.expectedPricedTotal() + COST.stream)) > 1e-12,
      'the assertion above cannot distinguish summed from excluded',
    );
    assert.ok(
      /a STREAMED call reported exact/.test(e.child.stderr) ||
        /a STREAMED call reported exact/.test(e.child.stdout),
      'a stream carrying a price is a contract change and must be announced, not swallowed',
    );

    console.log(
      `      calls=${e.records.length} streamed cost $${COST.stream.toFixed(6)} excluded and announced`,
    );

    // ---------------------------------------------------------------- run 6
    // A CONFIGURATION refusal, with no gateway at all. Both client rates at 0
    // can only ever print `$0.000000` under a `RECOMPUTED` label, and a
    // labelled zero is read as a price. It must refuse before it spends
    // anything, which is why this run needs no mock.
    console.log('\n[6/11] Both client rates at 0 must be refused, not printed as $0...');
    const refusal = await new Promise((resolve, reject) => {
      const env = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (!key.startsWith('NROUTER_')) env[key] = value;
      }
      Object.assign(env, {
        NROUTER_API_KEY: DEMO_KEY,
        // A base URL nothing is listening on: reaching the network at all would
        // itself be the failure.
        NROUTER_BASE_URL: 'http://127.0.0.1:1/v1',
        NROUTER_STREAM_RATE_IN_PER_MTOK: '0',
        NROUTER_STREAM_RATE_OUT_PER_MTOK: '0',
      });
      const proc = spawn(process.execPath, [EXAMPLE], { env, cwd: workRoot });
      let stdout = '';
      let stderr = '';
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => (stdout += chunk));
      proc.stderr.on('data', (chunk) => (stderr += chunk));
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error('the example did not refuse a zero rate pair within 15s'));
      }, 15_000);
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on('close', (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      });
    });
    assert.equal(refusal.status, 1, 'a zero rate pair must be refused, not run');
    assert.ok(
      /both 0/.test(refusal.stderr),
      `the refusal must name the reason:\n${refusal.stderr}`,
    );
    assert.ok(
      !/RECOMPUTED/.test(refusal.stdout),
      'nothing may be labelled RECOMPUTED when the rates cannot produce a real figure',
    );
    console.log('      exit=1 before any call, with the reason named');

    // ---------------------------------------------------------------- run 7
    // THE SETTLED JOIN. The streamed call's cost exists only on the spend row,
    // and this is the run that proves the example can actually see it.
    console.log('\n[7/11] The settled join — every billed call resolves, streams included (1 turn)...');
    const joinGw = startMock();
    const joinGwPort = await listen(joinGw.server);
    const joinDash = startDashboardMock(joinGw.ledger);
    const joinDashPort = await listen(joinDash.server);
    const workF = path.join(workRoot, 'join');
    fs.mkdirSync(workF);
    const f = await runExample({
      port: joinGwPort,
      turns: 1,
      workDir: workF,
      dashboardPort: joinDashPort,
      extraEnv: {
        NROUTER_STREAM_RATE_IN_PER_MTOK: String(RATE_IN_PER_MTOK),
        NROUTER_STREAM_RATE_OUT_PER_MTOK: String(RATE_OUT_PER_MTOK),
      },
    });
    joinGw.server.close();
    joinDash.server.close();

    if (f.child.status !== 0) {
      fail('run 7', f.child);
      throw new Error(`example exited ${f.child.status}, expected 0`);
    }

    // Only the BILLED calls are looked up. The free count_tokens writes no spend
    // row, so looking it up would spend rate-limit budget to learn nothing and
    // its `null` would look like a missing row rather than a route that never
    // writes one.
    const joinBilled = f.records.filter((r) => r.streamed || r.priced);
    assert.equal(joinBilled.length, 5, '4 priced (messages, chat, responses, the cache repeat) + 1 streamed');
    const joinLookups = joinDash.lookups();
    assert.equal(joinLookups.length, joinBilled.length, 'one lookup per billed call, and none for the free one');
    const freeRecord = f.records.find((r) => r.step === 'count');
    assert.ok(
      !joinLookups.includes(freeRecord.requestId),
      'a free call writes no spend row and must not be looked up',
    );

    for (const rec of joinBilled) {
      assert.equal(rec.settledFound, true, `no spend row read back: ${JSON.stringify(rec)}`);
      assert.equal(typeof rec.settledUsd, 'number');
      assert.equal(rec.settledCostStatus, 'exact');
      // ALWAYS false. The row says what it settled at; it does not say how that
      // figure was derived, and this client cannot verify it.
      assert.equal(rec.settledBasisKnown, false, 'this client cannot vouch for the basis of a settled figure');
    }

    const joinStream = f.records.find((r) => r.step === 'stream');
    // THE WHOLE POINT: the response carried no price, and the spend row does.
    assert.equal(joinStream.cost, null, 'the streamed RESPONSE still carries no price');
    assert.equal(joinStream.costStatus, 'unpriced');
    assert.equal(joinStream.settledUsd, SETTLED_STREAM_USD, 'the settled figure came from the spend row');
    assert.ok(
      Math.abs(joinStream.settledUsd - joinStream.recomputedUsd) > 1e-9,
      'the fixture cannot tell a real read-back from an echoed estimate',
    );
    assert.ok(
      /↳ delta: settled .* − recomputed .* = /.test(f.child.stdout),
      `the stream's settled-vs-recomputed delta was not printed:\n${f.child.stdout}`,
    );
    assert.ok(
      /\[settled\] .* stream=true /.test(f.child.stdout),
      'the per-lookup line must say which calls were streams',
    );

    // The settled total INCLUDES the streamed call, which is the one figure
    // `pricedTotalUsd` can never contain.
    const settledTotal = summaryNumber(f.child.stdout, 'settledTotalUsd');
    const expectedSettled =
      COST.messages + COST.chat + COST.responses + COST.cacheHit + SETTLED_STREAM_USD;
    assert.equal(settledTotal.toFixed(8), expectedSettled.toFixed(8));
    const joinPriced = summaryNumber(f.child.stdout, 'pricedTotalUsd');
    assert.ok(
      settledTotal > joinPriced,
      'the settled total must exceed the priced total by exactly the streamed call',
    );
    assert.ok(Math.abs(settledTotal - joinPriced - SETTLED_STREAM_USD) < 1e-12);
    // No disagreement between a buffered response header and its spend row here.
    assert.ok(!/spend row says/.test(f.child.stdout));

    console.log(
      `      lookups=${joinLookups.length} settledTotalUsd=${settledTotal.toFixed(8)} ` +
        `(priced ${joinPriced.toFixed(8)} + stream ${SETTLED_STREAM_USD.toFixed(6)})`,
    );

    // ---------------------------------------------------------------- run 8
    // The row has not landed yet. `{"log":null,"total":0}` is ALSO what a
    // foreign id and an unknown id return, so it can never be read as $0.
    console.log('\n[8/11] A stream whose spend row has not landed — pending, never $0 (1 turn)...');
    const pendGw = startMock();
    const pendGwPort = await listen(pendGw.server);
    const pendDash = startDashboardMock(pendGw.ledger, {
      pendingStreams: true,
      divergeBufferedSettled: true,
    });
    const pendDashPort = await listen(pendDash.server);
    const workG = path.join(workRoot, 'pending');
    fs.mkdirSync(workG);
    const g = await runExample({
      port: pendGwPort,
      turns: 1,
      workDir: workG,
      dashboardPort: pendDashPort,
      extraEnv: {
        NROUTER_STREAM_RATE_IN_PER_MTOK: String(RATE_IN_PER_MTOK),
        NROUTER_STREAM_RATE_OUT_PER_MTOK: String(RATE_OUT_PER_MTOK),
      },
    });
    pendGw.server.close();
    pendDash.server.close();

    if (g.child.status !== 0) {
      fail('run 8', g.child);
      throw new Error(`example exited ${g.child.status}, expected 0 (a pending row is not a failure)`);
    }

    const pendStream = g.records.find((r) => r.step === 'stream');
    assert.equal(pendStream.settledFound, false);
    assert.equal(pendStream.settledUsd, null, 'a pending row must log null, never 0');
    assert.equal(pendStream.settledCostStatus, null);
    // FALSE on the not-found path too. Both branches write it, so a test that
    // only checked the found one left half the field unpinned.
    assert.equal(pendStream.settledBasisKnown, false, 'a row that was never read cannot have a known basis');
    assert.ok(
      /not yet settled \/ not visible/.test(g.child.stdout),
      'a missing row must be reported as pending, not as free',
    );
    assert.ok(/NOT \$0/.test(g.child.stdout));
    // POLLED rather than believed on the first null: the docs say a row can
    // take a moment to appear after a stream closes.
    const pendLookups = pendDash.lookups().filter((id) => id === pendStream.requestId);
    assert.equal(pendLookups.length, 3, 'a null must be polled, not taken as final on the first read');

    // No total, and the reason named — a partial sum labelled as a total is the
    // same defect as summing an unpriced call at zero.
    assert.ok(
      /settledTotalUsd {2}—.*not yet settled or not visible/.test(g.child.stdout),
      `a partial join must refuse to print a total:\n${g.child.stdout}`,
    );
    assert.ok(
      !new RegExp(`settledTotalUsd {2}[0-9]`).test(g.child.stdout),
      'no settled total may be printed while a row is missing',
    );
    // The buffered rows disagree with their own response headers in this run,
    // and the example must say so rather than silently preferring one.
    // `console.warn` goes to stderr, so both streams are searched — asserting
    // on stdout alone would have made this pass for the wrong reason.
    const pendOutput = `${g.child.stdout}\n${g.child.stderr}`;
    assert.ok(
      /the response header said .* and the spend row says /.test(pendOutput),
      `a header/spend-row disagreement must be reported:\n${pendOutput}`,
    );
    assert.ok(/spend row is authoritative/.test(pendOutput));

    console.log(`      polled ${pendLookups.length}x, reported pending, no settled total printed`);

    // ---------------------------------------------------------------- run 9
    // A MASTER-shaped key. Every call here is billed inference and the join
    // sends the same key, so it must be refused BEFORE anything is sent —
    // proven by the gateway seeing zero requests, not by reading the message.
    console.log('\n[9/11] A master-shaped key must be refused before the first call...');
    const masterGw = startMock();
    const masterGwPort = await listen(masterGw.server);
    const masterDash = startDashboardMock(masterGw.ledger);
    const masterDashPort = await listen(masterDash.server);
    const workH = path.join(workRoot, 'master');
    fs.mkdirSync(workH);
    const h = await runExample({
      port: masterGwPort,
      turns: 1,
      workDir: workH,
      dashboardPort: masterDashPort,
      // placeholder shaped like a master key, never a credential
      extraEnv: { NROUTER_API_KEY: `sk-nrouter-master-${'0'.repeat(24)}` },
    });
    masterGw.server.close();
    masterDash.server.close();

    assert.equal(h.child.status, 1, 'a master-shaped key must be refused');
    assert.ok(/MASTER key/i.test(h.child.stderr), `the refusal must name the reason:\n${h.child.stderr}`);
    // THE ASSERTION THAT MATTERS: nothing was sent. A refusal that arrives after
    // the first billed call has already cost money.
    assert.equal(masterGw.counts().requests, 0, 'not one request may reach the gateway');
    assert.equal(masterDash.lookups().length, 0, 'not one lookup may reach the dashboard');

    console.log('      exit=1, 0 gateway requests, 0 dashboard lookups');

    // --------------------------------------------------------------- run 10
    // THE FOURTH FAILURE CLASS: refused by the SDK before anything was sent.
    // `n > 1` on the Anthropic Messages wire returns exactly one completion, so
    // the SDK raises a `configuration` error rather than dropping the field and
    // reporting success for a request that asked for more and was billed.
    //
    // It costs nothing, and the whole assertion is that the log says so: a
    // summary that lumps it in with "FAILED and may still have been billed"
    // sends an operator to check an invoice line that cannot exist.
    console.log('\n[10/11] A local refusal — nothing sent, nothing billed (1 turn)...');
    const localGw = startMock();
    const localGwPort = await listen(localGw.server);
    const workI = path.join(workRoot, 'local-refusal');
    fs.mkdirSync(workI);
    const i = await runExample({
      port: localGwPort,
      turns: 1,
      workDir: workI,
      extraEnv: { NROUTER_COMPLETIONS_N: '2' },
    });
    localGw.server.close();

    assert.equal(i.child.status, 1, 'a refused call must exit non-zero');
    // THE ASSERTION THAT MATTERS: not one byte left the process.
    assert.equal(localGw.counts().requests, 0, 'a local refusal must reach the gateway zero times');

    assert.equal(i.records.length, 1, 'the run stops at the first refusal');
    const localRecord = i.records[0];
    assert.equal(localRecord.ok, false);
    // FALSE, not null — and decided by the error KIND, never by the absent id.
    assert.equal(localRecord.sentToGateway, false, 'a configuration error means nothing was sent');
    assert.equal(localRecord.billed, false, 'nothing sent is nothing billed');
    assert.equal(localRecord.requestId, null, 'a request that was never sent has no id');
    assert.equal(localRecord.cost, null);
    assert.equal(localRecord.priced, false);
    assert.match(localRecord.error, /configuration/, 'the record must name the error kind');

    // The summary must count it separately and must NOT say it may have been
    // billed. Both directions are checked: the counter is right AND the
    // maybe-billed sentence is absent.
    assert.equal(summaryNumber(i.child.stdout, 'localRefusals'), 1);
    assert.equal(summaryNumber(i.child.stdout, 'failedCalls'), 0, 'a local refusal is not a billed failure');
    assert.ok(
      !/may still have been billed/.test(i.child.stdout),
      `a locally refused call must never be reported as possibly billed:\n${i.child.stdout}`,
    );
    assert.ok(/REFUSED LOCALLY/.test(i.child.stdout));
    assert.ok(/cost nothing/.test(i.child.stdout));
    // Nothing to join on either.
    assert.ok(!/SETTLED JOIN/.test(i.child.stdout));

    console.log('      exit=1, 0 gateway requests, billed=false, not reported as maybe-billed');

    // --------------------------------------------------------------- run 11
    // NO ANSWER. The socket dies with the request already delivered — a
    // transport failure or a timeout. The gateway may have received it and
    // billed it, and this client cannot know, so `sentToGateway` is NULL and
    // the call stays counted as billed.
    //
    // This run is what makes the three-valued field a tested property rather
    // than a comment: every other run produces `true` or `false`, so a
    // classifier keyed on a missing request id, or a `billed` derived as
    // `=== true`, is indistinguishable from the correct one without it.
    console.log('\n[11/11] A dropped connection — no answer, so BILLED is unknown-but-assumed (1 turn)...');
    const dropGw = startMock({ dropChatConnection: true });
    const dropGwPort = await listen(dropGw.server);
    const workJ = path.join(workRoot, 'dropped');
    fs.mkdirSync(workJ);
    const j = await runExample({ port: dropGwPort, turns: 1, workDir: workJ });
    dropGw.server.close();

    assert.equal(j.child.status, 1, 'a transport failure must exit non-zero');
    // The request DID leave this process and DID reach the mock.
    assert.equal(dropGw.counts().chatCompletionsBuffered, 1, 'the request reached the gateway');

    assert.deepEqual(j.records.map((r) => r.step), ['messages', 'chat']);
    const droppedRecord = j.records[1];
    assert.equal(droppedRecord.ok, false);
    assert.equal(droppedRecord.requestId, null, 'no answer means no request id came back');
    // NULL, not false — and this is exactly where a classifier keyed on the
    // absent request id would wrongly say "never sent".
    assert.equal(
      droppedRecord.sentToGateway,
      null,
      'a transport failure is not a local refusal: nothing answered, but it may have arrived',
    );
    // ...and it stays BILLED, because a charge may exist.
    assert.equal(droppedRecord.billed, true, 'no answer must not be written off as unbilled');

    // It is a FAILURE, not a local refusal, and the summary must say the money
    // is in doubt.
    assert.equal(summaryNumber(j.child.stdout, 'failedCalls'), 1);
    assert.equal(summaryNumber(j.child.stdout, 'localRefusals'), 0, 'nothing was refused locally here');
    assert.ok(
      /may still have been billed/.test(j.child.stdout),
      `a call with no answer must be flagged as possibly billed:\n${j.child.stdout}`,
    );
    assert.ok(j.child.stdout.includes('TOTAL INCOMPLETE'));
    // The money spent before it must still be reported.
    assert.equal(
      summaryNumber(j.child.stdout, 'pricedTotalUsd').toFixed(8),
      dropGw.expectedPricedTotal().toFixed(8),
    );

    console.log('      exit=1, sentToGateway=null, billed=true, reported as possibly billed');

    console.log('\n======================================================================');
    console.log('Result: PASS (chat-agent cost, usage, streaming, cache and logging verified)');
    console.log('======================================================================');
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
