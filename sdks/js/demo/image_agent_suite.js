#!/usr/bin/env node
/**
 * Mock-gateway certification for examples/typescript/image-agent.
 *
 * The example under test spends real money against a real gateway, which makes
 * it exactly the kind of code nobody exercises in CI. So the gateway is stood
 * up locally instead: a `node:http` server that speaks `/v1/images/generations`
 * and stamps the same `x-nr-*` headers a real one does.
 *
 * Images are the modality where "how much did that cost?" has TWO answers, and
 * the suite exercises both because they fail differently:
 *
 *   per IMAGE       a `dall-e`-class model. Price is a function of count, size
 *                   and quality — none of which the gateway reports in a
 *                   header. Only the spend row carries them, so a client that
 *                   does not record `n`/size/quality itself cannot ever explain
 *                   its own bill.
 *   per IMAGE TOKEN a `gpt-image-*` model. The body's `usage` block carries
 *                   `input_tokens`, `output_tokens` and `input_tokens_details`,
 *                   and the gateway prices from those.
 *
 * Every assertion below is about a property that costs money if it is wrong:
 * that a request id reaches the log, that an `exact` cost is summed, that an
 * `unpriced` one is NOT summed and is announced instead of being rounded into
 * the total as zero (Rule #28), that the bytes claimed on disk are the bytes
 * that arrived, and that a refusal exits non-zero.
 *
 * No network, no key, no credits. Runs in about a second.
 *
 *   node examples/typescript/image_agent_suite.js
 *
 * Requires the JS SDK to be built first (the example imports its dist):
 *
 *   (cd sdks/js && npm run build)
 */

'use strict';

const http = require('node:http');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const EXAMPLE = path.resolve(__dirname, 'image-agent', 'image-agent.mjs');
const SDK_DIST = path.resolve(__dirname, '..', '..', 'sdks', 'js', 'dist', 'index.mjs');

// A DISTINCT cost per call. A single shared price would let a summation bug
// that counted the wrong call still produce the right total.
const costForCall = (index) => Number((0.01 * index).toFixed(6));

// `x-nr-latency-ms` — what the GATEWAY measured, as opposed to what the client
// timed around its own call. Distinct per call for the same reason the costs
// are: a record that copied another call's latency must not assert green.
const gatewayMsForCall = (index) => 100 + index * 7;

const DEMO_KEY = 'sk-nrouter-imageagentsuite000000000000000000000000';

/**
 * Deterministic image bytes, unique per image.
 *
 * A real PNG signature followed by filler keyed to `seed`, so two images in one
 * response can never be byte-identical: an example that wrote image 1 twice
 * would otherwise pass a size check.
 */
function pngBytes(seed) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(48 + seed, 0x20 + (seed % 64)),
  ]);
}

/**
 * A gateway that bills for images.
 *
 * `mode` selects the billing shape:
 *
 *   'per_image'   a dall-e-class model: `data[]` of b64 images, `exact` cost,
 *                 no `usage` block at all. The quantity that produced the
 *                 price (count/size/quality) exists ONLY on the server side.
 *   'image_token' a gpt-image-class model: `data[]` plus a `usage` block with
 *                 `input_tokens`, `output_tokens` and `input_tokens_details`.
 *   'url'         `data[]` of `url` entries and no b64 at all.
 *
 * `firstCostStatus` rewrites what the FIRST call reports:
 *
 *   null          priced exactly, like every other call
 *   'unpriced'    `x-nr-cost-status: unpriced` and NO `x-nr-request-cost`
 *                 header at all — the real shape for a model the gateway
 *                 cannot price. It is never a `0` on the wire.
 */
function startMock({ mode = 'per_image', firstCostStatus = null, refuse = false, shortBy = 0, notJson = false, destroySocket = false, guardrails = null } = {}) {
  let requests = 0;
  let imageCalls = 0;
  let expectedPricedTotal = 0;
  const seenBodies = [];
  const servedImages = [];

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
      const requestId = `req-image-${requests}`;
      const url = (req.url || '').split('?')[0];

      if (url !== '/v1/images/generations') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `no mock route for ${url}` } }));
        return;
      }

      imageCalls += 1;
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        body = {};
      }
      seenBodies.push(body);

      if (refuse && imageCalls === 2) {
        // 402 with the gateway's own envelope shape: `error.type`, no
        // top-level `code`. Nothing was served, so nothing is added to the
        // expected total.
        res.writeHead(402, {
          'content-type': 'application/json',
          'x-nr-request-id': requestId,
        });
        res.end(
          JSON.stringify({
            error: { type: 'insufficient_credits', message: 'organization has insufficient credits' },
          }),
        );
        return;
      }

      if (destroySocket) {
        // The request REACHED this server — it was fully read — and then the
        // connection died with no response at all. The SDK raises a transport
        // error carrying no status and no request id: identical emptiness to a
        // local refusal, opposite meaning. A real gateway could have served
        // and charged this before the socket dropped.
        req.socket.destroy();
        return;
      }

      if (notJson === 'no-request-id') {
        // Served, billed, unparseable — AND the gateway sent no request id.
        // `requestId === null` is therefore true of a REAL CHARGE, which is
        // why the local/remote split may not lean on it. Only the HTTP status
        // still says this was served.
        expectedPricedTotal += costForCall(imageCalls);
        res.writeHead(200, {
          'content-type': 'text/plain',
          'x-nr-cost-status': 'exact',
          'x-nr-request-cost': costForCall(imageCalls).toFixed(6),
        });
        res.end('billed, unparseable, and anonymous');
        return;
      }

      if (notJson) {
        // A 200 the caller WAS BILLED FOR, whose body is not JSON. The SDK
        // raises a `configuration` error here — the same KIND the pre-send
        // validator raises — but this one carries an HTTP status and a meta,
        // because the request was served. It is the counter-example that stops
        // "kind === 'configuration'" from being used as "never sent".
        expectedPricedTotal += costForCall(imageCalls);
        res.writeHead(200, {
          'content-type': 'text/plain',
          'x-nr-request-id': requestId,
          'x-nr-model': 'mock-per_image-model',
          'x-nr-request-cost': costForCall(imageCalls).toFixed(6),
          'x-nr-cost-status': 'exact',
          'x-nr-latency-ms': String(gatewayMsForCall(imageCalls)),
        });
        res.end('this is not json, and you were charged for it');
        return;
      }

      const status = imageCalls === 1 && firstCostStatus ? firstCostStatus : 'exact';
      const cost = costForCall(imageCalls);
      const headers = {
        'content-type': 'application/json',
        'x-nr-request-id': requestId,
        'x-nr-model': `mock-${mode}-model`,
        'x-nr-cost-status': status,
        'x-nr-latency-ms': String(gatewayMsForCall(imageCalls)),
      };
      // `x-nr-guardrails` is published on the image route since gateway
      // `1c2c3df`. `guardrails` is a per-CALL list so two calls in one run get
      // DIFFERENT postures — a record that copied its neighbour's must fail
      // rather than pass on a plausible token. An entry of `null` sends no
      // header at all, which is the distinct "made no claim" state.
      if (Array.isArray(guardrails)) {
        const posture = guardrails[(imageCalls - 1) % guardrails.length];
        if (posture !== null) headers['x-nr-guardrails'] = posture;
      }
      // ABSENT, not zero, when unpriced. A `0` on the wire would be a price.
      if (status !== 'unpriced') {
        headers['x-nr-request-cost'] = cost.toFixed(6);
      }
      if (status === 'exact') {
        expectedPricedTotal += cost;
      }

      // `shortBy` models a provider that DELIVERS FEWER IMAGES THAN ASKED FOR.
      // It is a real state — the price follows what arrived, not what was
      // requested — and it is the only thing that tells a client recording
      // `data.length` apart from one recording its own `n`.
      const asked = Number.isInteger(body.n) && body.n > 0 ? body.n : 1;
      const count = Math.max(1, asked - shortBy);
      const data = [];
      const produced = [];
      for (let index = 0; index < count; index += 1) {
        // Seed by CALL as well as position, so no two images anywhere in a
        // session share bytes.
        const bytes = pngBytes(imageCalls * 8 + index);
        produced.push(bytes);
        if (mode === 'url') {
          data.push({ url: `https://mock.invalid/${requestId}-${index + 1}.png` });
        } else {
          data.push({ b64_json: bytes.toString('base64') });
        }
      }
      servedImages.push(produced);

      const payload = { created: 1_700_000_000 + imageCalls, data };

      if (mode === 'image_token') {
        // The gpt-image-* shape. The gateway prices from these, and the
        // example must record them: they are the only client-visible evidence
        // of WHAT was measured.
        payload.usage = {
          input_tokens: 40 + imageCalls,
          output_tokens: 900 + imageCalls,
          total_tokens: 940 + 2 * imageCalls,
          input_tokens_details: { text_tokens: 30 + imageCalls, image_tokens: 10 },
        };
        headers['x-nr-input-tokens'] = String(payload.usage.input_tokens);
        headers['x-nr-output-tokens'] = String(payload.usage.output_tokens);
        headers['x-nr-total-tokens'] = String(payload.usage.total_tokens);
      }

      res.writeHead(200, headers);
      res.end(JSON.stringify(payload));
    });
  });

  return {
    server,
    counts: () => ({ requests, imageCalls }),
    bodies: () => seenBodies,
    servedImages: () => servedImages,
    expectedPricedTotal: () => expectedPricedTotal,
  };
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
async function runExample({ port, model, prompts, n, size, quality, workDir, responseFormat, outDirMode }) {
  const logPath = path.join(workDir, 'image-agent.log.jsonl');
  const outDir = path.join(workDir, 'out');
  // Pre-create the output directory READ-ONLY when asked, to exercise the
  // "billed but not saved" path. `mkdir(..., { recursive: true })` succeeds on
  // an existing directory, so the example gets as far as the write.
  if (outDirMode !== undefined) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.chmodSync(outDir, outDirMode);
  }

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
    NROUTER_IMAGE_MODEL: model,
    NROUTER_IMAGE_PROMPTS: String(prompts),
    NROUTER_IMAGE_N: String(n),
    NROUTER_IMAGE_SIZE: size,
    NROUTER_IMAGE_QUALITY: quality,
    NROUTER_IMAGE_LOG: logPath,
    NROUTER_IMAGE_OUT: outDir,
  });
  if (responseFormat) env.NROUTER_IMAGE_RESPONSE_FORMAT = responseFormat;

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

  return { child, records, logPath, outDir };
}

function summaryNumber(stdout, field) {
  // Anchored to the start of a summary line so `calls` cannot match inside
  // `pricedCalls` or `unpricedCalls`.
  const match = new RegExp(`^\\s*${field}\\s+([0-9]+(?:\\.[0-9]+)?)\\s*$`, 'm').exec(stdout);
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

async function main() {
  console.log('======================================================================');
  console.log('nRouter image-agent example — mock gateway certification');
  console.log('======================================================================');

  assert.ok(
    fs.existsSync(SDK_DIST),
    `the JS SDK is not built: ${SDK_DIST} is missing. Run: (cd sdks/js && npm run build)`,
  );

  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nrouter-image-agent-'));

  try {
    // ---------------------------------------------------------------- run 1
    // A per-IMAGE model: two prompts, two images each, every call priced.
    console.log('\n[1/12] Per-image billing, fully priced (2 prompts x n=2)...');
    // Two DIFFERENT postures, and one of them is `none` — the token this suite
    // used to forbid outright, back when the image route published nothing.
    // `none` is a real verdict (the chain ran, no rule applied) and must round
    // trip; only an ABSENT header may render as `—`.
    const perImage = startMock({ mode: 'per_image', guardrails: ['pass', 'none'] });
    const perImagePort = await listen(perImage.server);
    const workA = path.join(workRoot, 'per-image');
    fs.mkdirSync(workA);
    const a = await runExample({
      port: perImagePort,
      model: 'mock-dall-e-3',
      prompts: 2,
      n: 2,
      size: '1024x1024',
      quality: 'standard',
      workDir: workA,
    });
    perImage.server.close();

    if (a.child.status !== 0) {
      fail('run 1', a.child);
      throw new Error(`example exited ${a.child.status}, expected 0`);
    }

    assert.equal(a.records.length, 2, 'one JSONL record per billed image call');
    assert.equal(perImage.counts().imageCalls, 2, 'the mock served exactly two image calls');

    const served = perImage.servedImages();
    a.records.forEach((record, callIndex) => {
      // A record with no request id cannot be joined to a spend row, which is
      // the only reason this log exists.
      assert.ok(
        typeof record.requestId === 'string' && record.requestId.length > 0,
        `record without a requestId: ${JSON.stringify(record)}`,
      );
      assert.equal(record.requestId, `req-image-${callIndex + 1}`, 'requestId came from the wrong call');
      assert.equal(record.step, 'image');
      assert.equal(record.costStatus, 'exact', `record not priced exact: ${JSON.stringify(record)}`);
      assert.equal(record.ok, true);
      assert.equal(record.priced, true);
      assert.equal(record.cost, costForCall(callIndex + 1), 'the record carries another call\'s cost');
      // THE quantity. No header carries it, so if the client does not record
      // it the count that produced the price is unrecoverable from this side.
      assert.equal(record.count, 2, `the image COUNT was not recorded: ${JSON.stringify(record)}`);
      assert.equal(record.requestedN, 2, 'the requested `n` was not recorded');
      assert.equal(record.size, '1024x1024', 'the size was not recorded');
      assert.equal(record.quality, 'standard', 'the quality was not recorded');
      // A per-image model reports no `usage` block at all.
      assert.equal(record.imageTokens, null, 'a per-image model has no image-token usage');
      assert.equal(
        record.gatewayMs,
        gatewayMsForCall(callIndex + 1),
        `gatewayMs came from the wrong call: ${JSON.stringify(record)}`,
      );
      assert.ok(Number.isInteger(record.latencyMs), 'the client clock is always measured');
      assert.ok(Array.isArray(record.files) && record.files.length === 2, 'two files per call');
      assert.equal(record.urls.length, 0, 'a b64 response records no urls');
      // Published on this route now, so it must be recorded VERBATIM and per
      // call — never defaulted, never copied from a neighbour.
      assert.equal(
        record.guardrails,
        ['pass', 'none'][callIndex],
        `the guardrail posture came from the wrong call: ${JSON.stringify(record)}`,
      );

      // The bytes claimed on disk must be the bytes that arrived. A truncated
      // decode is a corrupt image that still reports success.
      record.files.forEach((entry, imageIndex) => {
        const onDisk = fs.readFileSync(path.join(a.outDir, path.basename(entry.path)));
        const fromMock = served[callIndex][imageIndex];
        assert.equal(onDisk.length, fromMock.length, `wrong byte count for ${entry.path}`);
        assert.equal(entry.bytes, fromMock.length, `the log's byte count disagrees with the file`);
        assert.ok(onDisk.equals(fromMock), `${entry.path} is not the image the gateway returned`);
      });
    });

    // The documented file names.
    for (const name of ['image-1-1.png', 'image-1-2.png', 'image-2-1.png', 'image-2-2.png']) {
      assert.ok(fs.existsSync(path.join(a.outDir, name)), `${name} was not written`);
    }

    // A non-gpt-image model gets an explicit `response_format`, because its
    // provider default is `url` — a link this example will not download.
    for (const body of perImage.bodies()) {
      assert.equal(body.response_format, 'b64_json', 'a per-image model must be asked for b64_json');
      assert.equal(body.n, 2);
      assert.equal(body.size, '1024x1024');
      assert.equal(body.quality, 'standard');
    }

    const expectedTotal = perImage.expectedPricedTotal();
    const reportedTotal = summaryNumber(a.child.stdout, 'pricedTotalUsd');
    assert.equal(
      reportedTotal.toFixed(8),
      expectedTotal.toFixed(8),
      `pricedTotalUsd ${reportedTotal} != mock total ${expectedTotal}`,
    );
    assert.equal(summaryNumber(a.child.stdout, 'pricedCalls'), 2);
    assert.equal(summaryNumber(a.child.stdout, 'unpricedCalls'), 0);
    assert.equal(summaryNumber(a.child.stdout, 'failedCalls'), 0);
    assert.equal(summaryNumber(a.child.stdout, 'calls'), 2);
    assert.equal(summaryNumber(a.child.stdout, 'imagesReturned'), 4);
    assert.ok(
      !a.child.stdout.includes('TOTAL INCOMPLETE'),
      'a fully priced session must not be reported as incomplete',
    );

    // The per-call line the operator actually reads.
    assert.ok(/\[image\]/.test(a.child.stdout), 'no per-call [image] line printed');
    assert.ok(/n=2/.test(a.child.stdout), 'the per-call line does not print the image count');
    assert.ok(/1024x1024/.test(a.child.stdout), 'the per-call line does not print the size');
    assert.ok(
      new RegExp(`gw=${gatewayMsForCall(1)}ms`).test(a.child.stdout),
      `the per-call line does not print the gateway latency:\n${a.child.stdout}`,
    );
    assert.ok(/client=\d+ms/.test(a.child.stdout), 'the per-call line does not print the client latency');
    assert.ok(/guardrails=pass/.test(a.child.stdout), 'the per-call line must print the posture');
    assert.ok(
      /guardrails=none/.test(a.child.stdout),
      '`none` is a real verdict the gateway sends and must be printed, not suppressed',
    );

    console.log(
      `      calls=${a.records.length} images=4 pricedTotalUsd=${reportedTotal.toFixed(8)} (mock ${expectedTotal.toFixed(8)})`,
    );

    // ---------------------------------------------------------------- run 2
    // A gpt-image-class model: priced per image TOKEN, and the usage block is
    // the only client-visible evidence of what was measured.
    console.log('\n[2/12] Per-image-token billing with a usage block (1 prompt)...');
    const tokenPriced = startMock({ mode: 'image_token' });
    const tokenPort = await listen(tokenPriced.server);
    const workB = path.join(workRoot, 'image-token');
    fs.mkdirSync(workB);
    const b = await runExample({
      port: tokenPort,
      model: 'gpt-image-1-mini',
      prompts: 1,
      n: 1,
      size: '1024x1024',
      quality: 'low',
      workDir: workB,
    });
    tokenPriced.server.close();

    if (b.child.status !== 0) {
      fail('run 2', b.child);
      throw new Error(`example exited ${b.child.status}, expected 0`);
    }

    assert.equal(b.records.length, 1);
    const tokenRecord = b.records[0];
    assert.equal(tokenRecord.costStatus, 'exact');
    assert.equal(tokenRecord.cost, costForCall(1));
    assert.equal(tokenRecord.count, 1);
    assert.equal(tokenRecord.quality, 'low');
    assert.ok(tokenRecord.imageTokens, 'the usage block must be recorded for a token-priced model');
    assert.equal(tokenRecord.imageTokens.inputTokens, 41);
    assert.equal(tokenRecord.imageTokens.outputTokens, 901);
    assert.deepEqual(tokenRecord.imageTokens.inputTokensDetails, { text_tokens: 31, image_tokens: 10 });
    // The headers carry the same numbers; both are recorded, from their own
    // sources, because either can be absent on its own.
    assert.equal(tokenRecord.inputTokens, 41);
    assert.equal(tokenRecord.outputTokens, 901);
    assert.ok(/tokens=41\/901/.test(b.child.stdout), 'the per-call line does not print the token usage');
    // THE OTHER STATE, and the one that must never be invented. This mock sends
    // no `x-nr-guardrails` header, so the gateway made NO CLAIM: the record is
    // `null` and the line renders `—`. Printing `none` here would manufacture a
    // verdict — "the chain ran and no rule applied" — out of silence.
    assert.equal(tokenRecord.guardrails, null, 'an absent header is a null claim, never a posture');
    assert.ok(
      /guardrails=—/.test(b.child.stdout),
      'an absent guardrail posture must render as — , never as "none"',
    );

    // A gpt-image-* model must NOT be sent `response_format`: the provider
    // rejects the parameter outright and the whole call 400s.
    assert.equal(
      Object.prototype.hasOwnProperty.call(tokenPriced.bodies()[0], 'response_format'),
      false,
      'gpt-image-* must not be sent response_format',
    );
    assert.ok(fs.existsSync(path.join(b.outDir, 'image-1-1.png')), 'image-1-1.png was not written');

    console.log(`      calls=1 imageTokens=${tokenRecord.imageTokens.inputTokens}/${tokenRecord.imageTokens.outputTokens}`);

    // ---------------------------------------------------------------- run 3
    // One call comes back unpriced. The session still succeeds — unpriced is a
    // served request, not an error — but the total is INCOMPLETE and must say
    // so rather than silently under-reporting by one call.
    console.log('\n[3/12] An unpriced image call (2 prompts)...');
    const mixed = startMock({ mode: 'per_image', firstCostStatus: 'unpriced' });
    const mixedPort = await listen(mixed.server);
    const workC = path.join(workRoot, 'unpriced');
    fs.mkdirSync(workC);
    const c = await runExample({
      port: mixedPort,
      model: 'mock-dall-e-3',
      prompts: 2,
      n: 1,
      size: '1024x1024',
      quality: 'standard',
      workDir: workC,
    });
    mixed.server.close();

    if (c.child.status !== 0) {
      fail('run 3', c.child);
      throw new Error(`example exited ${c.child.status}, expected 0 (unpriced is not a failure)`);
    }

    const unpricedRecords = c.records.filter((r) => r.costStatus !== 'exact');
    assert.equal(unpricedRecords.length, 1, 'exactly one call should be unpriced');
    assert.equal(unpricedRecords[0].costStatus, 'unpriced');
    // Never a zero. `null` is what "the gateway did not price this" looks like.
    assert.equal(unpricedRecords[0].cost, null, 'an unpriced call must log a null cost, never 0');
    assert.equal(unpricedRecords[0].priced, false);
    assert.ok(
      unpricedRecords[0].requestId && unpricedRecords[0].requestId.length > 0,
      'an unpriced call still has a request id and still reaches a spend row',
    );
    // The IMAGE was still delivered and still written. Unpriced is about the
    // price, never about the goods.
    assert.equal(unpricedRecords[0].count, 1);
    assert.ok(fs.existsSync(path.join(c.outDir, 'image-1-1.png')), 'an unpriced call still delivers');

    // BOTH buckets. A summary that counted the unpriced call as priced would
    // still satisfy an `unpricedCalls` assertion on its own; it is the
    // COUNTING, not the arithmetic, that drifts first — and it drifts silently
    // whenever the excluded call happens to carry no amount.
    assert.equal(summaryNumber(c.child.stdout, 'pricedCalls'), 1);
    assert.equal(summaryNumber(c.child.stdout, 'unpricedCalls'), 1);
    assert.ok(
      c.child.stdout.includes('TOTAL INCOMPLETE'),
      'a session with an unpriced call must be reported as TOTAL INCOMPLETE',
    );

    const mixedExpected = mixed.expectedPricedTotal();
    const mixedReported = summaryNumber(c.child.stdout, 'pricedTotalUsd');
    assert.equal(
      mixedReported.toFixed(8),
      mixedExpected.toFixed(8),
      `pricedTotalUsd ${mixedReported} != mock priced total ${mixedExpected}`,
    );
    // Prove the exclusion is observable: had the unpriced call been summed as
    // its own (absent) amount, or as zero, the two would be indistinguishable
    // unless the priced subset is non-zero and the excluded call is not.
    assert.ok(mixedExpected > 0, 'the second call was priced and must be in the total');
    assert.equal(
      mixedReported.toFixed(8),
      costForCall(2).toFixed(8),
      'the total must be exactly the priced call, with nothing added for the unpriced one',
    );

    console.log(`      calls=${c.records.length} pricedTotalUsd=${mixedReported.toFixed(8)} unpricedCalls=1 (TOTAL INCOMPLETE)`);

    // ---------------------------------------------------------------- run 4
    // A cost status this SDK does not know, CARRYING a cost. `isPriced()`
    // accepts `exact` only, so the amount must be EXCLUDED and announced —
    // never summed on the strength of the number alone. Without this run any
    // code that checked `cost !== null` instead of the status would sum a
    // future third status silently, and run 3 could not tell the difference
    // because an `unpriced` call carries no amount to sum.
    console.log('\n[4/12] An unrecognised cost status carrying an amount (2 prompts)...');
    const odd = startMock({ mode: 'per_image', firstCostStatus: 'estimated' });
    const oddPort = await listen(odd.server);
    const workF = path.join(workRoot, 'estimated');
    fs.mkdirSync(workF);
    const f = await runExample({
      port: oddPort,
      model: 'mock-dall-e-3',
      prompts: 2,
      n: 1,
      size: '1024x1024',
      quality: 'standard',
      workDir: workF,
    });
    odd.server.close();

    if (f.child.status !== 0) {
      fail('run 4', f.child);
      throw new Error(`example exited ${f.child.status}, expected 0`);
    }

    const oddRecords = f.records.filter((r) => r.costStatus === 'estimated');
    assert.equal(oddRecords.length, 1, 'the mock served exactly one `estimated` call');
    assert.equal(typeof oddRecords[0].cost, 'number', 'the mock DID send a cost header');
    assert.equal(oddRecords[0].priced, false, 'an unrecognised cost status must not count as priced');
    assert.equal(summaryNumber(f.child.stdout, 'pricedCalls'), 1);
    assert.equal(summaryNumber(f.child.stdout, 'unpricedCalls'), 1);
    assert.ok(f.child.stdout.includes('TOTAL INCOMPLETE'));

    const oddExpected = odd.expectedPricedTotal();
    const oddReported = summaryNumber(f.child.stdout, 'pricedTotalUsd');
    assert.equal(
      oddReported.toFixed(8),
      oddExpected.toFixed(8),
      `pricedTotalUsd ${oddReported} counted an \`estimated\` amount it must exclude`,
    );
    // Prove the exclusion is OBSERVABLE: had it been summed, the total would
    // have been higher by exactly this call's price. Without this line the
    // assertion above passes whether the amount was excluded or was zero.
    assert.ok(
      Math.abs(oddReported - (oddExpected + costForCall(1))) > 1e-12,
      'the assertion above cannot distinguish summed from excluded',
    );

    console.log(
      `      calls=${f.records.length} pricedTotalUsd=${oddReported.toFixed(8)} (excludes the estimated $${costForCall(1).toFixed(6)})`,
    );

    // ---------------------------------------------------------------- run 5
    // A refusal mid-session. Two properties, and the second is the one that is
    // easy to lose: the process must exit NON-ZERO so a scripted caller
    // notices, AND it must still report the money it had already spent before
    // the refusal.
    console.log('\n[5/12] A refused call mid-session (2 prompts)...');
    const refused = startMock({ mode: 'per_image', refuse: true });
    const refusedPort = await listen(refused.server);
    const workD = path.join(workRoot, 'refused');
    fs.mkdirSync(workD);
    const d = await runExample({
      port: refusedPort,
      model: 'mock-dall-e-3',
      prompts: 2,
      n: 1,
      size: '1024x1024',
      quality: 'standard',
      workDir: workD,
    });
    refused.server.close();

    assert.equal(d.child.status, 1, 'a refused call must exit non-zero');
    // The typed refusal, not a stack trace.
    assert.ok(/credit/.test(d.child.stderr), `the error kind was not reported:\n${d.child.stderr}`);
    assert.ok(
      /insufficient credits/i.test(d.child.stderr),
      `the refusal message was not reported:\n${d.child.stderr}`,
    );
    // `limitSource` is what tells an operator WHICH limit measured a 429; it is
    // null on a 402 and must still be reported rather than omitted.
    assert.ok(/limitSource/.test(d.child.stderr), 'the refusal report omits limitSource');

    assert.equal(d.records.length, 2, 'the failed call is logged too');
    const failedRecord = d.records[1];
    assert.equal(failedRecord.ok, false);
    assert.equal(failedRecord.priced, false);
    assert.equal(failedRecord.cost, null);
    assert.ok(
      typeof failedRecord.error === 'string' && failedRecord.error.length > 0,
      'a failed call must log why',
    );
    assert.ok(failedRecord.requestId, 'a refusal still carries a request id to join on');
    // THE OTHER SIDE of the local/remote split. This call DID reach the
    // gateway, so `billed` must be the absence of a claim, never the FACT
    // `false`: the provider may have run before the refusal. A record that
    // says `billed: false` here tells the operator there is nothing to
    // reconcile when there may well be.
    assert.equal(failedRecord.sentToGateway, true, 'a 402 came back WITH a request id');
    assert.equal(
      failedRecord.billed,
      true,
      'anything that reached the gateway counts as billed until reconciled — only a proven local refusal is `false`',
    );
    assert.equal(failedRecord.errorKind, 'credit');

    // Failure is its OWN bucket: a refused call was not "served without a
    // price", and telling the operator it was sends them to the wrong page.
    assert.equal(summaryNumber(d.child.stdout, 'failedCalls'), 1);
    assert.equal(summaryNumber(d.child.stdout, 'unpricedCalls'), 0);
    assert.ok(d.child.stdout.includes('TOTAL INCOMPLETE'));
    assert.ok(
      /\b1 call\(s\) FAILED and may still have been billed/.test(d.child.stdout),
      'the summary must distinguish a failed call from an unpriced one, and count it',
    );

    const refusedReported = summaryNumber(d.child.stdout, 'pricedTotalUsd');
    assert.equal(
      refusedReported.toFixed(8),
      refused.expectedPricedTotal().toFixed(8),
      'the money already spent before the refusal must still be reported',
    );
    assert.ok(refusedReported > 0, 'one call was billed before the refusal');

    console.log(`      exit=1 calls=${d.records.length} pricedTotalUsd=${refusedReported.toFixed(8)} failedCalls=1`);

    // ---------------------------------------------------------------- run 6
    // A `url` response. The example records the link and downloads NOTHING:
    // fetching an arbitrary gateway-supplied URL from an example is an egress
    // the reader did not ask for, and the link expires anyway.
    console.log('\n[6/12] A url-shaped response is recorded, never downloaded (1 prompt)...');
    const urls = startMock({ mode: 'url' });
    const urlPort = await listen(urls.server);
    const workE = path.join(workRoot, 'urls');
    fs.mkdirSync(workE);
    const e = await runExample({
      port: urlPort,
      model: 'mock-dall-e-3',
      prompts: 1,
      n: 2,
      size: '1024x1024',
      quality: 'standard',
      workDir: workE,
      responseFormat: 'url',
    });
    urls.server.close();

    if (e.child.status !== 0) {
      fail('run 6', e.child);
      throw new Error(`example exited ${e.child.status}, expected 0`);
    }

    assert.equal(e.records.length, 1);
    const urlRecord = e.records[0];
    assert.equal(urlRecord.count, 2, 'a url response still delivered two images');
    assert.equal(urlRecord.files.length, 0, 'nothing is written to disk for a url response');
    assert.equal(urlRecord.urls.length, 2, 'both urls must be recorded');
    assert.ok(
      urlRecord.urls.every((u) => u.startsWith('https://mock.invalid/')),
      `the urls were not recorded verbatim: ${JSON.stringify(urlRecord.urls)}`,
    );
    // Nothing on disk at all: an example that quietly fetched them would have
    // written files here.
    const written = fs.existsSync(e.outDir) ? fs.readdirSync(e.outDir) : [];
    assert.deepEqual(written, [], `a url response must download nothing, found: ${written}`);
    assert.ok(
      /not downloaded/i.test(e.child.stdout),
      'the example must SAY it skipped the download rather than silently writing nothing',
    );
    assert.equal(summaryNumber(e.child.stdout, 'imagesReturned'), 2);

    console.log(`      calls=1 urls=${urlRecord.urls.length} filesWritten=0`);

    // ---------------------------------------------------------------- run 7
    // The provider DELIVERS FEWER IMAGES THAN ASKED FOR. Three requested, two
    // returned. The price follows what arrived, so `count` must be what
    // arrived — a client that recorded its own `n` instead would report a
    // quantity the spend row disagrees with, and since no header carries the
    // quantity, nothing else would ever contradict it.
    console.log('\n[7/12] A short delivery: n=3 asked, 2 returned (1 prompt)...');
    const short = startMock({ mode: 'per_image', shortBy: 1 });
    const shortPort = await listen(short.server);
    const workG = path.join(workRoot, 'short');
    fs.mkdirSync(workG);
    const g = await runExample({
      port: shortPort,
      model: 'mock-dall-e-3',
      prompts: 1,
      n: 3,
      size: '1024x1024',
      quality: 'standard',
      workDir: workG,
    });
    short.server.close();

    if (g.child.status !== 0) {
      fail('run 7', g.child);
      throw new Error(`example exited ${g.child.status}, expected 0`);
    }

    assert.equal(g.records.length, 1);
    const shortRecord = g.records[0];
    assert.equal(shortRecord.requestedN, 3, 'the request is recorded as made');
    assert.equal(shortRecord.count, 2, 'the DELIVERED count must be recorded, not the requested one');
    assert.notEqual(
      shortRecord.count,
      shortRecord.requestedN,
      'this run only proves anything while the two numbers differ',
    );
    assert.equal(shortRecord.files.length, 2, 'two images arrived, so two files exist');
    assert.equal(summaryNumber(g.child.stdout, 'imagesReturned'), 2);
    assert.ok(/n=2/.test(g.child.stdout), 'the per-call line must print what arrived');
    assert.ok(!/n=3/.test(g.child.stdout), 'the per-call line must not print what was merely asked for');
    assert.deepEqual(
      fs.readdirSync(g.outDir).sort(),
      ['image-1-1.png', 'image-1-2.png'],
      'a short delivery must not leave a phantom third file',
    );

    console.log(`      calls=1 requestedN=3 delivered=${shortRecord.count} files=${shortRecord.files.length}`);

    // ---------------------------------------------------------------- run 8
    // THE CALL SUCCEEDED AND WAS BILLED; THE DISK WRITE FAILED.
    //
    // This is the money property that is easiest to lose, because the obvious
    // shape loses it: if a post-response failure falls into the same `catch`
    // that handles a refused CALL, the record is rebuilt from the ERROR — and
    // a filesystem error is not an `nRouterError`, so cost, requestId, model
    // and costStatus all come back `null`. A call that was charged for
    // vanishes from `pricedTotalUsd` and, worse, loses the request id that is
    // the only way to find it on the spend row.
    //
    // So: the money record must survive intact, and the process must still
    // exit non-zero, because the customer paid for images they do not have.
    console.log('\n[8/12] Billed, delivered, but the disk write fails (1 prompt)...');
    const unwritable = startMock({ mode: 'per_image' });
    const unwritablePort = await listen(unwritable.server);
    const workH = path.join(workRoot, 'unwritable');
    fs.mkdirSync(workH);
    const h = await runExample({
      port: unwritablePort,
      model: 'mock-dall-e-3',
      prompts: 1,
      n: 1,
      size: '1024x1024',
      quality: 'standard',
      workDir: workH,
      outDirMode: 0o555,
    });
    unwritable.server.close();
    // Restore write permission so the temp tree can be removed.
    fs.chmodSync(path.join(workH, 'out'), 0o755);

    assert.equal(h.child.status, 1, 'undelivered images must exit non-zero');
    assert.equal(h.records.length, 1, 'the billed call must still be recorded');
    const saveFailed = h.records[0];
    // Every money and identity field, from `result.meta` — NOT from the error.
    assert.equal(saveFailed.ok, true, 'the CALL succeeded; only the write failed');
    assert.equal(saveFailed.priced, true, 'a billed call stays in the priced bucket');
    assert.equal(saveFailed.cost, costForCall(1), 'the cost must survive a write failure');
    assert.equal(saveFailed.costStatus, 'exact');
    assert.equal(
      saveFailed.requestId,
      'req-image-1',
      'the spend-row join key must survive a write failure',
    );
    assert.ok(typeof saveFailed.model === 'string' && saveFailed.model.length > 0);
    assert.equal(saveFailed.gatewayMs, gatewayMsForCall(1));
    // The image WAS delivered in the body — `count` describes the response,
    // never the filesystem.
    assert.equal(saveFailed.count, 1, 'the image was delivered; only the write failed');
    assert.equal(saveFailed.files.length, 0, 'nothing reached disk');
    assert.equal(saveFailed.saveErrors.length, 1, 'the write failure must be recorded');
    assert.ok(
      /EACCES|permission denied/i.test(saveFailed.saveErrors[0].error),
      `the write failure must say why: ${JSON.stringify(saveFailed.saveErrors[0])}`,
    );

    // The money is REPORTED, not lost.
    assert.equal(
      summaryNumber(h.child.stdout, 'pricedTotalUsd').toFixed(8),
      unwritable.expectedPricedTotal().toFixed(8),
      'a write failure must not erase the price from the session total',
    );
    assert.equal(summaryNumber(h.child.stdout, 'pricedCalls'), 1);
    assert.equal(summaryNumber(h.child.stdout, 'failedCalls'), 0, 'the CALL did not fail');
    assert.equal(summaryNumber(h.child.stdout, 'saveErrors'), 1);
    assert.ok(
      /not saved|could not write/i.test(h.child.stdout + h.child.stderr),
      'the operator must be told the images they paid for are not on disk',
    );

    console.log(
      `      exit=1 pricedTotalUsd=${summaryNumber(h.child.stdout, 'pricedTotalUsd').toFixed(8)} saveErrors=1 (money intact)`,
    );

    // ---------------------------------------------------------------- run 9
    // THE SDK REFUSES BEFORE SENDING. `n=99` is outside 1..10, and since
    // `b212c01` `image()` throws `nRouterConfigurationError` from
    // `validateImageParams` — no socket, no request id, no reservation, no
    // spend row.
    //
    // It arrives as an `nRouterError`, so the obvious shape files it with the
    // gateway refusals and tells the operator the call "FAILED and may still
    // have been billed". That sentence sends someone to reconcile a charge
    // that cannot exist, and on a wire holding $0.35 per image it is exactly
    // the wrong direction to be wrong in. A local refusal is its OWN class:
    // nothing was sent, so nothing was billed, and the accounting is COMPLETE
    // even though the run failed.
    console.log('\n[9/12] The SDK refuses locally before sending (n=99)...');
    const neverSent = startMock({ mode: 'per_image' });
    const neverSentPort = await listen(neverSent.server);
    const workI = path.join(workRoot, 'never-sent');
    fs.mkdirSync(workI);
    const i = await runExample({
      port: neverSentPort,
      model: 'mock-dall-e-3',
      prompts: 2,
      n: 99,
      size: '1024x1024',
      quality: 'standard',
      workDir: workI,
    });
    neverSent.server.close();

    assert.equal(i.child.status, 1, 'a refused run must exit non-zero');
    // THE proof, and the only one that cannot be faked by a well-worded log:
    // the gateway was never spoken to at all.
    assert.equal(
      neverSent.counts().requests,
      0,
      'the SDK must refuse BEFORE the socket — the mock saw a request',
    );

    assert.equal(i.records.length, 1, 'the local refusal is recorded once, and the loop stops');
    const local = i.records[0];
    assert.equal(local.ok, false);
    assert.equal(local.priced, false);
    assert.equal(local.sentToGateway, false, 'nothing left this process');
    assert.equal(
      local.billed,
      false,
      'the ONLY state that licenses "nothing was billed" — no socket was opened',
    );
    assert.equal(local.requestId, null, 'there is no request id to join on, because there is no request');
    assert.equal(local.cost, null);
    assert.equal(local.costStatus, null);
    assert.equal(local.errorKind, 'configuration', 'the SDK refusal kind must be recorded');
    assert.ok(
      /n` must be an integer from 1 through 10/.test(local.error),
      `the refusal reason must be recorded verbatim: ${JSON.stringify(local.error)}`,
    );

    // A gateway refusal says "may still have been billed" because it may have.
    // A local one MUST NOT: there is no charge to go looking for.
    const localOut = i.child.stdout + i.child.stderr;
    assert.ok(
      !/may still have been billed/.test(localOut),
      'a request that never left the process must not be reported as possibly billed',
    );
    assert.ok(
      /never reached the gateway|nothing was billed/i.test(localOut),
      `the summary must say the request never left: \n${localOut}`,
    );
    assert.equal(summaryNumber(i.child.stdout, 'locallyRefused'), 1);
    assert.equal(summaryNumber(i.child.stdout, 'failedCalls'), 0, 'no call reached the gateway to fail');
    assert.equal(summaryNumber(i.child.stdout, 'pricedTotalUsd'), 0);
    // The MONEY accounting is complete — nothing was spent that is unaccounted
    // for. The run failed; the ledger did not.
    assert.ok(
      !/TOTAL INCOMPLETE/.test(i.child.stdout),
      'a local refusal spends nothing, so the total is not incomplete',
    );

    console.log(
      `      exit=1 gatewayRequests=${neverSent.counts().requests} ` +
        `sentToGateway=${local.sentToGateway} billed=${local.billed} (no charge to reconcile)`,
    );

    // --------------------------------------------------------------- run 10
    // THE COUNTER-EXAMPLE TO RUN 9, and the reason its discriminator is three
    // conditions rather than one.
    //
    // The gateway serves a 200 with a non-JSON body. `image()` raises a
    // `configuration` error — the SAME KIND `validateImageParams` raises — but
    // this request was SENT, SERVED and BILLED, and the error carries an HTTP
    // status and a request id to prove it. Classify on the kind alone and this
    // charge is filed as "never reached the gateway, nothing was billed", and
    // the operator is told not to go looking for a bill that exists.
    console.log('\n[10/12] A billed 2xx with a non-JSON body is NOT a local refusal (1 prompt)...');
    const wrongType = startMock({ mode: 'per_image', notJson: true });
    const wrongTypePort = await listen(wrongType.server);
    const workJ = path.join(workRoot, 'not-json');
    fs.mkdirSync(workJ);
    const j = await runExample({
      port: wrongTypePort,
      model: 'mock-dall-e-3',
      prompts: 1,
      n: 1,
      size: '1024x1024',
      quality: 'standard',
      workDir: workJ,
    });
    wrongType.server.close();

    assert.equal(j.child.status, 1, 'an unparseable response is a failed run');
    assert.equal(wrongType.counts().requests, 1, 'this one really was sent');
    assert.equal(j.records.length, 1);
    const servedThenUnparseable = j.records[0];
    assert.equal(servedThenUnparseable.errorKind, 'configuration', 'the SDK raises the same KIND as a local refusal');
    assert.equal(
      servedThenUnparseable.sentToGateway,
      true,
      'a `configuration` error carrying a status and a request id was SENT — the kind alone must not decide',
    );
    assert.equal(servedThenUnparseable.billed, true, 'it was served, so it counts as billed');
    assert.ok(servedThenUnparseable.requestId, 'there IS a request id, and it is how the charge is found');
    assert.equal(summaryNumber(j.child.stdout, 'locallyRefused'), 0, 'this was not a local refusal');
    assert.equal(summaryNumber(j.child.stdout, 'failedCalls'), 1);
    assert.ok(
      /\b1 call\(s\) FAILED and may still have been billed/.test(j.child.stdout),
      'a served-then-unparseable call MUST be counted as possibly billed',
    );
    assert.ok(
      !/NEVER REACHED THE GATEWAY/.test(j.child.stdout),
      'a served call must never be reported as never sent',
    );

    console.log(
      `      exit=1 sentToGateway=${servedThenUnparseable.sentToGateway} ` +
        `billed=${servedThenUnparseable.billed} requestId=${servedThenUnparseable.requestId} ` +
        '(a real charge to reconcile)',
    );

    // --------------------------------------------------------------- run 11
    // The same served-and-billed failure as run 10, but the gateway sent NO
    // request id. This is why `refusedBeforeSending` does not test for one: a
    // missing request id is true of a real charge too, so a discriminator that
    // used it would file this bill as "never sent, nothing billed" — the worst
    // possible reading, because the operator is told to stop looking for a
    // charge they cannot even search for by id.
    console.log('\n[11/12] Served and billed with NO request id is still not a local refusal...');
    const anonymous = startMock({ mode: 'per_image', notJson: 'no-request-id' });
    const anonymousPort = await listen(anonymous.server);
    const workK = path.join(workRoot, 'anonymous');
    fs.mkdirSync(workK);
    const k = await runExample({
      port: anonymousPort,
      model: 'mock-dall-e-3',
      prompts: 1,
      n: 1,
      size: '1024x1024',
      quality: 'standard',
      workDir: workK,
    });
    anonymous.server.close();

    assert.equal(k.child.status, 1);
    assert.equal(anonymous.counts().requests, 1, 'this one was sent');
    assert.equal(k.records.length, 1);
    const anon = k.records[0];
    assert.equal(anon.requestId, null, 'the mock deliberately sent no request id');
    assert.equal(anon.errorKind, 'configuration');
    assert.equal(
      anon.sentToGateway,
      null,
      'no request id is UNKNOWN, never `false` — `false` is reserved for a proven local refusal',
    );
    assert.equal(
      anon.billed,
      true,
      'unknown resolves to BILLED: a served response may have been charged, id or no id',
    );
    assert.equal(summaryNumber(k.child.stdout, 'locallyRefused'), 0);
    assert.equal(summaryNumber(k.child.stdout, 'failedCalls'), 1);
    // The COUNT, not just the sentence. "0 call(s) FAILED and may still have
    // been billed" matches a bare /may still have been billed/ while telling
    // the operator the opposite of the truth.
    assert.ok(
      /\b1 call\(s\) FAILED and may still have been billed/.test(k.child.stdout),
      `an unknown outcome must be COUNTED as possibly billed:\n${k.child.stdout}`,
    );

    console.log(
      `      exit=1 requestId=${anon.requestId} sentToGateway=${anon.sentToGateway} ` +
        `billed=${anon.billed} (unknown, and unknown means billed)`,
    );

    // --------------------------------------------------------------- run 12
    // THE `null` BRANCH. The connection dies after the request was fully sent.
    // The resulting transport error carries no status and no request id —
    // EXACTLY the emptiness a local refusal produces — and the two must not be
    // confused, because a dropped socket may sit on top of a request the
    // gateway received, served and charged for.
    //
    // So: `sentToGateway: null`, and `billed: true`. Unknown resolves toward
    // the charge existing, never away from it.
    console.log('\n[12/12] The socket dies mid-request: unknown, and therefore BILLED...');
    const dropped = startMock({ mode: 'per_image', destroySocket: true });
    const droppedPort = await listen(dropped.server);
    const workL = path.join(workRoot, 'dropped');
    fs.mkdirSync(workL);
    const l = await runExample({
      port: droppedPort,
      model: 'mock-dall-e-3',
      prompts: 1,
      n: 1,
      size: '1024x1024',
      quality: 'standard',
      workDir: workL,
    });
    dropped.server.close();

    assert.equal(l.child.status, 1);
    assert.equal(dropped.counts().requests, 1, 'the request DID reach the server before the socket died');
    assert.equal(l.records.length, 1);
    const lost = l.records[0];
    assert.equal(lost.requestId, null, 'a dead socket returns no request id');
    assert.equal(lost.costStatus, null);
    assert.notEqual(lost.errorKind, 'configuration', 'a dead socket is a transport failure, not a config one');
    assert.equal(
      lost.sentToGateway,
      null,
      'sent, no usable answer — neither the proven `false` nor the confirmed `true`',
    );
    assert.equal(
      lost.billed,
      true,
      'UNKNOWN RESOLVES TO BILLED: the gateway may have served and charged this before the socket died',
    );
    assert.equal(summaryNumber(l.child.stdout, 'locallyRefused'), 0, 'a dead socket is not a local refusal');
    assert.equal(summaryNumber(l.child.stdout, 'failedCalls'), 1);
    assert.ok(
      /\b1 call\(s\) FAILED and may still have been billed/.test(l.child.stdout),
      `an unknown outcome must be COUNTED as possibly billed, not merely mentioned:\n${l.child.stdout}`,
    );
    assert.ok(
      !/NEVER REACHED THE GATEWAY/.test(l.child.stdout),
      'a dead socket must never be reported as never sent',
    );

    console.log(
      `      exit=1 requestId=${lost.requestId} sentToGateway=${lost.sentToGateway} ` +
        `billed=${lost.billed} (unknown resolves toward the charge)`,
    );

    console.log('\n======================================================================');
    console.log('Result: PASS (image-agent cost, usage, count and logging verified)');
    console.log('======================================================================');
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
