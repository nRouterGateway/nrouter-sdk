# nRouter SDK Validation Playbooks

This directory houses the validation playbook framework for the nRouter SDKs.

## Architecture

Every SDK technology maintains an authoritative, repeatable, evidence-based validation playbook located at:

```
sdks/<technology>/docs/validation-playbook.md
```

The master template defining the standard 18-step verification procedure lives at:

```
docs/validation-playbook-template.md
```

## Supported & Preview Technology Playbooks

1. **JavaScript / TypeScript** (`sdks/js/docs/validation-playbook.md`) — npm, CommonJS, ESM, TypeScript declarations
2. **Python** (`sdks/python/docs/validation-playbook.md`) — PyPI, wheel, pip, pytest, async/sync clients
3. **Java** (`sdks/java/docs/validation-playbook.md`) — Maven Central, jar, pom.xml, OpenAI-Java compatibility
4. **Go** (`sdks/go/docs/validation-playbook.md`) — Go Modules, streaming channels, typed errors
5. **Rust** (`sdks/rust/docs/validation-playbook.md`) — Crates.io, Cargo, Tokio async runtime
6. **Kotlin** (`sdks/kotlin/docs/validation-playbook.md`) — Maven Central, Gradle, Coroutines
7. **Android** (`sdks/android/docs/validation-playbook.md`) — Android AAR, Manifest meta-data, OkHttp client bounds
8. **Swift** (`sdks/swift/docs/validation-playbook.md`) — SwiftPM, async/await, URLSession
9. **Dart / Flutter** (`sdks/dart/docs/validation-playbook.md`) — pub.dev, Dart streams, cross-platform IO
10. **R** (`sdks/r/docs/validation-playbook.md`) — R-universe, CRAN, httr2, S3 classes

## Cross-SDK Parity Contract

When any validation step, gate, or invariant is added or revised:
1. Update `docs/validation-playbook-template.md`.
2. Propagate the corresponding implementation across all 10 `sdks/<tech>/docs/validation-playbook.md` files.
3. Validate using `python3 scripts/check_sdk_parity.py`.
