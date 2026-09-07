---
name: nrouter-sdk-parity
description: Use when ANY SDK wire, endpoint, demo, example, validation playbook, error code, or header is modified or added. Enforces cross-SDK synchronization across all ten nRouter SDKs.
metadata:
  version: 1.0.0
---

# nRouter Cross-SDK Parity

The `nrouter-sdk-parity` skill enforces that all ten nRouter SDKs (`js`, `python`, `java`, `go`, `rust`, `kotlin`, `android`, `swift`, `dart`, `r`) adhere to one synchronized contract.

**When one SDK changes, the entire ecosystem must stay aligned.**

---

## ⛔ The Invariants

1. **Rule #14 — The Spec is Canonical**:
   `spec/nrouter-sdk-spec.json` is the sole source of truth derived from the Rust gateway. When an SDK and the spec disagree, the SDK is wrong. A new endpoint, header, or error mapping is never single-language.
2. **One Coordinated Release Version**:
   All ten SDKs share a single coordinated version (e.g. `3.1.0`). A breaking change in any SDK advances the coordinated version for all ten. Manifests (`package.json`, `pyproject.toml`, `pom.xml`, `Cargo.toml`, `VERSION`, etc.) must never drift.
3. **Demo & Example Parity (`sdks/<tech>/demo/`)**:
   Every SDK owns a `demo/` directory containing runnable examples and a `README.md`. When a new usage pattern (such as token streaming, prompt templates, tool calling, media handling, or spend tracking) is added or modified in one SDK, equivalent runnable demonstrations must be updated across all SDK demo folders.
4. **Validation Playbook Parity (`sdks/<tech>/docs/validation-playbook.md`)**:
   Every SDK maintains an authoritative 18-step validation playbook in `sdks/<tech>/docs/validation-playbook.md` aligned with `docs/validation-playbook-template.md`. Any update to validation steps, error matrices, cache sequences, or dashboard reconciliation procedures must be applied across all ten playbooks.

---

## The Synchronization Matrix

| Area | Master Source of Truth | Target Locations | Verification Command |
|---|---|---|---|
| **Wire & Contract** | `spec/nrouter-sdk-spec.json` | `sdks/*/` source implementations | `python3 conformance/check_conformance.py` |
| **Feature Surface** | `conformance/feature_manifest.json` | Public client methods across all SDKs | `python3 conformance/check_features.py` |
| **Demo Implementations** | `sdks/<tech>/demo/` | All 10 `sdks/<tech>/demo/` folders | `python3 scripts/check_sdk_parity.py` |
| **Validation Playbooks** | `docs/validation-playbook-template.md` | All 10 `sdks/*/docs/validation-playbook.md` | `python3 scripts/check_sdk_parity.py` |
| **Version Alignment** | `spec/nrouter-sdk-spec.json` (`version`) | All 10 SDK manifests & lockfiles | `python3 scripts/check_sdk_parity.py` |

---

## Workflow When Making Changes

Whenever a task touches any SDK feature, demo, or playbook:

1. **Spec & Contract Update**:
   - If updating wire routes, headers, or error mappings, update `spec/nrouter-sdk-spec.json` first.
   - Implement the change in all 10 SDKs (`sdks/{js,python,java,go,rust,kotlin,android,swift,dart,r}`).
2. **Demo Synchronization**:
   - Add or update the runnable sample in `sdks/<tech>/demo/`.
   - Update matching demos in the other SDKs' `demo/` directories.
   - Ensure demo `README.md` files provide clear execution commands.
3. **Playbook Update**:
   - If adding or refining a validation requirement (e.g. a new error scenario or dashboard check), update `docs/validation-playbook-template.md`.
   - Propagate the step to each `sdks/<tech>/docs/validation-playbook.md`.
4. **Parity & Conformance Gate Execution**:
   - Run the automated parity checker:
     ```bash
     python3 scripts/check_sdk_parity.py
     ```
   - Run cross-SDK conformance:
     ```bash
     python3 conformance/check_conformance.py
     python3 conformance/check_conformance.py --self-test
     python3 conformance/check_features.py
     ```
   - Run contract unit tests and end-to-end recording:
     ```bash
     python3 -m unittest discover tests
     bash tests/demo-e2e-record.test.sh
     ```

---

## ⛔ Refuses

The `nrouter-sdk-parity` skill strictly refuses:
- Adding a feature, route, or header to one SDK without updating the remaining nine SDKs and `spec/nrouter-sdk-spec.json`.
- Creating or editing an SDK demo without maintaining `sdks/<tech>/demo/` and its `README.md`.
- Modifying a validation step in one playbook without updating `docs/validation-playbook-template.md` and all sibling playbooks.
- Bumping the version of one SDK manifest independently of the other nine.
- Committing API keys, credentials, or `.env` files into any demo or playbook (Rule #18).
