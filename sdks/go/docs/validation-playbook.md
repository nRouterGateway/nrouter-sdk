# nRouter Go SDK Validation Playbook

## Goal

Validate the Go SDK end to end:

**repo → tests → module check → fresh consumer → live API → manual dashboard verification → regression**

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
- current branch is clean
- `upstream` points to `nRouterGateway/nrouter-sdk`
- Go version is `>= 1.21`

---

## 2. Run the Existing Go SDK Suite

### Manual steps

From `sdks/go`:

```bash
go test -v ./...
go vet ./...
```

Run repository conformance:

```bash
python3 ../../conformance/check_conformance.py
```

---

## 3. Validate Public API Surface & Imports

### Manual verification

```go
import "github.com/nRouterGateway/nrouter-sdk/sdks/go/v3"

client, err := nrouter.NewClient() // Resolves NROUTER_API_KEY
```

Check:
- `nrouter.NewClient(nrouter.WithAPIKey("..."))`
- default timeouts (60s connect, 600s read)
- typed error classification via `errors.As`

---

## 4. Validate Module Packaging

### Manual steps

```bash
go mod tidy
go mod verify
```

Ensure no untracked dependencies or incorrect module paths exist.

---

## 5. Fresh Consumer Installation

### Manual steps

Create external module outside repository:

```bash
mkdir -p /tmp/nrouter-go-consumer
cd /tmp/nrouter-go-consumer
go mod init consumer
go mod edit -replace github.com/nRouterGateway/nrouter-sdk/sdks/go/v3=<path-to-sdks/go>
```

Compile a standalone caller:

```go
package main
import (
    "context"
    "fmt"
    "github.com/nRouterGateway/nrouter-sdk/sdks/go/v3"
)
func main() {
    client, _ := nrouter.NewClient()
    fmt.Println("Go client initialized")
}
```

---

## 6. Live Core API Validation

Run live requests from fresh consumer:
1. model discovery
2. chat completion
3. Claude Messages
4. stream completion with channels

Capture:
- `x-nr-request-id`, status, model, tokens, `x-nr-request-cost`, latency, cache, guardrails.

---

## 7. Chatbot-Like Demo

Run demo from `sdks/go/demo/`:

```bash
go run sdks/go/demo/quickstart.go
go run sdks/go/demo/stream/stream_example.go
```

Verify single-turn, streaming, and metadata.

---

## 8. Error Matrix

Test controlled failures:
- 400 invalid request
- 404 invalid model
- 400 guardrail block

Verify typed Go error types:
- `*nrouter.BadRequestError`
- `*nrouter.NotFoundError`
- `*nrouter.GuardrailBlockedError`

---

## 9. Cache Validation
Run 3-request sequence: MISS -> HIT -> BYPASS.

---

## 10. Guardrail Validation
Run control vs blocked request.

---

## 11. Routing / Model Validation
Verify advertised model IDs against gateway routing.

---

# Manual Dashboard Verification
Reconcile Request Logs, Performance, Advanced Errors, Guardrails, Cache, Cost & Usage, Models.

---

# Final Regression Procedure
Reproduce -> minimal fix -> test in Go -> conformance -> fresh consumer test -> manual dashboard check.
