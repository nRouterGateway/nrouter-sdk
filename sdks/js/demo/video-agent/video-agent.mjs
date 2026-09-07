#!/usr/bin/env node
/**
 * nRouter video agent — one billed call, then a free collection, accounted for
 * separately because they are different kinds of thing.
 *
 *   create  ->  poll  ->  download
 *
 * Video is the only asynchronous wire the gateway serves, and the asynchrony is
 * what makes it the example worth writing. The other modalities hand you the
 * product in the response. `POST /v1/videos` hands you a JOB — an opaque
 * `nrouter_video_…` handle — and you then collect the result over two more
 * calls. Three HTTP requests, and only the FIRST of them costs anything:
 *
 *   POST /v1/videos              BILLS. A credit reservation is taken before
 *                                the provider is called, floored at $3.00 and
 *                                adding $0.75 per requested second, and it is
 *                                settled from the seconds the accepted job
 *                                reports.
 *   GET  /v1/videos/{id}         FREE. No reservation, no settlement, no spend
 *   GET  /v1/videos/{id}/content row, and — the part this file is about — NO
 *                                cost header at all.
 *
 * THE TRAP THIS EXAMPLE EXISTS TO SHOW
 *
 * A free call and an unpriced call are byte-identical on the wire: neither
 * carries `x-nr-request-cost`. Read naively, a forty-poll render reports forty
 * calls the gateway "could not price", and an operator goes hunting a pricing
 * bug that does not exist. Read the other naive way — `cost ?? 0` — the client
 * asserts a settled price of $0.00 for a call nobody priced, which is the
 * confident zero Rule #28 forbids.
 *
 * Both readings come from having two buckets where the domain has three. So
 * this example keeps three, and the distinction is decided ONCE, at the call
 * site, by whether the ROUTE bills:
 *
 *   billed + priced     the create, with `costStatus: exact` and an amount
 *   billed + unpriced   the create, served but unpriceable  -> TOTAL INCOMPLETE
 *   free                every collection call               -> not in either count
 *
 * `costStatus` is `null` on a free call — the gateway made no cost CLAIM — and
 * that is a different fact from `'unpriced'`, which is a claim that pricing was
 * attempted and failed. This file never collapses them.
 *
 * WHAT "FREE" DOES NOT MEAN
 *
 * Free is a statement about money and nothing else. A collection call still
 * authenticates the key, still re-checks the key's model ACL, still checks
 * tenancy against the sealed handle, still consumes an RPM slot, and still
 * carries `x-nr-request-id` and `x-nr-latency-ms`. So every call is logged,
 * billed or not: a log that skipped the free ones would hide the traffic that
 * produces a 429.
 *
 * RUN IT
 *
 *   (cd ../../../sdks/js && npm run build)     # this example imports dist/
 *   export NROUTER_API_KEY=sk-nrouter-...
 *   node video-agent.mjs
 *
 * The create call spends real credits — a floor of $3.00 — and there is no
 * retry loop anywhere in this file. The client pins `maxRetries: 0` explicitly:
 * a retried create is a SECOND JOB and a second bill, and the first job keeps
 * rendering and keeps being charged for. On this wire a retry is the most
 * expensive mistake available.
 */

import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The built-from-source package, not a published one: this example is the
// SDK's own proof, so it must exercise the code in this repository.
import { isPriced, nRouter, nRouterError } from '../../dist/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

// --------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------

const API_KEY = env.NROUTER_API_KEY;
if (!API_KEY) {
  console.error('Set NROUTER_API_KEY (see .env.example). Nothing runs without a virtual key.');
  process.exit(1);
}

const BASE_URL = env.NROUTER_BASE_URL || 'https://api.nrouter.ai/v1';
const VIDEO_MODEL = env.NROUTER_VIDEO_MODEL || 'sora-2';

// `seconds` and `size` are not decoration: the reservation is computed from the
// seconds you ASK for, and the settlement from the seconds the accepted job
// REPORTS. Doubling either roughly doubles the bill, which is why they are
// printed on the create line and written to the log even though no response
// header carries them.
// Validated as an INTEGER here and handed to the SDK as a number. The wire
// wants a string — OpenAI's video route types `seconds` as one and answers 400
// for a JSON number, while the gateway accepts both and relays the body
// verbatim — and `media.video()` does that serialisation itself
// (`sdks/js/src/multimodal.ts`, `wireSeconds`). Stringifying here too would be
// a second place to get it wrong.
const SECONDS = positiveInt(env.NROUTER_VIDEO_SECONDS, 4, 'NROUTER_VIDEO_SECONDS');
const SIZE = env.NROUTER_VIDEO_SIZE || '1280x720';

const PROMPT =
  env.NROUTER_VIDEO_PROMPT ||
  'A slow overhead shot of rain falling into a still puddle on grey pavement, ' +
    'ripples spreading outward, muted daylight, no people, no text.';

// Polling defaults chosen for the shape of the work, not for a demo. A render
// takes minutes, so a 5s interval is ~120 free calls for a ten-minute job —
// harmless for the bill and comfortably inside the RPM slot the collection
// route takes. A tight loop would not cost money; it would cost you a 429.
const POLL_MS = positiveInt(env.NROUTER_VIDEO_POLL_MS, 5_000, 'NROUTER_VIDEO_POLL_MS');
const TIMEOUT_MS = positiveInt(env.NROUTER_VIDEO_TIMEOUT_MS, 600_000, 'NROUTER_VIDEO_TIMEOUT_MS');

// Both default INSIDE this example's own directory, which carries a .gitignore
// for them. Resolving against the script rather than the shell's cwd keeps a
// run from scattering video files and logs wherever it happened to be started.
const LOG_PATH = path.resolve(HERE, env.NROUTER_VIDEO_LOG || './video-agent.log.jsonl');
const OUT_DIR = path.resolve(HERE, env.NROUTER_VIDEO_OUT || './out');

/**
 * The statuses that END a poll loop.
 *
 * Mirrored from the SDK's own `waitForVideo` (`sdks/js/src/multimodal.ts`), and
 * kept in sync deliberately rather than by import because they are not
 * exported. See `pollUntilTerminal` for why this file polls by hand at all.
 */
const DONE_STATUSES = new Set(['completed', 'succeeded']);
const FAILED_STATUSES = new Set(['failed', 'cancelled']);

function positiveInt(raw, fallback, name) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`${name} must be a positive integer; got ${JSON.stringify(raw)}.`);
    process.exit(1);
  }
  return value;
}

/**
 * The wire sends `seconds` as a string on some providers and a number on
 * others (the gateway's own reader admits both). Normalise to a number for the
 * log so a spend reconciliation can do arithmetic with it, and to `null` when
 * it is genuinely unreadable — never to `0`, which would claim a zero-length
 * video and is exactly the shape the settle path treats as a refused job.
 */
function readSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** The container extension, taken from what the gateway actually returned. */
function extensionFor(contentType) {
  const type = (contentType || '').toLowerCase();
  if (type.includes('webm')) return 'webm';
  if (type.includes('quicktime') || type.includes('mov')) return 'mov';
  return 'mp4';
}

// --------------------------------------------------------------------------
// Per-call accounting
// --------------------------------------------------------------------------

const calls = [];

/**
 * Did this call reach the gateway?
 *
 * THREE answers, because there are three situations and collapsing any two of
 * them tells an operator something untrue about their money.
 *
 *   true   a request id came back, so it demonstrably reached the gateway.
 *          A create that got this far MAY have been billed even if it then
 *          failed — the provider can have run before the refusal.
 *
 *   false  the SDK refused it BEFORE sending. `nRouterConfigurationError` is
 *          exactly that class: `validateVideoParams` rejects a `seconds` above
 *          MAX_VIDEO_SECONDS or a malformed `size` without opening a socket.
 *          Nothing was reserved, nothing was settled, and there is no request
 *          id to take to support.
 *
 *   null   it left this process and no usable answer came back — a transport
 *          failure or a timeout. UNKNOWN, and deliberately not `false`.
 *          The SDK's own words for `transportError` are "the request left this
 *          process and got no usable answer", so the gateway may well have
 *          received it, reserved credit and settled. Reporting that as "never
 *          sent, nothing billed" would be the same overconfidence as reporting
 *          an unpriced call as $0 — a confident claim about money we do not
 *          have.
 *
 * Absence of a request id is therefore NOT the test. A timeout has no id
 * either, and it is the one case where a charge is most likely to exist and
 * hardest to find.
 */
function sentToGateway(error) {
  if (error instanceof nRouterError) {
    if (error.meta?.requestId) return true;
    if (error.kind === 'configuration') return false;
    return null;
  }
  return null;
}

function money(value) {
  return value === null || value === undefined ? '—' : `$${value.toFixed(6)}`;
}

async function record(entry) {
  calls.push(entry);
  await appendFile(LOG_PATH, `${JSON.stringify(entry)}\n`);
}

/**
 * Run the ONE billed call and account for it whether it succeeds or fails.
 *
 * A failed call can still have cost money and it always has a request id, so
 * the failure path writes a record too. On this wire that matters more than
 * anywhere else: a create that is ACCEPTED and later fails stays billed, so the
 * record is the only evidence of a charge whose product never arrived.
 */
async function meteredCreate(label, call) {
  const started = Date.now();
  try {
    const result = await call();
    const meta = result.meta;
    const latencyMs = Date.now() - started;

    // ONE pricing predicate, decided here and carried on the record. The
    // summary must not re-derive it: two copies of "was this priced?" drift
    // the day `isPriced` changes, and they drift in the direction that either
    // sums an unpriced call or hides a priced one.
    const priced = isPriced(meta);

    const job = result.body ?? {};
    const jobId = typeof job.id === 'string' ? job.id : null;
    const status = typeof job.status === 'string' ? job.status : null;
    // Read off the JOB, not off the request. The gateway settles from the
    // seconds the accepted job reports, and a provider is free to accept a
    // different duration from the one asked for — logging the request's value
    // would produce a record that disagrees with the invoice.
    const seconds = readSeconds(job.seconds);
    const size = typeof job.size === 'string' ? job.size : SIZE;

    await record({
      ts: new Date().toISOString(),
      step: 'video.create',
      label,
      requestId: meta.requestId,
      model: meta.model,
      costStatus: meta.costStatus,
      // `meta.cost` is already `null` when absent. Never `?? 0`.
      cost: meta.cost,
      // The two quantities the settlement is computed from. No response header
      // carries them, so the job document is the only client-side record of
      // what the bill was measured against.
      seconds,
      size,
      jobId,
      status,
      // `?? null` because an `undefined` is DROPPED by JSON.stringify, and a
      // record missing the key reads as "this log predates gateway latency"
      // rather than "the gateway did not report it".
      gatewayMs: meta.latencyMs ?? null,
      latencyMs,
      ok: true,
      // A response came back, so it reached the gateway by definition.
      sentToGateway: true,
      // The three-bucket distinction, decided by the ROUTE. This one bills.
      billed: true,
      free: false,
      priced,
    });

    console.log(
      `[video.create] ${meta.requestId ?? '(no request id)'} ${meta.model ?? '(model not reported)'} ` +
        `${meta.costStatus ?? '(no cost status)'} ${money(meta.cost)} ` +
        `seconds=${seconds ?? '—'} size=${size} ` +
        `gw=${meta.latencyMs ?? '—'}ms client=${latencyMs}ms  ${label}`,
    );
    console.log(`      job: ${jobId ?? '(no job id)'}  status=${status ?? '(none)'}`);

    if (!priced) {
      console.warn(
        `      ⚠ costStatus=${meta.costStatus ?? 'absent'}: this job WAS accepted and reserved ` +
          'credit, but nRouter could not price it. It is excluded from the total below — do NOT ' +
          'record it as $0.',
      );
    }

    return result;
  } catch (error) {
    const meta = error instanceof nRouterError ? error.meta : undefined;
    const sent = sentToGateway(error);
    await record({
      ts: new Date().toISOString(),
      step: 'video.create',
      label,
      requestId: meta?.requestId ?? null,
      model: meta?.model ?? null,
      costStatus: meta?.costStatus ?? null,
      cost: meta?.cost ?? null,
      seconds: null,
      size: SIZE,
      jobId: null,
      status: null,
      gatewayMs: meta?.latencyMs ?? null,
      latencyMs: Date.now() - started,
      ok: false,
      sentToGateway: sent,
      // `billed` is a claim about whether money COULD be involved, and a
      // request that never left the process cannot be. Hardcoding `true` here
      // — which this file did — makes the summary tell an operator to go and
      // check a charge that cannot exist, for a request id that does not
      // exist. `null` (unknown) stays billed: we cannot rule it out, and the
      // cautious side of an unknown charge is to say so.
      billed: sent !== false,
      free: false,
      // A refused call is not a priced one, and it is not an unpriced SERVED
      // one either — the summary counts it separately.
      priced: false,
      error:
        error instanceof nRouterError
          ? `${error.kind}: ${error.message}`
          : String(error?.message ?? error),
    });
    throw error;
  }
}

/**
 * Run one FREE collection call and account for it in its own bucket.
 *
 * Nothing here reads `meta.cost` or `meta.costStatus` to DECIDE anything: the
 * route is free by contract, so the decision is made by which function you are
 * in, not by inspecting a header that is absent for two different reasons.
 * Deciding it from the header is precisely the bug — an absent cost header on
 * a free route would be read as `unpriced`.
 *
 * The values are still written to the log, as `null`, because "we looked and
 * the gateway said nothing" is worth recording. What is never written is a `0`.
 */
async function meteredFree(step, label, call, describe) {
  const started = Date.now();
  try {
    const result = await call();
    const meta = result.meta;
    const latencyMs = Date.now() - started;
    const extra = describe ? describe(result) : {};

    await record({
      // `extra` is spread FIRST, so a `describe` callback can add fields but can
      // never overwrite one below it. Spread last, a callback that happened to
      // return `cost` or `billed` would silently rewrite the free-route
      // contract this whole function exists to state — and it would do it
      // quietly, in the one record nobody re-reads. Same rule the SDK applies
      // to `VideoParams.extra`: caller data merges under named fields, never
      // over them.
      ...extra,
      ts: new Date().toISOString(),
      step,
      label,
      requestId: meta.requestId,
      model: meta.model,
      // Both null, and both for the same reason: the gateway made no cost
      // claim about this route. `null` is "no claim"; `'unpriced'` would be
      // "tried and failed", which is untrue and sends an operator to the wrong
      // page.
      costStatus: null,
      cost: null,
      // Free is about MONEY only. The edge still measured this call.
      gatewayMs: meta.latencyMs ?? null,
      latencyMs,
      ok: true,
      sentToGateway: true,
      billed: false,
      free: true,
      priced: false,
    });

    console.log(
      `[${step}] ${meta.requestId ?? '(no request id)'} ` +
        `${extra.status ? `status=${extra.status} ` : ''}` +
        `${extra.bytes !== undefined ? `bytes=${extra.bytes} ${extra.contentType ?? 'unknown'} ` : ''}` +
        `costStatus=— (free) gw=${meta.latencyMs ?? '—'}ms client=${latencyMs}ms  ${label}`,
    );

    return result;
  } catch (error) {
    const meta = error instanceof nRouterError ? error.meta : undefined;
    await record({
      ts: new Date().toISOString(),
      step,
      label,
      requestId: meta?.requestId ?? null,
      model: meta?.model ?? null,
      costStatus: null,
      cost: null,
      gatewayMs: meta?.latencyMs ?? null,
      latencyMs: Date.now() - started,
      ok: false,
      sentToGateway: sentToGateway(error),
      // A collection call that FAILED is still free — the route bills nothing
      // whatever it answers. It is counted as failed, never as unpriced.
      billed: false,
      free: true,
      priced: false,
      error:
        error instanceof nRouterError
          ? `${error.kind}: ${error.message}`
          : String(error?.message ?? error),
    });
    throw error;
  }
}

function printSummary() {
  // FOUR buckets, and the fourth is the one this example exists for.
  //
  //   failed    the call was refused; it may or may not have been billed
  //   priced    billed, and the gateway quoted an exact amount
  //   unpriced  billed and SERVED, but the gateway could not price it
  //   free      the route bills nothing, by contract
  //
  // Collapsing `free` into `unpriced` reports a pricing failure that did not
  // happen. Collapsing it into `priced` at $0 asserts a price nobody quoted.
  const failed = calls.filter((entry) => !entry.ok);
  const billed = calls.filter((entry) => entry.ok && entry.billed);
  const priced = billed.filter((entry) => entry.priced);
  const unpriced = billed.filter((entry) => !entry.priced);
  const free = calls.filter((entry) => entry.ok && entry.free);
  const pricedTotalUsd = priced.reduce((sum, entry) => sum + entry.cost, 0);

  console.log('\nSESSION SUMMARY');
  console.log(`  calls            ${calls.length}`);
  console.log(`  billedCalls      ${billed.length}`);
  console.log(`  pricedCalls      ${priced.length}`);
  console.log(`  unpricedCalls    ${unpriced.length}`);
  console.log(`  freeCalls        ${free.length}`);
  console.log(`  failedCalls      ${failed.length}`);
  console.log(`  pricedTotalUsd   ${pricedTotalUsd.toFixed(8)}`);
  console.log(
    `\n  freeCalls are the ${free.length} collection call(s) — polls and the download. They report\n` +
      '  NO cost header, and that absence means zero rather than unknown: the render was\n' +
      '  settled once, when it was created. They are NOT unpriced and must never be counted\n' +
      '  as a pricing failure.',
  );

  if (unpriced.length > 0 || failed.length > 0) {
    // A failed BILLED call and a failed FREE call are not the same news, and
    // one sentence covering both would be wrong about one of them. Only the
    // create can leave money behind; a collection call that fails cost
    // nothing, because the route bills nothing whatever it answers. Telling an
    // operator a failed poll "may still have been billed" sends them looking
    // for a charge that cannot exist.
    // FOUR failure sentences, because there are four situations and one
    // sentence covering them all is wrong about three.
    const neverSent = failed.filter((entry) => entry.sentToGateway === false);
    const sentFailed = failed.filter((entry) => entry.sentToGateway !== false);
    const failedBilled = sentFailed.filter((entry) => entry.billed);
    const failedFree = sentFailed.filter((entry) => !entry.billed);
    const reasons = [];
    if (unpriced.length > 0) {
      reasons.push(`${unpriced.length} billed call(s) were SERVED without a price`);
    }
    if (neverSent.length > 0) {
      // The whole point of the class. Do NOT say "may still have been billed":
      // this request never reached the gateway, so no reservation, no
      // settlement and no spend row exist — and there is no request id to take
      // to support, because there was no request. Sending someone to look is a
      // wild goose chase invented by an accounting shortcut.
      reasons.push(
        `${neverSent.length} call(s) were refused BEFORE being sent and never reached the ` +
          'gateway — nothing was sent and nothing was billed, and there is no request id ' +
          'to chase. Fix the configuration named in the error and re-run',
      );
    }
    if (failedBilled.length > 0) {
      reasons.push(`${failedBilled.length} billed call(s) FAILED and may still have been billed`);
    }
    if (failedFree.length > 0) {
      reasons.push(
        `${failedFree.length} free collection call(s) FAILED — nothing was billed for them, ` +
          'but the render they were collecting was already paid for at create',
      );
    }
    console.log(
      `\n  TOTAL INCOMPLETE — ${reasons.join('; ')}. ` +
        'The figure above is the priced subset, NOT the session total.',
    );
  } else {
    console.log('\n  TOTAL COMPLETE — every billed call in this session was priced exactly.');
  }

  console.log(`\n  log: ${LOG_PATH}`);
  console.log(`  video: ${OUT_DIR}`);
  console.log(
    '\n  Join it up: every requestId above is `x-nr-request-id`. The CREATE id is the one\n' +
      '  that finds a spend row on the dashboard Logs page — the collection ids will find\n' +
      '  none, because collection writes none, and their absence is the expected result\n' +
      '  rather than a missing row. The spend row carries the seconds and resolution the\n' +
      '  settlement was measured in; no response header does.',
  );
}

// --------------------------------------------------------------------------
// The job
// --------------------------------------------------------------------------

// `maxRetries: 0` is stated rather than inherited. The SDK's default is already
// 0, but a DEFAULT is a promise someone else keeps — and on THIS wire an
// automatic retry does not merely double a bill, it starts a second render the
// first job's charge does not cover.
const client = new nRouter({ apiKey: API_KEY, baseURL: BASE_URL, maxRetries: 0 });

/**
 * Poll the job until it reaches a terminal status, accounting for every poll.
 *
 * The SDK ships `waitForVideo(id, { pollIntervalMs, timeoutMs })`, which
 * implements exactly this loop with the same terminal statuses. It is the right
 * call for ordinary code and the wrong one HERE, for one reason: it exposes no
 * per-poll hook, so a caller gets one resolved value and no way to see the
 * intermediate responses. This example's entire subject is that each of those
 * intermediate calls is a real, authenticated, rate-limited, request-id-carrying
 * gateway call that costs nothing — and you cannot demonstrate that about calls
 * you never see. So the loop is written out, and `DONE_STATUSES` /
 * `FAILED_STATUSES` above mirror the SDK's.
 *
 * If you do not need per-poll accounting, use `waitForVideo` instead of copying
 * this.
 */
async function pollUntilTerminal(jobId) {
  const deadline = Date.now() + TIMEOUT_MS;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;
    const response = await meteredFree(
      'video.poll',
      `poll #${attempt}`,
      () => client.nr.media.videoStatus(jobId),
      (result) => ({ status: String(result.body?.status ?? '').toLowerCase() || null }),
    );

    const status = String(response.body?.status ?? '').toLowerCase();
    if (DONE_STATUSES.has(status)) return { status, response };
    if (FAILED_STATUSES.has(status)) {
      // Stop here. There is no content to fetch for a job that did not render,
      // so a download attempt would be a guaranteed 404 that buries the real
      // error under an unrelated one.
      const error = new Error(
        `video job ${jobId} ended with status "${status}" after ${attempt} poll(s). ` +
          'The CREATE call is NOT refunded by this outcome: a job that was ACCEPTED and later ' +
          'failed stays billed, because nothing observes its terminal state. Read the ' +
          '[video.create] line above for what it actually cost — a job refused AT create ' +
          'reports an exact $0.00 or no cost header at all, and was not billed.',
      );
      error.videoStatus = status;
      throw error;
    }

    // Sleep only if there is budget left to sleep inside.
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_MS, remaining)));
  }

  throw new Error(
    `timed out after ${TIMEOUT_MS}ms waiting for video job ${jobId}. The job may still be ` +
      'rendering, and the create call was billed regardless — the handle above is still valid, ' +
      'so re-poll it rather than creating a second job.',
  );
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(path.dirname(LOG_PATH), { recursive: true });
  // Truncate: a session's log is that session's, and appending across runs
  // would make the totals above the sum of two different jobs.
  await writeFile(LOG_PATH, '');

  console.log(`gateway   ${BASE_URL}`);
  console.log(`model     ${VIDEO_MODEL}`);
  console.log(`seconds   ${SECONDS}`);
  console.log(`size      ${SIZE}`);
  console.log(`poll      every ${POLL_MS}ms, up to ${TIMEOUT_MS}ms\n`);

  const created = await meteredCreate('start the render (THE billed call)', () =>
    client.nr.media.video({ model: VIDEO_MODEL, prompt: PROMPT, seconds: SECONDS, size: SIZE }),
  );

  const jobId = created.body?.id;
  if (typeof jobId !== 'string' || jobId === '') {
    throw new Error(
      'the gateway accepted the job but returned no id, so the render cannot be collected. ' +
        'The create call was billed; take the requestId above to support.',
    );
  }

  // A create that comes back already `failed` is a REFUSAL we could see, on the
  // one response the gateway reads — so it bills zero seconds. That is a
  // different outcome from a job that failed later, and the message says which.
  const createStatus = String(created.body?.status ?? '').toLowerCase();
  if (FAILED_STATUSES.has(createStatus)) {
    const error = new Error(
      `the job was refused at create with status "${createStatus}". A job refused AT create ` +
        'bills zero seconds — read the [video.create] line above: an exact $0.00, or no cost ' +
        'header at all, means it was not billed.',
    );
    error.videoStatus = createStatus;
    throw error;
  }

  await pollUntilTerminal(jobId);

  const content = await meteredFree(
    'video.content',
    'download the rendered video',
    () => client.nr.media.videoContent(jobId),
    (result) => ({ bytes: result.bytes.length, contentType: result.contentType }),
  );

  const videoPath = path.join(OUT_DIR, `video.${extensionFor(content.contentType)}`);
  await writeFile(videoPath, content.bytes);
  console.log(`      wrote ${videoPath} (${content.bytes.length} bytes)`);
}

try {
  await main();
} catch (error) {
  if (error instanceof nRouterError) {
    // A typed refusal. The distinction that matters operationally is WHY:
    // `credit` needs a top-up, `authentication` needs a different key,
    // `rate_limit` names the limit that measured it, and none of them is fixed
    // by trying again immediately — least of all on the create call.
    console.error('\n✗ the gateway refused a call\n');
    console.error({
      kind: error.kind,
      status: error.status,
      message: error.message,
      requestId: error.meta?.requestId,
      authReason: error.authReason,
      limitSource: error.limitSource,
    });
  } else {
    console.error(`\n✗ ${error?.message ?? error}`);
  }
  process.exitCode = 1;
} finally {
  // ALWAYS. Money was committed at create before any failure downstream, and a
  // run that dies without reporting what it already billed is the worst
  // possible outcome for the person reading this output.
  printSummary();
}
