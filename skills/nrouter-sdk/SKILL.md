---
name: nrouter-sdk
description: Use when changing or adding any SDK wire, endpoint, header, error code, demo, example, validation playbook, README or version and running the conformance gate, when changing error classification, streaming abort/cancellation, secret redaction, retry policy or timeouts, or when adding, running or auditing tests in any of the ten nRouter SDKs (runner commands, offline default, NROUTER_LIVE probe, fake transports).
metadata:
  version: 1.0.0
---

# nRouter SDKs (router)

Ten SDKs, one gateway contract. This router holds the facts every SDK change shares; open the
sub-skill for the kind of change you are making.

## Sub-skills

| Sub-skill | When to open |
|---|---|
| sub-skill `parity` | Any wire, endpoint, header, error code, demo, example, validation playbook, README or version change — the cross-SDK propagation protocol, the synchronization matrix, the README standard, the coordinated version. |
| sub-skill `hardening` | Error classification (and the undocumented 502/504 arms), streaming and abort/cancellation, secret redaction, client retry policy, timeouts. |
| sub-skill `testing` | Adding, changing, running or auditing tests — per-language runner commands, the offline-by-default suite, the `NROUTER_LIVE` billed probe, in-process fakes per ecosystem, what a change must be covered by, what each registry publishes. |

Most changes touch more than one: a new wire is `parity` (all ten SDKs) plus `testing` (a contract
test per SDK); a classification change is `hardening` plus `testing` (a behavioural test per status).

## Shared facts

### The ten SDKs

`js python java go rust kotlin android swift dart r`, each under `sdks/<tech>/`. Derive the list
rather than trusting this sentence: `ls -d sdks/*/ | wc -l`.

### The spec is canonical

`spec/nrouter-sdk-spec.json` is the sole source of truth, derived from the gateway: base URL,
`NROUTER_API_KEY`, the `sk-nrouter-` key prefix, every `x-nr-*` header, the documented error codes
and the coordinated release version. Count the error codes rather than quoting a number — the set
grows:
`python3 -c "import json;print(len(json.load(open('spec/nrouter-sdk-spec.json'))['errors']))"`. When an SDK and the spec disagree, the SDK is wrong. A contract change
is never single-language.

### The conformance gate — the only cross-SDK check, and it needs nothing

```bash
python3 conformance/check_conformance.py --self-test   # prove the gate bites, FIRST
python3 conformance/check_conformance.py               # then run it
```

**Requires Python 3 and nothing else** — no toolchains, no network, no key. That is deliberate: it
greps each SDK's SOURCE TEXT for spec constants rather than importing or compiling it, because a
missing toolchain would otherwise be silently "skipped", and a skip that reads as a pass is the
failure mode the gate exists to prevent.

It enforces the base URL, the `NROUTER_API_KEY` env name, the `sk-nrouter-` key prefix, every
`x-nr-*` header and every gateway error code the spec documents; the route-ownership matrix (every route × every
SDK, each either exposing a native helper or declaring an explicit delegation seam); and the
coordinated release version across all ten distribution manifests plus the JS and Rust lockfiles.
It also drives four sub-gates — doc wires, source defaults, doc header counts, and client timeouts.

**Run `--self-test` before trusting a green run.** A conformance gate that passes while checking
nothing is worse than no gate.

### What the conformance gate cannot see

Reading source text is the right design, but it has consequences the gate's own
`conformance/README.md` states plainly. Do not let the gate stand in for a real test:

1. **It cannot bind an error code to its status.** It proves the full set of codes and the full set
   of statuses each appear *somewhere* in the dispatch. A code wired to the wrong status passes.
2. **It cannot prove a header is used correctly.** It proves the header name is *referenced*. A
   header parsed into the wrong field passes.
3. **By construction, any status outside the spec's documented errors is invisible to the gate.**
   502 and 504 are the live examples. That is where the worst divergence lives (sub-skill
   `hardening`, §1).

**A green conformance run is necessary and never sufficient.** Behaviour needs a behavioural test in
the SDK's own suite (sub-skill `testing`).

### The client retries nothing on a billed path

**Every SDK pins automatic client-side retries to zero on billed calls.** The gateway reserves
credit once per request and owns retry and failover itself; a client-side retry is a second call and
a second bill, with nothing to deduplicate against.

⚠️ **The two SDKs wrapping a vendor client had to OVERRIDE a non-zero vendor default.** If you swap,
upgrade, or reconfigure a vendor client, re-assert the pin and prove it with a test — this is the
one place the default silently comes back.
