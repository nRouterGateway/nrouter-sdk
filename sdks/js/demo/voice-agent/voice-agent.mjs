#!/usr/bin/env node
/**
 * nRouter voice agent — three billed wires in one loop, each one accounted for.
 *
 *   speech-to-text  ->  chat  ->  text-to-speech
 *
 * A voice assistant is the smallest useful thing that touches three DIFFERENT
 * billing units in a single turn, which is why it is the example worth writing:
 *
 *   /v1/audio/transcriptions   billed per TOKEN or per SECOND, by model
 *   /v1/chat/completions       billed per token, in and out
 *   /v1/audio/speech           billed per CHARACTER of input
 *
 * Each one is timed twice, because a voice loop lives or dies on latency and
 * the two numbers answer different questions: `gw=` is `x-nr-latency-ms`,
 * measured from edge arrival until the response headers were ready, and
 * `client=` is what this process observed around the whole call. The gap
 * between them is the network to and from the edge.
 *
 * Nothing here computes a price. The gateway settles every call and reports the
 * result in the `x-nr-*` response headers, which the SDK parses into
 * `result.meta`. This example's whole job is to READ that honestly: print one
 * line per call, append one JSON record per call, and — the part that is easy
 * to get wrong — refuse to fold an UNPRICED call into the total as zero.
 *
 * `x-nr-request-cost` is ABSENT when the gateway could not price a model; it is
 * never sent as `0`. So `meta.cost` is `null` and `meta.costStatus` is
 * `unpriced`. The request was served, it consumed provider capacity, and it is
 * on your spend rows — it simply has no price attached here. Summing it as $0
 * is how a spend dashboard quietly under-reports (Rule #28), so this example
 * sums only calls `isPriced()` accepts and labels the result TOTAL INCOMPLETE
 * whenever anything was left out.
 *
 * RUN IT
 *
 *   (cd ../../../sdks/js && npm run build)     # this example imports dist/
 *   export NROUTER_API_KEY=sk-nrouter-...
 *   node voice-agent.mjs
 *
 * Every call below spends real credits. There is no retry loop anywhere in this
 * file, and the client below pins `maxRetries` to 0 explicitly: a retry is a
 * second call and a second bill, and an automatic one on a billed wire is how a
 * transient blip becomes a doubled invoice.
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
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
// The SDK picks the wire from the model id: a Claude-family id posts to
// /v1/messages, which is the ONLY wire the gateway serves Anthropic on — the
// same id sent to /v1/chat/completions answers 404 model_unavailable_on_route.
// `client.nr.chat()` below handles that; nothing here has to.
// nrouter-doc-wire: messages
const CHAT_MODEL = env.NROUTER_CHAT_MODEL || 'claude-haiku-4-5-20251001';
const SPEECH_MODEL = env.NROUTER_SPEECH_MODEL || 'tts-1';
const SPEECH_VOICE = env.NROUTER_SPEECH_VOICE || 'alloy';
const TRANSCRIBE_MODEL = env.NROUTER_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
// Audio container for the synthesised speech. Unset takes the provider default
// (mp3). The SDK validates it against its own list BEFORE sending, which is the
// fourth failure class this example accounts for — see `deliveryOf` below.
const SPEECH_FORMAT = env.NROUTER_SPEECH_FORMAT || undefined;
const MAX_TOKENS = positiveInt(env.NROUTER_MAX_TOKENS, 120, 'NROUTER_MAX_TOKENS');
const TURNS = positiveInt(env.NROUTER_TURNS, 2, 'NROUTER_TURNS');

// Both default INSIDE this example's own directory, which carries a .gitignore
// for them. Resolving against the script rather than the shell's cwd keeps a
// run from scattering audio and logs wherever it happened to be started.
const LOG_PATH = path.resolve(HERE, env.NROUTER_VOICE_LOG || './voice-agent.log.jsonl');
const OUT_DIR = path.resolve(HERE, env.NROUTER_VOICE_OUT || './out');

/**
 * `whisper-1` is billed per SECOND of audio, and the gateway can only learn the
 * duration from a `verbose_json` body — ask for plain `json` and the request
 * settles UNPRICED. The per-token transcribers do not need it. Getting this
 * wrong costs nothing at the till and everything in the spend report, so it is
 * decided here rather than left to the caller to remember.
 */
const TRANSCRIBE_FORMAT =
  env.NROUTER_TRANSCRIBE_FORMAT || (/whisper/i.test(TRANSCRIBE_MODEL) ? 'verbose_json' : undefined);

const SYSTEM_PROMPT =
  env.NROUTER_SYSTEM_PROMPT ||
  'You are a concise voice assistant. Answer in at most two short sentences, in plain spoken ' +
    'English, with no lists, markdown or emoji — every character you emit is billed and then read ' +
    'aloud.';

/** The caller's opening line, spoken by TTS when no real recording is supplied. */
const OPENING_LINE =
  env.NROUTER_OPENING_LINE ||
  "Hi, I'd like to check on my order. Can you tell me whether it has shipped yet?";

/** Deterministic follow-ups, so a demo without a microphone is still a conversation. */
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

/**
 * The upload filename must carry the REAL extension: upstream transcribers pick
 * their decoder from it and reject an extensionless name outright. So the
 * extension comes from what the gateway actually returned, never from what we
 * hoped for.
 */
function extensionFor(contentType) {
  const type = (contentType || '').toLowerCase();
  if (type.includes('wav')) return 'wav';
  if (type.includes('flac')) return 'flac';
  if (type.includes('opus')) return 'opus';
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('aac')) return 'aac';
  if (type.includes('pcm')) return 'pcm';
  // Nothing recognisable in the content type: fall back to what was ASKED for
  // rather than to a guess, and to mp3 only when nothing was asked.
  return SPEECH_FORMAT || 'mp3';
}

// --------------------------------------------------------------------------
// Per-call accounting
// --------------------------------------------------------------------------

const calls = [];

/**
 * Did this failure reach the gateway?
 *
 * ONE field with THREE values, because "we do not know" is a real and common
 * answer and collapsing it into either neighbour is a lie in one direction or
 * the other.
 *
 *   true   the gateway answered — there is a status, a request id, or response
 *          metadata. It was sent.
 *   false  the SDK refused BEFORE any I/O: an audio format not on its list, an
 *          empty `input`, a filename with no extension. There was no request,
 *          so there is no request id and no spend row to go looking for.
 *   null   it left this process and nothing usable came back — a connection
 *          failure, a timeout. Unknowable from here.
 *
 * `false` is keyed on `kind === 'configuration'` and NEVER on a missing request
 * id. An absent request id proves nothing: a connection that died mid-flight
 * has none either, and that request may well have been served and billed.
 * Keying on the absence would silently reclassify every network blip as "we owe
 * nothing", which is the expensive direction to be wrong in.
 *
 * The `reachedGateway` check comes FIRST for a reason: `configuration` is also
 * thrown for a 2xx whose body is not JSON, which is a served, BILLED response.
 * That one carries a status and metadata, so it is caught here and never
 * reaches the `configuration` arm below.
 */
function deliveryOf(error) {
  if (!(error instanceof nRouterError)) return null;

  // STATUS FIRST, kind second, and the order is the whole correctness argument.
  //
  // An HTTP status exists only if a response came back, so it is the one piece
  // of evidence that cannot be produced without the gateway. `requestId` and
  // `meta` are the same evidence by another route — headers we parsed off a
  // real response. Any of the three means it was sent.
  //
  // The kind cannot lead, because `configuration` is raised on BOTH sides of
  // the wire: by the pre-send validators, and by `requireJson()` /
  // `requireBinary()` for a 2xx whose body has the wrong shape — which is a
  // SERVED, BILLED response. Check the kind first and that billed call is
  // written off as never sent, with its request id sitting in the log.
  //
  // `!= null` is LOOSE on purpose — the one place in this file where it is.
  // `undefined !== null` is true, so a strict check would read an UNSET
  // property as gateway evidence: if a future SDK left `status` undefined
  // rather than explicitly null on a local validation error, every local
  // refusal would silently reclassify as gateway-answered and be reported as
  // billed, and no build would have broken.
  if (error.status != null || error.requestId != null || error.meta != null) return true;

  // No response evidence at all. Only now does the kind decide, and only
  // `configuration` — the kind the pre-send validators raise — is provably
  // never-sent. A transport failure falls through to `null`.
  if (error.kind === 'configuration') return false;
  return null;
}

/**
 * Assume it cost money unless we can PROVE it did not.
 *
 * Only a refusal raised before the request left this process is provably free.
 * Everything else — a gateway-side refusal, a timeout we never got an answer to
 * — is counted as billed, because under-counting spend is the failure that
 * shows up later as a surprise invoice, and over-counting is the one that shows
 * up as a question.
 */
function billedFor(sentToGateway) {
  return sentToGateway !== false;
}

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
 * Run one billed call and account for it whether it succeeds or fails.
 *
 * A failed call can still have cost money and it always has a request id, so
 * the failure path writes a record too. A log that only records successes is a
 * spend report that only sees the cheap half of a bad day.
 */
async function metered(step, turn, label, call) {
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

    await record({
      ts: new Date().toISOString(),
      step,
      turn,
      label,
      requestId: meta.requestId,
      model: meta.model,
      costStatus: meta.costStatus,
      // `meta.cost` is already `null` when absent. Never `?? 0`.
      cost: meta.cost,
      inputTokens: meta.inputTokens,
      outputTokens: meta.outputTokens,
      totalTokens: meta.totalTokens,
      // TWO clocks, and the pair is the point. `gatewayMs` is `x-nr-latency-ms`:
      // milliseconds from EDGE ARRIVAL until the response headers were ready,
      // which on these buffered calls includes the provider round trip.
      // `latencyMs` is what this process timed around the whole call, so it
      // adds the network to and from the edge and whatever this machine was
      // doing. Either alone is unactionable: a slow model and a slow link look
      // identical. Absent is `null`, never 0 — a zero would claim a
      // measurement was taken and came back instant.
      //
      // ⚠ It is TIME TO HEADERS, so on a streamed response it is not a
      // total-generation figure. Nothing here streams, which is the only
      // reason the two are comparable at all.
      // `?? null` on BOTH paths, not just the error one. `ResponseMeta` types
      // this `number | null`, so today it cannot be undefined — but an
      // undefined here is DROPPED by JSON.stringify, and a record missing the
      // key reads as "this log predates gateway latency" rather than "the
      // gateway did not report it". Same normalization as line ~245.
      gatewayMs: meta.latencyMs ?? null,
      latencyMs,
      ok: true,
      // It answered, so it was sent, and a served call is billed even when it
      // could not be priced — `unpriced` means "no price attached", never
      // "free".
      sentToGateway: true,
      billed: billedFor(true),
      priced,
    });

    console.log(
      `[${step}] turn=${turn} ${meta.requestId ?? '(no request id)'} ${meta.model ?? '(model not reported)'} ` +
        `${meta.costStatus ?? '(no cost status)'} ${money(meta.cost)} tokens=${tokens(meta)} ` +
        // `??` rather than `=== null`: a strict check prints `gw=undefinedms`
        // on the value it was meant to guard against. A genuine 0 still
        // renders as `0ms`, which is a measurement and must not become `—`.
        `gw=${meta.latencyMs ?? '—'}ms client=${latencyMs}ms  ${label}`,
    );

    if (!priced) {
      console.warn(
        `      ⚠ costStatus=${meta.costStatus ?? 'absent'}: this request WAS served and consumed ` +
          'provider capacity, but nRouter could not price it. It is excluded from the total ' +
          'below — do NOT record it as $0.',
      );
    }

    return result;
  } catch (error) {
    const meta = error instanceof nRouterError ? error.meta : undefined;
    const sentToGateway = deliveryOf(error);
    await record({
      ts: new Date().toISOString(),
      step,
      turn,
      label,
      requestId: meta?.requestId ?? null,
      model: meta?.model ?? null,
      costStatus: meta?.costStatus ?? null,
      cost: meta?.cost ?? null,
      inputTokens: meta?.inputTokens ?? null,
      outputTokens: meta?.outputTokens ?? null,
      totalTokens: meta?.totalTokens ?? null,
      gatewayMs: meta?.latencyMs ?? null,
      latencyMs: Date.now() - started,
      ok: false,
      sentToGateway,
      billed: billedFor(sentToGateway),
      // A refused call is not a priced one, and it is not an unpriced SERVED
      // one either — the summary counts it separately.
      priced: false,
      error: error instanceof nRouterError ? `${error.kind}: ${error.message}` : String(error?.message ?? error),
    });
    throw error;
  }
}

function printSummary() {
  // FOUR buckets, and the fourth is the one that is easy to get wrong.
  //
  //   priced         served and priced exactly — the only thing summed
  //   unpriced       SERVED, but the gateway attached no price
  //   localRefusals  refused by the SDK before the request was sent: nothing
  //                  reached the gateway, so nothing can have been billed
  //   unknownBilling failed at or after the gateway, or got no answer at all —
  //                  counted as billed, because we cannot prove otherwise
  //
  // Merging the last two is the defect. A call the SDK refused for an invalid
  // audio format has no request id, because there was no request; reporting it
  // as possibly billed sends the operator hunting a spend row that does not
  // exist. It costs money in the other direction too: a genuinely unknown
  // billing state hidden among local refusals stops being investigated.
  const failed = calls.filter((entry) => !entry.ok);
  const priced = calls.filter((entry) => entry.ok && entry.priced);
  const unpriced = calls.filter((entry) => entry.ok && !entry.priced);
  const localRefusals = failed.filter((entry) => entry.sentToGateway === false);
  const unknownBilling = failed.filter((entry) => entry.sentToGateway !== false);
  const pricedTotalUsd = priced.reduce((sum, entry) => sum + entry.cost, 0);

  console.log('\nSESSION SUMMARY');
  console.log(`  calls            ${calls.length}`);
  console.log(`  pricedCalls      ${priced.length}`);
  console.log(`  unpricedCalls    ${unpriced.length}`);
  console.log(`  failedCalls      ${failed.length}`);
  console.log(`  localRefusals    ${localRefusals.length}`);
  console.log(`  pricedTotalUsd   ${pricedTotalUsd.toFixed(8)}`);

  // Only what was SENT can make the money total incomplete. A local refusal is
  // a failed session, not an unaccounted-for dollar.
  if (unpriced.length > 0 || unknownBilling.length > 0) {
    const reasons = [];
    if (unpriced.length > 0) {
      reasons.push(`${unpriced.length} call(s) were SERVED without a price`);
    }
    if (unknownBilling.length > 0) {
      // "may", and "after leaving this process" rather than "at the gateway":
      // this bucket holds both a refusal the gateway ANSWERED and a call that
      // got no answer at all, and only the first is known to have arrived. The
      // gateway releases what it reserved on a routing or upstream failure, but
      // a call refused after the provider ran was still billed upstream. The
      // log rows say which calls, and the request ids — where there are any —
      // say where to check.
      reasons.push(
        `${unknownBilling.length} call(s) FAILED after leaving this process and may still have been billed`,
      );
    }
    console.log(
      `  TOTAL INCOMPLETE — ${reasons.join('; ')}. ` +
        'The figure above is the priced subset, NOT the session total.',
    );
  } else if (priced.length === 0) {
    console.log('  TOTAL COMPLETE — nothing reached a provider, so nothing was billed.');
  } else {
    console.log('  TOTAL COMPLETE — every call that was sent was priced exactly.');
  }

  if (localRefusals.length > 0) {
    console.log(
      `  ${localRefusals.length} call(s) refused locally, never sent, nothing billed — ` +
        'the SDK rejected them before any request was made, so they carry no request id ' +
        'and there is no spend row to look for. Fix the arguments, not the account.',
    );
  }

  console.log(`\n  log: ${LOG_PATH}`);
  console.log(`  audio: ${OUT_DIR}`);
  console.log(
    '\n  Join it up: every requestId above is `x-nr-request-id`, which is the same value as\n' +
      '  the spend row\'s request id. Look each one up on the dashboard Logs page to see the\n' +
      '  settled cost, the org/team/key it was billed to, and the units it was measured in\n' +
      '  (characters for speech, tokens or seconds for transcription) — the gateway sends no\n' +
      '  quantity header, so the unit count lives only on the server side.',
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

/**
 * The caller's audio for turn 1.
 *
 * With `NROUTER_AUDIO_IN` set this is a real recording. Without it, the line is
 * synthesised with TTS first — which is not a shortcut but the point: the
 * bootstrap round trip proves the speech wire before the transcription wire
 * consumes its output, so a broken one is diagnosed by which call failed rather
 * than by a mysteriously empty transcript.
 */
async function openingAudio() {
  if (env.NROUTER_AUDIO_IN) {
    const file = path.resolve(process.cwd(), env.NROUTER_AUDIO_IN);
    const bytes = new Uint8Array(await readFile(file));
    console.log(`caller audio: ${file} (${bytes.length} bytes)`);
    return { bytes, fileName: path.basename(file) };
  }

  const spoken = await metered('tts', 0, 'bootstrap: synthesise the caller\'s opening line', () =>
    client.nr.media.speech({
      model: SPEECH_MODEL,
      input: OPENING_LINE,
      voice: SPEECH_VOICE,
      ...(SPEECH_FORMAT ? { response_format: SPEECH_FORMAT } : {}),
    }),
  );
  return { bytes: spoken.bytes, fileName: `user-turn-1.${extensionFor(spoken.contentType)}` };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(path.dirname(LOG_PATH), { recursive: true });
  // Truncate: a session's log is that session's, and appending across runs
  // would make the totals above the sum of two different conversations.
  await writeFile(LOG_PATH, '');

  console.log(`gateway   ${BASE_URL}`);
  console.log(`chat      ${CHAT_MODEL}`);
  console.log(`speech    ${SPEECH_MODEL} (voice ${SPEECH_VOICE})`);
  console.log(
    `transcribe ${TRANSCRIBE_MODEL}${TRANSCRIBE_FORMAT ? ` (response_format=${TRANSCRIBE_FORMAT})` : ''}`,
  );
  console.log(`turns     ${TURNS}\n`);

  let userAudio = await openingAudio();
  const history = [];

  for (let turn = 1; turn <= TURNS; turn += 1) {
    const heardResult = await metered('stt', turn, 'caller audio → text', () =>
      client.nr.media.transcribe({
        file: userAudio.bytes,
        fileName: userAudio.fileName,
        model: TRANSCRIBE_MODEL,
        ...(TRANSCRIBE_FORMAT ? { response_format: TRANSCRIBE_FORMAT } : {}),
      }),
    );

    const heard = (heardResult.text ?? '').trim();
    if (heard === '') {
      // Stop rather than send an empty user turn: the chat call would be a
      // billed request carrying no question.
      throw new Error(
        `transcription returned no text for turn ${turn} (requestId ${heardResult.meta.requestId}); ` +
          'stopping rather than billing a chat call with an empty prompt',
      );
    }
    console.log(`      caller: ${heard}`);

    history.push({ role: 'user', content: heard });

    const answer = await metered('chat', turn, 'assistant reply', () =>
      client.nr.chat({
        model: CHAT_MODEL,
        systemPrompt: SYSTEM_PROMPT,
        messages: history,
        maxTokens: MAX_TOKENS,
      }),
    );

    const reply = client.nr.text(answer).trim();
    console.log(`      agent : ${reply || '(no text in the reply)'}`);
    history.push({ role: 'assistant', content: reply });

    const spoken = await metered('tts', turn, 'assistant reply → audio', () =>
      client.nr.media.speech({
        model: SPEECH_MODEL,
        // Speech is billed per CHARACTER, so an empty input is not merely
        // useless, it is a refused request. Say something short instead.
        input: reply || 'Sorry, I did not catch that.',
        voice: SPEECH_VOICE,
        ...(SPEECH_FORMAT ? { response_format: SPEECH_FORMAT } : {}),
      }),
    );

    const audioPath = path.join(OUT_DIR, `turn-${turn}.${extensionFor(spoken.contentType)}`);
    await writeFile(audioPath, spoken.bytes);
    console.log(`      wrote ${audioPath} (${spoken.bytes.length} bytes)`);

    if (turn < TURNS) {
      const line = FOLLOW_UPS[(turn - 1) % FOLLOW_UPS.length];
      const nextAudio = await metered('tts', turn + 1, 'synthesise the caller\'s next turn', () =>
        client.nr.media.speech({
          model: SPEECH_MODEL,
          input: line,
          voice: SPEECH_VOICE,
          ...(SPEECH_FORMAT ? { response_format: SPEECH_FORMAT } : {}),
        }),
      );
      userAudio = {
        bytes: nextAudio.bytes,
        fileName: `user-turn-${turn + 1}.${extensionFor(nextAudio.contentType)}`,
      };
    }
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof nRouterError) {
    // A typed refusal. The distinction that matters operationally is WHY:
    // `credit` needs a top-up, `authentication` needs a different key,
    // `rate_limit` names the limit that measured it, and none of them is
    // fixed by trying again immediately.
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
