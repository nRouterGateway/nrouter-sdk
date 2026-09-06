#!/usr/bin/env node
/**
 * nRouter image agent — one billed wire, two billing UNITS, both accounted for.
 *
 *   POST /v1/images/generations
 *
 * Images are the modality where "how much did that cost?" has two answers, and
 * a client that assumes either one is wrong half the time:
 *
 *   per IMAGE        a `dall-e`-class model. Price is a function of the COUNT,
 *                    the SIZE and the QUALITY.
 *   per IMAGE TOKEN  a `gpt-image-*` model. The response body carries a `usage`
 *                    block — `input_tokens`, `output_tokens` and
 *                    `input_tokens_details` — and the gateway prices from it.
 *
 * The part that costs money to get wrong: **no response header carries the
 * quantity.** There is no `x-nr-image-count`, no `x-nr-image-size`. The count,
 * size and quality that produced the price live only on the server-side spend
 * row, in `metadata.nrouter_units`. So this example records them ITSELF, from
 * the request it made and the response it got, because nothing else on the
 * client side can reconstruct them afterwards.
 *
 * Nothing here computes a price. The gateway settles every call and reports the
 * result in the `x-nr-*` response headers, which the SDK parses into
 * `result.meta`. This example's whole job is to READ that honestly: print one
 * line per call, append one JSON record per call, and — the part that is easy
 * to get wrong — refuse to fold an UNPRICED call into the total as zero.
 *
 * `x-nr-request-cost` is ABSENT when the gateway could not price a model; it is
 * never sent as `0`. So `meta.cost` is `null` and `meta.costStatus` is
 * `unpriced`. The request was served, the images were delivered, and it is on
 * your spend rows — it simply has no price attached here. Summing it as $0 is
 * how a spend dashboard quietly under-reports (Rule #28), so this example sums
 * only calls `isPriced()` accepts and labels the result TOTAL INCOMPLETE
 * whenever anything was left out.
 *
 * RUN IT
 *
 *   (cd ../../../sdks/js && npm run build)     # this example imports dist/
 *   export NROUTER_API_KEY=sk-nrouter-...
 *   node image-agent.mjs
 *
 * Every call below spends real credits, and an image call spends more of them
 * than a text one: the gateway holds `max($0.35, $0.35 x n)` before it calls the
 * provider and settles down to the real price afterwards. There is no retry
 * loop anywhere in this file, and the client below pins `maxRetries` to 0
 * explicitly: a retry is a second call and a second bill, and an automatic one
 * on a billed wire is how a transient blip becomes a doubled invoice.
 */

import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The built-from-source package, not a published one: this example is the
// SDK's own proof, so it must exercise the code in this repository.
import { isPriced, nRouter, nRouterError } from '../../../sdks/js/dist/index.mjs';

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
const IMAGE_MODEL = env.NROUTER_IMAGE_MODEL || 'gpt-image-1-mini';
const IMAGE_SIZE = env.NROUTER_IMAGE_SIZE || '1024x1024';
const IMAGE_QUALITY = env.NROUTER_IMAGE_QUALITY || 'low';
// The gateway caps `n` at 10 per request (`src/http/images.rs`: MAX_IMAGES).
// Asking for more is a 400, not a silent truncation, so it is checked here
// rather than discovered by a refused call.
const IMAGE_N = boundedInt(env.NROUTER_IMAGE_N, 1, 'NROUTER_IMAGE_N', 10);
const PROMPT_COUNT = boundedInt(env.NROUTER_IMAGE_PROMPTS, 2, 'NROUTER_IMAGE_PROMPTS', 100);

// Both default INSIDE this example's own directory, which carries a .gitignore
// for them. Resolving against the script rather than the shell's cwd keeps a
// run from scattering images and logs wherever it happened to be started.
const LOG_PATH = path.resolve(HERE, env.NROUTER_IMAGE_LOG || './image-agent.log.jsonl');
const OUT_DIR = path.resolve(HERE, env.NROUTER_IMAGE_OUT || './out');

/**
 * Whether to ask for base64 in the body, or a link.
 *
 * `gpt-image-*` models do not accept `response_format` at all — they always
 * return `b64_json`, and sending the parameter 400s the whole call, which
 * delivers nothing. Every other family DEFAULTS to `url`, and a url is the one
 * shape this example cannot save (see below), so it is asked for b64
 * explicitly.
 *
 * Decided here rather than left to the caller to remember, for the same reason
 * the voice example decides `verbose_json` for whisper: getting it wrong costs
 * nothing at the till and everything in the output.
 */
const RESPONSE_FORMAT =
  env.NROUTER_IMAGE_RESPONSE_FORMAT || (/^gpt-image/i.test(IMAGE_MODEL) ? undefined : 'b64_json');

/** Deterministic prompts, so a demo is repeatable and diffable. */
const PROMPTS = [
  'A flat vector illustration of a lighthouse on a rocky shore at dusk, three colours, no text.',
  'An isometric diagram of a small server rack with routed cables, muted palette, no text.',
  'A minimal line drawing of a paper aeroplane over a topographic map, single accent colour.',
];

function boundedInt(raw, fallback, name, max) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    console.error(`${name} must be an integer from 1 through ${max}; got ${JSON.stringify(raw)}.`);
    process.exit(1);
  }
  return value;
}

/**
 * The extension comes from the BYTES, never from a hoped-for format.
 *
 * `gpt-image-1` can be asked for webp or jpeg through `extra`, and a `.png`
 * name on a webp file is a file half the world's tooling refuses to open.
 */
function extensionForBytes(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'webp';
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
  return 'bin';
}

// --------------------------------------------------------------------------
// Per-call accounting
// --------------------------------------------------------------------------

const calls = [];

function money(value) {
  return value === null || value === undefined ? '—' : `$${value.toFixed(6)}`;
}

function tokens(meta) {
  const inTok = meta.inputTokens === null ? '—' : meta.inputTokens;
  const outTok = meta.outputTokens === null ? '—' : meta.outputTokens;
  return `${inTok}/${outTok}`;
}

async function record(entry) {
  calls.push(entry);
  await appendFile(LOG_PATH, `${JSON.stringify(entry)}\n`);
}

/**
 * Read the `usage` block a token-priced model returns, or `null`.
 *
 * `null` is "this response carried no usage block", which is the normal and
 * correct state for a per-IMAGE model. Zeroes would claim the model reported a
 * measurement of nothing, which is a different and false statement.
 */
function imageTokensFrom(body) {
  const usage = body && typeof body === 'object' ? body.usage : undefined;
  if (!usage || typeof usage !== 'object') return null;
  const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : null;
  const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : null;
  const total = typeof usage.total_tokens === 'number' ? usage.total_tokens : null;
  if (input === null && output === null && total === null) return null;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    // Verbatim. The split between text and image input tokens is what makes a
    // gpt-image bill explicable, and re-shaping it here would lose whichever
    // key the provider adds next.
    inputTokensDetails:
      usage.input_tokens_details && typeof usage.input_tokens_details === 'object'
        ? usage.input_tokens_details
        : null,
  };
}

/**
 * Run one billed image call and account for it whether it succeeds or fails.
 *
 * A failed call can still have cost money and it always has a request id, so
 * the failure path writes a record too. A log that only records successes is a
 * spend report that only sees the cheap half of a bad day.
 *
 * `enrich` runs AFTER the response and returns the image-specific facts — the
 * count actually delivered, the files written, the urls skipped. It runs before
 * the record is written so a single line in the log describes the whole call.
 */
async function metered(promptIndex, label, call, enrich) {
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

    // `enrich` runs on a call that ALREADY SUCCEEDED and was ALREADY BILLED,
    // so nothing it does may reach the `catch` below. That block rebuilds the
    // record from the ERROR, and a non-`nRouterError` carries no `meta`: cost,
    // costStatus, model and requestId would each log `null`, silently removing
    // a real charge from `pricedTotalUsd` and severing the spend-row join.
    // `saveImages` already turns a write failure into data; this is the second
    // arm, for anything else that could throw after the response arrived.
    //
    // ⚠ NOT EXERCISED BY `image_agent_suite.js`, and said out loud rather than
    // left to look tested. The only `enrich` body in this file is
    // `saveImages`, which catches every throwing operation it performs, so
    // nothing the suite can do from the wire reaches this arm — planting a
    // `throw` here leaves all eight runs green. It is defence in depth for the
    // NEXT enrich body, which must ship with a test that reaches it.
    let extra;
    try {
      extra = await enrich(result);
    } catch (cause) {
      extra = {
        count: 0,
        files: [],
        urls: [],
        saveErrors: [],
        imageTokens: null,
        enrichError: String(cause?.message ?? cause),
      };
      console.warn(
        `      ⚠ could not process the response: ${cause?.message ?? cause}\n` +
          '        The call WAS billed; the accounting below is still exact.',
      );
    }

    await record({
      ts: new Date().toISOString(),
      step: 'image',
      prompt: promptIndex,
      label,
      requestId: meta.requestId,
      model: meta.model,
      // THE QUANTITY, recorded client-side because no header carries it. The
      // gateway prices `Units::Images { count, width, height, quality }` and
      // writes that onto the spend row's `metadata.nrouter_units`; the response
      // says only what it cost. Drop these fields and this log can report a
      // number but never explain it.
      requestedN: IMAGE_N,
      size: IMAGE_SIZE,
      quality: IMAGE_QUALITY,
      responseFormat: RESPONSE_FORMAT ?? null,
      ...extra,
      // ALWAYS null on this route: the gateway publishes no guardrail posture
      // for images (`ResponseMeta.guardrails`: "Not published on the image,
      // audio or video routes"). That is "the gateway made no claim", NOT "no
      // guardrail applied" — `none` is an explicit posture with a different
      // meaning, and rendering null as `none` invents a reassurance nobody
      // gave. Recorded so a later log reader can see the claim was absent
      // rather than assume it was never asked for.
      guardrails: meta.guardrails,
      costStatus: meta.costStatus,
      // `meta.cost` is already `null` when absent. Never `?? 0`.
      cost: meta.cost,
      inputTokens: meta.inputTokens,
      outputTokens: meta.outputTokens,
      totalTokens: meta.totalTokens,
      // TWO clocks, and the pair is the point. `gatewayMs` is `x-nr-latency-ms`:
      // milliseconds from EDGE ARRIVAL until the response headers were ready,
      // which on an image call includes the whole provider render. `latencyMs`
      // is what this process timed around the call, so it adds the network to
      // and from the edge — and for a b64 response, the transfer of the image
      // itself, which is the bulk of it. Either alone is unactionable. Absent
      // is `null`, never 0 — a zero would claim a measurement was taken and
      // came back instant.
      gatewayMs: meta.latencyMs ?? null,
      latencyMs,
      ok: true,
      priced,
    });

    console.log(
      `[image] p=${promptIndex} ${meta.requestId ?? '(no request id)'} ${meta.model ?? '(model not reported)'} ` +
        `${meta.costStatus ?? '(no cost status)'} ${money(meta.cost)} n=${extra.count} ${IMAGE_SIZE} ${IMAGE_QUALITY} ` +
        `tokens=${tokens(meta)} guardrails=${meta.guardrails ?? '—'} ` +
        // `??` rather than `=== null`: a strict check prints `gw=undefinedms`
        // on the value it was meant to guard against. A genuine 0 still
        // renders as `0ms`, which is a measurement and must not become `—`.
        `gw=${meta.latencyMs ?? '—'}ms client=${latencyMs}ms  ${label}`,
    );

    if (!priced) {
      console.warn(
        `      ⚠ costStatus=${meta.costStatus ?? 'absent'}: this request WAS served, the images ` +
          'were delivered, and it is on your spend rows — but nRouter could not price it. It is ' +
          'excluded from the total below — do NOT record it as $0.',
      );
    }

    return result;
  } catch (error) {
    const meta = error instanceof nRouterError ? error.meta : undefined;
    await record({
      ts: new Date().toISOString(),
      step: 'image',
      prompt: promptIndex,
      label,
      requestId: meta?.requestId ?? null,
      model: meta?.model ?? null,
      requestedN: IMAGE_N,
      size: IMAGE_SIZE,
      quality: IMAGE_QUALITY,
      responseFormat: RESPONSE_FORMAT ?? null,
      // Reachable ONLY from a failed `call()` — every post-response failure is
      // absorbed above — so nothing was delivered, and `0` here is a
      // measurement of the delivery rather than a guess about the price.
      count: 0,
      files: [],
      urls: [],
      saveErrors: [],
      imageTokens: null,
      guardrails: meta?.guardrails ?? null,
      costStatus: meta?.costStatus ?? null,
      cost: meta?.cost ?? null,
      inputTokens: meta?.inputTokens ?? null,
      outputTokens: meta?.outputTokens ?? null,
      totalTokens: meta?.totalTokens ?? null,
      gatewayMs: meta?.latencyMs ?? null,
      latencyMs: Date.now() - started,
      ok: false,
      // A refused call is not a priced one, and it is not an unpriced SERVED
      // one either — the summary counts it separately.
      priced: false,
      error: error instanceof nRouterError ? `${error.kind}: ${error.message}` : String(error?.message ?? error),
    });
    throw error;
  }
}

function printSummary() {
  // Three buckets, not two. A call that FAILED is not a call that was "served
  // without a price": lumping them together tells the operator the gateway
  // priced nothing when in fact it refused, which sends them to the wrong page.
  const failed = calls.filter((entry) => !entry.ok);
  const priced = calls.filter((entry) => entry.ok && entry.priced);
  const unpriced = calls.filter((entry) => entry.ok && !entry.priced);
  const pricedTotalUsd = priced.reduce((sum, entry) => sum + entry.cost, 0);
  const imagesReturned = calls.reduce((sum, entry) => sum + entry.count, 0);
  const filesWritten = calls.reduce((sum, entry) => sum + entry.files.length, 0);
  const urlsSkipped = calls.reduce((sum, entry) => sum + entry.urls.length, 0);
  const saveErrors = calls.reduce((sum, entry) => sum + entry.saveErrors.length, 0);

  console.log('\nSESSION SUMMARY');
  console.log(`  calls            ${calls.length}`);
  console.log(`  imagesReturned   ${imagesReturned}`);
  console.log(`  filesWritten     ${filesWritten}`);
  console.log(`  urlsNotDownloaded ${urlsSkipped}`);
  console.log(`  saveErrors       ${saveErrors}`);
  console.log(`  pricedCalls      ${priced.length}`);
  console.log(`  unpricedCalls    ${unpriced.length}`);
  console.log(`  failedCalls      ${failed.length}`);
  console.log(`  pricedTotalUsd   ${pricedTotalUsd.toFixed(8)}`);

  if (unpriced.length > 0 || failed.length > 0) {
    const reasons = [];
    if (unpriced.length > 0) {
      reasons.push(`${unpriced.length} call(s) were SERVED without a price`);
    }
    if (failed.length > 0) {
      // "may": the gateway releases what it reserved on a routing or upstream
      // failure, but a call refused after the provider ran was still billed
      // upstream. The log rows say which calls, and the request ids say where
      // to check.
      reasons.push(`${failed.length} call(s) FAILED and may still have been billed`);
    }
    console.log(
      `  TOTAL INCOMPLETE — ${reasons.join('; ')}. ` +
        'The figure above is the priced subset, NOT the session total.',
    );
  } else {
    console.log('  TOTAL COMPLETE — every call in this session was priced exactly.');
  }

  if (saveErrors > 0) {
    // Deliberately SEPARATE from the money verdict above. Every call may have
    // priced exactly — the accounting can be COMPLETE — while the images the
    // customer paid for are not on this disk. Folding the two together would
    // report a billing problem that does not exist, or hide a delivery one
    // that does.
    console.log(
      `  ⚠ ${saveErrors} image(s) were BILLED AND DELIVERED but could NOT BE SAVED. ` +
        'The prices above are correct; the files are missing locally.',
    );
  }

  console.log(`\n  log: ${LOG_PATH}`);
  console.log(`  images: ${OUT_DIR}`);
  console.log(
    '\n  Join it up: every requestId above is `x-nr-request-id`, which is the same value as\n' +
      '  the spend row\'s request id. Look each one up on the dashboard Logs page to see the\n' +
      '  settled cost, the org/team/key it was billed to, and the units it was measured in —\n' +
      '  `metadata.nrouter_units` carries `{"unit":"image","count":n,"size":...,"quality":...}`\n' +
      '  for a per-image model and the image-token breakdown for a gpt-image one. The gateway\n' +
      '  sends NO quantity header, so the count/size/quality above were recorded by this client\n' +
      '  from its own request — they are what to reconcile the spend row against.',
  );
}

// --------------------------------------------------------------------------
// The loop
// --------------------------------------------------------------------------

// `maxRetries: 0` is stated rather than inherited. The SDK's default is already
// 0, but a DEFAULT is a promise someone else keeps: on a wire where every
// attempt is a separate bill — and an image attempt holds $0.35 per image — the
// no-retry property should be visible in the code that spends the money, not
// one release note away from changing.
const client = new nRouter({ apiKey: API_KEY, baseURL: BASE_URL, maxRetries: 0 });

/**
 * Save what the response actually delivered.
 *
 * TWO shapes, and only one of them is bytes:
 *
 *   `b64_json`  base64 INSIDE the JSON body. `image()` always returns JSON —
 *               there is no image-bytes route — so the decode happens here,
 *               and the byte count written is recorded so the log can be
 *               checked against the file rather than trusted.
 *   `url`       a link to the provider's CDN. Deliberately NOT fetched: an
 *               example that reaches out to an arbitrary gateway-supplied host
 *               performs an egress the reader never asked for, from a process
 *               holding their API key. The link is RECORDED instead, and the
 *               link expires — which is exactly why b64 is the default above.
 */
async function saveImages(promptIndex, body) {
  const data = Array.isArray(body?.data) ? body.data : [];
  const files = [];
  const urls = [];
  const saveErrors = [];

  for (let index = 0; index < data.length; index += 1) {
    const item = data[index];
    const b64 = item && typeof item.b64_json === 'string' ? item.b64_json : null;
    if (b64) {
      const bytes = Buffer.from(b64, 'base64');
      const file = path.join(OUT_DIR, `image-${promptIndex}-${index + 1}.${extensionForBytes(bytes)}`);
      try {
        await writeFile(file, bytes);
        files.push({ path: file, bytes: bytes.length });
        console.log(`      wrote ${file} (${bytes.length} bytes)`);
      } catch (cause) {
        // A FAILED WRITE IS DATA, NOT AN EXCEPTION. Throwing here would send a
        // call that SUCCEEDED and was BILLED into the caller's failure path,
        // where the record is rebuilt from the error — and a filesystem error
        // carries no `meta`, so the cost, the model and the request id would
        // all log `null`. The charge would vanish from the session total and
        // take the spend-row join key with it. A full disk must not be able to
        // erase a bill.
        //
        // It also must not lose the OTHER images in the same response: one bad
        // write is one entry here, and the loop continues.
        saveErrors.push({
          path: file,
          bytes: bytes.length,
          error: String(cause?.message ?? cause),
        });
        console.warn(
          `      ⚠ could not write ${file} (${bytes.length} bytes): ${cause?.message ?? cause}\n` +
            '        The image WAS generated and the call WAS billed — this is a local ' +
            'failure to save it, not a failure to charge for it.',
        );
      }
      continue;
    }
    const url = item && typeof item.url === 'string' ? item.url : null;
    if (url) {
      urls.push(url);
      console.log(`      url  ${url}  (recorded, not downloaded)`);
      continue;
    }
    console.warn(`      ⚠ image ${index + 1} carried neither b64_json nor url; nothing to save`);
  }

  // `data.length`, not `IMAGE_N`: what was DELIVERED, which is what the spend
  // row was priced on. A provider that returns fewer than asked for is a real
  // state, and reporting the request instead of the response would hide it.
  return { count: data.length, files, urls, saveErrors };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(path.dirname(LOG_PATH), { recursive: true });
  // Truncate: a session's log is that session's, and appending across runs
  // would make the totals above the sum of two different sessions.
  await writeFile(LOG_PATH, '');

  console.log(`gateway   ${BASE_URL}`);
  console.log(`model     ${IMAGE_MODEL}`);
  console.log(`size      ${IMAGE_SIZE} (quality ${IMAGE_QUALITY})`);
  console.log(`n         ${IMAGE_N} per call, ${PROMPT_COUNT} prompt(s)`);
  console.log(
    `format    ${RESPONSE_FORMAT ?? 'provider default (gpt-image-* always returns b64_json and rejects the parameter)'}\n`,
  );

  for (let promptIndex = 1; promptIndex <= PROMPT_COUNT; promptIndex += 1) {
    const prompt = PROMPTS[(promptIndex - 1) % PROMPTS.length];
    console.log(`prompt ${promptIndex}: ${prompt}`);

    await metered(
      promptIndex,
      'generate',
      () =>
        client.nr.media.image({
          model: IMAGE_MODEL,
          prompt,
          n: IMAGE_N,
          size: IMAGE_SIZE,
          quality: IMAGE_QUALITY,
          // `undefined` is DROPPED by the SDK's `defined()` helper, so a
          // gpt-image model sends no `response_format` key at all rather than
          // a null the provider would reject.
          ...(RESPONSE_FORMAT ? { response_format: RESPONSE_FORMAT } : {}),
        }),
      async (result) => ({
        ...(await saveImages(promptIndex, result.body)),
        imageTokens: imageTokensFrom(result.body),
      }),
    );
  }

  // The money is settled and reported either way, but a run that could not
  // save what it paid for did not do its job — a scripted caller must see a
  // non-zero exit rather than a green run and an empty directory.
  const unsaved = calls.reduce((sum, entry) => sum + entry.saveErrors.length, 0);
  if (unsaved > 0) {
    throw new Error(
      `${unsaved} image(s) were billed and delivered but could not be written to ${OUT_DIR}`,
    );
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof nRouterError) {
    // A typed refusal. The distinction that matters operationally is WHY:
    // `credit` needs a top-up, `authentication` needs a different key,
    // `rate_limit` names the limit that measured it via `limitSource`, and
    // none of them is fixed by trying again immediately.
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
  // ALWAYS. Money was spent before the failure too, and a run that dies
  // without reporting what it already billed is the worst possible outcome
  // for the person reading this output.
  printSummary();
}
