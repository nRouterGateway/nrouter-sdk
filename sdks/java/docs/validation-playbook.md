# nRouter Maven / Java SDK Validation Playbook

## Goal

Validate the Java SDK end to end:

**repo → tests → maven jar → fresh consumer → live API → manual dashboard verification → regression**

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
- `upstream` points to `nRouterGateway/nrouter-sdk`

### Short agent prompt

```text
Inspect the current repo state for Java SDK validation.
Confirm branch, status, upstream remote, commit SHA, Java version, Maven version and pom.xml version.
Do not modify or push anything.
```

---

## 2. Run the Existing Java SDK Suite

### Manual steps

From `sdks/java`:

```bash
mvn clean compile
mvn test
```

Also run repository conformance:

```bash
python3 ../../conformance/check_conformance.py
```

Record:
- total tests
- passed
- failed
- skipped
- build result

### Short agent prompt

```text
Run the complete existing Java SDK validation from sdks/java.
Use only commands defined by the repo.
Record compile, test and conformance results.
Do not fix anything yet.
```

---

## 3. Validate Public API Surface & Imports

### Manual verification

Confirm Java imports and client creation:

```java
import ai.nrouter.sdk.NRouter;
import ai.nrouter.sdk.NRouterClient;
import ai.nrouter.sdk.exceptions.*;

NRouterClient client = NRouter.builder().build(); // Resolves NROUTER_API_KEY
```

Check:
- `NRouter.builder().apiKey("...").build()`
- default timeout settings (connect: 60s, read: 600s)
- typed exception hierarchy mapping gateway HTTP status and reasons

### Short agent prompt

```text
Validate the Java SDK consumer API surface:
1. Builder pattern and client creation
2. Environment key fallback
3. Exception classes
Report exact results and do not modify source unless a verified defect exists.
```

---

## 4. Validate the Actual Maven Jar

### Manual steps

```bash
mvn clean package -DskipTests
jar -tf target/nrouter-sdk-*.jar
```

Verify jar contains:
- compiled `.class` files under `ai/nrouter/sdk/`
- `pom.xml` and `pom.properties` under `META-INF/`
- `README.md`, `LICENSE`

Verify jar does NOT contain:
- `.env`
- test classes (`target/test-classes`)
- local build logs

### Short agent prompt

```text
Package the Java SDK jar and inspect its contents.
Flag any test or internal artifacts that should not be published.
```

---

## 5. Fresh Consumer Installation

### Manual steps

Create a clean external Maven project:

```bash
mkdir -p /tmp/nrouter-java-consumer
cd /tmp/nrouter-java-consumer
mvn archetype:generate -DgroupId=com.example -DartifactId=consumer -DarchetypeArtifactId=maven-archetype-quickstart -DinteractiveMode=false
```

Install local jar to consumer `pom.xml` or via `mvn install:install-file`.
Verify clean compilation of a basic caller class.

Important: **Do not compile against the source repository.**

### Short agent prompt

```text
Create a fresh temporary Maven consumer project.
Install and depend on the generated nRouter jar.
Compile and verify client instantiation.
Do not use repository-relative paths.
```

---

## 6. Live Core API Validation

Use the installed jar in the fresh consumer.
Set `NROUTER_API_KEY` through environment only.

Test:
1. model discovery
2. chat completion
3. Claude Messages
4. streaming responses
5. error classification

Capture:
- request ID, HTTP status, model, input/output tokens, cost, latency, cache, guardrails.

### Short agent prompt

```text
Using the installed Java jar, run controlled live tests for:
model discovery, chat, Claude Messages and streaming.
Capture request IDs, status, model, tokens, exact cost, latency, cache and guardrail metadata.
Never print the API key.
```

---

## 7. Chatbot-Like Demo

### Manual verification

Run the Java demo from `sdks/java/demo/`:

```bash
javac -cp "../target/*:." sdks/java/demo/quickstart.java
java -cp "../target/*:." sdks.java.demo.quickstart
```

Verify:
- single user message
- multi-turn history
- metadata display
- typed error handling

### Short agent prompt

```text
Run the Java CLI chatbot demo in sdks/java/demo/.
Demonstrate single-turn, multi-turn, metadata and one controlled failure.
```

---

## 8. Error Matrix

Test safe failures:
- invalid request → 400
- invalid model → 404
- guardrail block → 400

Verify:
- typed SDK error class (`BadRequestException`, `NotFoundException`, `GuardrailBlockedException`)
- HTTP status and request ID

### Short agent prompt

```text
Run a controlled Java SDK error matrix.
Prioritize safe 400, 404 and guardrail failures.
Verify typed error class, HTTP status, request ID and message.
```

---

## 9. Cache Validation

Run 3-request sequence: MISS -> HIT -> BYPASS.
Inspect `x-nr-response-cache` metadata.

### Short agent prompt

```text
Run a 3-request cache sequence using the Java SDK:
1. normal request (MISS)
2. identical repeat (HIT)
3. explicit bypass (BYPASS)
```

---

## 10. Guardrail Validation

Run one control request and one blocked request.
Verify typed `GuardrailBlockedException` and metadata.

---

## 11. Routing / Model Validation

Test advertised models vs live routability and verify provider routing.

---

# Manual Dashboard Verification

Use exact request IDs to verify in dashboard:
12. Request Logs
13. Performance
14. Advanced Errors
15. Guardrails
16. Cache
17. Cost & Usage
18. Models / Routing

---

# Final Regression Procedure

```text
Reproduce
→ identify root cause
→ minimal fix
→ add regression test
→ targeted test
→ full Java suite (mvn test)
→ conformance
→ rebuild jar
→ fresh consumer install
→ repeat live test
→ manual Dashboard reconciliation
```

---

# Final Agent Prompt for Daily / Release Validation

```text
Run the complete nRouter Java/Maven SDK release validation.
Flow: git inspection -> mvn compile/test -> conformance -> jar inspection -> fresh consumer -> live API -> error matrix -> cache -> guardrail -> model routing -> dashboard reconciliation.
```
