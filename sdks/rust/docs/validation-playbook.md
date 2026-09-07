# nRouter Rust SDK Validation Playbook

## Goal

Validate the Rust SDK end to end:

**repo → cargo test → cargo package → fresh consumer → live API → manual dashboard verification → regression**

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

## 2. Run the Existing Rust SDK Suite

From `sdks/rust`:

```bash
cargo check
cargo test
cargo clippy -- -D warnings
```

Run repository conformance:

```bash
python3 ../../conformance/check_conformance.py
```

---

## 3. Validate Public API Surface & Imports

```rust
use nrouter::{Client, ClientBuilder};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Client::from_env()?;
    Ok(())
}
```

Check:
- `ClientBuilder::new().api_key("...").build()`
- default timeouts (60s connect, 600s read)
- secret redaction (Debug representation never leaks API key)
- typed error enum `nrouter::Error`

---

## 4. Validate Cargo Packaging

```bash
cargo package --allow-dirty --list
```

Verify tarball contains only:
- `src/`
- `Cargo.toml`, `README.md`, `LICENSE`
Does not contain target directories, `.env`, or local logs.

---

## 5. Fresh Consumer Installation

Create a new binary project:

```bash
cargo new /tmp/nrouter-rust-consumer
cd /tmp/nrouter-rust-consumer
# Add local path dependency to Cargo.toml:
# nrouter = { path = "<path-to-sdks/rust>" }
cargo build
```

---

## 6. Live Core API Validation

Run live requests using Tokio runtime:
1. model discovery (`client.models().list()`)
2. chat completion (`client.chat().create()`)
3. Claude Messages
4. streaming chunks

Capture:
- `x-nr-request-id`, status, model, tokens, `x-nr-request-cost`, latency, cache, guardrails.

---

## 7. Chatbot-Like Demo

Run demo from `sdks/rust/demo/`:

```bash
cargo run --example quickstart
```

---

## 8. Error Matrix

Test controlled failures:
- 400 invalid request
- 404 invalid model
- 400 guardrail block

Verify:
- `nrouter::Error::BadRequest`
- `nrouter::Error::NotFound`
- `nrouter::Error::GuardrailBlocked`

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
Reproduce -> minimal fix -> cargo test -> conformance -> fresh consumer test -> manual dashboard check.
