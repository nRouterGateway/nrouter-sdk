#!/usr/bin/env bash
# README spec parity gate.
#
# spec/nrouter-sdk-spec.json is the contract (Rule #14); the READMEs must not
# drift from it. This gate checks:
#
#   Root README.md
#     - every spec `errors` key appears (as a whole word)
#     - every spec `x-nr-*` response header appears
#     - every stated "<N> codes" / "<N> classed conditions" /
#       "<N> typed errors" count equals the number of spec error codes
#
#   Every discovered sdks/*/README.md
#     - every spec `errors` key appears (as a whole word)
#     - every stated count (same phrases as above) equals the spec count
#
#   Per-SDK READMEs are NOT required to list every x-nr-* header. When this
#   gate was extended no SDK README listed the full header set (the best
#   covered 14 of 25); the documented convention is that the root README's
#   header table is the one complete list and each SDK README documents its
#   own accessor surface. Requiring all headers there would invent a new
#   convention rather than enforce an existing one.
#
# Every failure is reported (the gate never stops at the first), each naming
# the offending file.
#
# Usage:
#   bash tests/readme-spec-parity.test.sh              # check this repo
#   README_PARITY_ROOT=/path bash tests/readme-spec-parity.test.sh
#                                                      # check another root
#   bash tests/readme-spec-parity.test.sh --self-test  # prove the gate itself
#
# Compatible with macOS /bin/bash 3.2: no associative arrays, no mapfile.
set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

run_gate() {
  local root="$1"
  python3 - "$root" <<'PY'
import glob
import json
import os
import re
import sys

root = sys.argv[1]
spec_path = os.path.join(root, "spec", "nrouter-sdk-spec.json")
root_readme = os.path.join(root, "README.md")

failures = []

if not os.path.isfile(spec_path):
    print(f"FAIL: spec file {spec_path} not found", file=sys.stderr)
    sys.exit(1)

with open(spec_path, encoding="utf-8") as f:
    spec = json.load(f)

codes = list(spec.get("errors", {}).keys())
headers = [h for h in spec.get("response_headers", {}).keys() if h.startswith("x-nr-")]
expected = len(codes)

if expected == 0:
    print(f"FAIL: {spec_path} declares no error codes", file=sys.stderr)
    sys.exit(1)

UNITS = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11,
    "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15,
    "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19,
}
TENS = {
    "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50,
    "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90,
}


def to_number(token):
    """Return the integer a count token states, or None if it is not a number."""
    t = token.lower()
    if t.isdigit():
        return int(t)
    if t in UNITS:
        return UNITS[t]
    if t in TENS:
        return TENS[t]
    parts = re.split(r"[-\s]+", t)
    if len(parts) == 2 and parts[0] in TENS and parts[1] in UNITS and 0 < UNITS[parts[1]] < 10:
        return TENS[parts[0]] + UNITS[parts[1]]
    return None


# "<N> codes", "<N> error codes", "<N> gateway error codes",
# "<N> classed conditions", "<N> typed errors", "<N> typed gateway errors".
COUNT_RE = re.compile(
    r"\b((?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\s-]+[A-Za-z]+|[A-Za-z]+-[A-Za-z]+|[A-Za-z]+|\d+)\s+"
    r"(?:(?:gateway\s+)?(?:error\s+)?codes"
    r"|classed\s+conditions?"
    r"|typed\s+(?:gateway\s+)?errors?)\b",
    re.I,
)


def rel(path):
    return os.path.relpath(path, root)


def check_counts(path, text):
    for m in COUNT_RE.finditer(text):
        n = to_number(m.group(1))
        if n is None or n == expected:
            continue
        line = text.count("\n", 0, m.start()) + 1
        failures.append(
            f"{rel(path)}:{line}: stale count '{m.group(0)}' "
            f"(states {n}, spec has {expected} error codes)"
        )


def check_codes(path, text):
    for code in codes:
        if not re.search(r"(?<![A-Za-z0-9_])" + re.escape(code) + r"(?![A-Za-z0-9_])", text):
            failures.append(f"{rel(path)}: error code '{code}' from spec is missing")


def check_headers(path, text):
    for header in headers:
        if not re.search(r"(?<![A-Za-z0-9_-])" + re.escape(header) + r"(?![A-Za-z0-9_-])", text, re.I):
            failures.append(f"{rel(path)}: header '{header}' from spec is missing")


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


# Root README: counts + codes + headers.
if os.path.isfile(root_readme):
    text = read(root_readme)
    check_counts(root_readme, text)
    check_codes(root_readme, text)
    check_headers(root_readme, text)
else:
    failures.append(f"README.md: not found under {root}")

# Optional LANGUAGES.md: check stated counts when the file exists.
languages_md = os.path.join(root, "LANGUAGES.md")
if os.path.isfile(languages_md):
    check_counts(languages_md, read(languages_md))

# Every SDK README: counts + codes (headers deliberately not required; see header).
sdk_readmes = sorted(glob.glob(os.path.join(root, "sdks", "*", "README.md")))
if not sdk_readmes:
    failures.append("sdks/*/README.md: no SDK READMEs discovered (refusing a vacuous pass)")
for path in sdk_readmes:
    text = read(path)
    check_counts(path, text)
    check_codes(path, text)

checked = 1 + len(sdk_readmes)
if failures:
    for line in failures:
        print(f"FAIL: {line}", file=sys.stderr)
    bad_files = sorted({line.split(":", 1)[0] for line in failures})
    print(
        f"README spec parity check: FAILED ({len(failures)} errors in "
        f"{len(bad_files)} of {checked} files: {', '.join(bad_files)})",
        file=sys.stderr,
    )
    sys.exit(1)

print(f"README spec parity check: PASS ({checked} READMEs, {expected} codes, {len(headers)} headers)")
PY
}

# ---------------------------------------------------------------------------
# Self-test: build a fixture root and prove the gate passes and fails as
# intended. Points the gate at the fixture through README_PARITY_ROOT.
# ---------------------------------------------------------------------------

SELF_TEST_DIR=""

cleanup_self_test() {
  if [ -n "$SELF_TEST_DIR" ] && [ -d "$SELF_TEST_DIR" ]; then
    rm -rf "$SELF_TEST_DIR"
  fi
}

# write_fixture <dir> <root-readme-body> <sdk-readme-body>
write_fixture() {
  local dir="$1" root_body="$2" sdk_body="$3"
  rm -rf "$dir"
  mkdir -p "$dir/spec" "$dir/sdks/x"
  cat >"$dir/spec/nrouter-sdk-spec.json" <<'JSON'
{
  "errors": {
    "invalid_api_key": {"status": 401},
    "insufficient_credits": {"status": 402},
    "insufficient_promo_credit": {"status": 402}
  },
  "response_headers": {
    "x-nr-request-id": {},
    "x-nr-request-cost": {},
    "retry-after": {}
  }
}
JSON
  printf '%s\n' "$root_body" >"$dir/README.md"
  printf '%s\n' "$sdk_body" >"$dir/sdks/x/README.md"
}

GOOD_ROOT='# Fixture
Errors: `invalid_api_key`, `insufficient_credits`, `insufficient_promo_credit` (3 codes).
Headers: `x-nr-request-id`, `x-nr-request-cost`.'

GOOD_SDK='# x SDK
The three typed errors: `invalid_api_key`, `insufficient_credits`,
`insufficient_promo_credit`. Read `x-nr-request-id` from the response.'

self_test_failures=0

# expect <name> <want-exit: 0|1> [required output substring...]
expect() {
  local name="$1" want="$2"
  shift 2
  local out rc=0
  out="$(README_PARITY_ROOT="$SELF_TEST_DIR/root" bash "$SCRIPT_PATH" 2>&1)" || rc=$?
  if [ "$want" = "0" ] && [ "$rc" -ne 0 ]; then
    echo "SELF-TEST FAIL [$name]: expected pass, got exit $rc" >&2
    printf '%s\n' "$out" | sed 's/^/    /' >&2
    self_test_failures=$((self_test_failures + 1))
    return 0
  fi
  if [ "$want" != "0" ] && [ "$rc" -eq 0 ]; then
    echo "SELF-TEST FAIL [$name]: expected failure, gate passed" >&2
    printf '%s\n' "$out" | sed 's/^/    /' >&2
    self_test_failures=$((self_test_failures + 1))
    return 0
  fi
  local needle
  for needle in ${1+"$@"}; do
    case "$out" in
      *"$needle"*) ;;
      *)
        echo "SELF-TEST FAIL [$name]: output lacks '$needle'" >&2
        printf '%s\n' "$out" | sed 's/^/    /' >&2
        self_test_failures=$((self_test_failures + 1))
        ;;
    esac
  done
  echo "self-test ok: $name"
}

self_test() {
  SELF_TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/readme-parity-selftest.XXXXXX")"
  trap cleanup_self_test EXIT
  local fx="$SELF_TEST_DIR/root"

  write_fixture "$fx" "$GOOD_ROOT" "$GOOD_SDK"
  expect "good fixture passes (SDK README need not list every header)" 0 "PASS"

  # (a) a spec code missing from an SDK README.
  write_fixture "$fx" "$GOOD_ROOT" '# x SDK
The three typed errors: `invalid_api_key`, `insufficient_credits`.'
  expect "missing code in SDK README fails" 1 \
    "sdks/x/README.md: error code 'insufficient_promo_credit' from spec is missing"

  # A longer code must not satisfy a shorter one (whole-word match).
  write_fixture "$fx" "$GOOD_ROOT" '# x SDK
Three typed errors: `invalid_api_key`, `insufficient_credits_v2`, `insufficient_promo_credit`.'
  expect "substring does not satisfy a code" 1 \
    "sdks/x/README.md: error code 'insufficient_credits' from spec is missing"

  # (b) a stale count in an SDK README (digits and number words).
  write_fixture "$fx" "$GOOD_ROOT" '# x SDK
The two typed errors: `invalid_api_key`, `insufficient_credits`, `insufficient_promo_credit`.'
  expect "stale word count in SDK README fails" 1 \
    "sdks/x/README.md:2: stale count 'two typed errors'"

  write_fixture "$fx" "$GOOD_ROOT" '# x SDK
Maps 2 error codes: `invalid_api_key`, `insufficient_credits`, `insufficient_promo_credit`.'
  expect "stale digit count in SDK README fails" 1 \
    "sdks/x/README.md:2: stale count '2 error codes'"

  # Root README keeps its count + header checks.
  write_fixture "$fx" '# Fixture
Errors: `invalid_api_key`, `insufficient_credits`, `insufficient_promo_credit` (2 classed conditions).
Headers: `x-nr-request-id`.' "$GOOD_SDK"
  expect "root stale count and missing header fail" 1 \
    "README.md:2: stale count '2 classed conditions'" \
    "README.md: header 'x-nr-request-cost' from spec is missing"

  # Every failure is reported, across files, not just the first.
  write_fixture "$fx" '# Fixture
Errors: `invalid_api_key`, `insufficient_credits` (3 codes).
Headers: `x-nr-request-id`, `x-nr-request-cost`.' '# x SDK
Two typed errors: `invalid_api_key`.'
  expect "all failures in all files are reported" 1 \
    "README.md: error code 'insufficient_promo_credit' from spec is missing" \
    "sdks/x/README.md:2: stale count 'Two typed errors'" \
    "sdks/x/README.md: error code 'insufficient_credits' from spec is missing" \
    "sdks/x/README.md: error code 'insufficient_promo_credit' from spec is missing"

  # No SDK READMEs at all is a failure, not a vacuous pass.
  write_fixture "$fx" "$GOOD_ROOT" "$GOOD_SDK"
  rm -f "$fx/sdks/x/README.md"
  expect "no SDK READMEs fails" 1 "no SDK READMEs discovered"

  if [ "$self_test_failures" -gt 0 ]; then
    echo "README spec parity self-test: FAILED ($self_test_failures)" >&2
    exit 1
  fi
  echo "README spec parity self-test: PASS"
}

case "${1:-}" in
  --self-test)
    self_test
    ;;
  "")
    run_gate "${README_PARITY_ROOT:-$REPO_ROOT}"
    ;;
  *)
    echo "usage: $0 [--self-test]" >&2
    exit 2
    ;;
esac
