# JS SDK demo agent

This folder contains a tiny demo agent that exercises the JS SDK from built
`dist/` output.

```bash
cd sdks/js
npm run build
node demo/agent.js --dry-run
```

Dry-run mode uses an in-memory requester and does not spend credits.

To hit the live gateway, set `NROUTER_API_KEY` or keep it in the repo-root
`.env` file, then run:

```bash
node demo/agent.js --live
```

The live mode defaults to `claude-haiku-4-5-20251001`. Override it with:

```bash
NROUTER_DEMO_MODEL=claude-sonnet-4-5-20250929 node demo/agent.js --live
```

The demo verifies:

- model discovery through `client.nrouterModels.list()`
- an agent chat/message request
- nRouter response metadata, including request id and cost status
- local guardrail override refusal

## Aggressive live test

`aggressive-agent-test.js` repeatedly exercises the live JS SDK until it reaches
the observed cost target or the request limit. It prints one JSON line per
request and a final summary.

Start small:

```bash
NROUTER_TARGET_USD=0.05 NROUTER_MAX_REQUESTS=20 node demo/aggressive-agent-test.js
```

To target about five dollars:

```bash
NROUTER_TARGET_USD=5 NROUTER_MAX_REQUESTS=500 NROUTER_MAX_TOKENS=1024 node demo/aggressive-agent-test.js
```

On PowerShell:

```powershell
$env:NROUTER_TARGET_USD="5"
$env:NROUTER_MAX_REQUESTS="500"
$env:NROUTER_MAX_TOKENS="1024"
node demo\aggressive-agent-test.js
```

It currently tests:

- `client.nrouterModels.list()`
- local refusal of `guardrailIds`
- local refusal of non-nRouter API keys
- `client.nr.countTokens()`
- `client.nr.chat()`
- `client.nr.messages()`
- `client.nr.responses()`
- `client.nr.stream()`

### What the spend number is, and what it is not

The spend number comes from `x-nr-request-cost` response metadata, and it is the
**priced subset of the run, not the run's cost**. `x-nr-request-cost` is omitted
when the gateway could not price a request and is never sent as `0`, so a call
with no cost header is *unknown*, not free — see
[`../docs/cost.md`](../docs/cost.md).

Both probes therefore sort every call into one of five buckets and sum only the
first:

| bucket | meaning | summed |
|---|---|---|
| `priced` | `costStatus: exact` with an amount | ✅ |
| `streamed` | unpriced by construction — a stream's headers are written before the first token, so it reports `unpriced` permanently | ❌ settles server-side |
| `free` | a route documented as costing nothing (`countTokens`, video polling, model listing) | ❌ it cost nothing |
| `unpriced` | SERVED and billed, but the gateway could not price it | ❌ this is the hole |
| `failed` | refused; may still have been billed upstream if the provider had run | ❌ |

A run with any `unpriced` or `failed` call prints **`TOTAL INCOMPLETE`** under
the figure. That is not a probe bug — it means the printed total is smaller than
what the run actually cost, and the settled amounts live on the spend rows.
Every line carries the `requestId`, which is `x-nr-request-id`, which is the
spend row's request id; look them up on the dashboard Logs page.

`aggressive-agent-test.js` advances toward `NROUTER_TARGET_USD` on the **priced**
total, so a run dominated by streamed calls stops at `NROUTER_MAX_REQUESTS`
rather than at the target. That is the honest behaviour: advancing on a coerced
zero would spin to the request cap while reporting a spend of `$0.00000000`.

The bucketing lives in [`lib/accounting.js`](./lib/accounting.js) — shared by
both probes so the two cannot disagree — and is unit-tested offline:

```bash
cd sdks/js
npm run build      # the probes and the test import the SDK's own isPriced()
node --test demo/lib/
```

## Local browser UI

The UI calls a tiny local Node server. The browser never receives the API key;
the server loads `NROUTER_API_KEY` and calls the JS SDK package through
`require('../..')`, which resolves `sdks/js/package.json` and uses built `dist/`.

```bash
cd sdks/js
npm run build
node demo/ui/server.js
```

Open:

```text
http://127.0.0.1:4317
```

The UI can:

- check whether the server loaded the API key
- list models
- run `client.nr.chat()`
- run `client.nr.messages()`
- verify local guardrail override refusal

## Feature spend test

`feature-spend-test.js` is for testing feature billing beyond normal LLM text
calls. It uses the same [`lib/accounting.js`](./lib/accounting.js) bucketing as
the aggressive test above, so an embedding, image, speech, transcription or
video call the gateway could not price is counted and named rather than added to
the total as `0`.

```powershell
cd D:\nrouter-sdk\sdks\js
npm run build
node demo\feature-spend-test.js
```

By default it tries:

- embeddings with `text-embedding-3-small`
- image generation with `gemini-2.5-flash-image`

Speech, transcription and video need exact model IDs. If those models are added
to your key later, run:

```powershell
$env:NROUTER_SPEECH_MODEL="your-speech-model-id"
$env:NROUTER_TRANSCRIBE_MODEL="your-transcription-model-id"
$env:NROUTER_VIDEO_MODEL="your-video-model-id"
node demo\feature-spend-test.js
```

Useful overrides:

```powershell
$env:NROUTER_EMBEDDING_MODEL="text-embedding-3-large"
$env:NROUTER_IMAGE_MODEL="gemini-3-pro-image"
$env:NROUTER_IMAGE_SIZE="1024x1024"
node demo\feature-spend-test.js
```

To spend more on embeddings, repeat the embedding call:

```powershell
$env:NROUTER_EMBEDDING_REPEAT="100"
node demo\feature-spend-test.js
```

Embeddings are very cheap, so even 100 calls may still be only a tiny amount of
credit.
