# nRouter Android SDK Validation Playbook

## Goal

Validate the Android SDK end to end:

**repo → gradle check → AAR artifact → fresh consumer → live API → manual dashboard verification → regression**

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

## 2. Run the Existing Android SDK Suite

From `sdks/android`:

```bash
./gradlew testDebugUnitTest
./gradlew lint
```

Run repository conformance:

```bash
python3 ../../conformance/check_conformance.py
```

---

## 3. Validate Public API Surface & Imports

```kotlin
import ai.nrouter.sdk.android.NRouterAndroid

val client = NRouterAndroid.create(context)
```

Check:
- `AndroidManifest.xml` meta-data reading (`ai.nrouter.sdk.API_KEY`)
- Explicit key constructor `create(context, apiKey)`
- No crashes when `System.getenv` returns null on handset
- Safe OkHttp timeout bounds (default 60s connect, 600s read)

---

## 4. Validate AAR Packaging

```bash
./gradlew bundleReleaseAar
unzip -l build/outputs/aar/nrouter-sdk-android-release.aar
```

Verify AAR contains:
- `classes.jar`
- `AndroidManifest.xml`
- `consumer-rules.pro`

---

## 5. Fresh Consumer Installation

Add AAR to a sample Android project or test suite:

```kotlin
dependencies {
    implementation(files("path/to/nrouter-sdk-android-release.aar"))
}
```

---

## 6. Live Core API Validation

Validate live calls on an emulator or Robolectric test harness.
Never hardcode real API keys into git-committed APKs.

---

## 7. Android Demo Verification

Verify `sdks/android/demo/QuickstartDemo.kt` compiles and runs.

---

## 8. Error Matrix
Verify Android typed errors and HTTP status mapping.

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
