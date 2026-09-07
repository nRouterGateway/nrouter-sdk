# nRouter R SDK Validation Playbook

## Goal

Validate the R SDK end to end:

**repo → R CMD check → package build → fresh consumer → live API → manual dashboard verification → regression**

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

## 2. Run the Existing R SDK Suite

From `sdks/r`:

```bash
R CMD build .
R CMD check nrouter_*.tar.gz
```

Run repository conformance:

```bash
python3 ../../conformance/check_conformance.py
```

---

## 3. Validate Public API Surface & Imports

```R
library(nrouter)

client <- nrouter_client() # Resolves NROUTER_API_KEY from env
```

Check:
- `nrouter_client(api_key = "...")`
- Print method redacts API key (never prints raw key in console)
- S3 methods and error handling

---

## 4. Validate Package Artifact

Inspect `nrouter_*.tar.gz`:
- `R/`, `man/`, `DESCRIPTION`, `NAMESPACE`, `README.md`, `LICENSE`
- No local `.Rhistory`, `.env`, or test caches included

---

## 5. Fresh Consumer Installation

In a fresh R session:

```R
install.packages("path/to/nrouter_3.1.0.tar.gz", repos = NULL, type = "source")
library(nrouter)
client <- nrouter_client()
```

---

## 6. Live Core API Validation

Run live requests:
1. model discovery (`nrouter_models(client)`)
2. chat completion (`nrouter_chat(client, ...)`)
3. Claude Messages

Capture:
- `x-nr-request-id`, status, model, tokens, `x-nr-request-cost`, latency, cache, guardrails.

---

## 7. Demo Verification

Run demo from `sdks/r/demo/`:

```bash
Rscript sdks/r/demo/quickstart.R
```

---

## 8. Error Matrix
Test 400, 404, guardrail blocks.
Verify typed R error conditions.

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
Reproduce -> minimal fix -> R CMD check -> conformance -> fresh consumer test -> manual dashboard check.
