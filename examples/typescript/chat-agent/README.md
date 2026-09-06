# Chat agent — every text wire, and three different ways to be honest about money

A working chat agent in one file, looping over **all four text wires** the
gateway serves, plus a streamed call, a repeat that probes the response cache,
and a free token count:

| # | Step | Wire | Accounting |
|---|---|---|---|
| 1 | `messages` | `POST /v1/messages` | priced `exact`, summed |
| 2 | `chat` | `POST /v1/chat/completions` | priced `exact`, summed |
| 3 | `responses` | `POST /v1/responses` | priced `exact`, summed |
| 4 | `stream` | `POST /v1/chat/completions` (SSE) | **`unpriced` by design**, settled server-side |
| 5 | `cache` | `POST /v1/chat/completions`, the identical body | priced `exact`, summed — **a hit is still billed** |
| 6 | `count` | `POST /v1/messages/count_tokens` | **free**, no cost header, no spend row |

The voice agent next door proves three different billing *units*. This one
proves something a single-wire example cannot: **the same account has three
different kinds of "no price in the response", and confusing any two of them
produces a wrong invoice.**

```
node chat-agent.mjs

[messages]  turn=1 req_01J... claude-haiku-4-5 exact $0.003120 tokens=55/25 gw=640ms client=712ms cache=miss guardrails=pass  Anthropic-family id -> the Messages wire
[chat]      turn=1 req_01J... gpt-4.1-mini     exact $0.001210 tokens=55/25 gw=305ms client=361ms cache=miss guardrails=pass  OpenAI-family id -> the chat-completions wire
[responses] turn=1 req_01J... gpt-4.1-mini     exact $0.000470 tokens=40/18 gw=412ms client=470ms cache=—    guardrails=pass  the Responses wire
[stream]    turn=1 req_01J... gpt-4.1-mini     unpriced —      tokens=55/25 gw=88ms  client=903ms cache=bypass guardrails=pass  the chat wire, STREAMED
      ↳ streamed: costStatus is `unpriced` with no amount BY DESIGN ... join it on requestId req_01J...
[cache]     turn=1 req_01J... gpt-4.1-mini     exact $0.000190 tokens=55/25 gw=12ms  client=41ms  cache=hit(34s) guardrails=pass
[count]     turn=1 req_01J... claude-haiku-4-5 (no cost status) — tokens=—/— gw=7ms client=44ms cache=— guardrails=—
      ↳ free: this route reports no cost header, and here that absence means ZERO.

SESSION SUMMARY
  calls            12
  pricedCalls      8
  streamedCalls    2
  freeCalls        2
  unpricedCalls    0
  failedCalls      0
  cacheHits        2
  cacheMisses      2
  pricedTotalUsd   0.00998000
  streamRecomputedUsd —   <- set NROUTER_STREAM_RATE_IN_PER_MTOK and NROUTER_STREAM_RATE_OUT_PER_MTOK ...
  TOTAL COMPLETE — every BILLED call in this session was priced exactly. ...
```

<!-- The transcript above and the tables below name a Claude id, which this SDK sends to /v1/messages. nrouter-doc-wire: messages -->

## Three absences, three meanings

`x-nr-request-cost` is **omitted** when there is no price to report. It is never
sent as `0`. But *why* it is omitted differs, and the whole design of this
example is telling the three apart:

| State | What the response says | What it means | What this example does |
|---|---|---|---|
| **priced** | `x-nr-cost-status: exact` + an amount | settled, this is what you are charged | sums it into `pricedTotalUsd` |
| **streamed** | `unpriced`, no amount, **permanently** | the headers were written before a token existed. The real figure lands on the spend row | counts it under `streamedCalls`, **never sums it**, and prints the request id to join on |
| **free** | no cost header *and* no cost status | this route is free to you. Here, absent means **zero** | counts it under `freeCalls` |
| **unpriced** | `unpriced`, no amount, on a **buffered** call | the request was served and consumed provider capacity, but nRouter could not price it | counts it under `unpricedCalls` and reports `TOTAL INCOMPLETE` |

`unpriced` on a buffered call is the only one of the four that is a problem, and
it is the only one that makes the total incomplete. A run whose only unpriced
calls are streams is `TOTAL COMPLETE`; folding streams into `unpricedCalls`
would report every healthy session as broken, and folding them into the total
would invent a figure.

**Never `total += meta.cost ?? 0`.** `isPriced(meta)` is the single predicate —
`costStatus === 'exact' && cost !== null` — and this example decides it once per
call, writes the answer to the record, and never re-derives it in the summary.

## Streaming: unpriced is honest, not a gap

A streamed response's headers are written before the first body byte is
relayed. Nothing has been generated, so nothing can be priced, and the gateway
never revises a header it has already sent. `x-nr-cost-status: unpriced` with no
amount is therefore the **permanent and correct** state of that response — not a
race to re-read later.

What you do instead:

1. **Join on `meta.requestId`.** It is `x-nr-request-id`, the same value as the
   spend row's request id. The settled cost for the stream lives there, and the
   gateway settles it from the very frames you just consumed.
2. **Read the token counts from the frames, not the headers.** The gateway
   forces `stream_options.include_usage` on the OpenAI wire, so the stream ends
   with a terminal chunk carrying `usage` — and that chunk has an **empty
   `choices` array**, so a reader that reaches for `choices[0]` throws on the one
   frame it needed. This example accumulates usage **max-wins per counter**
   across every frame, which also covers the Anthropic wire (input on
   `message_start`, output on `message_delta`) and the Responses wire (on
   `response.completed`). Summing would double-count a running total; last-wins
   would lose the input count.
3. **Optionally recompute an estimate.** Set `NROUTER_STREAM_RATE_IN_PER_MTOK`
   and `NROUTER_STREAM_RATE_OUT_PER_MTOK` and the example multiplies the relayed
   token counts by *your* rates and prints the result on its own
   `streamRecomputedUsd` line, labelled `RECOMPUTED, NOT the gateway's settled
   figure`. **No rate card ships with this example on purpose** — a price table
   baked into a public repository rots silently and is then read as
   authoritative. The estimate is a sanity check against the spend row, never a
   substitute for it, and it is never added to `pricedTotalUsd`.

`meta.guardrails` **is** reported on a stream (`none | monitor | pass | partial |
blocked`). A `null` there is "the gateway made no claim", not "no guardrail
applied" — never render it as a reassurance.

## The response cache: four states, and a hit is still billed

Repeat a buffered text request with a byte-identical body and the gateway may
serve it from its tenant-isolated cache. Step 5 reuses the *exact same options
object* as step 2, because a repeat that differs by one character is a different
request and can never hit.

| `meta.responseCache` | Meaning |
|---|---|
| `miss` | the cache looked for this exact request and did not find it |
| `hit` | it found one; `meta.responseCacheAge` is whole seconds since it was produced |
| `bypass` | this request is not cacheable. **Every stream reports this** — a cache stores a complete response, and a stream is relayed as it is produced |
| `null` | the header was absent: **this gateway is not caching**. Not a miss |

**A cache hit is still billed and metered.** It skips the provider call and
nothing else: authorization, rate limits, guardrails, usage accounting, budgets
and the spend row all still happen. Caching cuts *our* provider cost, never your
invoice — never describe a hit to a customer as a discount.

⚠ **This example does not assert a hit, and a run that never sees one is not a
bug.** Two independent gates decide it: an operator gate on the deployment, and
your organization's own toggle. With the operator gate off the header is absent
entirely, `meta.responseCache` is `null`, and the summary says so. Before telling
a customer their cache opt-out is working, check the operator gate on that plane
— a toggle over a disabled gate answers a compliance question with a control
that does nothing.

## Refusals

A refusal exits **non-zero** and still prints the summary: money spent before the
failure is money you were billed, and a run that dies without itemising it is the
worst possible output. The typed error carries `kind`, `status`, `requestId`,
`authReason` and `limitSource`.

`limitSource` on a `429` is one of `key | plan | team | user | budget`, and
`null` means the gateway did not say. **Do not guess** — sending a customer to
raise the wrong limit is worse than saying you do not know.

## Run it

```bash
(cd ../../../sdks/js && npm run build)      # this example imports dist/
cp .env.example .env                        # then put your key in it
node --env-file=.env chat-agent.mjs
```

| Variable | Default | |
|---|---|---|
| `NROUTER_API_KEY` | — | **required**; your `sk-nrouter-…` virtual key |
| `NROUTER_BASE_URL` | `https://api.nrouter.ai/v1` | |
| `NROUTER_MESSAGES_MODEL` | a Claude Haiku id | takes `/v1/messages`, chosen by the id |
| `NROUTER_CHAT_MODEL` | `gpt-4.1-mini` | takes `/v1/chat/completions`, buffered and streamed |
| `NROUTER_RESPONSES_MODEL` | `gpt-4.1-mini` | takes `/v1/responses` |
| `NROUTER_TURNS` | `2` | five billed calls + one free call per turn |
| `NROUTER_MAX_TOKENS` | `120` | |
| `NROUTER_CHAT_LOG` | `./chat-agent.log.jsonl` | one JSONL record per call; gitignored |
| `NROUTER_STREAM_RATE_IN_PER_MTOK` | unset | optional; see *Streaming* above |
| `NROUTER_STREAM_RATE_OUT_PER_MTOK` | unset | optional; both required together |

<!-- nrouter-doc-wire: messages -->
The wire is chosen by the **model id**, not by you: `client.nr.chat()` sends an
Anthropic-family id (`claude-…`, `…haiku…`, `…sonnet…`, `…opus…`) to
`/v1/messages` and everything else to `/v1/chat/completions`. That matters
because the gateway serves Anthropic on `/v1/messages` **only** — the same id
posted to the other wire answers `404 model_unavailable_on_route` for a customer
holding a valid key and a real model id. `client.nr.responses()` and
`client.nr.messages()` are raw pass-throughs and do **not** route by family: you
pick the wire by picking the method.

No retries anywhere: the client pins `maxRetries: 0`. A retry is a second call
and a second bill, and an automatic one on a billed wire is how a transient blip
becomes a doubled invoice.

## The log

One JSON record per call, appended as it happens — on the failure path too, so a
bad run is itemised rather than lost:

```json
{"ts":"…","step":"stream","turn":1,"label":"…","wire":"/v1/chat/completions (stream)",
 "requestId":"req_…","model":"gpt-4.1-mini","costStatus":"unpriced","cost":null,
 "priced":false,"streamed":true,"free":false,"inputTokens":55,"outputTokens":25,
 "totalTokens":80,"usageFrom":"stream-usage-frame","recomputedUsd":null,
 "responseCache":"bypass","responseCacheAge":null,"guardrails":"pass",
 "gatewayMs":88,"latencyMs":903,"ok":true}
```

`gatewayMs` is `x-nr-latency-ms` — edge arrival until the response headers were
ready. `latencyMs` is what this process timed around the whole call, so it adds
the network. Absent is `null`, never `0`: a zero claims a measurement was taken
and came back instant. ⚠ On the **streamed** call `gatewayMs` is time to
*headers* while `latencyMs` covers the whole generation, so that one pair is not
like for like.

`wire` is the example's **claim** about which path the call took, not an
observation — the SDK does not report the path it chose. The mock suite is what
makes the claim checkable, by counting requests per route on a server it owns.

## What this example does NOT prove

- **The settled cost of a streamed call.** It is on the spend row, and this SDK
  has no spend-lookup call to read it back with. `requestId` is the join key;
  the dashboard Logs page is where the number lives.
- **That the cache is enabled on your plane.** It reports what it observed. See
  the four states above.
- **Cross-tenant isolation of the cache.** The cache key includes the tenant;
  proving that needs two keys and is a gateway-side test, not a client one.
- **Any live pricing.** No rate card ships here, and the optional recomputation
  uses rates *you* supply.
- **Tool calls, multi-turn tool loops, or structured output.** This is a
  tool-free agent on purpose: the subject is accounting, not orchestration.

## Certification

```bash
(cd ../../../sdks/js && npm run build)
node ../chat_agent_suite.js
```

Five runs against a local mock gateway — no key, no network, no credits: a fully
priced session with a cache miss then hit; an unpriced buffered call that must
produce `TOTAL INCOMPLETE`; a `429` carrying `x-nr-limit-source` that must exit
non-zero and still report what was already billed; a plane with caching off and
no stream usage frame, where every absence must log `null` rather than `0` or
`"miss"`; and a stream whose headers carry an exact cost, which must **still** be
excluded and announced.
