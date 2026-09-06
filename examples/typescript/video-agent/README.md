# Video agent — one billed call, then a free collection

A complete video generation in one file: **create → poll → download**, with the
one call that costs money accounted for separately from the four that do not.

Video is the only *asynchronous* wire nRouter serves. The other modalities hand
you the product in the response; `POST /v1/videos` hands you a **job** and you
collect the result over two more calls. That split is the whole reason this
example exists, because the money follows the split and nothing on the wire
tells you so.

```
node video-agent.mjs

gateway   https://api.nrouter.ai/v1
model     sora-2
seconds   4
size      1280x720
poll      every 5000ms, up to 600000ms

[video.create] req_01J... sora-2 exact $3.000000 seconds=4 size=1280x720 gw=812ms client=1204ms  start the render (THE billed call)
      job: nrouter_video_8fJ2...  status=queued
[video.poll] req_01J... status=queued      costStatus=— (free) gw=17ms client=94ms   poll #1
[video.poll] req_01J... status=in_progress costStatus=— (free) gw=19ms client=88ms   poll #2
[video.poll] req_01J... status=completed   costStatus=— (free) gw=17ms client=91ms   poll #3
[video.content] req_01J... bytes=2841160 video/mp4 costStatus=— (free) gw=244ms client=1710ms  download the rendered video
      wrote out/video.mp4 (2841160 bytes)

SESSION SUMMARY
  calls            5
  billedCalls      1
  pricedCalls      1
  unpricedCalls    0
  freeCalls        4
  failedCalls      0
  pricedTotalUsd   3.00000000

  TOTAL COMPLETE — every billed call in this session was priced exactly.
```

## Create bills; collection is free

| Call | Money | What still applies |
|---|---|---|
| `POST /v1/videos` | **Bills.** A credit reservation is taken before the provider is called, then settled from the seconds the accepted job reports. | everything |
| `GET /v1/videos/{id}` | **Free.** No reservation, no settlement, no spend row, and **no cost header at all**. | auth, tenancy, the key's model ACL, a blocked key, an RPM slot |
| `GET /v1/videos/{id}/content` | **Free**, same reasons. | the same, plus a 512 MiB ceiling on the download |

The settlement is moved to the create deliberately. Billing on collection would
mean holding a reservation open across a render that takes minutes and may never
be collected at all — a customer who starts a job and walks away would leak the
hold forever. And a poll produces no seconds, no tokens and no images, so a
billed poll would settle at the *full reservation estimate*: the endpoint that
exists to let you collect what you already bought would be the most expensive
route on the gateway.

**Free is a statement about money and nothing else.** A collection call is still
authenticated, still tenant-checked against the sealed handle, still subject to
the key's model ACL — revoke a key's access to `sora-2` and its in-flight job
becomes uncollectable — and still takes an RPM slot. It still carries
`x-nr-request-id` and `x-nr-latency-ms`. So this example logs every call, billed
or not: a log that skipped the free ones would hide exactly the traffic that
produces a 429.

### Absence is not $0 — and it is not `unpriced` either

`x-nr-request-cost` is **absent** on a free call. It is also **absent** when the
gateway could not price a billed call. Byte-identical on the wire, and two
completely different facts:

| | `costStatus` | `cost` | Means |
|---|---|---|---|
| priced | `exact` | a number | settled, this is the bill |
| unpriced | `unpriced` | `null` | **served and billed**, but the gateway could not attach a price |
| free | `null` | `null` | the route bills nothing; the render was settled once, at create |

Two buckets where the domain has three is how both of the naive readings go
wrong:

- counted as **unpriced**, a forty-poll render reports forty calls the gateway
  "failed to price", and someone goes hunting a pricing bug that does not exist;
- counted as **$0.00**, the client asserts a settled price for a call nobody
  priced — the confident zero the pricing contract forbids: an absent cost
  header never means free.

So this example decides the bucket **at the call site, from the route**, never by
inspecting a header that is absent for two reasons:

```js
// the create — the route bills, so isPriced() decides priced vs unpriced
await meteredCreate(...);   // billed: true,  priced: isPriced(meta)

// every poll and the download — the route bills nothing, full stop
await meteredFree(...);     // billed: false, free: true, cost: null, costStatus: null
```

`costStatus: null` on a free record is "the gateway made no cost claim".
Writing `'unpriced'` there would be claiming it tried and failed. The summary
keeps the two apart, and a session whose only billed call was priced exactly
reports `TOTAL COMPLETE` even though four of its five calls carry no price.

## What it proves

| Property | Where to look |
|---|---|
| **Cost** | `result.meta.cost` + `meta.costStatus` on the create — the only call with either |
| **Price honesty** | an unpriced create logs `cost: null`, is excluded from the total, and the summary says `TOTAL INCOMPLETE` |
| **Free ≠ unpriced** | a free call logs `cost: null` **and** `costStatus: null`, lands in `freeCalls`, and never touches `unpricedCalls` |
| **Free ≠ unmeasured** | `gatewayMs` is present on every free call — the edge stamps `x-nr-latency-ms` on responses it does not bill |
| **Spend units** | `seconds` and `size` on the create record, read off the **job** rather than the request |
| **Usage** | there is none to report: no token count exists for a rendered asset, so no token field is invented |
| **Spend join** | `requestId` on every record; the create's is the one that finds a spend row |
| **Logging** | one JSONL record per call, written on the failure path as well as the success path |
| **Refusals** | typed errors: `kind`, `status`, `requestId`, `authReason`, `limitSource` |

## The job handle

`POST /v1/videos` does not return the provider's job id. It returns a sealed
`nrouter_video_…` handle that carries the model alias, the upstream job id and
your organization id, authenticated so it cannot be forged. That is what lets
the two collection routes — which carry no model and would otherwise have
nothing to route on — find your job and prove it is yours.

Two consequences worth knowing before you build on it:

- **Every refusal a stranger can provoke is the same refusal.** A garbage id, a
  tampered handle and another tenant's handle all return an identical `404
  job_not_found` with no detail. An error that distinguished them would confirm
  that another tenant's job exists.
- **Treat the handle as the only route back to a paid render.** Log it. It is on
  the create record as `jobId`, and `out/` is gitignored precisely because the
  log carries it.

## Run it

```bash
# 1. Build the SDK — this example imports the package built from this repo.
(cd ../../../sdks/js && npm run build)

# 2. Supply a virtual key. nRouter holds the provider keys; there is no
#    OpenAI key to configure.
cp .env.example .env      # then edit it
node --env-file=.env video-agent.mjs

# ...or just:
NROUTER_API_KEY=sk-nrouter-... node video-agent.mjs
```

**The create call spends real credits**, and this is the most expensive single
call the gateway serves: the reservation floors at `$3.00` and adds `$0.75` per
requested second, so a sixty-second job holds `$45` before a frame is rendered.
Cut `NROUTER_VIDEO_SECONDS` before you experiment.

There is no retry loop in this file and the client pins `maxRetries: 0`
explicitly. On every other wire a retry is a second bill; **here it is a second
render** — the first job keeps rendering and keeps being charged for, and you
now hold two handles and one result you wanted.

Every variable is documented in [`.env.example`](./.env.example). Output goes to
`out/video.mp4` and `video-agent.log.jsonl`, both inside this directory and both
gitignored.

## Joining a call to its spend row

```bash
jq -r '[.step, .requestId, (.cost // "—"), (.costStatus // "—"), (.free|tostring)] | @tsv' video-agent.log.jsonl
```

Take the **create** id to the Logs page in the nRouter dashboard. The row shows
the settled cost, the organization / team / key it was billed to, and the
seconds and resolution the settlement was measured in — no response header
carries those, so the spend row is the only place the arithmetic is visible.

The **collection** ids will find no row, and that is the expected result, not a
missing one: collection writes none. If you build a reconciliation that expects a
spend row per request id, this is the wire that breaks it.

## Verify it without spending anything

```bash
node ../video_agent_suite.js
```

A local mock gateway speaks the three video routes and stamps the same `x-nr-*`
headers — including, on the collection routes, deliberately stamping *no* cost
headers. Seven runs, no key, no network, about two seconds:

1. **Create bills, collection is free.** Five records: one billed create with an
   exact cost, three free polls and a free download. The free calls log
   `cost: null` **and** `costStatus: null`, land in `freeCalls`, and are asserted
   *not* to appear in `unpricedCalls` — the run would still pass a naive
   implementation without that last assertion, which is why it is there. Each
   poll must log its own request id and the status *it* observed, so a record
   that copied the create's id or the final status fails.
2. **An unpriced create.** The job still runs and is still collected — unpriced
   is a served request, not an error — but the one billed call has no price, so
   the total is `TOTAL INCOMPLETE` and says the call was *served without a
   price*. A total of `0` here means "nothing could be priced", never "this was
   free", and the summary is what makes the zero readable.
3. **A job that fails after create.** The process exits non-zero **and does not
   attempt the download**: a failed job has no content, so the request would be a
   guaranteed 404 burying the real error under an unrelated one. The create is
   still reported as billed, because it still was.
4. **A 402 at create.** Exit non-zero, no polls, no download, nothing billed. A
   refusal is its own bucket — it was not "served without a price" and it was not
   free; the job never existed.
5. **`succeeded`, the other terminal success status**, and 6. **`cancelled`, the
   other terminal failure status.** Both are accepted alongside `completed` and
   `failed`. A suite that only ever saw one of each pair would stay green if the
   other were dropped from the terminal set — and dropping it turns a finished
   render into a poll loop that runs to its ten-minute timeout on a job that was
   ready in one. Both runs assert the loop *stopped*, not merely that it ended.
7. **A collection call that fails.** The download answers 503. The record is
   still `free: true` with `cost: null`, the create is still reported as billed
   in full, and the summary says *nothing was billed for them* rather than *may
   still have been billed* — a failed free call is not money that may have been
   spent, and saying it was sends someone looking for a charge that cannot exist.

Nine planted mutations were checked to go red against these runs: marking free
calls billed, logging a free cost as `0`, inventing `costStatus: 'unpriced'` on a
free call, downloading after a failed job, dropping the create from the billed
bucket, exiting `0` on a failed job, dropping `succeeded` from the terminal set,
dropping `cancelled` from it, and describing a failed free call as possibly
billed.

## What this example does not do

Stated plainly, because an example that quietly omits things teaches the
omission:

- **It uses its own poll loop rather than `waitForVideo`.** The SDK ships
  `waitForVideo(id, { pollIntervalMs, timeoutMs })` — same terminal statuses,
  fewer lines, and it additionally refuses a `pollIntervalMs` below 250 ms or a
  `timeoutMs` shorter than one interval (polling costs no credit, but every poll
  spends one of your key's rate-limit slots, and a deadline shorter than the
  interval times out without ever polling). It is the right call for ordinary
  code. It exposes **no per-poll hook**, so a caller sees one resolved value and
  never the intermediate responses. This example's entire subject is that each of those calls is a real,
  authenticated, rate-limited, request-id-carrying call that costs nothing, and
  you cannot demonstrate that about calls you never see. If you do not need
  per-poll accounting, use `waitForVideo` instead of copying `pollUntilTerminal`.
- **A job that is accepted and then fails stays billed.** The settlement happens
  at create and nothing observes the job's terminal state afterwards, so the
  charge is not reversed when the render fails. It is bounded by the requested
  duration and recorded in the spend row's metadata, so it is refundable by hand
  — but you have to ask. This is different from a job refused **at** create,
  which bills zero seconds; the example prints which one happened.
- **No cancellation.** There is no `DELETE` on a video job in this SDK surface,
  so a job you no longer want runs to completion and stays billed.
- **No resumption across runs.** The handle is logged, but the example does not
  read a previous log to re-attach to an in-flight job. If it times out, re-poll
  the logged handle by hand — do **not** create a second job.
- **One job, no queue.** Real batch video work needs concurrency limits and a
  durable job table; five calls in a straight line does not.
- **Model availability is per-plane.** No OpenAI video model is guaranteed to be
  published on the plane your key belongs to, and an unpublished model answers
  `404 model_not_found` at create rather than silently substituting one. Check
  `GET /v1/models` before assuming `sora-2` is servable for you.
- **`seconds` and `size` are validated by the SDK, but only for shape and for
  the one bound that costs money.** `video()` refuses before the request leaves
  the process: `seconds` must be a positive finite number or numeric string and
  at most `MAX_VIDEO_SECONDS` (1333), and `size` must be `WIDTHxHEIGHT` with
  both dimensions above zero. The seconds ceiling is not a style rule — above it
  the gateway's per-request credit hold saturates, so the pre-call
  insufficient-credit refusal stops covering the whole request and the settle
  lands as an overage against your balance. Refusing in-process is the only
  place that costs nothing.

  **Everything else is still the gateway's and the provider's to decide**, and
  an SDK stricter than the gateway would be a false gate. Whether `sora-2` is
  published on your plane, and whether *this* duration at *this* resolution is a
  combination the provider renders, are create-time refusals — which is the
  cheap place to find out, because the create is refused before a reservation is
  taken.
