# CLAUDE.md — nrouter-sdk

Public repository (`github.com/nRouterGateway/nrouter-sdk`). Never commit secrets, keys, or internal endpoints.
Skills: `nrouter-sdk`, `deploy-nrouter-sdk` (`/deploy-nrouter-sdk`).

## Architecture & Contract (Rule #14)
- **Ten client SDKs (`sdks/`):** JS/TS, Python, Java, Kotlin, Android, Go, Rust, Swift, Dart, and R speak one wire contract (`api.nrouter.ai/v1/*`).
- **Canonical spec:** `spec/nrouter-sdk-spec.json` is authoritative for routes, headers (`x-nr-*`), and errors. Disagreement means the SDK is wrong.
- **Invariants:** `x-nr-request-cost` absent when unpriced (never zero, Rule #28); API keys redacted in logs; coordinated version releases.

## Commands
```bash
python3 conformance/check_conformance.py [--self-test]   # verify all SDKs against spec
python3 scripts/check_sdk_parity.py                     # playbooks and manifests parity
scripts/test-all.sh                                     # run test suites across all SDKs
```


<!-- BEGIN GENERATED: permanent-rules-pointer (bootstrap.sh) -->
## The Permanent Rules — for Codex, Gemini CLI and Antigravity
Read in order before editing (`00-permanent-rules.md` is authority for all the rules):
- `~/nr/nrouter-brain/sdlc/rules/00-permanent-rules.md`
- `~/nr/nrouter-brain/sdlc/rules/00-workspace-repos.md`
- `~/nr/nrouter-brain/sdlc/rules/10-testing.md`
- `~/nr/nrouter-brain/sdlc/rules/19-soc2-new-feature-checklist.md`
- `~/nr/nrouter-brain/sdlc/rules/20-tdd-and-fleet.md`
- `~/nr/nrouter-brain/nrouter-app/rules/02-multi-tenancy.md`
- `~/nr/nrouter-brain/nrouter-app/rules/03-credit-safety.md`
- `~/nr/nrouter-brain/nrouter-app/rules/05-frontend-standards.md`
- `~/nr/nrouter-brain/nrouter-app/rules/07-stripe-integration.md`
- `~/nr/nrouter-brain/nrouter-app/rules/11-api-routes.md`
- `~/nr/nrouter-brain/nrouter-app/rules/13-enterprise-features.md`
- `~/nr/nrouter-brain/nrouter-app/rules/17-virtual-keys.md`
- `~/nr/nrouter-brain/nrouter-app/rules/30-email-templates.md`
- `~/nr/nrouter-brain/nrouter-cortex/rules/00-cortex-rules.md`
- `~/nr/nrouter-brain/nrouter-frontend-ui/rules/40-image-blog-standards.md`
- `~/nr/nrouter-brain/nrouter-frontend-ui/rules/41-seo-geo-aeo-page-checklist.md`
- `~/nr/nrouter-brain/nrouter-frontend-ui/rules/42-homepage-design.md`
- `~/nr/nrouter-brain/nrouter-infra-cicd/rules/08-database.md`
- `~/nr/nrouter-brain/nrouter-infra-cicd/rules/15-startup-health.md`
- `~/nr/nrouter-brain/nrouter-infra-cicd/rules/16-infrastructure.md`
- `~/nr/nrouter-brain/nrouter-rust-gateway/rules/00-gateway-rules.md`
- `~/nr/nrouter-brain/nrouter-rust-gateway/rules/01-provider-contract.md`
<!-- END GENERATED: permanent-rules-pointer -->
