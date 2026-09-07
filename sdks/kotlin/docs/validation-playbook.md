# nRouter Kotlin SDK Validation Playbook

## Goal

Validate the Kotlin SDK end to end:

**repo → gradle test → jar artifact → fresh consumer → live API → manual dashboard verification → regression**

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

## 2. Run the Existing Kotlin SDK Suite

From `sdks/kotlin`:

```bash
./gradlew check
./gradlew test
```

Run repository conformance:

```bash
python3 ../../conformance/check_conformance.py
```

---

## 3. Validate Public API Surface & Imports

```kotlin
import ai.nrouter.sdk.NRouter

val client = NRouter.create() // Resolves NROUTER_API_KEY
```

Check:
- `NRouter.create(apiKey = "...")`
- Coroutine and Flow streaming helpers
- Typed exception hierarchy

---

## 4. Validate Gradle Packaging

```bash
./gradlew jar
jar -tf build/libs/*.jar
```

Verify jar contains compiled classes, license, metadata.
Verify absence of test classes, `.env`, or build cache.

---

## 5. Fresh Consumer Installation

Create clean Gradle project outside repository and link to local jar:

```bash
mkdir -p /tmp/nrouter-kotlin-consumer
```

---

## 6. Live Core API Validation

Run live requests:
1. model discovery
2. chat completion
3. Claude Messages
4. Flow streaming

Capture:
- `x-nr-request-id`, status, model, tokens, `x-nr-request-cost`, latency, cache, guardrails.

---

## 7. Chatbot-Like Demo

Run demo from `sdks/kotlin/demo/`:

```bash
kotlinc -cp "build/libs/*" sdks/kotlin/demo/quickstart.kt -include-runtime -d quickstart.jar
java -jar quickstart.jar
```

---

## 8. Error Matrix
Test safe 400, 404, guardrail blocks.
Verify typed Kotlin exceptions.

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
Reproduce -> minimal fix -> ./gradlew test -> conformance -> fresh consumer test -> manual dashboard check.
