# demo-e2e-sdk-example

One real end-to-end request through the nRouter JS SDK, printing the two things a
production integration has to branch on: **what it cost**, and **why it was refused**.

It is deliberately small. `index.mjs` is the whole program.

## Run it

The example resolves `@nrouter_ai/sdk` from this repo's `sdks/js` rather than from
npm (see [Why `file:`](#why-file) below), so build the SDK first:

```bash
cd ../../sdks/js && npm install && npm run build   # sdks/js/dist is gitignored
cd -                                                # back to examples/demo-e2e-sdk-example
npm install
cp .env.example .env                                # copy template to .env
# Edit .env and set your NROUTER_API_KEY=sk-nrouter-...
npm start
```

**`npm start` sends a real, billed request.** One call, capped at
`NROUTER_MAX_TOKENS` (default 200).

## Environment

`.env.example` is the complete list; copy it to `.env` in this directory (`examples/demo-e2e-sdk-example/.env`), which is gitignored.

| Variable | Required | Default | What it does |
|---|---|---|---|
| `NROUTER_API_KEY` | **yes** | — | Your `sk-nrouter-…` virtual key. Put this in `.env`. Never commit it; this repo is public. |
| `NROUTER_BASE_URL` | no | `https://api.nrouter.ai/v1` | Point at a local gateway for development (`http://localhost:4000/v1`). |
| `NROUTER_MODEL` | no | `claude-fable-5` | Any model your key can reach (e.g. `claude-fable-5` or `claude-haiku-4-5-20251001`). |
| `NROUTER_PROMPT` | no | a question about unpriced costs | The prompt to send. |
| `NROUTER_MAX_TOKENS` | no | `200` | Output ceiling — this is what you pay for. |

### Local Docker Stack Notes
When running against the local containerized stack:
- The Rust gateway container (`nrouter-gw`) serves inference at `http://localhost:4000/v1` (health at `GET http://localhost:4000/health`).
- The Next.js web application and dashboard (`nrouter-app-web`) serves at `http://localhost:3001` (where virtual keys can be created and spend logs viewed).
- To test locally, ensure `NROUTER_BASE_URL=http://localhost:4000/v1` is set in your `.env`.


<!-- nrouter-doc-wire: messages -->
The default model is a Claude id, and the gateway serves Anthropic on `/v1/messages`
**only** — a Claude id sent to chat-completions answers `404
model_unavailable_on_route`. `index.mjs` calls `client.nr.chat()`, which selects the
Messages wire for Claude ids itself, so this works as written; if you swap
`NROUTER_MODEL` for a non-Claude id it will pick that model's wire instead.

## What it demonstrates

**Cost is two fields, not one.** `meta.cost` is the priced cost of *this* request
and `meta.costStatus` says whether to trust it. `exact` means priced; `unpriced`
means nRouter could not price the model and the cost is **absent** — never a silent
zero. `cost ?? 0` is how a spend dashboard quietly under-reports; branch on
`costStatus` instead. The example prints a warning whenever `costStatus !== 'exact'`.

**A cache hit is still billed.** `meta.responseCache` / `meta.responseCacheAge`
report whether a byte-identical repeat was served from the tenant-keyed cache. A
hit skips the provider call and nothing else — it is still authorized, rate-limited,
guardrailed, metered and billed. Response caching is off unless the gateway you are
calling has opted in; **while it is off, both fields read `null`** — which means "this
gateway is not caching", not "this was a cache hit".

**Refusals are typed.** `err.kind`, `err.status` and `err.authReason` separate
"your key is wrong" from "your key is fine but the account is on hold". Only the
first is fixed by minting a new key, and neither is fixed by retrying — so the
example prints the distinction rather than a generic failure.

## Why `file:`

`package.json` depends on `file:../../sdks/js`, not on a published range. The
in-repo SDK is 3.x and npm's latest is 2.2.1, so a `^3.0.0` range does not install
yet, and pinning `^2.2.1` would ship an example demonstrating an SDK this repo no
longer contains.

Once 3.0.0 is published, this becomes a one-line change back to a normal
dependency — which is also what you should write in your own project:

```json
"@nrouter_ai/sdk": "^3.0.0"
```

`tests/demo-e2e-record.test.sh --static-only` fails if this example's major ever
drifts from `sdks/js`, and resolves a `file:` spec through to the linked package's
own version so the check reads the same before and after that change.
