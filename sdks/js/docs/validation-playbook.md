# nRouter npm / JavaScript SDK Validation Playbook

## Goal

Validate the JavaScript SDK end to end:

**repo → tests → npm package → fresh consumer → live API → manual dashboard verification → regression**

Keep the process repeatable and evidence-based.

## 1. Start from the Correct Branch

### Manual steps

```bash
git fetch upstream
git switch sdk-validation
git rebase upstream/main
git status
```

Confirm:

- current branch is `sdk-validation`
- working tree is clean before starting
- no unrelated SDK changes are mixed in
- `upstream` points to `nRouterGateway/nrouter-sdk`

### Short agent prompt

```text
Inspect the current repo state for JS SDK validation.
Confirm branch, status, upstream remote, current commit, Node version, npm version and JS package version.
Do not modify or push anything.
```

## 2. Run the Existing JavaScript SDK Suite

### Manual steps

From `sdks/js`:

```bash
npm ci
npm run build
npm test
```

Also run any existing lint/typecheck/conformance commands that are actually defined in the repository.

Record:

- total tests
- passed
- failed
- skipped
- warnings
- build result

### Short agent prompt

```text
Run the complete existing JS SDK validation from sdks/js.
Use only commands defined by the repo.
Record build, test, typecheck, lint and conformance results.
Do not fix anything yet.
```

## 3. Validate CJS, ESM and TypeScript

### Manual verification

Confirm all of these work:

```js
const NRouter = require("@nrouter_ai/sdk");
```

```js
import NRouter from "@nrouter_ai/sdk";
```

```js
import { nRouter } from "@nrouter_ai/sdk";
```

Also verify a small TypeScript consumer compiles successfully.

Check:

- CommonJS import
- ESM default import
- ESM named imports
- export parity
- declaration files
- runtime/type consistency

### Short agent prompt

```text
Validate the JS SDK consumer API:
1. CommonJS require
2. ESM default import
3. ESM named imports
4. export parity
5. TypeScript consumer compilation
Report exact results and do not modify source unless a verified defect exists.
```

## 4. Validate the Actual npm Package

### Manual steps

```bash
npm pack --dry-run
npm pack
```

Inspect the tarball.

It should contain only required public package files such as:

- compiled JS
- `.d.ts`
- package metadata
- README
- license
- approved public docs

It should not contain:

- audit reports
- live test outputs
- `.env`
- internal demo artifacts
- logs
- `node_modules`
- unrelated SDK files

### Short agent prompt

```text
Run npm pack --dry-run and create the real tarball.
Inspect every packed file.
Flag internal/dev/test artifacts that should not be published.
Do not change package contents unless the issue is verified.
```

## 5. Fresh Consumer Installation

### Manual steps

Create a clean external project:

```bash
mkdir nrouter-js-consumer
cd nrouter-js-consumer
npm init -y
npm install <path-to-generated-tgz>
```

Run CJS, ESM and TypeScript checks against the installed tarball.

Important: **Do not import from the source repository.**

### Short agent prompt

```text
Create a fresh temporary Node consumer project.
Install only the generated nRouter npm .tgz.
Test CJS, ESM default/named imports and TypeScript declarations using the installed package.
Do not use repository-relative imports.
```

## 6. Live Core API Validation

Use the installed npm tarball.

Set API key through environment only.

Use `maxRetries: 0` for controlled requests.

Test:

1. model discovery
2. chat
3. Claude Messages
4. Responses API
5. streaming

Capture for every live request:

- request purpose
- request ID
- HTTP status
- model
- provider if exposed
- resolved model if exposed
- input tokens
- output tokens
- total tokens
- exact cost
- latency
- cache state
- guardrail state
- error class/message if failed

### Short agent prompt

```text
Using the installed npm tarball, run controlled live tests with maxRetries: 0 for:
model discovery, chat, Claude Messages, Responses and streaming.
Capture request IDs, status, model, tokens, exact cost, latency, cache, guardrail and routing/provider metadata.
Never print the API key.
```

## 7. Chatbot-Like Demo

### Manual verification

Use a minimal CLI example, not a large application.

Verify:

- one user message
- multi-turn history
- context carried through messages
- streaming output
- request metadata
- typed error handling

### Short agent prompt

```text
Create a minimal CLI chatbot demo using the packed npm SDK.
Demonstrate single-turn, multi-turn, streaming, metadata and one controlled failure.
Keep it small and presentation-ready.
Do not add unrelated UI or framework dependencies.
```

## 8. Error Matrix

Test controlled failures where safe.

Recommended:

- invalid request → 400
- invalid model → 404
- guardrail block → 400

Only test these when safe/approved:

- 401
- 402 budget
- 403
- 429
- 5xx

Verify:

- typed SDK error class
- HTTP status
- request ID
- message
- retry behavior
- no retry when `maxRetries: 0`

### Short agent prompt

```text
Run a controlled JS SDK error matrix.
Prioritize safe 400, 404 and guardrail failures.
Verify typed error class, HTTP status, request ID, message and retry behavior.
Do not trigger budget/auth/rate-limit/account-changing tests unless explicitly safe.
```

## 9. Cache Validation

Run three requests:

- Request A: normal request → expect `MISS`
- Request B: identical request → expect `HIT`
- Request C: same request with cache bypass → expect `BYPASS`

Do not infer cache state from latency. Only use explicit cache metadata.

### Short agent prompt

```text
Run a 3-request cache sequence using the packed npm SDK:
1. normal request
2. identical repeat
3. explicit bypass
Capture request IDs and explicit cache metadata.
Expected: MISS -> HIT -> BYPASS.
Do not infer cache state from latency.
```

## 10. Guardrail Validation

Run:

- one allowed/control request
- one request that triggers configured gateway guardrails

Verify:

- HTTP status
- request ID
- typed SDK error
- `pass` / `blocked` metadata

A model refusal is **not** the same as a gateway guardrail block.

### Short agent prompt

```text
Run one guardrail control request and one controlled gateway-blocked request.
Verify typed SDK guardrail error, request ID and explicit guardrail metadata.
Do not classify a model refusal as gateway enforcement.
```

## 11. Routing / Model Validation

Test:

- valid routable model
- another provider/model if supported
- routing alias such as `nrouter-auto` if exposed

Check:

- advertised model
- actual routability
- provider
- resolved model
- error if route unavailable

### Short agent prompt

```text
Validate representative JS SDK model/routing behavior.
Compare advertised model IDs with live routability.
Test one routing alias if supported.
Classify failures as SDK, routing/configuration or gateway based on evidence.
```

# Manual Dashboard Verification

The coding agent cannot authenticate into the Dashboard. These checks are manual.

Use exact request IDs generated by the agent.

## 12. Request Logs

Open **Request Logs** and search each request ID individually.

Verify:

- request exists
- endpoint
- model
- provider
- success/error
- tokens
- cost
- latency
- cache state

Defect signal:

- request ID missing
- wrong status
- wrong model
- wrong endpoint
- materially wrong token/cost values

## 13. Performance

Select the exact time window covering the controlled batch.

Compare:

- total requests
- successes
- errors
- error rate
- latency

Example:

```text
8 total
5 success
3 error
Expected error rate = 37.5%
```

Defect signal: known 400/404 requests appear in Request Logs but are not included in Performance error counts.

## 14. Advanced Errors

Search:

- invalid-model request ID
- guardrail request ID
- routing-alias failure request ID

Verify:

- HTTP status
- error category
- count
- timestamp
- model/endpoint

## 15. Guardrails

Search the blocked request ID.

Verify:

- guardrail execution exists
- action = blocked
- correct rule/stage where shown
- control request is not incorrectly marked blocked

## 16. Cache

Search the three cache request IDs.

Verify:

- first = MISS
- second = HIT
- third = BYPASS

If Dashboard displays `—` for bypass, inspect the request detail before calling it a bug.

## 17. Cost & Usage

For successful buffered requests compare:

- input tokens
- output tokens
- total tokens
- exact/rounded cost

Small display rounding is legitimate.

Example:

```text
SDK exact cost: $0.0008025
Dashboard: $0.000803
```

This is acceptable rounding.

## 18. Models / Routing

Check:

- model shown
- provider shown
- resolved route where available
- routing alias outcome

If `nrouter-auto` returns 404, classify it as routing/configuration unless SDK behavior itself is incorrect.

# Manual Changes to Make Before Final Submission

Update the final report manually with these items:

1. **Branch** — Ensure report shows `sdk-validation`, not `main`, if that is the actual working branch.
2. **Dashboard status** — Use `PARTIAL — automated access unavailable; manual request-ID reconciliation performed`.
3. **Request Logs** — Mark PASS if controlled success and error IDs are visible.
4. **Performance** — Add actual total/success/error/error-rate values after manual check.
5. **Advanced Errors** — Add exact results for 400/404/routing failures.
6. **Guardrails** — Add Dashboard result for blocked request.
7. **Cache** — Add Dashboard MISS/HIT/BYPASS result.
8. **Billing** — Add one exact cost reconciliation example.
9. **Routing** — Keep `nrouter-auto` classified as routing/configuration unless evidence changes.
10. **R** — Remove R environment notes from the JS-only executive summary.
11. **Repo changes** — If demo/example files moved, say: `No JS SDK core implementation changes were required; example/demo organization and supporting declarations/docs were updated.`

# Final Regression Procedure

If a genuine JS/npm defect is found:

```text
Reproduce
→ identify root cause
→ minimal fix
→ add regression test
→ targeted test
→ full JS suite
→ conformance
→ build
→ npm pack
→ fresh consumer install
→ repeat live test
→ manual Dashboard reconciliation
```

Never fix a gateway/dashboard/provider/configuration problem inside JS SDK code.

# Final Agent Prompt for Daily / Release Validation

```text
Run the complete nRouter JavaScript/npm SDK release validation.

Flow:
1. inspect git/environment
2. run JS build/tests/type checks
3. run conformance
4. validate CJS/ESM/types
5. npm pack and inspect tarball
6. install tarball in fresh external consumer
7. run core live APIs with maxRetries: 0
8. run safe error matrix
9. run cache MISS/HIT/BYPASS
10. run guardrail control/block
11. run routing/model checks
12. output exact request IDs and expected Dashboard values
13. classify every issue as SDK/npm/harness/gateway/dashboard/provider/routing/environment/docs
14. do not push
15. create/update the final Markdown report

Do not claim PASS without executed evidence.
Never print secrets.
```