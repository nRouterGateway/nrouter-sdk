# nRouter <TECHNOLOGY> SDK Validation Playbook Template

## Goal

Validate the <TECHNOLOGY> SDK end to end:

**repo → tests → package artifact → fresh consumer → live API → manual dashboard verification → regression**

Keep the process repeatable and evidence-based.

---

## 1. Start from the Correct Branch

### Manual steps

```bash
git fetch upstream
git switch <BRANCH_NAME>
git rebase upstream/main
git status
```

Confirm:
- current branch is `<BRANCH_NAME>` (e.g. `sdk-validation` or `main`)
- working tree is clean before starting
- no unrelated SDK changes are mixed in
- `upstream` points to `nRouterGateway/nrouter-sdk`

### Short agent prompt

```text
Inspect the current repo state for <TECHNOLOGY> SDK validation.
Confirm branch, status, upstream remote, current commit, toolchain version, package version.
Do not modify or push anything.
```

---

## 2. Run the Existing <TECHNOLOGY> SDK Suite

### Manual steps

From `sdks/<TECH_DIR>`:

```bash
<BUILD_COMMAND>
<TEST_COMMAND>
```

Also run any existing lint, typecheck, or conformance commands defined in the repository:

```bash
python3 conformance/check_conformance.py
```

Record:
- total tests
- passed
- failed
- skipped
- warnings
- build result

### Short agent prompt

```text
Run the complete existing <TECHNOLOGY> SDK validation from sdks/<TECH_DIR>.
Use only commands defined by the repo.
Record build, test, typecheck, lint and conformance results.
Do not fix anything yet.
```

---

## 3. Validate Public API Surface & Imports

### Manual verification

Verify that standard package imports, typed signatures, and public symbols load cleanly without warnings or runtime syntax issues:

```text
<IMPORT_EXAMPLE>
```

Check:
- client initialization with environment variable `NROUTER_API_KEY`
- client initialization with explicit `api_key` argument
- type definitions and export visibility
- default timeout configuration
- error envelope hierarchy

### Short agent prompt

```text
Validate the <TECHNOLOGY> SDK consumer API surface:
1. Public import and module resolution
2. Client constructor options
3. Exported classes and types
Report exact results and do not modify source unless a verified defect exists.
```

---

## 4. Validate the Actual Package Artifact

### Manual steps

Build the distribution artifact (e.g. tarball, wheel, jar, gem, crate):

```bash
<PACKAGE_BUILD_COMMAND>
```

Inspect the artifact contents.
It should contain only required public package files such as:
- compiled binaries / bytecode / source files
- type definitions / interface definitions
- package metadata (`README.md`, `LICENSE`, manifest)
- approved documentation

It should not contain:
- `.env` or secret keys
- local test cache / logs / coverage reports
- build-time temporary files
- internal test harnesses / unreleased features

### Short agent prompt

```text
Build the distribution artifact for <TECHNOLOGY> SDK.
Inspect every packed file.
Flag internal/dev/test artifacts that should not be published.
Do not change package contents unless the issue is verified.
```

---

## 5. Fresh Consumer Installation

### Manual steps

Create a clean external sandbox project:

```bash
mkdir <CONSUMER_DIR>
cd <CONSUMER_DIR>
<CONSUMER_INIT_COMMAND>
<CONSUMER_INSTALL_COMMAND>
```

Verify that the consumer runs successfully using only the published artifact.

Important: **Do not import from the source repository.**

### Short agent prompt

```text
Create a fresh temporary <TECHNOLOGY> consumer project.
Install only the generated package artifact.
Test client initialization and basic types using the installed package.
Do not use repository-relative imports.
```

---

## 6. Live Core API Validation

Use the installed package in the fresh consumer.
Set `NROUTER_API_KEY` through environment only.

Test:
1. model discovery (`/v1/models`)
2. chat completion (`/v1/chat/completions`)
3. Claude Messages (`/v1/messages`)
4. Responses API (`/v1/responses`)
5. streaming

Capture for every live request:
- request purpose
- request ID (`x-nr-request-id`)
- HTTP status
- model & resolved model
- token counts (input, output, total)
- exact cost (`x-nr-request-cost`)
- latency
- cache state (`x-nr-response-cache`)
- guardrail state (`x-nr-guardrail-*`)
- error class/message if failed

### Short agent prompt

```text
Using the installed package, run controlled live tests for:
model discovery, chat, Claude Messages, Responses and streaming.
Capture request IDs, status, model, tokens, exact cost, latency, cache, guardrail and routing metadata.
Never print the API key.
```

---

## 7. Chatbot-Like Demo

### Manual verification

Run the SDK's demo from `sdks/<TECH_DIR>/demo/`:

Verify:
- single user message
- multi-turn history
- streaming output
- response metadata display
- typed error handling

### Short agent prompt

```text
Execute the minimal CLI chatbot demo in sdks/<TECH_DIR>/demo/.
Demonstrate single-turn, multi-turn, streaming, metadata and one controlled failure.
Do not add unrelated UI or framework dependencies.
```

---

## 8. Error Matrix

Test controlled failures where safe:
- invalid request → 400
- invalid model → 404
- guardrail block → 400

Verify:
- typed SDK error class
- HTTP status
- request ID
- error message
- retry behavior (no retry on non-retryable 4xx)

### Short agent prompt

```text
Run a controlled <TECHNOLOGY> SDK error matrix.
Prioritize safe 400, 404 and guardrail failures.
Verify typed error class, HTTP status, request ID, message and retry behavior.
Do not trigger budget/auth/rate-limit/account-changing tests unless explicitly safe.
```

---

## 9. Cache Validation

Run a 3-request sequence:
1. Request A: normal request → expect `MISS`
2. Request B: identical request → expect `HIT`
3. Request C: same request with cache bypass → expect `BYPASS`

Do not infer cache state from latency. Only use explicit cache headers/metadata.

### Short agent prompt

```text
Run a 3-request cache sequence using the packed <TECHNOLOGY> SDK:
1. normal request
2. identical repeat
3. explicit bypass
Capture request IDs and explicit cache metadata.
Expected: MISS -> HIT -> BYPASS.
Do not infer cache state from latency.
```

---

## 10. Guardrail Validation

Run:
- one allowed/control request
- one request that triggers configured gateway guardrails

Verify:
- HTTP status
- request ID
- typed SDK error
- `pass` / `blocked` metadata

### Short agent prompt

```text
Run one guardrail control request and one controlled gateway-blocked request.
Verify typed SDK guardrail error, request ID and explicit guardrail metadata.
Do not classify a model refusal as gateway enforcement.
```

---

## 11. Routing / Model Validation

Test:
- valid routable model
- routing alias (e.g. `nrouter-auto`) if exposed
- error if route is unavailable

### Short agent prompt

```text
Validate representative <TECHNOLOGY> SDK model/routing behavior.
Compare advertised model IDs with live routability.
Classify failures as SDK, routing/configuration or gateway based on evidence.
```

---

# Manual Dashboard Verification

The coding agent cannot authenticate into the dashboard. These checks are manual using exact request IDs.

## 12. Request Logs
Search each request ID in **Request Logs**:
- status, endpoint, model, provider, tokens, cost, latency, cache state.

## 13. Performance
Select the time window and verify:
- total requests, successes, errors, error rate, latency match observed batch.

## 14. Advanced Errors
Search error request IDs (400/404/routing failures):
- verify category, timestamp, HTTP status.

## 15. Guardrails
Search the blocked request ID:
- action = blocked, correct rule/stage.

## 16. Cache
Search the three cache request IDs:
- MISS, HIT, BYPASS correctly reflected.

## 17. Cost & Usage
For successful requests compare input/output tokens and cost.

## 18. Models / Routing
Verify model shown, provider shown, and resolved route.

---

# Final Regression Procedure

If a genuine defect is found:
```text
Reproduce
→ identify root cause
→ minimal fix
→ add regression test
→ targeted test
→ full SDK suite
→ conformance
→ package rebuild
→ fresh consumer install
→ repeat live test
→ manual Dashboard reconciliation
```

---

# Final Agent Prompt for Release Validation

```text
Run the complete nRouter <TECHNOLOGY> SDK release validation.

Flow:
1. inspect git/environment
2. run SDK build/tests/type checks
3. run conformance
4. validate imports and packaging
5. build package artifact and inspect contents
6. install package artifact in fresh external consumer
7. run core live APIs
8. run safe error matrix
9. run cache MISS/HIT/BYPASS
10. run guardrail control/block
11. run routing/model checks
12. output exact request IDs and expected Dashboard values
13. classify issues accurately
14. do not push
15. create/update the final Markdown report
```
