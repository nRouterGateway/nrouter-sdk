# Cost and usage

Every response carries `res.meta`, parsed from the `x-nr-*` headers:

```ts
const res = await client.nr.chat({ model, prompt });

res.meta.requestId;    // join key for a spend row or a support ticket
res.meta.cost;         // number | null  — USD
res.meta.costStatus;   // 'exact' | 'unpriced' | null
res.meta.model;        // what actually served it
res.meta.inputTokens;  // number | null
res.meta.outputTokens;
res.meta.totalTokens;
```

## Absent is not zero, and it is not free

`x-nr-request-cost` is **omitted** when the request could not be priced. It is
never sent as `0`. The SDK surfaces that omission as `cost: null` alongside
`costStatus: 'unpriced'`.

```ts
// WRONG — reports a free request, which no billable model is.
const spend = res.meta.cost ?? 0;

// Right.
if (res.meta.cost === null) {
  logUnpriced(res.meta.requestId, res.meta.costStatus);
} else {
  addToSpend(res.meta.cost);
}
```

`unpriced` means *we do not know what this cost*, not *this cost nothing*. It
still consumed credit: an unpriceable request settles at the amount that was
reserved for it rather than being released, because releasing it would make the
call free.

Treat `null` as unknown everywhere — the same rule applies to `inputTokens`,
`limitSource` and every other field on `meta`. The gateway omits a header rather
than sending a placeholder, so a default of `0` invents a measurement nobody
made.

## Streams always report `unpriced`, and that is honest

A streamed response's headers are written before the first body byte is relayed —
before anything has been generated and before anything can be priced. So on a
stream `x-nr-cost-status` is `unpriced` with no amount, and that is **permanent
for that response**, not a race you can re-read later: the gateway never revises
a header it has already sent. Reporting `0` there would claim a free request,
which no enabled model is.

That does not leave you with nothing. The usage is in the stream itself, and the
settled figure is retrievable afterwards — two different remedies for two
different questions.

### The usage arrives in the frames

Every wire ends a stream with the token counts, and the gateway prices from
exactly those frames server-side. The SDK yields content-less frames too — with
an empty `delta` and the whole decoded body on `chunk.raw` — precisely so the
terminal ones are not dropped:

| Wire | Where the usage is |
|---|---|
| chat completions, legacy completions | a terminal chunk carrying `usage`, whose `choices` array is **empty**. The gateway forces `stream_options.include_usage` on this wire, overriding a `false` you sent, because without it an OpenAI-protocol upstream emits no usage in a stream at all and every streamed request would settle unpriced. |
| Messages (Anthropic shape) | `message_start` carries the input tokens, `message_delta` carries the output tokens. Nothing to opt into. |
| Responses | the terminal `response.completed` event, at `response.usage`. Nothing to opt into either — and `stream_options` on this wire carries no `include_usage` member, so injecting one is a 400 naming the nested key. |

Accumulate **max-wins per counter** rather than summing: some wires repeat a
cumulative count on several frames, and adding those together invents tokens
nobody used. A client that filters on `chunk.delta` to get text will never see
the frame it needed — filter for display, not for accounting.

### Recomputing is an estimate, and must be labelled one

With the counts in hand you can multiply by the model's published rates and show
a number before the spend row settles. Do it, and then say what it is: it is your
arithmetic over relayed counts, not the gateway's settled price. The two can
differ — a rate you cached is a rate that can move, and the settlement applies
the platform fee and the pricing the gateway actually held. Print it as
*recomputed, not the settled cost*, and never fold it into a figure you present
as the bill.

### Reading the settled figure back

The real figure lands on the spend row, keyed by `meta.requestId`, which is
present on the stream's headers before the first token. The dashboard API returns
that one row to the **same virtual key that made the call**:

```bash
curl -sS "https://nrouter.ai/api/nrouter-proxy/spend/by-key?request_id=$REQUEST_ID" \
  -H "Authorization: Bearer $NROUTER_API_KEY"
```

It answers exactly one request id — no window, no paging, no filters — with
`{ "log": { request_id, model, spend, cost_status, prompt_tokens,
completion_tokens, total_tokens, cache_hit, status, … }, "total": 1 }`, and it is
rate limited per key.

Three things about it that decide whether a reconciliation is correct:

- **`spend: null` with `cost_status: "unpriced"` is unknown, never free.** The
  request was still settled against your balance at the amount reserved for it.
  The same rule as the header, one layer down.
- **A row can take a moment to appear after a stream closes.** Poll `total`
  rather than treating the first `null` as final.
- **A request id from another organization and one that never existed answer
  identically** — `{ "log": null, "total": 0 }` with HTTP 200. The lookup is
  scoped to the organization on your key and deliberately reveals nothing about
  ids outside it, so absence is not evidence that a call was never made.

### The cache header on a stream

`meta.responseCache` is `bypass` on every stream: the cache stores a complete
response and a stream is relayed as it is produced, so there is nothing to store
or serve. That is different from `null`, which means the gateway made no cache
claim at all — including on a plane where response caching is not switched on.
Do not read either as a hit or a miss.

## Calls that are genuinely free

A handful of routes are free to you. They report no cost header, and that
absence means zero rather than unknown:

| Call | Why |
|---|---|
| `POST /v1/messages/count_tokens` | a gateway whose product claim is cost visibility cannot be the thing that makes estimating cost impossible |
| polling a video job, and fetching its content | the render was settled once, when it was created |
| `GET /v1/models`, `GET /v1/models/{id}` | nothing was priced |

Free to you is not free of policy. Those routes still authenticate your key,
still check your rate limits, and still refuse a blocked key — they cost us a
real upstream call even when they cost you nothing.

## Four buckets, and three of them carry no cost

An absent cost header has three separate causes. A client that keeps fewer
buckets than that does not lose detail — it misreports one cause as another:

| Bucket | `costStatus` | `cost` | Decide it from |
|---|---|---|---|
| **priced** | `'exact'` | a number | `isPriced(meta)` |
| **streamed** | `'unpriced'` | `null` | the call was a stream — permanent, expected, and settled server-side |
| **unpriced** | `'unpriced'` | `null` | a **buffered** call the gateway could not price. The one that is a problem |
| **free** | `null` | `null` | the **route**, at the call site — never a header |

Streamed and unpriced are indistinguishable in the headers, so separate them by
what you called, not by what came back. Fold streams into `unpricedCalls` and
every streaming session reports a pricing failure that did not happen; fold free
calls in and a forty-poll video render reports forty of them.

A run containing a genuinely unpriced buffered call has no total — only a lower
bound. Say so where you print it, and never write `cost ?? 0`: the default is the
one value the gateway refuses to send.

## The two numbers that are not the same number

What you are **charged** and what the underlying provider **cost** are tracked
separately, through one shared formula. `res.meta.cost` is what you are charged.

## Rate-limit and budget refusals

A `429` carries `res.meta.limitSource` — which limit measured it, when the
gateway can say. A `null` there means it did not say; do not guess, and do not
send a customer to raise the wrong limit.

A `402` means the reservation failed and **nothing was spent**. See
[errors.md](./errors.md) for telling a credit refusal from a budget refusal.
