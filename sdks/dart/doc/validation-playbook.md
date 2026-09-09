# nRouter Dart & Flutter SDK Validation Playbook

## Goal

Validate the Dart & Flutter SDK end to end:

**repo → dart test → pub package check → fresh consumer → live API → manual dashboard verification → regression**

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

## 2. Run the Existing Dart SDK Suite

From `sdks/dart`:

```bash
dart pub get
dart test
dart analyze
```

Run repository conformance:

```bash
python3 ../../conformance/check_conformance.py
```

---

## 3. Validate Public API Surface & Imports

```dart
import 'package:nrouter/nrouter.dart';

final client = NRouter(apiKey: 'sk-nrouter-...');
```

Note: Dart client does NOT resolve `NROUTER_API_KEY` from environment automatically because `dart:io` is absent on Flutter Web. An explicit API key is required.

---

## 4. Validate Pub Package

```bash
dart pub publish --dry-run
```

Verify that only `lib/`, `pubspec.yaml`, `README.md`, `CHANGELOG.md`, `LICENSE` are included.

---

## 5. Fresh Consumer Installation

Create clean Dart console project:

```bash
mkdir -p /tmp/nrouter-dart-consumer
cd /tmp/nrouter-dart-consumer
dart create -t console-simple consumer
```

Add path dependency:
```yaml
dependencies:
  nrouter:
    path: <path-to-sdks/dart>
```

---

## 6. Live Core API Validation

Run live requests:
1. model discovery
2. chat completion
3. stream completion

Capture:
- `x-nr-request-id`, status, model, tokens, `x-nr-request-cost`, latency, cache, guardrails.

---

## 7. Chatbot-Like Demo

Run demo from `sdks/dart/demo/`:

```bash
dart run sdks/dart/demo/quickstart.dart
```

---

## 8. Error Matrix
Test 400, 404, guardrail blocks.
Verify typed `NRouterException`.

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
Reproduce -> minimal fix -> dart test -> conformance -> fresh consumer test -> manual dashboard check.
