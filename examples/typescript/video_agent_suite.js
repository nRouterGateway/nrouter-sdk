#!/usr/bin/env node
/**
 * Mock-gateway certification for examples/typescript/video-agent.
 *
 * The example under test starts a real video generation job, which is the most
 * expensive single call this gateway serves — a floor of $3.00 held at create,
 * before a frame is rendered. That price is exactly why nobody exercises it in
 * CI, and exactly why the accounting has to be certified somewhere. So the
 * gateway is stood up locally instead: a `node:http` server that speaks the
 * three video routes and stamps the headers a real one does — and, on the two
 * collection routes, deliberately stamps NO cost headers at all.
 *
 * That absence is the whole subject of this suite. `POST /v1/videos` bills;
 * `GET /v1/videos/{id}` and `GET /v1/videos/{id}/content` are free by design
 * (gateway `src/http/videos.rs`: "Create bills; collection is free"). A free
 * call and an UNPRICED call look identical on the wire — no `x-nr-request-cost`
 * header either way — and conflating them is the specific defect this suite
 * exists to catch:
 *
 *   - counted as unpriced, a 40-poll render reports 40 calls the gateway
 *     "failed to price" and sends the operator to chase a pricing bug that
 *     does not exist;
 *   - counted as $0.00, the client asserts a price for a call the gateway
 *     never priced, which is the confident zero Rule #28 forbids.
 *
 * The right answer is a third bucket: FREE, with `cost: null`, excluded from
 * the total and excluded from the unpriced count. Every assertion below is
 * about a property that costs money or misleads an operator if it is wrong.
 *
 * No network, no key, no credits. Runs in about a second.
 *
 *   node examples/typescript/video_agent_suite.js
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

const EXAMPLE = path.resolve(__dirname, 'video-agent', 'video-agent.mjs');
const SDK_DIST = path.resolve(__dirname, '..', '..', 'sdks', 'js', 'dist', 'index.mjs');

// The mock's price for the ONE billed call. Deliberately not a round number and
// deliberately not zero: a summation bug that dropped the create cost would
// still produce `0.00000000`, and a total of zero is indistinguishable from a
// total nobody computed.
const CREATE_COST = 3.0;

// `x-nr-latency-ms` — what the GATEWAY measured, as opposed to what the client
// timed around its own call.
const CREATE_GATEWAY_MS = 812;

// The collection routes carry `x-nr-latency-ms` too — the edge stamps every
// response it produces, billed or not. Distinct values so a record that copied
// another call's timing fails rather than passing on a plausible number, and
// so "free" can never be confused with "unmeasured".
const POLL_GATEWAY_MS = 17;
const CONTENT_GATEWAY_MS = 244;

const SECONDS = 4;
const SIZE = '1280x720';

// The sealed handle shape. The gateway hands back `nrouter_video_<sealed>` and
// never the provider's own job id (`src/http/videos.rs`: `HANDLE_PREFIX`), so
// the mock uses the same prefix — an example that logged a bare provider id
// would be documenting an id no collection route accepts.
const JOB_ID = 'nrouter_video_bW9ja3NlYWxlZGhhbmRsZQ';

// Assembled rather than written out. This repository is PUBLIC and a
// key-shaped literal trips every secret scanner pointed at it — including
// ours. The value is meaningless; the mock only checks the `sk-nrouter-`
// prefix, which is what the real gateway keys off too.
const DEMO_KEY = ['sk', 'nrouter', 'videoagentsuite'.padEnd(38, '0')].join('-');

// A plausible MP4: `ftyp` box header plus filler. The SDK refuses an empty 2xx
// body on a binary endpoint, and rightly so — an empty file that reports
// success is worse than a failure.
const VIDEO_BYTES = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42', 'ascii'),
  Buffer.alloc(4096, 0x21),
]);

/**
 * A gateway that bills at create and gives the collection away.
 *
 * `createStatus` rewrites what `POST /v1/videos` reports:
 *
 *   null          `x-nr-cost-status: exact` with a cost header, the normal case
 *   'unpriced'    `x-nr-cost-status: unpriced` and NO `x-nr-request-cost`
 *                 header at all — the real shape for a model the gateway
 *                 cannot price. It is never a `0` on the wire.
 *
 * `jobOutcome` decides what the polls converge on: `'completed'` or `'failed'`.
 *
 * `refuseCreate` answers 402 before any job exists.
 */
function startMock({
  createStatus = null,
  jobOutcome = 'completed',
  refuseCreate = false,
  failContent = false,
  destroyCreate = false,
} = {}) {
  let requests = 0;
  let createCalls = 0;
  let statusCalls = 0;
  let contentCalls = 0;
  let expectedPricedTotal = 0;

  // queued -> in_progress -> <outcome>. Three polls, so the example's poll
  // loop is exercised as a LOOP rather than as a single lucky first call.
  const STATUS_SEQUENCE = ['queued', 'in_progress', jobOutcome];

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
      const requestId = `req-video-${requests}`;
      const url = (req.url || '').split('?')[0];

      if (url === '/v1/videos' && req.method === 'POST') {
        createCalls += 1;
        if (destroyCreate) {
          // The request ARRIVED and then the connection died. This is the
          // UNKNOWN case: the gateway may have reserved credit before the
          // socket dropped, and no request id ever came back to find out.
          req.socket.destroy();
          return;
        }
        if (refuseCreate) {
          // 402 with the gateway's own envelope shape: `error.type`, no
          // top-level `code`. Nothing was served, so nothing is added to the
          // expected total.
          res.writeHead(402, {
            'content-type': 'application/json',
            'x-nr-request-id': requestId,
          });
          res.end(
            JSON.stringify({
              error: {
                type: 'insufficient_credits',
                message: 'organization has insufficient credits',
              },
            }),
          );
          return;
        }

        const status = createStatus || 'exact';
        const headers = {
          'content-type': 'application/json',
          'x-nr-request-id': requestId,
          'x-nr-model': 'mock-sora-2',
          'x-nr-cost-status': status,
          'x-nr-latency-ms': String(CREATE_GATEWAY_MS),
        };
        // ABSENT, not zero, when unpriced.
        if (status === 'exact') {
          headers['x-nr-request-cost'] = CREATE_COST.toFixed(6);
          expectedPricedTotal += CREATE_COST;
        }
        res.writeHead(200, headers);
        // `seconds` comes back as a STRING, which is what the wire actually
        // does (`src/http/videos.rs` reads it through `as_seconds`, which
        // admits both). An example that only handled a number would print
        // `seconds=undefined` against a real gateway.
        res.end(
          JSON.stringify({
            id: JOB_ID,
            object: 'video',
            status: 'queued',
            model: 'mock-sora-2',
            seconds: String(SECONDS),
            size: SIZE,
          }),
        );
        return;
      }

      if (url === `/v1/videos/${JOB_ID}` && req.method === 'GET') {
        const status = STATUS_SEQUENCE[Math.min(statusCalls, STATUS_SEQUENCE.length - 1)];
        statusCalls += 1;
        // NO `x-nr-request-cost`. NO `x-nr-cost-status`. The collection routes
        // take no reservation, settle nothing and write no spend row, so there
        // is no cost to report and reporting `$0` would be a lie. This absence
        // is the property under test.
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-nr-request-id': requestId,
          'x-nr-latency-ms': String(POLL_GATEWAY_MS),
        });
        res.end(
          JSON.stringify({
            id: JOB_ID,
            object: 'video',
            status,
            model: 'mock-sora-2',
            seconds: String(SECONDS),
            size: SIZE,
          }),
        );
        return;
      }

      if (url === `/v1/videos/${JOB_ID}/content` && req.method === 'GET') {
        contentCalls += 1;
        if (failContent) {
          // A collection call that fails. It is still FREE — the route bills
          // nothing whatever it answers — so the summary must not describe it
          // as money that may have been spent.
          res.writeHead(503, {
            'content-type': 'application/json',
            'x-nr-request-id': requestId,
            'x-nr-latency-ms': String(CONTENT_GATEWAY_MS),
          });
          res.end(
            JSON.stringify({
              error: { type: 'service_unavailable', message: 'upstream is unavailable' },
            }),
          );
          return;
        }
        // Free too, and for the same reason. Also note the absence of any
        // token headers: a rendered asset has no token count to report.
        res.writeHead(200, {
          'content-type': 'video/mp4',
          'content-length': String(VIDEO_BYTES.length),
          'x-nr-request-id': requestId,
          'x-nr-latency-ms': String(CONTENT_GATEWAY_MS),
        });
        res.end(VIDEO_BYTES);
        return;
      }

      // A foreign or garbage handle is an indistinguishable 404 `job_not_found`
      // — the gateway refuses to tell a stranger whether an id decodes.
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'job_not_found', message: 'job not found' } }));
    });
  });

  return {
    server,
    counts: () => ({ requests, createCalls, statusCalls, contentCalls }),
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
async function runExample({ port, workDir, envOverrides = {} }) {
  const logPath = path.join(workDir, 'video-agent.log.jsonl');
  const outDir = path.join(workDir, 'out');

  // Start from the ambient environment MINUS every NROUTER_* variable. A
  // developer's real key or base URL leaking in here would point this suite at
  // the production gateway and start a $3 job.
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('NROUTER_')) env[key] = value;
  }
  Object.assign(env, {
    NROUTER_API_KEY: DEMO_KEY,
    NROUTER_BASE_URL: `http://127.0.0.1:${port}/v1`,
    NROUTER_VIDEO_MODEL: 'mock-sora-2',
    NROUTER_VIDEO_SECONDS: String(SECONDS),
    NROUTER_VIDEO_SIZE: SIZE,
    NROUTER_VIDEO_PROMPT: 'A mock clip, for a mock gateway.',
    NROUTER_VIDEO_POLL_MS: '10',
    NROUTER_VIDEO_TIMEOUT_MS: '10000',
    NROUTER_VIDEO_LOG: logPath,
    NROUTER_VIDEO_OUT: outDir,
  });
  Object.assign(env, envOverrides);

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
  // `freeCalls` or `pricedCalls`.
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
  console.log('nRouter video-agent example — mock gateway certification');
  console.log('======================================================================');

  assert.ok(
    fs.existsSync(SDK_DIST),
    `the JS SDK is not built: ${SDK_DIST} is missing. Run: (cd sdks/js && npm run build)`,
  );

  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nrouter-video-agent-'));

  try {
    // ---------------------------------------------------------------- run 1
    // The whole journey: one billed create, three free polls, one free
    // download. The create cost is the ONLY thing in the total.
    console.log('\n[1/9] Create bills, collection is free (completed job)...');
    const happy = startMock();
    const happyPort = await listen(happy.server);
    const workA = path.join(workRoot, 'happy');
    fs.mkdirSync(workA);
    const a = await runExample({ port: happyPort, workDir: workA });
    happy.server.close();

    if (a.child.status !== 0) {
      fail('run 1', a.child);
      throw new Error(`example exited ${a.child.status}, expected 0`);
    }

    assert.deepEqual(
      a.records.map((r) => r.step),
      ['video.create', 'video.poll', 'video.poll', 'video.poll', 'video.content'],
      'the JSONL log must carry one record per call — billed and free alike',
    );

    // Every call, billed or free, is joinable. A free call still has a request
    // id, still crossed the gateway, and still counts against the RPM limiter
    // (`meter_collection`), so a log that skipped free calls would hide the
    // traffic that produces a 429.
    for (const record of a.records) {
      assert.ok(
        typeof record.requestId === 'string' && record.requestId.length > 0,
        `record without a requestId: ${JSON.stringify(record)}`,
      );
      assert.equal(record.ok, true, `record not ok: ${JSON.stringify(record)}`);
      assert.ok(typeof record.ts === 'string' && record.ts.length > 0);
      assert.ok(Number.isInteger(record.latencyMs), 'the client clock is measured here, always present');
    }

    // --- the create record: the only billed call -------------------------
    const create = a.records[0];
    assert.equal(create.billed, true, 'create is the billed call');
    assert.equal(create.free, false);
    assert.equal(create.priced, true, 'an `exact` create with a cost is priced');
    assert.equal(create.costStatus, 'exact');
    assert.equal(create.cost, CREATE_COST);
    assert.equal(create.jobId, JOB_ID, 'the sealed handle must reach the log — it is the only way back to the job');
    // `seconds` and `size` are what the SETTLEMENT is computed from, so they
    // belong on the record even though no header carries them. Read off the
    // JOB, not off the request: the gateway settles from the job's `seconds`.
    assert.equal(create.seconds, SECONDS, 'seconds must be read off the job document and normalised to a number');
    assert.equal(create.size, SIZE);
    assert.equal(create.gatewayMs, CREATE_GATEWAY_MS);

    // --- the free records: the property this suite exists for -------------
    const free = a.records.filter((r) => r.free);
    assert.equal(free.length, 4, 'three polls and one download are free');
    for (const record of free) {
      assert.equal(record.billed, false, `a collection call must not be marked billed: ${JSON.stringify(record)}`);
      // NULL, never 0. A `0` asserts a price the gateway never quoted.
      assert.equal(record.cost, null, `a free call must log a null cost, never 0: ${JSON.stringify(record)}`);
      // The gateway sends NO cost status on these routes. `null` is "no claim
      // was made"; `'unpriced'` would be "the gateway tried and failed", which
      // is a different and untrue statement.
      assert.equal(
        record.costStatus,
        null,
        `a free call must not invent a cost status: ${JSON.stringify(record)}`,
      );
      assert.equal(record.priced, false, 'a free call is not priced — there is nothing to price');
      // Free is a statement about MONEY and nothing else. The edge still
      // stamps `x-nr-latency-ms` on these responses, so a record that dropped
      // it would be claiming the gateway told us nothing about a call it in
      // fact measured.
      assert.equal(
        record.gatewayMs,
        record.step === 'video.poll' ? POLL_GATEWAY_MS : CONTENT_GATEWAY_MS,
        `a free call still carries the gateway's own latency: ${JSON.stringify(record)}`,
      );
    }

    // The three polls carry the job's progression, which is what makes the
    // loop a loop rather than one lucky call.
    assert.deepEqual(
      a.records.filter((r) => r.step === 'video.poll').map((r) => r.status),
      ['queued', 'in_progress', 'completed'],
      'each poll must log the status IT observed, not the final one',
    );
    // Each poll has its OWN request id. One id reused across polls would mean
    // the example logged the create's id, or its first poll's, against every
    // subsequent call — and a support ticket would then name the wrong call.
    const pollIds = a.records.filter((r) => r.step === 'video.poll').map((r) => r.requestId);
    assert.equal(new Set(pollIds).size, pollIds.length, 'every poll must log its OWN request id');
    assert.ok(!pollIds.includes(create.requestId), "a poll must not log the create call's request id");

    // --- the download ------------------------------------------------------
    const content = a.records[4];
    assert.equal(content.contentType, 'video/mp4');
    assert.equal(content.bytes, VIDEO_BYTES.length, 'the byte count must be what was actually received');
    const videoPath = path.join(a.outDir, 'video.mp4');
    assert.ok(fs.existsSync(videoPath), 'out/video.mp4 was not written');
    assert.equal(
      fs.readFileSync(videoPath).length,
      VIDEO_BYTES.length,
      'the file on disk must be the bytes the gateway sent',
    );

    // --- the summary -------------------------------------------------------
    const expectedTotal = happy.expectedPricedTotal();
    const reportedTotal = summaryNumber(a.child.stdout, 'pricedTotalUsd');
    assert.equal(
      reportedTotal.toFixed(8),
      expectedTotal.toFixed(8),
      `pricedTotalUsd ${reportedTotal} != mock total ${expectedTotal}`,
    );
    assert.ok(reportedTotal > 0, 'the create WAS billed; a zero total means it was never summed');
    assert.equal(summaryNumber(a.child.stdout, 'calls'), 5);
    assert.equal(summaryNumber(a.child.stdout, 'billedCalls'), 1, 'exactly one call bills');
    assert.equal(summaryNumber(a.child.stdout, 'freeCalls'), 4, 'polls + download');
    // THE assertion. A free call is not an unpriced one. Were the polls
    // counted as unpriced this would read 4 and the session would falsely
    // report TOTAL INCOMPLETE.
    assert.equal(
      summaryNumber(a.child.stdout, 'unpricedCalls'),
      0,
      'free collection calls must NOT be counted as unpriced',
    );
    assert.equal(summaryNumber(a.child.stdout, 'failedCalls'), 0);
    assert.ok(
      !a.child.stdout.includes('TOTAL INCOMPLETE'),
      'a session whose only billed call was priced exactly is COMPLETE',
    );

    // The per-call lines the operator actually reads.
    assert.ok(/\[video\.create\]/.test(a.child.stdout), 'no [video.create] line printed');
    assert.ok(/\[video\.poll\]/.test(a.child.stdout), 'no [video.poll] line printed');
    assert.ok(/\[video\.content\]/.test(a.child.stdout), 'no [video.content] line printed');
    // A free call prints `costStatus=— (free)`, never `$0.000000`. The dash is
    // the visible half of the same honesty the log carries as `null`.
    const pollLines = a.child.stdout.split('\n').filter((line) => line.includes('[video.poll]'));
    assert.equal(pollLines.length, 3, `expected three poll lines, got:\n${a.child.stdout}`);
    for (const line of pollLines) {
      assert.ok(/\(free\)/.test(line), `a poll line must say it was free: ${line}`);
      assert.ok(!/\$/.test(line), `a poll line must print no money at all: ${line}`);
    }
    assert.ok(
      new RegExp(`gw=${CREATE_GATEWAY_MS}ms`).test(a.child.stdout),
      `the create line does not print the gateway latency:\n${a.child.stdout}`,
    );
    assert.ok(/client=\d+ms/.test(a.child.stdout), 'the create line does not print the client latency');

    const counts = happy.counts();
    assert.equal(counts.createCalls, 1, 'exactly ONE create — a retried create is a second $3 bill');
    assert.equal(counts.statusCalls, 3);
    assert.equal(counts.contentCalls, 1);

    console.log(
      `      calls=${a.records.length} billed=1 free=4 pricedTotalUsd=${reportedTotal.toFixed(8)} (mock ${expectedTotal.toFixed(8)})`,
    );

    // ---------------------------------------------------------------- run 2
    // The create comes back unpriced. The job still runs and is still
    // collected — unpriced is a served request, not an error — but the ONE
    // billed call in the session has no price, so the total is INCOMPLETE and
    // must say so rather than reporting $0.00 as if that were the bill.
    console.log('\n[2/9] An unpriced create...');
    const unpriced = startMock({ createStatus: 'unpriced' });
    const unpricedPort = await listen(unpriced.server);
    const workB = path.join(workRoot, 'unpriced');
    fs.mkdirSync(workB);
    const b = await runExample({ port: unpricedPort, workDir: workB });
    unpriced.server.close();

    if (b.child.status !== 0) {
      fail('run 2', b.child);
      throw new Error(`example exited ${b.child.status}, expected 0 (unpriced is not a failure)`);
    }

    const unpricedCreate = b.records[0];
    assert.equal(unpricedCreate.step, 'video.create');
    assert.equal(unpricedCreate.costStatus, 'unpriced');
    assert.equal(unpricedCreate.cost, null, 'an unpriced create must log a null cost, never 0');
    assert.equal(unpricedCreate.priced, false);
    assert.equal(unpricedCreate.billed, true, 'unpriced does not mean free — this call still reserved credit');
    assert.ok(
      unpricedCreate.requestId && unpricedCreate.requestId.length > 0,
      'an unpriced call still has a request id and still reaches a spend row',
    );

    assert.equal(summaryNumber(b.child.stdout, 'unpricedCalls'), 1);
    assert.equal(summaryNumber(b.child.stdout, 'freeCalls'), 4, 'the collection is free either way');
    assert.equal(summaryNumber(b.child.stdout, 'pricedTotalUsd'), 0);
    assert.ok(
      b.child.stdout.includes('TOTAL INCOMPLETE'),
      'a session whose billed call was unpriced must be reported as TOTAL INCOMPLETE',
    );
    // The distinction that makes the zero readable: a total of 0 with
    // TOTAL INCOMPLETE means "nothing could be priced", never "this was free".
    assert.ok(
      /SERVED without a price/.test(b.child.stdout),
      `the summary must say the call was served without a price:\n${b.child.stdout}`,
    );

    console.log(`      calls=${b.records.length} unpricedCalls=1 pricedTotalUsd=0 (TOTAL INCOMPLETE)`);

    // ---------------------------------------------------------------- run 3
    // The job fails after being accepted. Two properties, and the second is
    // the one that costs money: the process exits non-zero, AND it does not
    // attempt the download. A `failed` job has no content to fetch, so a
    // download attempt is a guaranteed 404 the example would then report as a
    // second, unrelated failure — burying the real one.
    console.log('\n[3/9] A job that fails after create...');
    const failedJob = startMock({ jobOutcome: 'failed' });
    const failedPort = await listen(failedJob.server);
    const workC = path.join(workRoot, 'failed');
    fs.mkdirSync(workC);
    const c = await runExample({ port: failedPort, workDir: workC });
    failedJob.server.close();

    assert.equal(c.child.status, 1, 'a failed job must exit non-zero');

    const failedCounts = failedJob.counts();
    assert.equal(failedCounts.createCalls, 1);
    assert.equal(
      failedCounts.contentCalls,
      0,
      'a failed job has no content — attempting the download buries the real error under a 404',
    );

    assert.deepEqual(
      c.records.map((r) => r.step),
      ['video.create', 'video.poll', 'video.poll', 'video.poll'],
      'the log must stop at the failing poll, with no content record',
    );
    assert.equal(c.records[3].status, 'failed', 'the terminal poll must log the status it saw');

    // The money statement. The create WAS billed and the summary must still
    // report it: a run that dies without itemising hands the operator a bill
    // with no explanation. The example additionally states what the create's
    // OWN header said, because a job refused AT create bills $0.00 while a job
    // accepted here and failed later stays billed — and only the header can
    // tell those apart.
    const failedTotal = summaryNumber(c.child.stdout, 'pricedTotalUsd');
    assert.equal(failedTotal.toFixed(8), CREATE_COST.toFixed(8), 'the create was billed and must still be reported');
    assert.equal(summaryNumber(c.child.stdout, 'billedCalls'), 1);
    assert.equal(summaryNumber(c.child.stdout, 'freeCalls'), 3, 'the three polls were still free');
    assert.ok(
      /still billed|stays billed|was billed/i.test(c.child.stdout + c.child.stderr),
      `a failed job must state that the create remains billed:\n${c.child.stdout}\n${c.child.stderr}`,
    );
    assert.ok(/failed/i.test(c.child.stderr), `the failure must reach stderr:\n${c.child.stderr}`);

    console.log(`      exit=1 calls=${c.records.length} contentCalls=0 pricedTotalUsd=${failedTotal.toFixed(8)}`);

    // ---------------------------------------------------------------- run 4
    // A 402 at create. Nothing was started, so there is nothing to poll and
    // nothing to download — and, unlike run 3, nothing was billed either.
    console.log('\n[4/9] A refused create (402)...');
    const refused = startMock({ refuseCreate: true });
    const refusedPort = await listen(refused.server);
    const workD = path.join(workRoot, 'refused');
    fs.mkdirSync(workD);
    const d = await runExample({ port: refusedPort, workDir: workD });
    refused.server.close();

    assert.equal(d.child.status, 1, 'a refused create must exit non-zero');
    assert.ok(/credit/.test(d.child.stderr), `the error kind was not reported:\n${d.child.stderr}`);
    assert.ok(
      /insufficient credits/i.test(d.child.stderr),
      `the refusal message was not reported:\n${d.child.stderr}`,
    );

    const refusedCounts = refused.counts();
    assert.equal(refusedCounts.createCalls, 1);
    assert.equal(refusedCounts.statusCalls, 0, 'there is no job to poll');
    assert.equal(refusedCounts.contentCalls, 0, 'there is no content to fetch');

    assert.deepEqual(d.records.map((r) => r.step), ['video.create']);
    const refusedRecord = d.records[0];
    assert.equal(refusedRecord.ok, false);
    assert.equal(refusedRecord.priced, false);
    assert.equal(refusedRecord.cost, null);
    assert.ok(
      typeof refusedRecord.error === 'string' && refusedRecord.error.length > 0,
      'a failed call must log why',
    );
    assert.ok(refusedRecord.requestId, 'a refusal still carries a request id to join on');

    // A refusal is its OWN bucket. It was not "served without a price" and it
    // was not free — the job never existed.
    assert.equal(summaryNumber(d.child.stdout, 'failedCalls'), 1);
    assert.equal(summaryNumber(d.child.stdout, 'unpricedCalls'), 0);
    assert.equal(summaryNumber(d.child.stdout, 'freeCalls'), 0);
    assert.equal(summaryNumber(d.child.stdout, 'pricedTotalUsd'), 0);
    assert.ok(d.child.stdout.includes('TOTAL INCOMPLETE'));

    console.log(`      exit=1 calls=${d.records.length} statusCalls=0 contentCalls=0 failedCalls=1`);

    // ---------------------------------------------------------------- run 5
    // `succeeded`, the OTHER terminal success status. The gateway and the SDK
    // both accept `completed` and `succeeded`, and a suite that only ever sees
    // one of them stays green if the other is dropped from the terminal set —
    // and dropping it turns a finished render into a poll loop that runs to
    // its ten-minute timeout on a job that was ready in one.
    console.log('\n[5/9] The `succeeded` terminal status...');
    const succeeded = startMock({ jobOutcome: 'succeeded' });
    const succeededPort = await listen(succeeded.server);
    const workE = path.join(workRoot, 'succeeded');
    fs.mkdirSync(workE);
    const e = await runExample({ port: succeededPort, workDir: workE });
    succeeded.server.close();

    if (e.child.status !== 0) {
      fail('run 5', e.child);
      throw new Error(`example exited ${e.child.status}, expected 0`);
    }
    assert.equal(succeeded.counts().contentCalls, 1, '`succeeded` must be treated as done and collected');
    assert.equal(e.records[3].status, 'succeeded');
    assert.equal(e.records.length, 5, 'the poll loop must stop at `succeeded`, not run to the timeout');
    console.log(`      calls=${e.records.length} contentCalls=1`);

    // ---------------------------------------------------------------- run 6
    // `cancelled`, the other terminal FAILURE status, for the mirror-image
    // reason: dropped from the set it becomes a poll loop against a job that
    // will never progress.
    console.log('\n[6/9] The `cancelled` terminal status...');
    const cancelled = startMock({ jobOutcome: 'cancelled' });
    const cancelledPort = await listen(cancelled.server);
    const workF = path.join(workRoot, 'cancelled');
    fs.mkdirSync(workF);
    const f = await runExample({ port: cancelledPort, workDir: workF });
    cancelled.server.close();

    assert.equal(f.child.status, 1, 'a cancelled job must exit non-zero');
    assert.equal(cancelled.counts().contentCalls, 0, 'a cancelled job has no content to fetch');
    assert.equal(f.records.length, 4, 'the poll loop must stop at `cancelled`, not run to the timeout');
    assert.equal(f.records[3].status, 'cancelled');
    console.log(`      exit=1 calls=${f.records.length} contentCalls=0`);

    // ---------------------------------------------------------------- run 7
    // A collection call that FAILS. The distinction being certified: a failed
    // FREE call is not money that may have been spent. Saying it was sends an
    // operator looking for a charge that cannot exist — the route bills
    // nothing whatever it answers.
    console.log('\n[7/9] A failed collection call is still free...');
    const badContent = startMock({ failContent: true });
    const badContentPort = await listen(badContent.server);
    const workG = path.join(workRoot, 'content-fails');
    fs.mkdirSync(workG);
    const g = await runExample({ port: badContentPort, workDir: workG });
    badContent.server.close();

    assert.equal(g.child.status, 1, 'a failed download must exit non-zero');

    const badRecord = g.records[g.records.length - 1];
    assert.equal(badRecord.step, 'video.content');
    assert.equal(badRecord.ok, false);
    assert.equal(badRecord.free, true, 'a collection call is free even when it fails');
    assert.equal(badRecord.billed, false);
    assert.equal(badRecord.cost, null);
    assert.equal(badRecord.costStatus, null);
    assert.ok(badRecord.requestId, 'a failed collection call still carries a request id');

    // The create was billed and must still be reported in full.
    assert.equal(
      summaryNumber(g.child.stdout, 'pricedTotalUsd').toFixed(8),
      CREATE_COST.toFixed(8),
      'the render was paid for at create and must still be reported',
    );
    assert.equal(summaryNumber(g.child.stdout, 'failedCalls'), 1);
    assert.equal(summaryNumber(g.child.stdout, 'unpricedCalls'), 0, 'a failed free call is not unpriced');
    assert.ok(g.child.stdout.includes('TOTAL INCOMPLETE'));
    // THE sentence. A failed FREE call must NOT be described as money that may
    // have been spent.
    assert.ok(
      /free collection call\(s\) FAILED — nothing was billed for them/.test(g.child.stdout),
      `the summary must say a failed collection call cost nothing:\n${g.child.stdout}`,
    );
    assert.ok(
      !/1 billed call\(s\) FAILED/.test(g.child.stdout),
      `a failed collection call must not be reported as a failed BILLED call:\n${g.child.stdout}`,
    );

    console.log(`      exit=1 failedCalls=1 (free) pricedTotalUsd=${CREATE_COST.toFixed(8)}`);

    // ---------------------------------------------------------------- run 8
    // A refusal the SDK makes BEFORE the request leaves the process.
    // `validateVideoParams` caps `seconds` at MAX_VIDEO_SECONDS (1333), so
    // 5000 never reaches the network.
    //
    // This is a FOURTH failure class and it needs its own sentence. A refused
    // call that reached the gateway "may still have been billed" — a create
    // that got as far as the provider is charged for. One that never left the
    // process cannot have been: nothing was reserved, nothing was settled, and
    // there is no request id to take to support. Telling an operator to go and
    // check a charge that cannot exist, for an id that does not exist, is a
    // wild goose chase manufactured by an accounting shortcut.
    //
    // The strongest assertion here is on the MOCK: `createCalls === 0`. A
    // record can claim anything; the server proves nothing was sent.
    console.log('\n[8/9] A refusal before the request is sent...');
    const neverSent = startMock();
    const neverSentPort = await listen(neverSent.server);
    const workH = path.join(workRoot, 'never-sent');
    fs.mkdirSync(workH);
    const h = await runExample({
      port: neverSentPort,
      workDir: workH,
      // Above MAX_VIDEO_SECONDS, so the SDK refuses in-process.
      envOverrides: { NROUTER_VIDEO_SECONDS: '5000' },
    });
    neverSent.server.close();

    assert.equal(h.child.status, 1, 'a local refusal must still exit non-zero');
    assert.equal(
      neverSent.counts().requests,
      0,
      'the request never left the process — the mock must have seen NOTHING',
    );

    assert.equal(h.records.length, 1, 'the refusal is still logged');
    const local = h.records[0];
    assert.equal(local.step, 'video.create');
    assert.equal(local.ok, false);
    assert.equal(
      local.sentToGateway,
      false,
      'a pre-send refusal must record that it never reached the gateway',
    );
    assert.equal(
      local.billed,
      false,
      'a call that was never sent cannot have been billed — no reservation exists',
    );
    assert.equal(local.priced, false);
    assert.equal(local.cost, null);
    assert.equal(local.requestId, null, 'there is no request id, because there was no request');
    assert.ok(
      /seconds/.test(local.error) && /1333/.test(local.error),
      `the record must say what was refused and what the bound is: ${local.error}`,
    );

    // The summary sentences.
    assert.equal(summaryNumber(h.child.stdout, 'failedCalls'), 1);
    assert.equal(summaryNumber(h.child.stdout, 'billedCalls'), 0, 'nothing was billed');
    assert.equal(summaryNumber(h.child.stdout, 'unpricedCalls'), 0);
    assert.equal(summaryNumber(h.child.stdout, 'freeCalls'), 0);
    assert.equal(summaryNumber(h.child.stdout, 'pricedTotalUsd'), 0);
    assert.ok(h.child.stdout.includes('TOTAL INCOMPLETE'));
    // THE assertion this run exists for.
    assert.ok(
      !/may still have been billed/.test(h.child.stdout),
      `a call that was never sent must NOT be described as possibly billed:\n${h.child.stdout}`,
    );
    assert.ok(
      /never reached the gateway|nothing was sent and nothing was billed/.test(h.child.stdout),
      `the summary must say the call was never sent:\n${h.child.stdout}`,
    );

    console.log(`      exit=1 gatewayRequests=0 billedCalls=0 (refused in-process)`);

    // ---------------------------------------------------------------- run 9
    // The UNKNOWN arm, and it is the mirror image of run 8. Here the request
    // DID leave the process — the mock counted it — and then the connection
    // died before any response. No request id came back.
    //
    // "No request id" is therefore NOT a synonym for "never sent", and this
    // run is what stops anyone simplifying the classifier into
    // `requestId ? true : false`. The SDK's own words for a transport error
    // are "the request left this process and got no usable answer", so the
    // gateway may have reserved credit and settled it. Reporting that as
    // "nothing was sent and nothing was billed" would be a confident claim
    // about money we do not have — the same defect as reporting an unpriced
    // call as $0, pointed the other way.
    console.log('\n[9/9] A connection that dies mid-request is UNKNOWN, not never-sent...');
    const dropped = startMock({ destroyCreate: true });
    const droppedPort = await listen(dropped.server);
    const workI = path.join(workRoot, 'dropped');
    fs.mkdirSync(workI);
    const i = await runExample({ port: droppedPort, workDir: workI });
    dropped.server.close();

    assert.equal(i.child.status, 1, 'a transport failure must exit non-zero');
    assert.equal(
      dropped.counts().createCalls,
      1,
      'the request DID reach the mock — this is the difference from run 8',
    );

    assert.equal(i.records.length, 1);
    const unknown = i.records[0];
    assert.equal(unknown.ok, false);
    assert.equal(unknown.requestId, null, 'no response, so no request id — same as run 8');
    // ...and yet NOT `false`. This is the whole assertion.
    assert.equal(
      unknown.sentToGateway,
      null,
      'a dropped connection is UNKNOWN; treating a missing request id as proof of ' +
        'never-sent would claim no charge exists when one may',
    );
    assert.equal(
      unknown.billed,
      true,
      'unknown stays billed — the cautious side of a charge we cannot rule out',
    );

    assert.equal(summaryNumber(i.child.stdout, 'billedCalls'), 0, 'billedCalls counts SERVED calls');
    assert.equal(summaryNumber(i.child.stdout, 'failedCalls'), 1);
    assert.ok(i.child.stdout.includes('TOTAL INCOMPLETE'));
    // The opposite sentence from run 8, on a record with the same missing id.
    assert.ok(
      /may still have been billed/.test(i.child.stdout),
      `an unknown-outcome call must warn that it may have been billed:\n${i.child.stdout}`,
    );
    assert.ok(
      !/never reached the gateway|nothing was sent and nothing was billed/.test(i.child.stdout),
      `a request that DID reach the gateway must not be reported as never sent:\n${i.child.stdout}`,
    );

    console.log(`      exit=1 gatewayRequests=1 sentToGateway=null (unknown, stays billed)`);

    console.log('\n======================================================================');
    console.log('Result: PASS (video-agent cost, usage and logging verified)');
    console.log('======================================================================');
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
