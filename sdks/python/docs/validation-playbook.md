# nRouter PyPI / Python SDK Validation Playbook

## Goal

Validate the Python SDK end to end:

**repo → tests → wheel package → fresh consumer → live API → manual dashboard verification → regression**

Keep the process repeatable and evidence-based.

---

## 1. Start from the Correct Branch

### Manual steps

```bash
git fetch upstream
git switch sdk-validation
git rebase upstream/main
git status
```

Confirm:
- current branch is `sdk-validation` (or `main`)
- working tree is clean before starting
- no unrelated SDK changes are mixed in
- `upstream` points to `nRouterGateway/nrouter-sdk`

### Short agent prompt

```text
Inspect the current repo state for Python SDK validation.
Confirm branch, status, upstream remote, current commit, Python version and Python package version.
Do not modify or push anything.
```

---

## 2. Run the Existing Python SDK Suite

### Manual steps

From `sdks/python`:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
pytest
python3 -m mypy nroutersdk
```

Also run repository-wide conformance:

```bash
python3 ../../conformance/check_conformance.py
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
Run the complete existing Python SDK validation from sdks/python.
Use only commands defined by the repo.
Record pytest, mypy and conformance results.
Do not fix anything yet.
```

---

## 3. Validate Public API Surface & Imports

### Manual verification

Confirm all of these work:

```python
import nrouter
from nrouter import NRouter, AsyncNRouter
```

Verify client instantiation:

```python
client = NRouter() # Resolves NROUTER_API_KEY from environment
async_client = AsyncNRouter()
```

Check:
- client initialization without arguments
- client initialization with explicit `api_key`
- typing definitions (`py.typed` marker)
- default timeout settings (60s connect, 600s read)
- typed exception classes (`AuthenticationError`, `RateLimitError`, `GuardrailBlockedError`, etc.)

### Short agent prompt

```text
Validate the Python SDK consumer API surface:
1. Synchronous NRouter and asynchronous AsyncNRouter imports
2. Client constructor options
3. Type stubs and py.typed presence
Report exact results and do not modify source unless a verified defect exists.
```

---

## 4. Validate the Actual Wheel Package

### Manual steps

```bash
pip install build
python3 -m build
```

Inspect `dist/`:
- `nrouter_sdk-*.whl`
- `nrouter-sdk-*.tar.gz`

Use `tar -tzf dist/*.tar.gz` and `unzip -l dist/*.whl`.
It should contain only required public package files:
- `nroutersdk/` modules
- `py.typed`
- `README.md`, `LICENSE`, `pyproject.toml`

It should not contain:
- `.env`
- internal test logs or coverage files
- build caches (`__pycache__`, `.pytest_cache`, `.mypy_cache`)

### Short agent prompt

```text
Build the wheel and sdist for Python SDK.
Inspect every packed file.
Flag internal/dev/test artifacts that should not be published.
Do not change package contents unless the issue is verified.
```

---

## 5. Fresh Consumer Installation

### Manual steps

Create a clean external project outside the repository:

```bash
mkdir -p /tmp/nrouter-py-consumer
cd /tmp/nrouter-py-consumer
python3 -m venv .venv
source .venv/bin/activate
pip install <path-to-nrouter-sdk-whl>
```

Run test import and model discovery script:

```python
from nrouter import NRouter
client = NRouter()
print("Initialized successfully")
```

Important: **Do not import from the source repository.**

### Short agent prompt

```text
Create a fresh temporary Python consumer project in a virtualenv.
Install only the generated nRouter wheel.
Test client initialization and types using the installed package.
Do not use repository-relative imports.
```

---

## 6. Live Core API Validation

Use the installed wheel in the fresh consumer.
Set `NROUTER_API_KEY` through environment only.

Test:
1. model discovery (`client.models.list()`)
2. chat completion (`client.chat.completions.create()`)
3. Claude Messages (`client.messages.create()`)
4. streaming completion
5. async client concurrency

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
Using the installed Python wheel, run controlled live tests for:
model discovery, chat, Claude Messages, Responses and streaming.
Capture request IDs, status, model, tokens, exact cost, latency, cache, guardrail and routing metadata.
Never print the API key.
```

---

## 7. Chatbot-Like Demo

### Manual verification

Execute the interactive demo from `sdks/python/demo/`:

```bash
python sdks/python/demo/01_quickstart.py
python sdks/python/demo/03_streaming.py
```

Verify:
- single user message
- multi-turn history
- streaming output
- metadata and cost reporting
- typed error handling

### Short agent prompt

```text
Run the Python CLI chatbot demo in sdks/python/demo/.
Demonstrate single-turn, multi-turn, streaming, metadata and one controlled failure.
Keep it small and presentation-ready.
Do not add unrelated UI or framework dependencies.
```

---

## 8. Error Matrix

Test controlled failures where safe:
- invalid request → 400
- invalid model → 404
- guardrail block → 400

Verify:
- typed SDK error class (`nrouter.BadRequestError`, `nrouter.NotFoundError`, `nrouter.GuardrailBlockedError`)
- HTTP status
- request ID
- message
- retry behavior (no retry on 4xx)

### Short agent prompt

```text
Run a controlled Python SDK error matrix.
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

Do not infer cache state from latency. Only use explicit cache metadata.

### Short agent prompt

```text
Run a 3-request cache sequence using the packed Python SDK:
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
- typed SDK error (`GuardrailBlockedError`)
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
Validate representative Python SDK model/routing behavior.
Compare advertised model IDs with live routability.
Test one routing alias if supported.
Classify failures as SDK, routing/configuration or gateway based on evidence.
```

---

# Manual Dashboard Verification

The coding agent cannot authenticate into the dashboard. These checks are manual using exact request IDs.

## 12. Request Logs
Search each request ID in **Request Logs**:
- verify status, endpoint, model, provider, tokens, cost, latency, cache state.

## 13. Performance
Select the exact time window and verify total requests, successes, errors, and error rate match observed batch.

## 14. Advanced Errors
Search error request IDs (400/404/routing failures):
- verify category, timestamp, HTTP status.

## 15. Guardrails
Search the blocked request ID:
- action = blocked, correct rule/stage.

## 16. Cache
Search the three cache request IDs:
- verify MISS, HIT, BYPASS.

## 17. Cost & Usage
For successful requests compare input/output tokens and cost.

## 18. Models / Routing
Verify model shown, provider shown, and resolved route.

---

# Final Regression Procedure

If a genuine Python SDK defect is found:
```text
Reproduce
→ identify root cause
→ minimal fix
→ add regression test
→ targeted test
→ full Python suite
→ conformance
→ rebuild wheel
→ fresh consumer install
→ repeat live test
→ manual Dashboard reconciliation
```

---

# Final Agent Prompt for Daily / Release Validation

```text
Run the complete nRouter Python/PyPI SDK release validation.

Flow:
1. inspect git/environment
2. run Python build/tests/type checks
3. run conformance
4. validate imports and packaging
5. build wheel and inspect tarball
6. install wheel in fresh external venv
7. run core live APIs
8. run safe error matrix
9. run cache MISS/HIT/BYPASS
10. run guardrail control/block
11. run routing/model checks
12. output exact request IDs and expected Dashboard values
13. classify every issue accurately
14. do not push
15. create/update the final Markdown report
```
