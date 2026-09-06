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
function startMock({ mode = 'per_image', firstCostStatus = null, refuse = false, shortBy = 0 } = {}) {
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

      const status = imageCalls === 1 && firstCostStatus ? firstCostStatus : 'exact';
      const cost = costForCall(imageCalls);
      const headers = {
        'content-type': 'application/json',
        'x-nr-request-id': requestId,
        'x-nr-model': `mock-${mode}-model`,
        'x-nr-cost-status': status,
        'x-nr-latency-ms': String(gatewayMsForCall(imageCalls)),
      };
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
async function runExample({ port, model, prompts, n, size, quality, workDir, responseFormat }) {
  const logPath = path.join(workDir, 'image-agent.log.jsonl');
  const outDir = path.join(workDir, 'out');

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
    console.log('\n[1/7] Per-image billing, fully priced (2 prompts x n=2)...');
    const perImage = startMock({ mode: 'per_image' });
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
      // The gateway publishes NO guardrail posture on the image route, so
      // `meta.guardrails` is null: "the gateway made no claim". Recording it
      // as `none` would read as "the chain ran and found nothing", which is a
      // reassurance nobody gave.
      assert.equal(record.guardrails, null, 'the image route publishes no guardrail posture');

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
    assert.ok(
      /guardrails=—/.test(a.child.stdout),
      'an absent guardrail posture must render as — , never as "none"',
    );
    assert.ok(
      !/guardrails=none/.test(a.child.stdout),
      '`none` is an explicit posture the image route never sends; printing it invents a reassurance',
    );

    console.log(
      `      calls=${a.records.length} images=4 pricedTotalUsd=${reportedTotal.toFixed(8)} (mock ${expectedTotal.toFixed(8)})`,
    );

    // ---------------------------------------------------------------- run 2
    // A gpt-image-class model: priced per image TOKEN, and the usage block is
    // the only client-visible evidence of what was measured.
    console.log('\n[2/7] Per-image-token billing with a usage block (1 prompt)...');
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
    console.log('\n[3/7] An unpriced image call (2 prompts)...');
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
    console.log('\n[4/7] An unrecognised cost status carrying an amount (2 prompts)...');
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
    console.log('\n[5/7] A refused call mid-session (2 prompts)...');
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

    // Failure is its OWN bucket: a refused call was not "served without a
    // price", and telling the operator it was sends them to the wrong page.
    assert.equal(summaryNumber(d.child.stdout, 'failedCalls'), 1);
    assert.equal(summaryNumber(d.child.stdout, 'unpricedCalls'), 0);
    assert.ok(d.child.stdout.includes('TOTAL INCOMPLETE'));
    assert.ok(
      /FAILED and may still have been billed/.test(d.child.stdout),
      'the summary must distinguish a failed call from an unpriced one',
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
    console.log('\n[6/7] A url-shaped response is recorded, never downloaded (1 prompt)...');
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
    console.log('\n[7/7] A short delivery: n=3 asked, 2 returned (1 prompt)...');
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
