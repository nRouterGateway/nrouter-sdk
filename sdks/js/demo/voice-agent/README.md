# Voice agent — three billed wires, fully accounted for

A working voice assistant in one file: **speech-to-text → chat → text-to-speech**,
looped, with every call priced, logged and joinable to a spend row.

It is the smallest useful program that touches three *different* billing units in
a single turn, which is the whole reason it exists. Getting a chat call right
teaches you one unit. Getting this right teaches you the three you will actually
be invoiced for.

<!-- The transcript below is a Claude id, which this SDK sends to /v1/messages. nrouter-doc-wire: messages -->

```
node voice-agent.mjs

[tts] turn=0 req_01J...  tts-1                exact $0.000232 tokens=—/—   gw=305ms client=412ms  bootstrap: synthesise the caller's opening line
[stt] turn=1 req_01J...  gpt-4o-mini-transcribe exact $0.000090 tokens=24/11 gw=128ms client=380ms  caller audio → text
      caller: Hi, I'd like to check on my order. Can you tell me whether it has shipped yet?
[chat] turn=1 req_01J... claude-haiku-4-5     exact $0.000411 tokens=98/41 gw=612ms client=690ms  assistant reply
      agent : Your order shipped yesterday and is with the carrier now. It should arrive within two business days.
[tts] turn=1 req_01J...  tts-1                exact $0.000174 tokens=—/—   gw=289ms client=351ms  assistant reply → audio
      wrote out/turn-1.mp3 (28160 bytes)
...

SESSION SUMMARY
  calls            8
  pricedCalls      8
  unpricedCalls    0
  failedCalls      0
  localRefusals    0
  pricedTotalUsd   0.00811300
  TOTAL COMPLETE — every call in this session was priced exactly.
```

## What it proves

| Property | Where to look |
|---|---|
| **Cost, per call** | `result.meta.cost` + `result.meta.costStatus`, printed on every line and written to the log |
| **Price honesty** | an unpriced call logs `cost: null`, is **excluded** from the total, and the summary says `TOTAL INCOMPLETE` |
| **Failing closed** | a cost status the SDK does not recognise is excluded even when it carries an amount — `isPriced()` accepts `exact` and nothing else |
| **Usage** | `meta.inputTokens` / `outputTokens` / `totalTokens`, where the wire reports them |
| **Latency, two clocks** | `gw=` is `meta.latencyMs`, the gateway's `x-nr-latency-ms`: edge arrival to response-headers-ready, which on these buffered calls includes the provider round trip. `client=` is what this process timed around the whole call, so it adds the network to and from the edge. Neither alone tells a slow model from a slow link. Absent is `—`, never `0ms`. It is time-to-HEADERS, so on a streamed response it would not be a total-generation figure — nothing here streams. |
| **Spend join** | `meta.requestId` on every record — the key that finds this exact call on the dashboard |
| **Logging** | one JSONL record per call, written on the failure path as well as the success path |
| **Refusals** | typed errors: `kind`, `status`, `requestId`, `authReason`, `limitSource` |
| **Blame, correctly assigned** | every record carries `sentToGateway` and `billed`. A refusal the SDK raised *before sending* is `false`/`false` — no request id, no spend row, nothing billed — and is reported separately from one that came back **from** the gateway, where billing is genuinely unknown |

## Billing, wire by wire

nRouter settles each call and reports the result in the `x-nr-*` response
headers. The **unit** differs per wire, and the unit is what makes a cheap-looking
integration expensive.

| Wire | Billed per | What that means in practice |
|---|---|---|
| `/v1/audio/speech` | **character of input** | Cost tracks the assistant's reply LENGTH, not its token count. Capping `maxTokens` is a cost control on two wires at once — the chat output *is* the speech input. |
| `/v1/messages` *or* `/v1/chat/completions` | **token**, in and out | `client.nr.chat()` picks the wire from the model id: a Claude-family id goes to `/v1/messages`, which is the **only** wire the gateway serves Anthropic on, and everything else goes to `/v1/chat/completions`. The same Claude id posted to the wrong one answers 404 `model_unavailable_on_route`. Billing is per token either way, and the conversation history is re-sent every turn, so input tokens grow with the conversation. |
| `/v1/audio/transcriptions` — `gpt-4o-mini-transcribe` | **token** | Priced `exact`. |
| `/v1/audio/transcriptions` — `whisper-1` | **second of audio** | ⚠ The duration is only visible to the gateway in a `verbose_json` body. Ask for plain `json` and the call settles **unpriced**. This example sends `response_format=verbose_json` automatically for any whisper model. |

One thing the headers deliberately do **not** carry:

- **No quantity header.** There is no `x-nr-characters` or `x-nr-audio-seconds`.
  The unit count that produced the price lives server-side on the spend row, so
  a client cannot recompute the bill — it can only report what was settled.

And one that they do, with a reading that surprises people:

- **Guardrail posture is published on all three audio wires.**
  `meta.guardrails` carries the usual `none | monitor | pass | partial | blocked`
  token. Expect `partial` on transcription and translation and do not alarm on
  it: those wires carry an upload that is not itself a text channel, so an
  enforcing chain answers `partial` on the ordinary path. The token is a posture
  over your REQUEST — no check scans bytes, so it never claims the spoken output
  is clean. `null` still means the gateway made no claim at all, not "no
  guardrail applied".

### `unpriced` is a real state, not an error

`x-nr-request-cost` is **absent** when the gateway could not price a model. It is
never sent as `0`. So `meta.cost` is `null` and `meta.costStatus` is `unpriced`.
The request was served, it consumed provider capacity, and it is on your spend
rows — it just has no price attached in the response.

```js
if (isPriced(meta)) total += meta.cost;   // costStatus === 'exact' AND cost !== null
else                unpricedCalls += 1;   // never `total += meta.cost ?? 0`
```

Folding it in as zero is how a spend dashboard quietly under-reports. This
example sums only the priced subset and labels the result `TOTAL INCOMPLETE`
whenever anything was left out, so a partial sum can never be read as the total.

## Run it

```bash
# 1. Build the SDK — this example imports the package built from this repo.
(cd ../../../sdks/js && npm run build)

# 2. Supply a virtual key. nRouter holds the provider keys; there is no
#    OpenAI or Anthropic key to configure.
cp .env.example .env      # then edit it
node --env-file=.env voice-agent.mjs

# ...or just:
NROUTER_API_KEY=sk-nrouter-... node voice-agent.mjs
```

**Every call spends real credits.** Two turns is eight billed calls. There is no
retry loop in this file and the client pins `maxRetries: 0` explicitly — the
SDK's default is `0` too, but a default is a promise someone else keeps, and on
a wire where every attempt is a separate bill the no-retry property belongs in
the code that spends the money.

No microphone is needed. With `NROUTER_AUDIO_IN` unset the example synthesises
the caller's opening line with TTS first, then transcribes it — a round trip that
exercises both audio wires before the conversation starts, so a broken one is
diagnosed by *which call failed* rather than by a mysteriously empty transcript.
Point `NROUTER_AUDIO_IN` at a real `.wav` or `.mp3` to start from an actual
recording.

Every variable is documented in [`.env.example`](./.env.example). Output goes to
`out/turn-N.mp3` and `voice-agent.log.jsonl`, both inside this directory and both
gitignored — the log carries request ids and transcribed speech.

## Joining a call to its spend row

Each record carries `requestId`, which is the `x-nr-request-id` response header
and the same id the spend row is keyed by.

```bash
jq -r '[.step, .requestId, .costStatus, (.cost // "unpriced")] | @tsv' voice-agent.log.jsonl
```

Take any of those ids to the **Logs** page in the nRouter dashboard and search for
it. The row shows the settled cost, the organization / team / key it was billed
to, and the units it was measured in. That is the reconciliation path: the client
reports what it was told, the dashboard reports what was charged, and the request
id is the only thing that has to match.

A record is written for failed calls too, with `ok: false` and the error kind. A
log that only records successes is a spend report that only sees the cheap half of
a bad day.

**Not every failure is a billing question.** Each record also carries
`sentToGateway` and `billed`, because there are three answers and not two:

| `sentToGateway` | `billed` | what happened |
|---|---|---|
| `true` | `true` | the gateway answered — served, or a refusal like a 402. Either way it carries a request id and may be on your spend rows |
| `false` | `false` | the SDK refused **before sending**: an invalid audio format, an empty `input`, a filename with no extension. There was no request, so there is no request id and no spend row to go looking for |
| `null` | `true` | it left this process and nothing usable came back — a connection failure or a timeout. Counted as billed, because we cannot prove it was not |

`billed` is derived, not decided twice: it is `sentToGateway !== false`. Only a
call that never left this process is *provably* free, and everything else is
assumed to have cost money — under-counting spend surfaces later as a surprise
invoice, over-counting surfaces immediately as a question.

The classifier checks **response evidence first, kind second**, and both halves
of that order are load-bearing:

- An HTTP status exists only if a response came back, so a status (or a request
  id, or parsed response metadata) means it was sent — whatever the kind says.
- `false` is then keyed on the error **kind** (`configuration`, what the
  pre-send validators raise) and **never** on a missing request id. A connection
  that died mid-flight has no request id either, and that request may well have
  been served and billed; keying on the absence would silently write off every
  network blip.
- The kind cannot lead, because `configuration` is raised on *both* sides of the
  wire — the SDK's `requireJson()` / `requireBinary()` raise it for a `2xx`
  whose body has the wrong shape, and that response was served and **billed**.

Runs 5, 6 and 7 below pin all three, and the ordering is mutation-checked: swap
the two checks and run 7 goes red.

## Verify it without spending anything

```bash
node ../voice_agent_suite.js
```

A local mock gateway speaks the four wires — including `/v1/messages`, which is
where the default Claude model actually goes — and stamps the same `x-nr-*`
headers. Seven runs, no key, no network, about a second:

1. **Everything priced.** Every call reaches the log with a request id, and
   `pricedTotalUsd` equals the mock's own arithmetic. Each wire is given a
   distinct `x-nr-latency-ms`, so a record that copied another call's timing
   fails rather than passing on a plausible-looking number.
2. **One `unpriced` speech call**, on a run where the gateway also reports no
   latency for speech. The cost is excluded from the total and logs
   `cost: null` rather than `0`, the session reports `TOTAL INCOMPLETE`, and the
   missing latency logs `null` and renders `—` rather than `0ms`. An absent
   measurement and a measurement of zero are different facts.
3. **An unrecognised cost status carrying an amount.** Excluded too — the
   number alone is not authority to bill against — and the assertion proves the
   exclusion by showing the total is *not* higher by that amount.
4. **A refused call mid-session** — a 402 *from the gateway*. The process exits
   non-zero, the failure is logged with its request id, and the summary still
   reports the money already spent before the refusal, in its own `failedCalls`
   bucket. A refused call was not "served without a price", and the summary says
   so.
5. **A refusal raised locally, before anything is sent.** An invalid
   `response_format` fails the SDK's own validation, so there is no request, no
   request id and nothing billed. The mock asserts it received **zero** speech
   requests and exactly the two it was meant to — the proof is the gateway's
   silence, not the example's own flag — and the summary says `refused locally,
   never sent, nothing billed` rather than "may still have been billed". The
   money total stays `TOTAL COMPLETE`, because a call that was never sent did
   not cost anything.
6. **The connection dies with no answer.** Same missing request id as run 5, and
   it must NOT be treated the same: the mock confirms the request arrived, so it
   is `sentToGateway: null`, counted as billed, and reported as possibly billed.
7. **A billed `2xx` whose body is not JSON.** The SDK raises the *same*
   `configuration` kind a local refusal raises, but this call was served and the
   response carries a request id, a cost and a latency. It is `sentToGateway:
   true` and billed — writing it off as never-sent would discard a real charge
   with its spend-row key sitting in the log.

The suite also runs as step 3 of `tests/demo-e2e-record.test.sh`, and in its
`--mock-only` mode, which is the whole-repo gate that needs no key and no network.

## Interactive Companions: Terminal Agent & Web UI

If you want an interactive human-in-the-loop voice experience rather than an automated verification loop:

- **Interactive CLI Agent**: [`demo/interactive-agent.mjs`](../interactive-agent.mjs)
  Run `node demo/interactive-agent.mjs --live --voice` to chat in your terminal with streaming text, per-turn timing and cost breakdowns, and live speech audio playback. You can switch models at runtime (`/model <id>`), toggle voice playback (`/voice on|off`), inspect conversation history (`/history`), or clear context (`/clear`).

- **Interactive Web UI**: [`demo/ui/server.js`](../ui/server.js)
  Start the local server (`node demo/ui/server.js`) and open `http://127.0.0.1:4317`. It provides an interactive conversational UI with chat bubbles, real-time SSE streaming, browser microphone input (`SpeechRecognition`), and instant audio replay for synthesized speech turns.

## What this example does not do

Stated plainly, because an example that quietly omits things teaches the omission:

- **No realtime or streaming voice.** Every wire here is request/response. There
  is no bidirectional audio socket, so latency is the sum of three round trips —
  fine for a demo or an async voice workflow, not for barge-in conversation.
- **The chat reply is not streamed.** `client.nr.stream()` exists and would let
  text render while it generates, but speech synthesis needs the finished
  sentence anyway, so buffering is the honest choice for this shape.
- **No unit counts, only prices.** See "no quantity header" above; a client
  cannot verify the arithmetic, only reconcile the id.
- **`gpt-4o-mini-tts` is not currently priced per character** the way `tts-1` is.
  Use it and expect `unpriced` — which the example will tell you loudly rather
  than sum as zero.
- **No voice-activity detection, no turn-taking, no interruption handling.** The
  caller's turns are scripted so the demo is deterministic without a microphone.
- **The conversation history grows unbounded.** Every turn re-sends the whole
  transcript, so input tokens climb with turn count. A production agent
  summarises or windows; two turns does not need to.
