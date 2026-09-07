# Image agent — one wire, two billing units, fully accounted for

A working image generator in one file: **`POST /v1/images/generations`**, looped
over N prompts, with every call priced, counted, logged and joinable to a spend
row.

It exists because images are the modality where *"how much did that cost?"* has
two different answers, and because the number that produced the price — how many
images, at what size, at what quality — **never comes back in a response
header**. A client that does not record it itself can report a bill it cannot
explain.

```
node image-agent.mjs

gateway   https://api.nrouter.ai/v1
model     gpt-image-1-mini
size      1024x1024 (quality low)
n         1 per call, 2 prompt(s)
format    provider default (gpt-image-* always returns b64_json and rejects the parameter)

prompt 1: A flat vector illustration of a lighthouse on a rocky shore at dusk, three colours, no text.
      wrote out/image-1-1.png (1104382 bytes)
[image] p=1 req_01J... gpt-image-1-mini exact $0.011200 n=1 1024x1024 low tokens=41/1056 guardrails=pass gw=9412ms client=9980ms  generate
prompt 2: An isometric diagram of a small server rack with routed cables, muted palette, no text.
      wrote out/image-2-1.png (1233008 bytes)
[image] p=2 req_01J... gpt-image-1-mini exact $0.011900 n=1 1024x1024 low tokens=41/1120 guardrails=pass gw=8801ms client=9350ms  generate

SESSION SUMMARY
  calls            2
  imagesReturned   2
  filesWritten     2
  urlsNotDownloaded 0
  pricedCalls      2
  unpricedCalls    0
  failedCalls      0
  pricedTotalUsd   0.02310000
  TOTAL COMPLETE — every call in this session was priced exactly.
```

## What it proves

| Property | Where to look |
|---|---|
| **Cost, per call** | `result.meta.cost` + `result.meta.costStatus`, printed on every line and written to the log |
| **Price honesty** | an unpriced call logs `cost: null`, is **excluded** from the total, and the summary says `TOTAL INCOMPLETE` |
| **Failing closed** | a cost status the SDK does not recognise is excluded even when it carries an amount — `isPriced()` accepts `exact` and nothing else |
| **Quantity** | `count` (delivered), `requestedN`, `size`, `quality` on every record. **No header carries these** — see below |
| **Usage** | `meta.inputTokens` / `outputTokens` from the headers, *and* `imageTokens` read from the body's `usage` block, recorded separately because either can be absent alone |
| **Latency, two clocks** | `gw=` is `meta.latencyMs`, the gateway's `x-nr-latency-ms`: edge arrival to response-headers-ready, which on an image call includes the whole provider render. `client=` is what this process timed, so it adds the network *and*, for a b64 response, the transfer of the image itself. Absent is `—`, never `0ms`. |
| **Spend join** | `meta.requestId` on every record — the key that finds this exact call on the dashboard |
| **Logging** | one JSONL record per call, written on the failure path as well as the success path |
| **Refusals** | typed errors: `kind`, `status`, `requestId`, `authReason`, `limitSource` |
| **Was it billed?** | `sentToGateway` (`true` / `false` / `null`) and `billed` on every record — see below |

## Billing: per IMAGE, or per IMAGE TOKEN

nRouter settles the call and reports the result in the `x-nr-*` response
headers. Which **unit** it measured depends on the model, and the two do not
look alike:

| Model family | Billed per | What comes back |
|---|---|---|
| `gpt-image-*` | **image token** | A `usage` block in the body: `input_tokens`, `output_tokens`, and `input_tokens_details` splitting text tokens from image tokens. The gateway prices from these. |
| everything else (`dall-e`-class) | **image** | Nothing. No `usage` block at all. The price is a function of `n` x size x quality, and **none of those three is in the response.** |

Two ways to read that second row wrongly, both of which cost money:

- **A per-image model reporting no `usage` is not a bug.** This example records
  `imageTokens: null` rather than zeroes, because a zero claims the model
  reported a measurement of nothing.
- **The quantity is not recoverable after the fact from the client side.** So
  the example records `requestedN`, the delivered `count`, `size` and `quality`
  from its own request, and that is what you reconcile the spend row against.

### There is no quantity header — the units live on the spend row

The gateway prices `Units::Images { count, width, height, quality }` and writes
it to the spend row as `metadata.nrouter_units`:

```json
{ "unit": "image", "count": 2, "size": "1024x1024", "quality": "low" }
```

A token-priced call records the image-token breakdown in the same column
instead. There is no `x-nr-image-count`, no `x-nr-image-size`, and none is
coming: a client cannot recompute the bill, only reconcile the request id
against the row that carries the units.

### `unpriced` is a real state, not an error

`x-nr-request-cost` is **absent** when the gateway could not price a model. It is
never sent as `0`. So `meta.cost` is `null` and `meta.costStatus` is `unpriced`.
The request was served, **the images were delivered**, and it is on your spend
rows — it just has no price attached in the response.

```js
if (isPriced(meta)) total += meta.cost;   // costStatus === 'exact' AND cost !== null
else                unpricedCalls += 1;   // never `total += meta.cost ?? 0`
```

Folding it in as zero is how a spend dashboard quietly under-reports. This
example sums only the priced subset and labels the result `TOTAL INCOMPLETE`
whenever anything was left out, so a partial sum can never be read as the total.

### Where the parameters are checked, and what that means for the bill

The SDK bounds `n` (1–10), `size`, `quality` and `response_format` **before it
opens a socket** — `image()` throws `nRouterConfigurationError` from
`validateImageParams`. The gateway still decides everything else: whether the
model is published to your organization, whether the credit hold clears, and
what the images actually cost.

That split is worth spelling out, because the two refusals need opposite
responses and they arrive as the same type:

| | reached the gateway | request id | charge possible |
|---|---|---|---|
| SDK refused before send | no | none | **no — nothing was billed** |
| gateway refused (402, 404, 429) | yes | yes | yes, reconcile it |
| served but unusable, or the socket died | yes | maybe not | **yes, treat as billed** |

So this example records `sentToGateway` on every call — `true` when a request
id came back, `false` **only** for a proven pre-send refusal, `null` when the
request left the process and came back with nothing usable — and derives
`billed = sentToGateway !== false`. Unknown resolves *toward* the charge
existing: a dropped socket may sit on top of a request the gateway received,
served and charged for, and a client that assumed otherwise would tell you to
stop looking for a real bill.

⚠️ `false` cannot be keyed on the error kind alone. `requireJson()` raises the
same `configuration` kind for a 2xx whose body is not JSON — a response that was
**served and billed**. What separates them is the HTTP status: a status exists
only if a response came back. Nor can it be keyed on a missing request id, since
a served response can arrive without one. Runs 9–12 of the suite pin all four
corners.

This example therefore does **not** re-check `n` itself. The range lives in the
SDK and in the gateway; a third copy here is the one that would go stale, and
it would shadow the SDK's message with a worse one.

### The reservation is per image, not per call

The gateway holds `max($0.35, $0.35 × n)` **before** it calls the provider and
settles down to the real price afterwards. Two consequences worth knowing before
raising `NROUTER_IMAGE_N`:

- The hold scales with `n`, so a ten-image call needs $3.50 of available credit
  even if the settled price is a fraction of that. Insufficient credit is a
  **402 before the provider call**, not a partial delivery.
- Every retry is a fresh reservation and a fresh bill. This file has no retry
  loop and pins `maxRetries: 0` explicitly.

### `guardrails` is a posture over your PROMPT, not over the picture

`meta.guardrails` **is** published on the image route: the example prints the
`none | monitor | pass | partial | blocked` token and logs it. It reports the
PRE-CALL chain's posture over the request you sent — the `prompt` is a text field
like any other — upgraded to `blocked` when a post-call chain withheld the
response.

It says nothing about the rendered image. No check in the chain scans bytes, so
`guardrails=pass` means *your prompt was inspected and allowed*, never *this
picture is clean*. Never render it as a reassurance about the output.

The example still prints `guardrails=—` when the value is `null`, which means
**the gateway made no claim at all** — not the explicit `none` posture, and not a
statement that nothing was inspected.

## Run it

```bash
# 1. Build the SDK — this example imports the package built from this repo.
(cd ../../../sdks/js && npm run build)

# 2. Supply a virtual key. nRouter holds the provider keys; there is no
#    OpenAI key to configure.
cp .env.example .env      # then edit it
node --env-file=.env image-agent.mjs

# ...or just:
NROUTER_API_KEY=sk-nrouter-... node image-agent.mjs
```

**Every call spends real credits.** Every variable is documented in
[`.env.example`](./.env.example). Output goes to `out/image-<prompt>-<index>.png`
and `image-agent.log.jsonl`, both inside this directory and both gitignored — the
log carries request ids and prompts.

The file extension comes from the **bytes**, not from a hoped-for format:
`gpt-image-1` can be asked for webp or jpeg through `extra`, and a `.png` name on
a webp file is a file half the world's tooling refuses to open.

## Joining a call to its spend row

Each record carries `requestId`, which is the `x-nr-request-id` response header
and the same id the spend row is keyed by.

```bash
jq -r '[.requestId, .costStatus, (.cost // "unpriced"), .count, .size, .quality] | @tsv' image-agent.log.jsonl
```

Take any of those ids to the **Logs** page in the nRouter dashboard and search for
it. The row shows the settled cost, the organization / team / key it was billed
to, and `metadata.nrouter_units` — the count, size and quality the price was
computed from. That is the reconciliation path: the client reports the request it
made and the price it was told, the dashboard reports the units it was charged
on, and the request id is the only thing that has to match.

A record is written for failed calls too, with `ok: false` and the error kind. A
log that only records successes is a spend report that only sees the cheap half of
a bad day.

## Verify it without spending anything

```bash
node ../image_agent_suite.js
```

A local mock gateway speaks `/v1/images/generations` and stamps the same `x-nr-*`
headers. Twelve runs, no key, no network, a few seconds:

1. **Per-image billing, everything priced.** Two prompts at `n=2`. Every call
   reaches the log with a request id, `pricedTotalUsd` equals the mock's own
   arithmetic, the four files exist, and **the bytes on disk equal the bytes the
   mock sent** — a truncated base64 decode is a corrupt image that still reports
   success. Each call is given a distinct cost and a distinct
   `x-nr-latency-ms`, so a record that copied another call's numbers fails
   rather than passing on a plausible-looking value.
2. **Per-image-token billing.** A `gpt-image-*`-shaped response carrying
   `usage.{input_tokens, output_tokens, input_tokens_details}`. The breakdown is
   recorded, and the request is asserted to carry **no** `response_format` — the
   provider rejects the parameter outright.
3. **One `unpriced` call.** The images are still delivered and still written; the
   cost is excluded from the total and logs `cost: null` rather than `0`, and the
   session reports `TOTAL INCOMPLETE`. The total is asserted to be *exactly* the
   priced call, so summing the unpriced one as zero is indistinguishable from
   correct only if the assertion is removed.
4. **An unrecognised cost status carrying an amount.** Excluded too — the
   number alone is not authority to bill against — and the assertion proves the
   exclusion by showing the total is *not* higher by that amount. Run 3 cannot
   prove this on its own: an `unpriced` call carries no amount to sum, so code
   that trusted `cost !== null` instead of the status would pass it and fail
   here.
5. **A refused call mid-session.** The process exits non-zero, the failure is
   logged with its request id, `limitSource` is reported, and the summary still
   accounts for the money already spent before the refusal, in its own
   `failedCalls` bucket. A refused call was not "served without a price", and
   the summary says so.
6. **A `url`-shaped response.** Both links are recorded, **nothing** is written to
   disk, and the output says the download was skipped rather than leaving an
   empty directory to be misread as a failure.
7. **A short delivery.** Three images asked for, two returned. `count` must be
   what *arrived*, because that is what the price followed — a client that
   recorded its own `n` would report a quantity the spend row disagrees with,
   and since no header carries the quantity, nothing would ever contradict it.
8. **Billed and delivered, but the disk write fails.** The output directory is
   read-only. The call succeeded and was charged, so the record must keep its
   cost, cost status, model and **request id** — the obvious shape loses all
   four, because a filesystem error is not an `nRouterError` and a `catch` that
   rebuilds the record from the error logs `null` for every one of them,
   dropping a real charge out of `pricedTotalUsd` and severing the only link to
   its spend row. The money stays exact, `saveErrors` reports the loss
   separately from the pricing verdict, and the process still exits non-zero
   because the customer paid for images they do not have.
9. **The SDK refuses before sending** (`n=99`). The mock asserts it received
   **zero requests** — the only proof that cannot be faked by a well-worded log.
   The record is `sentToGateway: false`, `billed: false`, `requestId: null`, and
   the summary must **not** say "may still have been billed": there is no charge
   to reconcile, and sending someone to look for one on a wire holding $0.35 per
   image is the wrong direction to be wrong in.
10. **A billed 2xx with a non-JSON body.** The same `configuration` error kind as
    run 9, but it carries a status and a request id because it was served and
    charged. It must be counted as billed — keying the local/remote split on the
    kind alone files a real charge as unbillable.
11. **Served and billed with no request id.** Proves the split cannot lean on a
    missing `requestId` either: `sentToGateway: null`, still `billed: true`.
12. **The socket dies mid-request.** The mock confirms it received the request,
    then destroys the connection. No status, no request id — identical emptiness
    to run 9, opposite meaning. `sentToGateway: null`, `billed: true`, and the
    summary counts it among the calls that may still have been billed.

## What this example does not do

Stated plainly, because an example that quietly omits things teaches the omission:

- **No quantity header, so no client-side arithmetic.** See above; the count,
  size and quality in the log are what this client *asked for and received*, not
  what the gateway said it charged on. Reconcile, do not recompute.
- **It does not download a `url` response.** Fetching an arbitrary
  gateway-supplied host from a process holding your API key is an egress the
  reader never asked for, and the link expires anyway. The link is recorded; ask
  for `b64_json` if you want the bytes.
- **`dall-e-*` may not be published on your account.** The served catalogue is
  per-tenant, and a model your organization cannot see answers 404
  `model_not_found`. `GET /v1/models` is the list that counts, not this README.
- **No image editing or variations.** The gateway mounts image *generation*
  only; the edit and variation routes are not served.
- **No streaming, no partial images.** The call is request/response, so a large
  `n` at a large size is one long wait rather than progressive delivery.
- **No prompt-rewrite reporting.** Some providers revise the prompt before
  rendering and return the revision in the body; this example logs neither the
  revision nor the original beyond the prompt it sent.
- **No moderation posture on the OUTPUT.** `meta.guardrails` reports the
  pre-call chain over your prompt (above), never a verdict on the rendered image,
  and a provider-side content refusal arrives as a typed error rather than as a
  guardrail claim.
- **One guard is not exercised.** `metered` wraps its post-response `enrich`
  callback so that nothing after a successful billed call can be mistaken for a
  failed one. The suite cannot reach that arm — the only `enrich` body here is
  `saveImages`, which catches every throwing operation it performs — so
  planting a `throw` in it leaves all eight runs green. It is defence in depth
  for the next callback, said out loud rather than left to look tested.
