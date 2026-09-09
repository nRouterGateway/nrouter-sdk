#!/usr/bin/env node
/**
 * nRouter chat agent — every TEXT wire in one loop, each one accounted for.
 *
 *   /v1/messages          an Anthropic-family id, buffered
 *   /v1/chat/completions  an OpenAI-family id, buffered
 *   /v1/responses         the Responses wire, buffered
 *   /v1/chat/completions  the SAME call, STREAMED
 *   /v1/chat/completions  the SAME buffered body again, to observe the cache
 *   /v1/messages/count_tokens   free
 *
 * The voice agent next door proves three DIFFERENT billing units. This one
 * proves something the single-wire examples cannot: that the four text wires
 * account for money in three DIFFERENT ways, and that only one of them hands
 * you a price in the response.
 *
 *   BUFFERED   `x-nr-request-cost` carries the settled figure, `x-nr-cost-status`
 *              says `exact`. Sum it.
 *   STREAMED   the headers are written before the first body byte, so nothing
 *              has been generated and nothing can be priced. `costStatus` is
 *              `unpriced` with NO amount, permanently, on every stream. The
 *              real figure lands on the spend row afterwards and joins on
 *              `meta.requestId`. This is honest, not a gap — see the note at
 *              `recordStream()` below.
 *   FREE       `/v1/messages/count_tokens` reports no cost header, and there
 *              that absence means ZERO rather than unknown. It is the one
 *              place in this file where a missing header is not a warning.
 *
 * Two absences, opposite meanings, and telling them apart is the whole job of
 * the accounting below. `sdks/js/docs/cost.md` is the contract; this file is
 * the executable reading of it.
 *
 * The fifth call is the response cache. Repeat a buffered text request with a
 * byte-identical body and the gateway may serve it from its tenant-isolated
 * cache: `x-nr-response-cache: hit` plus `x-nr-response-cache-age`. A HIT IS
 * STILL BILLED AND METERED — it skips the provider call and nothing else, so
 * authorization, rate limits, guardrails, usage accounting, budgets and the
 * spend row all still happen. Caching cuts OUR provider cost, never your
 * invoice; never read a hit as a discount.
 *
 * ⚠ A cache hit is NOT asserted here, and a run that never sees one is not a
 * bug. Two independent gates decide it — an operator gate per deployment and
 * your organization's own toggle — and with the operator gate off the header
 * is absent entirely and `meta.responseCache` is `null`. This example REPORTS
 * what it observed; it does not require an outcome it does not control.
 *
 * RUN IT
 *
 *   (cd ../../../sdks/js && npm run build)     # this example imports dist/
 *   export NROUTER_API_KEY=sk-nrouter-...
 *   node chat-agent.mjs
 *
 * Five of the six calls per turn spend real credits. There is no retry loop
 * anywhere in this file, and the client below pins `maxRetries` to 0
 * explicitly: a retry is a second call and a second bill, and an automatic one
 * on a billed wire is how a transient blip becomes a doubled invoice.
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

/**
 * The master key is NEVER used for inference, and never for the spend lookup
 * either. Refused HERE, before the first call, rather than left to the gateway:
 * every call in this file is a billed inference request, so a master-shaped key
 * reaching this point is a mistake worth stopping while it is still free.
 *
 * The lookup added below sends the SAME key, so one guard covers both. A key
 * that could authenticate the join but not the call — or the reverse — would be
 * a second credential in a file whose whole claim is that there is only one.
 */
const MASTER_KEY_SHAPES = [/^sk-nrouter-master/i, /^sk-master-/i, /^sk-admin-/i];
if (MASTER_KEY_SHAPES.some((shape) => shape.test(API_KEY))) {
  console.error(
    'NROUTER_API_KEY looks like a MASTER key. This example makes billed inference calls and reads ' +
      'a spend row back; both take your own sk-nrouter-… virtual key. Refusing before anything is ' +
      'sent.',
  );
  process.exit(1);
}

const BASE_URL = env.NROUTER_BASE_URL || 'https://api.nrouter.ai/v1';

// THE WIRE IS CHOSEN BY THE MODEL ID, and `client.nr.chat()` does the choosing.
// An Anthropic-family id posts to /v1/messages, which is the ONLY wire the
// gateway serves Anthropic on — the same id sent to /v1/chat/completions
// answers 404 model_unavailable_on_route. Everything else takes the
// OpenAI-shaped wire. Two model variables rather than one, so a single run
// exercises BOTH paths instead of whichever one the default happened to pick.
// nrouter-doc-wire: messages
const MESSAGES_MODEL = env.NROUTER_MESSAGES_MODEL || 'claude-3-5-haiku-20241022';
const CHAT_MODEL = env.NROUTER_CHAT_MODEL || 'gpt-4.1-mini';
const RESPONSES_MODEL = env.NROUTER_RESPONSES_MODEL || 'gpt-4.1-mini';

const MAX_TOKENS = positiveInt(env.NROUTER_MAX_TOKENS, 120, 'NROUTER_MAX_TOKENS');

/**
 * How many completions to ask for on the Messages call.
 *
 * Above 1 this is REFUSED BEFORE THE SOCKET OPENS: the Anthropic Messages wire
 * returns exactly one completion, so the SDK raises a `configuration` error
 * rather than dropping the field and reporting success for a request that asked
 * for more and was billed. That refusal is the fourth failure class this example
 * accounts for — see `sentToGateway` below — and it is the one that costs
 * nothing, which is exactly why it must not be logged as if it might have.
 */
const COMPLETIONS_N = positiveInt(env.NROUTER_COMPLETIONS_N, 1, 'NROUTER_COMPLETIONS_N');
const TURNS = positiveInt(env.NROUTER_TURNS, 2, 'NROUTER_TURNS');

/**
 * OPTIONAL client-side rates, in USD per MILLION tokens, used to RECOMPUTE what
 * the streamed call probably cost.
 *
 * Both must be set or nothing is recomputed, and NO RATE CARD IS SHIPPED HERE
 * ON PURPOSE. A price table baked into a public example rots silently and is
 * then read as authoritative — the exact failure mode that produces a confident
 * wrong number. You supply the rates you were quoted; this file only does the
 * arithmetic and labels the result as yours.
 *
 * Whatever it produces is an ESTIMATE and is never added to `pricedTotalUsd`.
 * The gateway settles the same frames itself and writes the real figure to the
 * spend row; that row is the invoice, this is a sanity check against it.
 */
const RATE_IN_PER_MTOK = optionalRate(env.NROUTER_STREAM_RATE_IN_PER_MTOK, 'NROUTER_STREAM_RATE_IN_PER_MTOK');
const RATE_OUT_PER_MTOK = optionalRate(env.NROUTER_STREAM_RATE_OUT_PER_MTOK, 'NROUTER_STREAM_RATE_OUT_PER_MTOK');
const RECOMPUTE_STREAM_COST = RATE_IN_PER_MTOK !== null && RATE_OUT_PER_MTOK !== null;

// BOTH rates zero can only ever print `$0.000000` under a `RECOMPUTED` label,
// and a labelled zero is read as a price. Refuse the configuration rather than
// emit the one number that is never right (Rule #28).
if (RECOMPUTE_STREAM_COST && RATE_IN_PER_MTOK === 0 && RATE_OUT_PER_MTOK === 0) {
  console.error(
    'NROUTER_STREAM_RATE_IN_PER_MTOK and NROUTER_STREAM_RATE_OUT_PER_MTOK are both 0, which can ' +
      'only produce a $0.000000 estimate. Unset them to skip the recomputation instead.',
  );
  process.exit(1);
}

// Defaults INSIDE this example's own directory, which carries a .gitignore for
// it. Resolving against the script rather than the shell's cwd keeps a run from
// scattering logs wherever it happened to be started.
const LOG_PATH = path.resolve(HERE, env.NROUTER_CHAT_LOG || './chat-agent.log.jsonl');

/**
 * OPTIONAL. The DASHBOARD host — a different host from the gateway, and this is
 * the one place the two are not interchangeable.
 *
 * Inference goes to `NROUTER_BASE_URL` (`api.nrouter.ai/v1`). The settled spend
 * row is read from the dashboard app (`nrouter.ai`), so deriving one from the
 * other is wrong in both directions. Unset by default: without it the session
 * still runs and simply reports that the join was skipped.
 *
 * It is the ONLY way to see what a STREAMED call cost. That response carries no
 * price and never will, so the spend row is not a nicety here — it is the
 * figure itself.
 */
const DASHBOARD_URL = (env.NROUTER_DASHBOARD_URL || '').replace(/\/+$/, '');

// A settled row can take a moment to appear after a stream closes, so a single
// `null` is not final — poll `total` a few times before believing it. Bounded,
// because the route is rate limited to 60 lookups per minute per key and an
// unbounded poll on a dozen request ids is how an example becomes a 429.
const SETTLED_POLL_ATTEMPTS = positiveInt(env.NROUTER_SETTLED_POLL_ATTEMPTS, 3, 'NROUTER_SETTLED_POLL_ATTEMPTS');
const SETTLED_POLL_MS = positiveInt(env.NROUTER_SETTLED_POLL_MS, 500, 'NROUTER_SETTLED_POLL_MS');

const SYSTEM_PROMPT =
  env.NROUTER_SYSTEM_PROMPT ||
  'You are a concise support assistant. Answer in at most two short sentences, in plain English, ' +
    'with no lists, markdown or emoji.';

const OPENING_LINE =
  env.NROUTER_OPENING_LINE ||
  "Hi, I'd like to check on my order. Can you tell me whether it has shipped yet?";

/** Deterministic follow-ups, so the loop is a conversation without any input. */
const FOLLOW_UPS = [
  'Thanks. When should I expect it to arrive?',
  'Could you send the tracking number to the email on the account?',
  'One more thing: can I still change the delivery address?',
];

function positiveInt(raw, fallback, name) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`${name} must be a positive integer; got ${JSON.stringify(raw)}.`);
    process.exit(1);
  }
  return value;
}

function optionalRate(raw, name) {
  if (raw === undefined || raw === '') return null;
  const value = Number(raw);
  // A NEGATIVE or non-numeric rate is refused rather than clamped: clamping to
  // 0 would produce a $0 estimate out of an obviously wrong input.
  //
  // A rate of exactly 0 on ONE counter is allowed on purpose — a model that
  // bills output only is a real thing — but BOTH at 0 can only ever produce
  // $0.000000, which is not a price any billable model has. That pair is
  // refused below, where both values are in hand.
  if (!Number.isFinite(value) || value < 0) {
    console.error(`${name} must be a non-negative number of USD per million tokens; got ${JSON.stringify(raw)}.`);
    process.exit(1);
  }
  return value;
}

// --------------------------------------------------------------------------
// Per-call accounting
// --------------------------------------------------------------------------

const calls = [];

function money(value) {
  return value === null || value === undefined ? '—' : `$${value.toFixed(6)}`;
}

function tokenPair(inTok, outTok) {
  return `${inTok === null || inTok === undefined ? '—' : inTok}/${
    outTok === null || outTok === undefined ? '—' : outTok
  }`;
}

async function append(entry) {
  calls.push(entry);
  await appendFile(LOG_PATH, `${JSON.stringify(entry)}\n`);
}

/**
 * The text of a `/v1/responses` reply, defensively.
 *
 * `client.nr.text()` reads the chat and Messages shapes; the Responses wire is
 * a third one, so it gets its own reader rather than a cast. Never throws — a
 * reply whose text this cannot find is still a BILLED call, and losing the
 * accounting over a shape surprise is the expensive failure.
 */
function responsesText(body) {
  if (!body || typeof body !== 'object') return '';
  if (typeof body.output_text === 'string') return body.output_text;
  const output = Array.isArray(body.output) ? body.output : [];
  const parts = [];
  for (const item of output) {
    const content = item && Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (part && typeof part.text === 'string') parts.push(part.text);
    }
  }
  return parts.join('');
}

function cacheLabel(meta) {
  // FOUR states, and three of them are not `miss`:
  //
  //   miss     the cache looked for this exact request and did not find it
  //   hit      it found one, and the response was served from it — still BILLED
  //   bypass   this request is not cacheable at all. Every STREAM reports this:
  //            a cache stores a complete response, and a stream is relayed as
  //            it is produced.
  //   null     the header was absent, so THIS GATEWAY IS NOT CACHING. Rendering
  //            it as `miss` claims a lookup nobody performed, and tells a
  //            customer their opt-out is working when nothing consulted it.
  return meta.responseCache === null || meta.responseCache === undefined
    ? '—'
    : meta.responseCacheAge === null || meta.responseCacheAge === undefined
      ? meta.responseCache
      : `${meta.responseCache}(${meta.responseCacheAge}s)`;
}

/**
 * Run one call and account for it whether it succeeds or fails.
 *
 * A failed call can still have cost money and it always has a request id, so
 * the failure path writes a record too. A log that only records successes is a
 * spend report that only sees the cheap half of a bad day.
 *
 * `streamed` and `free` are declared by the CALLER, not sniffed from the
 * response. Both change how the money is read, and inferring them from an
 * absent cost header would make the two absences — "unpriced by design" and
 * "unpriceable model" — indistinguishable, which is the exact confusion this
 * whole file exists to prevent.
 */
async function metered(step, turn, label, wire, call, options = {}) {
  const { streamed = false, free = false, after } = options;
  const started = Date.now();
  try {
    const result = await call();
    // `after` drains a stream, so it is INSIDE the timing window on purpose:
    // on a streamed call the wall-clock number a caller cares about is time to
    // the last token, not time to the first header.
    const extra = after ? await after(result) : {};
    const latencyMs = Date.now() - started;
    const meta = result.meta;

    // ONE pricing predicate, decided here and carried on the record. The
    // summary must not re-derive it: two copies of "was this priced?" drift the
    // day `isPriced` changes, and they drift in the direction that either sums
    // an unpriced call or hides a priced one.
    //
    // A stream is `false` by CONSTRUCTION, not by measurement — its headers are
    // written before generation, so there is nothing to price and never will
    // be for that response.
    const priced = streamed ? false : isPriced(meta);

    if (streamed && isPriced(meta)) {
      // Not reachable against today's gateway, and loud rather than silent if
      // it ever becomes reachable: a stream that DID carry an exact cost is a
      // contract change, and quietly dropping the amount would under-report.
      console.warn(
        `      ⚠ a STREAMED call reported ${meta.costStatus} ${money(meta.cost)}. ` +
          'Streams are unpriced by construction; this amount was NOT summed. ' +
          'Check sdks/js/docs/cost.md — the contract may have changed.',
      );
    }
    if (free && meta.cost !== null && meta.cost !== undefined) {
      console.warn(
        `      ⚠ ${wire} is documented free but reported ${money(meta.cost)}. ` +
          'It was NOT summed. Check sdks/js/docs/cost.md.',
      );
    }

    const inputTokens = extra.inputTokens ?? meta.inputTokens;
    const outputTokens = extra.outputTokens ?? meta.outputTokens;
    const totalTokens = extra.totalTokens ?? meta.totalTokens;

    await append({
      ts: new Date().toISOString(),
      step,
      turn,
      label,
      // The path this call is DOCUMENTED to take. The SDK does not report the
      // path it chose, so this is the example's claim, not an observation —
      // the mock suite beside this file is what proves the claim, by counting
      // requests per route on a server it controls.
      wire,
      requestId: meta.requestId,
      model: meta.model,
      costStatus: meta.costStatus,
      // `meta.cost` is already `null` when absent. Never `?? 0`.
      cost: meta.cost,
      priced,
      streamed,
      free,
      inputTokens,
      outputTokens,
      totalTokens,
      // Where the usage numbers came from. On a stream the headers carry none,
      // so they arrive in a final usage FRAME instead — and a record that did
      // not say which would make a missing usage chunk look like a gateway
      // that stopped reporting tokens.
      usageFrom: extra.usageFrom ?? (inputTokens === null ? null : 'headers'),
      // OUR arithmetic, from rates the operator supplied — never the gateway's
      // settled figure, and never summed into `pricedTotalUsd`. Its own field
      // so that no later reader can mistake it for `cost`.
      recomputedUsd: extra.recomputedUsd ?? null,
      responseCache: meta.responseCache ?? null,
      responseCacheAge: meta.responseCacheAge ?? null,
      guardrails: meta.guardrails ?? null,
      // TWO clocks. `gatewayMs` is `x-nr-latency-ms`: milliseconds from EDGE
      // ARRIVAL until the response headers were ready. `latencyMs` is what this
      // process timed around the whole call, so it adds the network to and from
      // the edge. Either alone is unactionable: a slow model and a slow link
      // look identical.
      //
      // ⚠ `gatewayMs` is TIME TO HEADERS. On the streamed call it is therefore
      // NOT a generation time, and comparing it with that call's `latencyMs`
      // measures the whole generation against the first header. That is the one
      // pair in this log that is not like for like.
      //
      // `?? null` because an `undefined` is DROPPED by JSON.stringify, and a
      // record missing the key reads as "this log predates gateway latency"
      // rather than "the gateway did not report it".
      gatewayMs: meta.latencyMs ?? null,
      latencyMs,
      ok: true,
      // A response came back, so the request reached the gateway and is billed
      // per its own cost fields above. See the error path for the three-valued
      // contract this field carries.
      sentToGateway: true,
      billed: true,
    });

    console.log(
      `[${step}] turn=${turn} ${meta.requestId ?? '(no request id)'} ${meta.model ?? '(model not reported)'} ` +
        `${meta.costStatus ?? '(no cost status)'} ${money(meta.cost)} tokens=${tokenPair(inputTokens, outputTokens)} ` +
        // `??` rather than `=== null`: a strict check prints `gw=undefinedms`
        // on the value it was meant to guard against. A genuine 0 still renders
        // as `0ms`, which is a measurement and must not become `—`.
        `gw=${meta.latencyMs ?? '—'}ms client=${latencyMs}ms cache=${cacheLabel(meta)} ` +
        `guardrails=${meta.guardrails ?? '—'}  ${label}`,
    );

    if (streamed) {
      console.log(
        '      ↳ streamed: costStatus is `unpriced` with no amount BY DESIGN — the headers were ' +
          'written before a token existed. The settled figure is on the spend row; join it on ' +
          `requestId ${meta.requestId ?? '(none)'}.`,
      );
      if (extra.recomputedUsd !== null && extra.recomputedUsd !== undefined) {
        console.log(
          `      ↳ recomputed ≈ ${money(extra.recomputedUsd)} from ${tokenPair(inputTokens, outputTokens)} ` +
            `tokens × YOUR rates ($${RATE_IN_PER_MTOK}/$${RATE_OUT_PER_MTOK} per Mtok). ` +
            'RECOMPUTED, NOT the gateway\'s settled figure — an estimate to check the spend row ' +
            'against, never a substitute for it.',
        );
      } else if (RECOMPUTE_STREAM_COST) {
        console.log(
          '      ↳ not recomputed: the stream carried no usage frame, so there are no token counts ' +
            'to multiply. Absent, not zero.',
        );
      }
    } else if (free) {
      console.log('      ↳ free: this route reports no cost header, and here that absence means ZERO.');
    } else if (!priced) {
      console.warn(
        `      ⚠ costStatus=${meta.costStatus ?? 'absent'}: this request WAS served and consumed ` +
          'provider capacity, but nRouter could not price it. It is excluded from the total ' +
          'below — do NOT record it as $0.',
      );
    }

    return result;
  } catch (error) {
    const meta = error instanceof nRouterError ? error.meta : undefined;

    // THREE-VALUED, and the third value is the honest one.
    //
    //   false  the SDK refused BEFORE anything left this process. Nothing was
    //          sent, so nothing can have been billed, and saying it "may have
    //          been" sends an operator to check an invoice line that cannot
    //          exist.
    //   true   the gateway answered. It reached us, so it is billed per its own
    //          rules whatever the status was.
    //   null   we got NO answer: a transport failure or a timeout. The request
    //          may well have arrived and been billed, and this is the state that
    //          must never be flattened into either of the other two.
    //
    // ⚠ THE KIND ALONE IS NOT ENOUGH, and getting this wrong writes off a real
    // charge. `configuration` covers two different moments: a refusal built
    // before the socket opened, and `requireJson()` rejecting a SERVED 2xx whose
    // body was not JSON — a request that reached the gateway, ran, and was
    // billed. The SDK distinguishes them itself by carrying `status` (and the
    // meta) on the second: see the comment in `sdks/js/src/json.ts`, which says
    // in as many words that omitting them would report "never reached the
    // gateway" for a request that plainly did.
    //
    // So: `false` requires the kind AND the absence of any HTTP status. ANY
    // status means a response existed, which means it was sent.
    //
    // Decided from the ERROR, never from a missing request id: a gateway that
    // answered without one still charged for the call, and reading that absence
    // as "never sent" would write the charge off just as surely.
    const refusedBeforeSend =
      error instanceof nRouterError &&
      error.kind === 'configuration' &&
      (error.status === null || error.status === undefined);
    //
    // `> 0`, not merely "not null": some stacks surface status 0 for an aborted
    // or cross-origin request where NO HTTP response existed. A 0 must fall
    // through to `null` — unknown — rather than claim a response arrived. There
    // is no real status 0, so treating it as evidence is claiming knowledge from
    // a placeholder.
    const answered =
      (error instanceof nRouterError && typeof error.status === 'number' && error.status > 0) ||
      Boolean(meta?.requestId);
    const sentToGateway = refusedBeforeSend ? false : answered ? true : null;

    await append({
      ts: new Date().toISOString(),
      step,
      turn,
      label,
      wire,
      requestId: meta?.requestId ?? null,
      model: meta?.model ?? null,
      costStatus: meta?.costStatus ?? null,
      cost: meta?.cost ?? null,
      // A refused call is not a priced one, and it is not an unpriced SERVED
      // one either — the summary counts it in its own bucket.
      priced: false,
      streamed,
      free,
      inputTokens: meta?.inputTokens ?? null,
      outputTokens: meta?.outputTokens ?? null,
      totalTokens: meta?.totalTokens ?? null,
      usageFrom: null,
      responseCache: meta?.responseCache ?? null,
      responseCacheAge: meta?.responseCacheAge ?? null,
      guardrails: meta?.guardrails ?? null,
      gatewayMs: meta?.latencyMs ?? null,
      latencyMs: Date.now() - started,
      ok: false,
      sentToGateway,
      // Anything that was not refused locally may have cost money.
      billed: sentToGateway !== false,
      error:
        error instanceof nRouterError
          ? `${error.kind}: ${error.message}`
          : String(error?.message ?? error),
    });
    throw error;
  }
}

// --------------------------------------------------------------------------
// The settled join — the only way to see what a streamed call cost
// --------------------------------------------------------------------------

/**
 * One request id's settled spend row, polled until it lands or the budget runs
 * out.
 *
 * `{ "log": null, "total": 0 }` with HTTP 200 is the answer for BOTH a request
 * id that belongs to another organization and one that never existed — the
 * route is scoped to the organization on your key and deliberately reveals
 * nothing about ids outside it. It is also, briefly, the answer for a row that
 * has not landed yet. None of those three is `$0`.
 */
async function lookupSettled(requestId) {
  const url = `${DASHBOARD_URL}/api/nrouter-proxy/spend/by-key?request_id=${encodeURIComponent(requestId)}`;
  for (let attempt = 1; attempt <= SETTLED_POLL_ATTEMPTS; attempt += 1) {
    const res = await fetch(url, {
      // The SAME virtual key that made the call. There is no second credential.
      headers: { authorization: `Bearer ${API_KEY}`, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401) {
      throw new Error(
        'the spend lookup refused this key (401). It takes the same sk-nrouter-… virtual key the ' +
          'calls were made with — a master-shaped key is refused by design.',
      );
    }
    if (res.status === 429) {
      throw new Error(
        'the spend lookup is rate limited to 60 lookups per minute per key, and this run exceeded ' +
          'it. Lower NROUTER_TURNS or NROUTER_SETTLED_POLL_ATTEMPTS.',
      );
    }
    if (!res.ok) throw new Error(`the spend lookup answered HTTP ${res.status}`);
    const json = await res.json();
    if (json && json.total > 0 && json.log) return json.log;
    if (attempt < SETTLED_POLL_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, SETTLED_POLL_MS));
    }
  }
  return null;
}

/**
 * The calls that have a spend row to read back — ONE predicate, used by both the
 * join and the summary.
 *
 * Two copies of "which calls are billed?" drift, and they drift in the direction
 * where the summary counts a call the join never looked up, then reports the
 * missing total without being able to say which row is missing.
 *
 * The free `count_tokens` calls are excluded: they write no spend row at all, so
 * looking them up would spend rate-limit budget to learn nothing and a `null`
 * from one would look like a missing row rather than a route that never writes
 * one. An entry with no request id is excluded too — there is nothing to join
 * on — which is why the exclusion lives here rather than being re-derived.
 */
function hasSpendRow(entry) {
  return entry.ok === true && typeof entry.requestId === 'string' && entry.requestId.length > 0 && (entry.streamed || entry.priced);
}

/**
 * Read the settled figure back for every call that has a spend row, and write it
 * onto the log.
 */
async function joinSettledRows() {
  const billed = calls.filter(hasSpendRow);
  console.log(`\nSETTLED JOIN — ${billed.length} lookup(s) against ${DASHBOARD_URL}`);

  for (const entry of billed) {
    const row = await lookupSettled(entry.requestId);

    if (row === null) {
      // NOT $0, and the message says all three reasons out loud because the
      // operator reading it cannot tell them apart from here either.
      entry.settledFound = false;
      entry.settledUsd = null;
      entry.settledCostStatus = null;
      entry.settledBasisKnown = false;
      console.log(
        `[settled] ${entry.requestId} not yet settled / not visible — a row that has not landed, ` +
          'an id from another organization and an id that never existed all answer {"log":null}. ' +
          'NOT $0.',
      );
      continue;
    }

    // `spend` is null when the gateway could not price the request; the request
    // was still settled against the balance at the amount reserved for it.
    // `?? null`, never `?? 0`.
    const spend = typeof row.spend === 'number' ? row.spend : null;
    entry.settledFound = true;
    entry.settledUsd = spend;
    entry.settledCostStatus = row.cost_status ?? null;
    // FALSE, deliberately and always. The row says what it settled at; it does
    // not say how that figure was derived, and this client cannot verify it.
    // A field that claimed otherwise would turn "we read a number" into "we
    // checked the number", which is the claim nobody here is entitled to make.
    entry.settledBasisKnown = false;

    console.log(
      `[settled] ${entry.requestId} ${money(spend)} ${row.cost_status ?? '(no cost status)'} ` +
        `stream=${entry.streamed} tokens=${tokenPair(row.prompt_tokens ?? null, row.completion_tokens ?? null)}`,
    );

    if (spend === null) {
      console.warn(
        '      ⚠ the spend row carries no amount (cost_status=' +
          `${row.cost_status ?? 'absent'}). Unknown, not free — it settled at the reserved amount.`,
      );
    }

    // THE STREAM'S DELTA. This is the comparison the whole join exists for: the
    // response could not price the call, we estimated it from the frames, and
    // this is the first time the two numbers can be put side by side.
    if (entry.streamed && spend !== null && typeof entry.recomputedUsd === 'number') {
      const delta = spend - entry.recomputedUsd;
      const pct = entry.recomputedUsd === 0 ? null : (delta / entry.recomputedUsd) * 100;
      console.log(
        `      ↳ delta: settled ${money(spend)} − recomputed ${money(entry.recomputedUsd)} = ` +
          `${delta >= 0 ? '+' : '−'}$${Math.abs(delta).toFixed(6)}` +
          `${pct === null ? '' : ` (${delta >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%)`}. ` +
          'The settled figure is the invoice; the recompute was only ever a check on it.',
      );
    }

    // A buffered call reported a price in its own headers AND has a spend row.
    // They must agree, and a disagreement is worth saying out loud rather than
    // silently preferring one.
    if (!entry.streamed && typeof entry.cost === 'number' && spend !== null && Math.abs(spend - entry.cost) > 1e-9) {
      console.warn(
        `      ⚠ the response header said ${money(entry.cost)} and the spend row says ${money(spend)}. ` +
          'The spend row is authoritative; report the discrepancy.',
      );
    }
  }

  // The log is APPEND-ONLY during the session and rewritten ONCE here, because
  // the settled figure does not exist when a call record is written. A crash
  // before this point therefore still leaves every per-call record on disk.
  await writeFile(LOG_PATH, calls.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
}

function printSummary() {
  // FIVE buckets, and the separations are the point. A FAILED call is not a
  // call "served without a price". A STREAMED call is not an unpriceable model.
  // A FREE call is not a missing measurement. Collapsing any pair of them tells
  // the operator something false about where to look.
  // A LOCAL REFUSAL IS ITS OWN CLASS, and the cheapest one. The SDK refused
  // before anything left this process, so nothing was sent and nothing can have
  // been billed — telling an operator it "may have been" sends them to check an
  // invoice line that cannot exist. Keyed on `sentToGateway === false`, never on
  // a missing request id.
  const refusedLocally = calls.filter((entry) => !entry.ok && entry.sentToGateway === false);
  const failed = calls.filter((entry) => !entry.ok && entry.sentToGateway !== false);
  const served = calls.filter((entry) => entry.ok);
  const streamed = served.filter((entry) => entry.streamed);
  const free = served.filter((entry) => !entry.streamed && entry.free);
  const priced = served.filter((entry) => !entry.streamed && !entry.free && entry.priced);
  const unpriced = served.filter((entry) => !entry.streamed && !entry.free && !entry.priced);
  const pricedTotalUsd = priced.reduce((sum, entry) => sum + entry.cost, 0);
  const cacheHits = served.filter((entry) => entry.responseCache === 'hit');
  const cacheMisses = served.filter((entry) => entry.responseCache === 'miss');

  console.log('\nSESSION SUMMARY');
  console.log(`  calls            ${calls.length}`);
  console.log(`  pricedCalls      ${priced.length}`);
  console.log(`  streamedCalls    ${streamed.length}`);
  console.log(`  freeCalls        ${free.length}`);
  console.log(`  unpricedCalls    ${unpriced.length}`);
  console.log(`  failedCalls      ${failed.length}`);
  console.log(`  localRefusals    ${refusedLocally.length}`);
  console.log(`  cacheHits        ${cacheHits.length}`);
  console.log(`  cacheMisses      ${cacheMisses.length}`);
  console.log(`  pricedTotalUsd   ${pricedTotalUsd.toFixed(8)}`);

  // THE SETTLED TOTAL — read back from the spend rows, and the only figure here
  // that includes the streamed calls. Printed only when EVERY billed call
  // resolved to an amount: a partial sum labelled as a total is the same defect
  // as summing an unpriced call at zero, one level up.
  const billed = calls.filter(hasSpendRow);
  const settled = billed.filter((entry) => typeof entry.settledUsd === 'number');
  if (!DASHBOARD_URL) {
    console.log(
      '  settledTotalUsd  —   <- set NROUTER_DASHBOARD_URL to read the settled spend rows back; ' +
        'without it a streamed call\'s cost is not visible from this client at all',
    );
  } else if (settled.length === billed.length && billed.length > 0) {
    const settledTotal = settled.reduce((sum, entry) => sum + entry.settledUsd, 0);
    console.log(`  settledTotalUsd  ${settledTotal.toFixed(8)}   <- from the spend rows, INCLUDING the streamed calls`);
  } else {
    const pending = billed.filter((entry) => entry.settledFound === false).length;
    const unpricedRow = billed.filter((entry) => entry.settledFound === true && entry.settledUsd === null).length;
    console.log(
      `  settledTotalUsd  —   <- ${pending} row(s) not yet settled or not visible, ` +
        `${unpricedRow} settled without an amount. Neither is $0, so there is no total to print.`,
    );
  }

  // A SEPARATE LINE, never folded into the figure above. One is what the
  // gateway settled and reported; the other is arithmetic this process did from
  // rates a human typed. Adding them together would produce a total that is
  // partly measured and partly guessed, with nothing saying which part.
  const recomputed = served.filter((entry) => entry.recomputedUsd !== null && entry.recomputedUsd !== undefined);
  if (recomputed.length > 0) {
    const recomputedTotal = recomputed.reduce((sum, entry) => sum + entry.recomputedUsd, 0);
    console.log(`  streamRecomputedUsd ${recomputedTotal.toFixed(8)}   <- ESTIMATE, excluded from the total above`);
  } else if (RECOMPUTE_STREAM_COST) {
    console.log('  streamRecomputedUsd —   <- no usage frames carried token counts to multiply');
  } else {
    console.log(
      '  streamRecomputedUsd —   <- set NROUTER_STREAM_RATE_IN_PER_MTOK and ' +
        'NROUTER_STREAM_RATE_OUT_PER_MTOK to estimate what the streamed calls cost',
    );
  }

  if (unpriced.length > 0 || failed.length > 0) {
    const reasons = [];
    if (unpriced.length > 0) {
      reasons.push(`${unpriced.length} call(s) were SERVED without a price`);
    }
    if (failed.length > 0) {
      // "may": the gateway releases what it reserved on a routing or upstream
      // failure, but a call refused after the provider ran was still billed
      // upstream. The log rows say which calls, and the request ids say where
      // to check. `refusedLocally` is deliberately NOT in this sentence — those
      // never reached the gateway.
      reasons.push(`${failed.length} call(s) FAILED and may still have been billed`);
    }
    console.log(
      `  TOTAL INCOMPLETE — ${reasons.join('; ')}. ` +
        'The figure above is the priced subset, NOT the session total.',
    );
  } else {
    console.log(
      '  TOTAL COMPLETE — every BILLED call in this session was priced exactly. ' +
        `${streamed.length} streamed call(s) settle server-side and ${free.length} free call(s) ` +
        'cost nothing; neither is missing from the total.',
    );
  }

  if (refusedLocally.length > 0) {
    console.log(
      `\n  ${refusedLocally.length} call(s) were REFUSED LOCALLY — the SDK rejected them before ` +
        'anything was sent, so they cost nothing, carry no request id and have no spend row. They ' +
        'are NOT part of the incomplete total above and must not be reported as possibly billed.',
    );
  }

  if (cacheHits.length === 0) {
    console.log(
      '\n  No cache hit was observed. That is not a failure: response caching needs BOTH an\n' +
        "  operator gate on the deployment AND your organization's own toggle. With the operator\n" +
        '  gate off the header is absent entirely and `meta.responseCache` is null — which means\n' +
        '  "this gateway is not caching", NOT "the cache looked and missed".',
    );
  } else {
    console.log(
      `\n  ${cacheHits.length} cache hit(s). A HIT IS STILL BILLED AND METERED — it skips the\n` +
        '  provider call and nothing else, so it still authenticates, rate-limits, runs guardrails,\n' +
        '  counts usage and writes a spend row. It cuts OUR provider cost, never your invoice.',
    );
  }

  console.log(`\n  log: ${LOG_PATH}`);
  console.log(
    '\n  Join it up: every requestId above is `x-nr-request-id`, the same value as the spend\n' +
      "  row's request id. The STREAMED call is the one that needs it — its response carries no\n" +
      '  price and never will, so the dashboard Logs page is where its settled cost lives.',
  );
}

// --------------------------------------------------------------------------
// The loop
// --------------------------------------------------------------------------

// `maxRetries: 0` is stated rather than inherited. The SDK's default is already
// 0, but a DEFAULT is a promise someone else keeps: on a wire where every
// attempt is a separate bill, the no-retry property should be visible in the
// code that spends the money, not one release note away from changing.
const client = new nRouter({ apiKey: API_KEY, baseURL: BASE_URL, maxRetries: 0 });

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The usage object a single streamed frame carried, whichever wire produced it.
 *
 * THREE shapes, because the gateway relays the provider's own frames rather
 * than rewriting them (`chunk.delta` is the portable field; `chunk.raw` is not):
 *
 *   OpenAI      a terminal chunk `{ choices: [], usage: {...} }` — note the
 *               EMPTY choices array, which is why nothing here indexes
 *               `choices[0]`. The gateway forces
 *               `stream_options.include_usage`, so this frame always arrives.
 *   Anthropic   SPLIT across two frames: `message_start` carries
 *               `message.usage.input_tokens`, `message_delta` carries
 *               `usage.output_tokens`.
 *   Responses   `response.completed` carries `response.usage`.
 */
function usageFromFrame(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.usage && typeof raw.usage === 'object') return raw.usage;
  const message = raw.message;
  if (message && typeof message === 'object' && message.usage && typeof message.usage === 'object') {
    return message.usage;
  }
  const response = raw.response;
  if (response && typeof response === 'object' && response.usage && typeof response.usage === 'object') {
    return response.usage;
  }
  return null;
}

/**
 * Drain a streamed reply and report what the frames carried.
 *
 * MAX-WINS, per counter, and neither of the obvious alternatives is safe.
 * SUMMING double-counts a provider that repeats a running total on every frame.
 * LAST-WINS loses the input count the moment a later frame reports only the
 * output one — which is exactly what Anthropic's `message_delta` does.
 *
 * The counts are labelled `stream-usage-frame` on the record: a usage number
 * whose provenance is unrecorded is a number nobody can check, and on a stream
 * these did NOT come from the headers.
 */
async function drainStream(result) {
  let text = '';
  let inputTokens = null;
  let outputTokens = null;
  let totalTokens = null;
  let sawUsage = false;

  const maxWins = (current, next) =>
    next === null ? current : current === null ? next : Math.max(current, next);

  for await (const chunk of result.chunks) {
    text += chunk.delta;
    const usage = usageFromFrame(chunk.raw);
    if (!usage) continue;
    sawUsage = true;
    inputTokens = maxWins(inputTokens, numberOrNull(usage.prompt_tokens ?? usage.input_tokens));
    outputTokens = maxWins(outputTokens, numberOrNull(usage.completion_tokens ?? usage.output_tokens));
    totalTokens = maxWins(totalTokens, numberOrNull(usage.total_tokens));
  }

  if (!sawUsage) return { text, usageFrom: null };
  if (totalTokens === null && inputTokens !== null && outputTokens !== null) {
    totalTokens = inputTokens + outputTokens;
  }
  return {
    text,
    inputTokens,
    outputTokens,
    totalTokens,
    usageFrom: 'stream-usage-frame',
    recomputedUsd: recomputeStreamCost(inputTokens, outputTokens),
  };
}

/**
 * What the streamed call PROBABLY cost, from the relayed token counts and the
 * rates the operator supplied.
 *
 * This is the only number in this file that this process computes rather than
 * reads, and it is kept in its own field, its own summary line and its own
 * sentence for that reason. `null` whenever the rates are absent or the frames
 * carried no counts — never a `0`, which would read as a free stream.
 */
function recomputeStreamCost(inputTokens, outputTokens) {
  if (!RECOMPUTE_STREAM_COST) return null;
  if (inputTokens === null || outputTokens === null) return null;
  return (inputTokens / 1_000_000) * RATE_IN_PER_MTOK + (outputTokens / 1_000_000) * RATE_OUT_PER_MTOK;
}

async function main() {
  await mkdir(path.dirname(LOG_PATH), { recursive: true });
  // Truncate: a session's log is that session's, and appending across runs would
  // make the totals above the sum of two different conversations.
  await writeFile(LOG_PATH, '');

  console.log(`gateway    ${BASE_URL}`);
  // nrouter-doc-wire: messages
  console.log(`messages   ${MESSAGES_MODEL}   -> /v1/messages`);
  console.log(`chat       ${CHAT_MODEL}   -> /v1/chat/completions (buffered, streamed, repeated)`);
  console.log(`responses  ${RESPONSES_MODEL}   -> /v1/responses`);
  console.log(`turns      ${TURNS}\n`);

  const history = [];
  let userLine = OPENING_LINE;

  for (let turn = 1; turn <= TURNS; turn += 1) {
    history.push({ role: 'user', content: userLine });
    console.log(`      caller: ${userLine}`);

    // ---------------------------------------------------------------- (1)
    // The Anthropic wire. The id decides it; nothing here has to.
    // nrouter-doc-wire: messages
    const viaMessages = await metered(
      'messages',
      turn,
      'Anthropic-family id -> the Messages wire',
      '/v1/messages',
      () =>
        client.nr.chat({
          model: MESSAGES_MODEL,
          systemPrompt: SYSTEM_PROMPT,
          messages: history,
          maxTokens: MAX_TOKENS,
          // Only when asked for. `n > 1` here is refused locally, at no cost.
          ...(COMPLETIONS_N > 1 ? { extra: { n: COMPLETIONS_N } } : {}),
        }),
    );
    console.log(`      messages : ${client.nr.text(viaMessages).trim() || '(no text in the reply)'}`);

    // ---------------------------------------------------------------- (2)
    // The OpenAI-shaped wire. THIS EXACT OPTIONS OBJECT is reused at (5): the
    // response cache keys on the request, so a repeat that differs by one
    // character is a different request and can never hit. Building it once is
    // the only way to be sure the two are identical.
    const chatOptions = {
      model: CHAT_MODEL,
      systemPrompt: SYSTEM_PROMPT,
      messages: [...history],
      maxTokens: MAX_TOKENS,
    };

    const viaChat = await metered(
      'chat',
      turn,
      'OpenAI-family id -> the chat-completions wire',
      '/v1/chat/completions',
      () => client.nr.chat(chatOptions),
    );
    const reply = client.nr.text(viaChat).trim();
    console.log(`      chat     : ${reply || '(no text in the reply)'}`);

    // ---------------------------------------------------------------- (3)
    // The Responses wire. A third body shape, a third text reader, the same
    // `x-nr-*` accounting.
    const viaResponses = await metered(
      'responses',
      turn,
      'the Responses wire',
      '/v1/responses',
      () =>
        client.nr.responses({
          model: RESPONSES_MODEL,
          input: userLine,
          max_output_tokens: MAX_TOKENS,
        }),
    );
    console.log(`      responses: ${responsesText(viaResponses.body).trim() || '(no text in the reply)'}`);

    // ---------------------------------------------------------------- (4)
    // STREAMED. The one call in this loop whose response can never carry a
    // price. Its tokens arrive in a frame rather than a header.
    const streamed = await metered(
      'stream',
      turn,
      'the chat wire, STREAMED — unpriced headers by design',
      '/v1/chat/completions (stream)',
      () =>
        client.nr.stream({
          model: CHAT_MODEL,
          systemPrompt: SYSTEM_PROMPT,
          messages: [...history],
          maxTokens: MAX_TOKENS,
        }),
      { streamed: true, after: drainStream },
    );
    // `after` already drained the body, so re-reading `text()` here returns the
    // accumulated string rather than re-consuming a single-use stream.
    console.log(`      stream   : ${(await streamed.text()).trim() || '(no text streamed)'}`);

    // ---------------------------------------------------------------- (5)
    // The SAME buffered body again. Whether this hits is not ours to decide —
    // it is reported, never asserted.
    const repeated = await metered(
      'cache',
      turn,
      'the identical chat body again -> response-cache observation',
      '/v1/chat/completions',
      () => client.nr.chat(chatOptions),
    );
    console.log(
      `      cache    : ${cacheLabel(repeated.meta)} — a hit is still billed and metered; it skips ` +
        'the provider call and nothing else.',
    );

    // ---------------------------------------------------------------- (6)
    // FREE. No cost header, and here that absence means zero.
    // nrouter-doc-wire: messages
    await metered(
      'count',
      turn,
      'count_tokens — free, and free is not the same absence as unpriced',
      '/v1/messages/count_tokens',
      () => client.nr.countTokens({ model: MESSAGES_MODEL, messages: history }),
      { free: true },
    );

    history.push({ role: 'assistant', content: reply || '(no reply)' });
    userLine = FOLLOW_UPS[(turn - 1) % FOLLOW_UPS.length];
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof nRouterError) {
    // A typed refusal. The distinction that matters operationally is WHY:
    // `credit` needs a top-up, `authentication` needs a different key,
    // `rate_limit` names the limit that measured it, and none of them is fixed
    // by trying again immediately.
    console.error('\n✗ the gateway refused a call\n');
    console.error({
      kind: error.kind,
      status: error.status,
      message: error.message,
      requestId: error.meta?.requestId,
      authReason: error.authReason,
      // WHICH limit measured the 429. A null here means the gateway did not
      // say; do not guess, and do not send a customer to raise the wrong one.
      limitSource: error.limitSource,
    });
  } else {
    console.error(`\n✗ ${error?.message ?? error}`);
  }
  process.exitCode = 1;
} finally {
  // The join runs BEFORE the summary, so `settledTotalUsd` can use it — and
  // inside its own try/catch, because a lookup that fails must never cost the
  // operator the itemisation of what they already spent. It runs after a
  // REFUSAL too: the calls that succeeded before it were still billed, and
  // their rows are exactly the ones worth reading back.
  if (DASHBOARD_URL) {
    try {
      await joinSettledRows();
    } catch (error) {
      console.error(`\n✗ the settled join failed: ${error?.message ?? error}`);
      console.error('  The session totals below are unaffected; only the spend-row read-back is missing.');
    }
  }

  // ALWAYS. Money was spent before the failure too, and a run that dies without
  // reporting what it already billed is the worst possible outcome for the
  // person reading this output.
  printSummary();
}
