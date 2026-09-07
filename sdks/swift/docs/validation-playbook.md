# nRouter Swift SDK Validation Playbook

## Goal

Validate the Swift SDK end to end:

**repo → swift test → Package.swift check → fresh consumer → live API → manual dashboard verification → regression**

Keep the process repeatable and evidence-based.

---

## 1. Start from the Correct Branch

```bash
git fetch upstream
git switch sdk-validation
git rebase upstream/main
git status
```

---

## 2. Run the Existing Swift SDK Suite

From root and `sdks/swift`:

```bash
swift test
```

Run repository conformance:

```bash
python3 conformance/check_conformance.py
```

Note: Root `Package.swift` and `sdks/swift/Package.swift` must both pass and not drift.

---

## 3. Validate Public API Surface & Imports

```swift
import NRouter

let client = try NRouter() // Resolves NROUTER_API_KEY
```

Check:
- `NRouter(apiKey: "...")`
- `CustomStringConvertible` / `CustomDebugStringConvertible` redacts API key
- default timeouts (60s connect, 600s read)

---

## 4. Validate Package Manifest

Verify `Package.swift` syntax, target definitions, and platforms (macOS 13+, iOS 16+).

---

## 5. Fresh Consumer Installation

Create a fresh Swift package:

```bash
mkdir -p /tmp/nrouter-swift-consumer
cd /tmp/nrouter-swift-consumer
swift package init --type executable
```

Add local dependency `.package(path: "<path-to-nrouter-sdk>")` and compile.

---

## 6. Live Core API Validation

Run live requests:
1. model discovery
2. chat completion
3. Claude Messages
4. async sequence streaming

Capture:
- `x-nr-request-id`, status, model, tokens, `x-nr-request-cost`, latency, cache, guardrails.

---

## 7. Chatbot-Like Demo

Run demo from `sdks/swift/demo/`:

```bash
swift sdks/swift/demo/quickstart.swift
```

---

## 8. Error Matrix
Test 400, 404, guardrail blocks.
Verify typed `NRouterError`.

---

## 9. Cache Validation
Run 3-request sequence: MISS -> HIT -> BYPASS.

---

## 10. Guardrail Validation
Run control vs blocked request.

---

## 11. Routing / Model Validation
Test advertised models vs live routability.

---

# Manual Dashboard Verification
Reconcile Request Logs, Performance, Advanced Errors, Guardrails, Cache, Cost & Usage, Models.

---

# Final Regression Procedure
Reproduce -> minimal fix -> swift test -> conformance -> fresh consumer test -> manual dashboard check.
