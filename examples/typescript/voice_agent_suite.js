#!/usr/bin/env node
/**
 * Mock-gateway certification for examples/typescript/voice-agent.
 *
 * The example under test spends real money against a real gateway, which makes
 * it exactly the kind of code nobody exercises in CI. So the gateway is stood
 * up locally instead: a `node:http` server that speaks the three wires the
 * voice loop uses and stamps the same `x-nr-*` headers a real one does. Every
 * assertion below is about the property that costs money if it is wrong —
 * that a request id reaches the log, that an `exact` cost is summed, and that
 * an `unpriced` one is NOT summed and is announced instead of being rounded
 * into the total as zero (Rule #28).
 *
 * No network, no key, no credits. Runs in about a second.
 *
 *   node examples/typescript/voice_agent_suite.js
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

const EXAMPLE = path.resolve(__dirname, 'voice-agent', 'voice-agent.mjs');
const SDK_DIST = path.resolve(__dirname, '..', '..', 'sdks', 'js', 'dist', 'index.mjs');

// The mock's price list. Deliberately three DIFFERENT numbers: a single shared
// cost would let a summation bug that counts the wrong call still produce the
// right total.
const COST = { stt: 0.00004, chat: 0.00312, tts: 0.00003 };

const DEMO_KEY = 'sk-nrouter-voiceagentsuite000000000000000000000000';

/**
 * A gateway that bills.
 *
 * `firstSpeechStatus` rewrites what the FIRST /audio/speech call reports:
 *
 *   null          priced exactly, like every other call
 *   'unpriced'    `x-nr-cost-status: unpriced` and NO `x-nr-request-cost`
 *                 header at all — the real shape for a model the gateway
 *                 cannot price. It is never a `0` on the wire.
 *   'estimated'   a status this SDK does not know, WITH a cost header. Not a
 *                 status the gateway sends today, which is the point: the
 *                 example must fail CLOSED on an unrecognised status and leave
 *                 the amount out of the total rather than trusting a number
 *                 whose meaning it cannot vouch for.
 */
function startMock({ firstSpeechStatus = null, refuseChat = false } = {}) {
  let requests = 0;
  let speechCalls = 0;
  let sttCalls = 0;
  let chatCalls = 0;
  let messagesCalls = 0;
  let chatCompletionCalls = 0;
  let expectedPricedTotal = 0;

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
      const requestId = `req-voice-${requests}`;
      const url = (req.url || '').split('?')[0];

      if (url === '/v1/audio/speech') {
        speechCalls += 1;
        const status = speechCalls === 1 && firstSpeechStatus ? firstSpeechStatus : 'exact';
        const headers = {
          'content-type': 'audio/mpeg',
          'x-nr-request-id': requestId,
          'x-nr-model': 'mock-tts-1',
          'x-nr-cost-status': status,
        };
        // ABSENT, not zero, when unpriced. `estimated` DOES carry an amount —
        // and the example must still refuse to sum it, which is the only way
        // to tell "excluded because there was no number" apart from "excluded
        // because the number could not be vouched for".
        if (status !== 'unpriced') {
          headers['x-nr-request-cost'] = COST.tts.toFixed(6);
        }
        if (status === 'exact') {
          expectedPricedTotal += COST.tts;
        }
        res.writeHead(200, headers);
        // A plausible MP3 frame header plus filler: the SDK refuses an empty
        // 2xx body on a binary endpoint, and rightly so.
        res.end(Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(256, 0x11)]));
        return;
      }

      if (url === '/v1/audio/transcriptions') {
        sttCalls += 1;
        expectedPricedTotal += COST.stt;
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-nr-request-id': requestId,
          'x-nr-model': 'mock-transcribe-1',
          'x-nr-request-cost': COST.stt.toFixed(6),
          'x-nr-cost-status': 'exact',
          'x-nr-input-tokens': '9',
          'x-nr-output-tokens': '7',
          'x-nr-total-tokens': '16',
        });
        res.end(
          JSON.stringify({
            text: `Mock transcript ${sttCalls}.`,
            usage: { type: 'tokens', input_tokens: 9, output_tokens: 7 },
          }),
        );
        return;
      }

      // TWO chat wires, because the SDK picks between them by model id and the
      // example's DEFAULT model takes the second one. A mock serving only
      // /v1/chat/completions would leave the shipped default path untested and
      // 404 the moment anyone ran the example as documented.
      // nrouter-doc-wire: messages
      if (url === '/v1/messages') {
        chatCalls += 1;
        messagesCalls += 1;
        expectedPricedTotal += COST.chat;
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-nr-request-id': requestId,
          'x-nr-model': 'mock-claude-1',
          'x-nr-request-cost': COST.chat.toFixed(6),
          'x-nr-cost-status': 'exact',
          'x-nr-input-tokens': '55',
          'x-nr-output-tokens': '25',
          'x-nr-total-tokens': '80',
        });
        res.end(
          JSON.stringify({
            id: `msg-voice-${chatCalls}`,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: `Mock reply ${chatCalls}.` }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 55, output_tokens: 25 },
          }),
        );
        return;
      }

      if (url === '/v1/chat/completions') {
        chatCalls += 1;
        chatCompletionCalls += 1;
        if (refuseChat) {
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
        expectedPricedTotal += COST.chat;
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-nr-request-id': requestId,
          'x-nr-model': 'mock-chat-1',
          'x-nr-request-cost': COST.chat.toFixed(6),
          'x-nr-cost-status': 'exact',
          'x-nr-input-tokens': '55',
          'x-nr-output-tokens': '25',
          'x-nr-total-tokens': '80',
        });
        res.end(
          JSON.stringify({
            id: `chatcmpl-voice-${chatCalls}`,
            choices: [{ message: { role: 'assistant', content: `Mock reply ${chatCalls}.` } }],
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
    counts: () => ({ requests, speechCalls, sttCalls, chatCalls, messagesCalls, chatCompletionCalls }),
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
 * example. That cost an hour once; it is why this returns a promise.
 */
async function runExample({ port, turns, workDir, chatModel }) {
  const logPath = path.join(workDir, 'voice-agent.log.jsonl');
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
    NROUTER_CHAT_MODEL: chatModel,
    NROUTER_SPEECH_MODEL: 'mock-tts',
    NROUTER_SPEECH_VOICE: 'alloy',
    NROUTER_TRANSCRIBE_MODEL: 'mock-transcribe',
    NROUTER_TURNS: String(turns),
    NROUTER_VOICE_LOG: logPath,
    NROUTER_VOICE_OUT: outDir,
  });

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
  console.log('nRouter voice-agent example — mock gateway certification');
  console.log('======================================================================');

  assert.ok(
    fs.existsSync(SDK_DIST),
    `the JS SDK is not built: ${SDK_DIST} is missing. Run: (cd sdks/js && npm run build)`,
  );

  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nrouter-voice-agent-'));

  try {
    // ---------------------------------------------------------------- run 1
    // Two turns, every call priced. The full loop: bootstrap TTS, then per
    // turn STT -> chat -> TTS, plus one TTS synthesising the follow-up.
    console.log('\n[1/4] Fully priced session (2 turns)...');
    const priced = startMock();
    const pricedPort = await listen(priced.server);
    const workA = path.join(workRoot, 'priced');
    fs.mkdirSync(workA);
    // An OpenAI-shaped id, so this run exercises /v1/chat/completions.
    const a = await runExample({ port: pricedPort, turns: 2, workDir: workA, chatModel: 'mock-chat' });
    priced.server.close();

    if (a.child.status !== 0) {
      fail('run 1', a.child);
      throw new Error(`example exited ${a.child.status}, expected 0`);
    }

    const expectedSteps = ['tts', 'stt', 'chat', 'tts', 'tts', 'stt', 'chat', 'tts'];
    assert.deepEqual(
      a.records.map((r) => r.step),
      expectedSteps,
      'the JSONL log must carry one record per billed call, in loop order',
    );

    for (const record of a.records) {
      // A record with no request id cannot be joined to a spend row, which is
      // the only reason this log exists.
      assert.ok(
        typeof record.requestId === 'string' && record.requestId.length > 0,
        `record without a requestId: ${JSON.stringify(record)}`,
      );
      assert.equal(record.costStatus, 'exact', `record not priced exact: ${JSON.stringify(record)}`);
      assert.equal(record.ok, true);
      assert.equal(typeof record.cost, 'number');
      assert.equal(typeof record.latencyMs, 'number');
      assert.ok(typeof record.model === 'string' && record.model.length > 0);
      assert.ok(typeof record.ts === 'string' && record.ts.length > 0);
      // The single pricing predicate, carried on the record so the summary
      // cannot re-derive it differently.
      assert.equal(record.priced, true, `record not marked priced: ${JSON.stringify(record)}`);
    }

    const expectedTotal = priced.expectedPricedTotal();
    const reportedTotal = summaryNumber(a.child.stdout, 'pricedTotalUsd');
    assert.equal(
      reportedTotal.toFixed(8),
      expectedTotal.toFixed(8),
      `pricedTotalUsd ${reportedTotal} != mock total ${expectedTotal}`,
    );
    assert.equal(summaryNumber(a.child.stdout, 'unpricedCalls'), 0);
    assert.equal(summaryNumber(a.child.stdout, 'failedCalls'), 0);
    assert.equal(summaryNumber(a.child.stdout, 'calls'), expectedSteps.length);
    assert.ok(
      !a.child.stdout.includes('TOTAL INCOMPLETE'),
      'a fully priced session must not be reported as incomplete',
    );

    // The per-call line the operator actually reads.
    assert.ok(/\[chat\]/.test(a.child.stdout), 'no per-call [chat] line printed');
    assert.ok(/\[stt\]/.test(a.child.stdout), 'no per-call [stt] line printed');
    assert.ok(/\[tts\]/.test(a.child.stdout), 'no per-call [tts] line printed');

    // The audio it claims to have produced must exist on disk.
    assert.ok(fs.existsSync(path.join(a.outDir, 'turn-1.mp3')), 'turn-1.mp3 was not written');
    assert.ok(fs.existsSync(path.join(a.outDir, 'turn-2.mp3')), 'turn-2.mp3 was not written');

    const counts = priced.counts();
    assert.equal(counts.chatCalls, 2);
    assert.equal(counts.sttCalls, 2);
    assert.equal(counts.speechCalls, 4);
    assert.equal(counts.chatCompletionCalls, 2, 'an OpenAI-shaped id must take /v1/chat/completions');
    assert.equal(counts.messagesCalls, 0);

    console.log(`      calls=${a.records.length} pricedTotalUsd=${reportedTotal.toFixed(8)} (mock ${expectedTotal.toFixed(8)})`);

    // ---------------------------------------------------------------- run 2
    // One TTS call comes back unpriced. The session still succeeds — unpriced
    // is a served request, not an error — but the total is INCOMPLETE and must
    // say so rather than silently under-reporting by one call.
    console.log('\n[2/4] One unpriced TTS call (1 turn)...');
    const mixed = startMock({ firstSpeechStatus: 'unpriced' });
    const mixedPort = await listen(mixed.server);
    const workB = path.join(workRoot, 'unpriced');
    fs.mkdirSync(workB);
    // A Claude-family id, so this run exercises the wire the example's own
    // DEFAULT model takes. nrouter-doc-wire: messages
    const b = await runExample({ port: mixedPort, turns: 1, workDir: workB, chatModel: 'claude-mock-haiku-4-5' });
    mixed.server.close();

    if (b.child.status !== 0) {
      fail('run 2', b.child);
      throw new Error(`example exited ${b.child.status}, expected 0 (unpriced is not a failure)`);
    }

    assert.deepEqual(b.records.map((r) => r.step), ['tts', 'stt', 'chat', 'tts']);

    const unpricedRecords = b.records.filter((r) => r.costStatus !== 'exact');
    assert.equal(unpricedRecords.length, 1, 'exactly one call should be unpriced');
    assert.equal(unpricedRecords[0].costStatus, 'unpriced');
    // Never a zero. `null` is what "the gateway did not price this" looks like.
    assert.equal(unpricedRecords[0].cost, null, 'an unpriced call must log a null cost, never 0');
    assert.ok(
      unpricedRecords[0].requestId && unpricedRecords[0].requestId.length > 0,
      'an unpriced call still has a request id and still reaches a spend row',
    );

    assert.equal(summaryNumber(b.child.stdout, 'unpricedCalls'), 1);
    assert.ok(
      b.child.stdout.includes('TOTAL INCOMPLETE'),
      'a session with an unpriced call must be reported as TOTAL INCOMPLETE',
    );

    const mixedExpected = mixed.expectedPricedTotal();
    const mixedReported = summaryNumber(b.child.stdout, 'pricedTotalUsd');
    assert.equal(
      mixedReported.toFixed(8),
      mixedExpected.toFixed(8),
      `pricedTotalUsd ${mixedReported} != mock priced total ${mixedExpected}`,
    );
    // The sum must exclude the unpriced call rather than adding 0 for it, and
    // the two are only distinguishable because the mock's TTS price is not 0.
    assert.ok(mixedExpected > 0 && COST.tts > 0);

    // The default model is a Claude id, and the SDK routes those to
    // /v1/messages. Anthropic is served on that wire ONLY, so a run that hit
    // /v1/chat/completions here would be a documented 404 for a real customer.
    const mixedCounts = mixed.counts();
    assert.equal(mixedCounts.messagesCalls, 1, 'a Claude-family id must take the /v1/messages wire');
    assert.equal(mixedCounts.chatCompletionCalls, 0);
    // The Anthropic body shape is translated by the SDK, so the example's
    // `client.nr.text()` must still find the reply.
    assert.ok(/Mock reply 1\./.test(b.child.stdout), 'the Messages-wire reply text did not reach the transcript');

    console.log(`      calls=${b.records.length} pricedTotalUsd=${mixedReported.toFixed(8)} unpricedCalls=1 (TOTAL INCOMPLETE)`);

    // ---------------------------------------------------------------- run 3
    // A cost status this SDK does not know, carrying a cost. `isPriced()`
    // accepts `exact` only, so the amount must be EXCLUDED and announced —
    // never summed on the strength of the number alone. Without this run a
    // future third status would be summed silently by any code that checked
    // `cost !== null` instead of the status.
    console.log('\n[3/4] An unrecognised cost status carrying an amount (1 turn)...');
    const odd = startMock({ firstSpeechStatus: 'estimated' });
    const oddPort = await listen(odd.server);
    const workC = path.join(workRoot, 'estimated');
    fs.mkdirSync(workC);
    const c = await runExample({ port: oddPort, turns: 1, workDir: workC, chatModel: 'mock-chat' });
    odd.server.close();

    if (c.child.status !== 0) {
      fail('run 3', c.child);
      throw new Error(`example exited ${c.child.status}, expected 0`);
    }

    const oddRecords = c.records.filter((r) => r.costStatus === 'estimated');
    assert.equal(oddRecords.length, 1, 'the mock served exactly one `estimated` call');
    assert.equal(typeof oddRecords[0].cost, 'number', 'the mock DID send a cost header');
    assert.equal(oddRecords[0].priced, false, 'an unrecognised cost status must not count as priced');
    assert.equal(summaryNumber(c.child.stdout, 'unpricedCalls'), 1);
    assert.ok(c.child.stdout.includes('TOTAL INCOMPLETE'));

    const oddExpected = odd.expectedPricedTotal();
    const oddReported = summaryNumber(c.child.stdout, 'pricedTotalUsd');
    assert.equal(
      oddReported.toFixed(8),
      oddExpected.toFixed(8),
      `pricedTotalUsd ${oddReported} counted an \`estimated\` amount it must exclude`,
    );
    // Prove the exclusion is observable: had it been summed, the total would
    // have been higher by exactly the TTS price.
    assert.ok(
      Math.abs(oddReported - (oddExpected + COST.tts)) > 1e-12,
      'the assertion above cannot distinguish summed from excluded',
    );

    console.log(`      calls=${c.records.length} pricedTotalUsd=${oddReported.toFixed(8)} (excludes the estimated $${COST.tts.toFixed(6)})`);

    // ---------------------------------------------------------------- run 4
    // A refusal mid-session. Two properties, and the second is the one that is
    // easy to lose: the process must exit NON-ZERO so a scripted caller
    // notices, AND it must still report the money it had already spent before
    // the refusal. A run that dies without printing its summary hands the
    // operator a bill with no itemisation.
    console.log('\n[4/4] A refused chat call mid-session (1 turn)...');
    const refused = startMock({ refuseChat: true });
    const refusedPort = await listen(refused.server);
    const workD = path.join(workRoot, 'refused');
    fs.mkdirSync(workD);
    const d = await runExample({ port: refusedPort, turns: 1, workDir: workD, chatModel: 'mock-chat' });
    refused.server.close();

    assert.equal(d.child.status, 1, 'a refused call must exit non-zero');
    // The typed refusal, not a stack trace.
    assert.ok(/credit/.test(d.child.stderr), `the error kind was not reported:\n${d.child.stderr}`);
    assert.ok(
      /insufficient credits/i.test(d.child.stderr),
      `the refusal message was not reported:\n${d.child.stderr}`,
    );

    // The bootstrap TTS and the STT call happened BEFORE the refusal and were
    // billed. They must still be in the log and in the total.
    assert.deepEqual(d.records.map((r) => r.step), ['tts', 'stt', 'chat']);
    const failedRecord = d.records[2];
    assert.equal(failedRecord.ok, false);
    assert.equal(failedRecord.priced, false);
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
    assert.ok(refusedReported > 0, 'two calls were billed before the refusal');

    console.log(`      exit=1 calls=${d.records.length} pricedTotalUsd=${refusedReported.toFixed(8)} failedCalls=1`);

    console.log('\n======================================================================');
    console.log('Result: PASS (voice-agent cost, usage and logging verified)');
    console.log('======================================================================');
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
