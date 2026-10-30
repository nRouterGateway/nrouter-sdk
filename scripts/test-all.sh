#!/usr/bin/env bash
# One local release gate for the ten SDKs, run as INDEPENDENT LANES.
#
# Live tests remain opt-in because they spend credits; set NROUTER_LIVE=1 only
# with a local/stage gateway and a key.
#
#   scripts/test-all.sh                     # run every lane the machine can run
#   NROUTER_REQUIRE_ALL=1 scripts/test-all.sh   # a skipped lane is also a failure
#   scripts/test-all.sh --self-test         # prove the engine's own honesty
#
# ---------------------------------------------------------------------------
# WHY LANES, AND WHY THE EXIT CODE IS THE POINT
# ---------------------------------------------------------------------------
#
# This script used to be one `set -e` straight line behind an all-or-nothing
# preflight: `need` exited 78 on the FIRST tool it could not find, so a machine
# without Dart learned nothing about its Go, Rust or Python SDKs. One absent
# toolchain blocked all ten lanes.
#
# It also invoked the Python suites while installing nothing, so on a clean
# checkout `tests/test_sdk_contract.py` died in COLLECTION at
# `ModuleNotFoundError: httpx2` — three steps after conformance and the security
# audit had already printed green. Every spec assertion in that module was a
# DEAD GATE, and it read like a test failure rather than a missing dependency.
#
# The contract now:
#
#   PASSED   the lane ran and its commands succeeded
#   FAILED   the lane ran and something in it returned non-zero  -> EXIT 1
#   SKIPPED  a prerequisite is absent, so the lane never executed -> named, loud,
#            and NEVER counted as a pass
#
# A skip does not fail the run by default, because blocking nine working lanes on
# one absent compiler is the defect this rewrite removes. `NROUTER_REQUIRE_ALL=1`
# is the release posture: there, a lane that did not run is not evidence.
#
# ---------------------------------------------------------------------------
# THE TRAP THIS FILE EXISTS TO AVOID: A GATE THAT EXITS 0 WITHOUT RUNNING
# ---------------------------------------------------------------------------
#
# MEASURED on this machine's /bin/bash 3.2.57, which is the shell that matters:
#
#     f() { echo one; false; echo TWO; }
#     rc=0; ( set -e; f ) || rc=$?     # prints TWO, and rc is 0
#     if ( set -e; f ); then ... fi    # prints TWO, and takes the THEN branch
#
# POSIX disables errexit inside any compound command whose status is being
# TESTED — the left side of `||`, an `if` condition, a `&&` chain. So the two
# obvious ways to run a lane and capture its result are exactly the two ways to
# make a failing lane report success. That is not theoretical: this workspace
# already ships a runner that prints "1 of 3 lanes FAILED" and exits 0, so
# anything gating on it is not gated.
#
# The fix here is that a lane body runs in a SEPARATE `bash -c` PROCESS with its
# own `set -euo pipefail`, and its status is captured on the FOLLOWING line
# rather than in a condition. A child process always honours its own errexit;
# the suppression rule cannot reach across the fork. Lane bodies are ALSO
# `&&`-chained, so the lane still fails correctly even if someone later
# reintroduces a subshell. Both belts are deliberate; do not remove either.
#
# `run_lane` therefore ALWAYS returns 0 and records into counters. The only
# thing that decides this script's exit status is `summary`.
#
# Regression gate: `scripts/test-all.sh --self-test` drives THESE functions with
# a synthetic pass, a synthetic failure and a synthetic missing prerequisite,
# and asserts both the counts and the exit code. It shares the engine with the
# real run, so it cannot drift from it.
#
# ---------------------------------------------------------------------------
# DISCOVERED LANES: NOTHING IN tests/ OR agents/ CAN BE SILENTLY OMITTED
# ---------------------------------------------------------------------------
#
# The repo-level gate list used to be hand-maintained, and it drifted:
# tests/readme-spec-parity.test.sh went red and nothing here ran it, so nobody
# noticed. Two kinds of lane are therefore DISCOVERED, never listed:
#
#   repo gates   every tests/*.test.sh, tests/test_*.py and conformance/test_*.py
#                that no explicit lane above already runs gets ONE lane of its
#                own. "Already runs" is derived from the bodies of the lanes
#                that actually executed (LANE_BODIES), not from a second list,
#                so a gate is never run twice and never dropped. Shell gates
#                need only bash. tests/test_*.py gates carry the same
#                prerequisites as the repository contract lane (PY_GATE_REQS);
#                conformance/test_*.py gates need an interpreter with pytest.
#   agents       one lane per agents/*/package.json:
#                `npm ci && npm run typecheck && npm test && npm run build`.
#                Prerequisite: npm.
#
# Python interpreter resolution, in order: PYTHON_BIN if set; else a repo-local
# prepared venv ($ROOT/.venv/bin/python, then $ROOT/sdks/python/.venv/bin/python);
# else python3.13; else python3. The script never creates a venv and never
# installs anything — an interpreter missing a prerequisite still SKIPS by name.

set -uo pipefail
# NOTE: deliberately no `-e`. This driver's whole job is to continue past a
# failing lane. Errexit belongs INSIDE each lane, and each lane gets a real one.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ROOT

REQUIRE_ALL="${NROUTER_REQUIRE_ALL:-0}"

PASSED=0
FAILED=0
SKIPPED=0
# Newline-delimited strings, NOT arrays: under `set -u`, bash 3.2 treats
# "${EMPTY[@]}" as an unbound variable and aborts the script. Measured, not
# assumed. A report that kills the reporter is worse than no report.
FAILED_LANES=""
SKIPPED_LANES=""
# Every body handed to run_lane, run or skipped. Discovery reads it to decide
# which repo gates an explicit lane already owns — see run_discovered_gates.
LANE_BODIES=""

step() { printf '\n== %s ==\n' "$1"; }

# ---------------------------------------------------------------------------
# Prerequisite probes
# ---------------------------------------------------------------------------

# `have <requirement>` — true when the lane can run.
#
#   python       PYTHON_BIN resolved to a usable interpreter
#   py:<module>  the module imports under $PYTHON_BIN
#   pyfloor:<d>  <d> is installed AND satisfies its floor in sdks/python/pyproject.toml
#   pysdk        `nroutersdk` imports AND resolves to THIS checkout
#   jre          a Java runtime that actually starts
#   android      the Android SDK was located during preflight
#   <name>       an executable on PATH
have() {
  case "$1" in
    python)
      [ -n "${PYTHON_BIN:-}" ] && [ -x "$PYTHON_BIN" ]
      ;;
    py:*)
      [ -n "${PYTHON_BIN:-}" ] || return 1
      "$PYTHON_BIN" -c "import ${1#py:}" >/dev/null 2>&1
      ;;
    pyfloor:*)
      # SDKGATE-001. `py:openai` asks only "does it import". It does — an
      # openai from two years ago imports perfectly. What it CANNOT do is
      # satisfy this SDK's declared floor, and the failure that produces is
      # nine `TypeError: Invalid \`http_client\` argument; Expected an instance
      # of \`httpx.Client\` but got <class 'httpx2.Client'>` deep inside the
      # contract suite. That error names neither the package nor the floor, so
      # it reads as sabotage or as a typo in the dependency — an earlier
      # session mistook `httpx2` for exactly that and reverted a peer's correct
      # import. OpenAI 3.6 moved its transport boundary to the separately
      # named `httpx2` distribution, so the two are a matched pair and an
      # under-floor openai mismatches the transport this SDK passes it.
      #
      # Compare against the floor in `sdks/python/pyproject.toml` rather than a
      # literal here: a second copy of the version is the drift this file
      # exists to catch elsewhere.
      [ -n "${PYTHON_BIN:-}" ] || return 1
      "$PYTHON_BIN" - "${1#pyfloor:}" "$ROOT/sdks/python/pyproject.toml" <<'PYFLOOR'
import re, sys

dist, pyproject = sys.argv[1], sys.argv[2]

# PEP 440 ordering, not a hand-rolled tuple compare. BOTH reviewer families
# independently killed the hand-rolled version: `[int(x) for x in
# re.findall(r"\d+", v)[:3]]` gets two things wrong that matter here.
#   * `3.6.0rc1` and `3.6.0` both reduce to [3, 6, 0], so a PRERELEASE — which
#     is semantically BELOW the floor — satisfied it, and the incompatible lane
#     ran anyway. That is the whole failure this prerequisite exists to stop.
#   * a shorter tuple sorts below a longer one, so installed "1.26" read as
#     less than floor "1.26.0" and skipped a lane that was fine.
# `packaging` is not stdlib, so its absence makes this prerequisite
# UNSATISFIED rather than silently true: an unverifiable floor must skip the
# lane by name, never wave it through.
try:
    from packaging.version import InvalidVersion, Version
except ImportError:
    sys.exit(1)

try:
    from importlib.metadata import PackageNotFoundError, version
    installed = version(dist)
except Exception:
    sys.exit(1)

try:
    text = open(pyproject, encoding="utf-8").read()
except OSError:
    sys.exit(1)

m = re.search(rf'"{re.escape(dist)}>=([^,"]+)', text)
if not m:
    # No declared floor is not "any version is fine" — it means this check
    # cannot answer, so it declines instead of passing.
    sys.exit(1)

try:
    sys.exit(0 if Version(installed) >= Version(m.group(1).strip()) else 1)
except InvalidVersion:
    sys.exit(1)
PYFLOOR
      ;;
    pysdk)
      # IDENTITY, not merely presence. A previously released `nrouter-sdk` from
      # PyPI imports perfectly and is not this checkout, so the contract tests
      # would compare the spec against a version nobody is editing — green, and
      # measuring the wrong tree.
      [ -n "${PYTHON_BIN:-}" ] || return 1
      local at
      at="$("$PYTHON_BIN" -c 'import nroutersdk,os;print(os.path.dirname(os.path.dirname(os.path.abspath(nroutersdk.__file__))))' 2>/dev/null)" || return 1
      [ "$at" = "$ROOT/sdks/python" ]
      ;;
    jre)
      # `command -v java` is a FALSE POSITIVE on macOS: /usr/bin/java is a stub
      # that exists with no JDK installed and answers "Unable to locate a Java
      # Runtime". Measured on this machine. Start it instead.
      if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java" ]; then
        "$JAVA_HOME/bin/java" -version >/dev/null 2>&1
      else
        command -v java >/dev/null 2>&1 && java -version >/dev/null 2>&1
      fi
      ;;
    android)
      [ -n "${ANDROID_HOME:-}" ]
      ;;
    *)
      command -v "$1" >/dev/null 2>&1
      ;;
  esac
}

# ---------------------------------------------------------------------------
# The lane engine
# ---------------------------------------------------------------------------

# run_lane <name> <requirements|-> <body>
#
# Always returns 0. It records; `summary` judges.
run_lane() {
  local name="$1" reqs="$2" body="$3"
  local req missing=""

  # Recorded BEFORE the prerequisite check: a gate inside a skipped lane is
  # still owned by that lane (and reported as skipped by name), so discovery
  # must not run it a second time under a different lane.
  LANE_BODIES="${LANE_BODIES}${body}
"

  if [ "$reqs" != "-" ]; then
    for req in $reqs; do
      have "$req" || missing="$missing $req"
    done
  fi

  if [ -n "$missing" ]; then
    SKIPPED=$((SKIPPED + 1))
    SKIPPED_LANES="${SKIPPED_LANES}${name}|missing:${missing}
"
    printf '\n== %s ==\n' "$name"
    printf 'SKIPPED: prerequisite absent —%s\n' "$missing"
    printf '         This lane did NOT run. It is not a pass.\n'
    return 0
  fi

  printf '\n== %s ==\n' "$name"
  local status
  # The fork is load-bearing — see the header. `set -e` inside a child process
  # is honoured no matter what context the parent captured it from, and the
  # status is read on the NEXT line, never inside a condition.
  bash -c "set -euo pipefail; $body"
  status=$?

  if [ "$status" -eq 0 ]; then
    PASSED=$((PASSED + 1))
    printf '\nPASSED: %s\n' "$name"
  else
    FAILED=$((FAILED + 1))
    FAILED_LANES="${FAILED_LANES}${name}|exit ${status}
"
    printf '\nFAILED: %s (exit %s)\n' "$name" "$status"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Discovered lanes — see "DISCOVERED LANES" in the header
# ---------------------------------------------------------------------------

# The prerequisites of the repository contract lane, shared with every
# discovered tests/test_*.py gate: a new gate there may import the SDK, httpx2,
# openai or yaml exactly as its neighbours do, and must SKIP by name rather
# than die in collection when they are absent.
PY_GATE_REQS="pysdk py:httpx2 py:openai pyfloor:openai py:pytest py:yaml git"

# resolve_python <root>
#
# Python interpreter resolution, in order: PYTHON_BIN if set and executable;
# else a repo-local prepared venv ($root/.venv/bin/python, then
# $root/sdks/python/.venv/bin/python); else python3.13; else python3.
resolve_python() {
  local root="$1"
  if [ -n "${PYTHON_BIN:-}" ] && [ -x "$PYTHON_BIN" ]; then
    printf '%s\n' "$PYTHON_BIN"
    return 0
  fi
  if [ -x "$root/.venv/bin/python" ]; then
    printf '%s\n' "$root/.venv/bin/python"
  elif [ -x "$root/sdks/python/.venv/bin/python" ]; then
    printf '%s\n' "$root/sdks/python/.venv/bin/python"
  elif command -v python3.13 >/dev/null 2>&1; then
    command -v python3.13
  else
    command -v python3 2>/dev/null || true
  fi
}

# discover_gates <root> <owned-bodies>
#
# Prints, one repo-relative path per line, every tests/*.test.sh,
# tests/test_*.py and conformance/test_*.py under <root> that <owned-bodies>
# (the text of the lane bodies already handed to run_lane) does not mention.
# A mention counts only after a path boundary — `/`, a space or a quote — so
# `tests/a.test.sh` is not mistaken for part of some longer path.
discover_gates() {
  local root="$1" owned="$2" f rel
  for f in "$root"/tests/*.test.sh "$root"/tests/test_*.py "$root"/conformance/test_*.py; do
    # An unmatched glob stays literal; it is not a gate.
    [ -f "$f" ] || continue
    rel="${f#"$root"/}"
    case "$owned" in
      *"/$rel"* | *" $rel"* | *"'$rel"* | *"\"$rel"*) continue ;;
    esac
    printf '%s\n' "$rel"
  done
}

# run_discovered_gates <root> <owned-bodies> — one lane per discovered gate.
run_discovered_gates() {
  local root="$1" owned="$2" rel
  # The list is read on fd 3, NOT stdin: each lane's `bash -c` inherits stdin,
  # and a gate that reads it would silently swallow the remaining gate names.
  while IFS= read -r rel <&3; do
    [ -n "$rel" ] || continue
    case "$rel" in
      *.test.sh)
        run_lane "repo gate: $rel" "-" \
          "cd '$root' && bash '$root/$rel'"
        ;;
      conformance/*)
        run_lane "repo gate: $rel" "python py:pytest" \
          "cd '$root' && '$PYTHON_BIN' -m pytest -q '$rel'"
        ;;
      *)
        run_lane "repo gate: $rel" "$PY_GATE_REQS" \
          "cd '$root' && '$PYTHON_BIN' -m pytest -q '$rel'"
        ;;
    esac
  done 3<<GATES
$(discover_gates "$root" "$owned")
GATES
}

# run_agent_lanes <root> — one lane per agents/*/package.json. A package with
# no lockfile FAILS at `npm ci`, which is the honest verdict: it cannot be
# installed reproducibly.
run_agent_lanes() {
  local root="$1" manifest dir
  for manifest in "$root"/agents/*/package.json; do
    [ -f "$manifest" ] || continue
    dir="${manifest%/package.json}"
    run_lane "agent: ${dir#"$root"/}" "npm" \
      "cd '$dir' && npm ci && npm run typecheck && npm test && npm run build"
  done
}

# summary — prints the verdict and RETURNS the script's exit status.
summary() {
  local total=$((PASSED + FAILED + SKIPPED))
  printf '\n=====================================================\n'
  printf 'SDK release gate — %s lanes\n' "$total"
  printf '=====================================================\n'
  printf '  PASSED   %s\n' "$PASSED"
  printf '  FAILED   %s\n' "$FAILED"
  printf '  SKIPPED  %s   (prerequisite absent — NOT a pass)\n' "$SKIPPED"

  if [ -n "$FAILED_LANES" ]; then
    printf '\nFAILED lanes:\n'
    printf '%s' "$FAILED_LANES" | while IFS='|' read -r n why; do
      [ -n "$n" ] && printf '  - %-28s %s\n' "$n" "$why"
    done
  fi

  if [ -n "$SKIPPED_LANES" ]; then
    printf '\nSKIPPED lanes (never executed):\n'
    printf '%s' "$SKIPPED_LANES" | while IFS='|' read -r n why; do
      [ -n "$n" ] && printf '  - %-28s %s\n' "$n" "$why"
    done
    # SDKCI-004. The hint below is Python-only, so a semgrep skip used to be
    # answered with `pip install -e sdks/python[dev]` — advice that does not
    # install semgrep and sends the reader somewhere useless. The SAST lane is
    # the local stand-in for hosted CodeQL analysis, so name its remedy
    # specifically rather than letting it inherit the generic one.
    case "$SKIPPED_LANES" in
      *semgrep*)
        printf '\nThe first-party SAST lane did not run. It mirrors the CodeQL gate that\n'
        printf 'stands in for hosted CodeQL analysis, so nothing scanned this\n'
        printf 'code. Install semgrep:\n'
        printf '  brew install semgrep            # macOS\n'
        printf '  python3 -m pip install --user semgrep\n'
        ;;
    esac
    printf '\nPython prerequisites, including the SDK itself, install in one step:\n'
    printf "  %s -m pip install -e '%s/sdks/python[dev]'\n" "${PYTHON_BIN:-python3}" "$ROOT"
    printf '\nOr without touching that interpreter:\n'
    printf '  python3 -m venv .venv && . .venv/bin/activate \\\n'
    printf "    && pip install -e 'sdks/python[dev]' \\\\\n"
    printf '    && PYTHON_BIN=$(command -v python) scripts/test-all.sh\n'
  fi

  if [ "$FAILED" -ne 0 ]; then
    printf '\nRESULT: FAILED — %s lane(s) returned non-zero.\n' "$FAILED"
    return 1
  fi
  if [ "$SKIPPED" -ne 0 ] && [ "$REQUIRE_ALL" = "1" ]; then
    printf '\nRESULT: INCOMPLETE — NROUTER_REQUIRE_ALL=1 and %s lane(s) never ran.\n' "$SKIPPED"
    return 1
  fi
  if [ "$SKIPPED" -ne 0 ]; then
    printf '\nRESULT: PASSED with %s lane(s) SKIPPED — this is NOT full release\n' "$SKIPPED"
    printf '        evidence. Re-run with NROUTER_REQUIRE_ALL=1 to require them.\n'
    return 0
  fi
  printf '\nRESULT: PASSED — all %s lanes ran and succeeded.\n' "$PASSED"
  return 0
}

# ---------------------------------------------------------------------------
# --self-test: mutation-proof the engine, using the engine
# ---------------------------------------------------------------------------
#
# Three synthetic lanes exercise the three outcomes, then the counters and the
# exit status of `summary` are asserted. If someone reintroduces the
# errexit-suppression bug, or makes a skip count as a pass, this goes red.
# Synthetic temp trees then prove the discovered lanes: a new tests/*.test.sh
# is found and run, a failing one fails the run, an owned gate is not run
# twice, and an agent whose `npm test` fails is FAILED and never built.
self_test() {
  local fails=0
  assert_eq() {
    if [ "$2" = "$3" ]; then
      printf '  ok   %s = %s\n' "$1" "$2"
    else
      printf '  FAIL %s: expected %s, got %s\n' "$1" "$3" "$2"
      fails=$((fails + 1))
    fi
  }

  local scratch_floor_root scratch_floor scratch_lanes
  scratch_floor_root="$(mktemp -d "${TMPDIR:-/tmp}/nrouter-testall-floor.XXXXXX")"
  scratch_floor="$scratch_floor_root/sdks/python"
  # Synthetic trees for the discovery and agents controls. Never the real tree.
  scratch_lanes="$(mktemp -d "${TMPDIR:-/tmp}/nrouter-testall-lanes.XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -rf '$scratch_floor_root' '$scratch_lanes'" RETURN

  printf '== engine self-test ==\n'

  run_lane "synthetic-pass" "-" "true && true" >/dev/null 2>&1
  # A body whose FIRST command fails and which then does more work: this is the
  # exact shape that reports success under `( set -e; ... ) || rc=$?`.
  run_lane "synthetic-fail" "-" "false && echo unreachable" >/dev/null 2>&1
  run_lane "synthetic-fail-midway" "-" "true && false && true" >/dev/null 2>&1
  run_lane "synthetic-skip" "definitely-not-a-real-tool-xyzzy" "true" >/dev/null 2>&1

  # SDKGATE-001: an unsatisfiable floor SKIPS the lane by name instead of
  # letting it run and produce nine unattributable TypeErrors.
  run_lane "synthetic-floor" "pyfloor:definitely-not-installed-xyzzy" "true" >/dev/null 2>&1

  # ...and the POSITIVE control, which both reviewers required: without it a
  # `pyfloor:*` branch broken to always `return 1` still printed ok here while
  # skipping every real lane and running zero contract tests. `pip` is a floor
  # this interpreter satisfies by construction, so the fixture needs no
  # network and no install.
  local floor_fixture="$scratch_floor/pyproject.toml"
  mkdir -p "$scratch_floor"
  local floor_py="${PYTHON_BIN:-$(resolve_python "$ROOT")}"
  local floor_dist="pip"
  if [ -n "$floor_py" ] && [ -x "$floor_py" ]; then
    floor_dist="$("$floor_py" -c '
try:
    import importlib.metadata
    dists = [d.metadata["Name"] for d in importlib.metadata.distributions() if d.metadata.get("Name")]
    if "packaging" in dists:
        print("packaging")
    elif "pip" in dists:
        print("pip")
    elif dists:
        print(dists[0])
    else:
        print("pip")
except Exception:
    print("pip")
' 2>/dev/null || echo "pip")"
  fi
  printf 'dependencies = [\n  "%s>=0.1",\n]\n' "$floor_dist" > "$floor_fixture"
  if PYTHON_BIN="$floor_py" ROOT="$scratch_floor_root" have "pyfloor:$floor_dist"; then
    printf '  ok   a SATISFIED floor passes the prerequisite\n'
  else
    printf '  FAIL a satisfied floor was reported unsatisfied — the branch may be broken shut\n'
    fails=$((fails + 1))
  fi

  # And an UNDER-floor version must not pass, which the missing-distribution
  # case cannot prove: it never reaches the comparison at all.
  printf 'dependencies = [\n  "%s>=99999.0",\n]\n' "$floor_dist" > "$floor_fixture"
  if PYTHON_BIN="$floor_py" ROOT="$scratch_floor_root" have "pyfloor:$floor_dist"; then
    printf '  FAIL an under-floor version satisfied the prerequisite\n'
    fails=$((fails + 1))
  else
    printf '  ok   an UNDER-floor version fails the prerequisite\n'
  fi

  assert_eq "PASSED" "$PASSED" "1"
  assert_eq "FAILED" "$FAILED" "2"
  assert_eq "SKIPPED" "$SKIPPED" "2"

  case "$SKIPPED_LANES" in
    *synthetic-floor*) printf '  ok   under-floor dependency skips the lane BY NAME\n' ;;
    *) printf '  FAIL under-floor dependency did not name its lane\n'; fails=$((fails + 1)) ;;
  esac

  case "$FAILED_LANES" in
    *synthetic-fail*) printf '  ok   failing lane is named in the report\n' ;;
    *) printf '  FAIL failing lane missing from the report\n'; fails=$((fails + 1)) ;;
  esac
  case "$SKIPPED_LANES" in
    *synthetic-skip*) printf '  ok   skipped lane is named in the report\n' ;;
    *) printf '  FAIL skipped lane missing from the report\n'; fails=$((fails + 1)) ;;
  esac

  local rc
  summary >/dev/null 2>&1
  rc=$?
  assert_eq "exit status with 2 FAILED" "$rc" "1"

  # A skip alone must NOT fail the run, and MUST fail it under REQUIRE_ALL.
  PASSED=1; FAILED=0; SKIPPED=1; FAILED_LANES=""; SKIPPED_LANES="s|missing: x
"
  REQUIRE_ALL=0; summary >/dev/null 2>&1; rc=$?
  assert_eq "exit status, skip only, default" "$rc" "0"
  REQUIRE_ALL=1; summary >/dev/null 2>&1; rc=$?
  assert_eq "exit status, skip only, REQUIRE_ALL=1" "$rc" "1"

  # An all-green run exits 0.
  PASSED=3; FAILED=0; SKIPPED=0; FAILED_LANES=""; SKIPPED_LANES=""
  REQUIRE_ALL=0; summary >/dev/null 2>&1; rc=$?
  assert_eq "exit status, all green" "$rc" "0"

  # ---- discovery: no repo gate can be silently omitted, none runs twice ----
  #
  # A synthetic tree with two shell gates (one passing, one failing), one gate
  # an explicit lane already owns, one Python gate in each discovered location,
  # and two decoys that match neither glob.
  printf '\n== discovery self-test ==\n'
  PASSED=0; FAILED=0; SKIPPED=0; FAILED_LANES=""; SKIPPED_LANES=""
  local disc="$scratch_lanes/disc"
  mkdir -p "$disc/tests" "$disc/conformance"
  printf 'touch "%s/alpha.ran"\n' "$disc" > "$disc/tests/alpha.test.sh"
  printf 'echo planted discovered-gate failure >&2\nexit 1\n' > "$disc/tests/beta.test.sh"
  printf 'touch "%s/owned.ran"\n' "$disc" > "$disc/tests/owned.test.sh"
  printf 'def test_ok():\n    pass\n' > "$disc/tests/test_gamma.py"
  printf 'def test_ok():\n    pass\n' > "$disc/conformance/test_delta.py"
  printf 'exit 1\n' > "$disc/tests/helper.sh"
  printf 'raise SystemExit(1)\n' > "$disc/tests/fixture_test.py"
  # What an explicit lane's body looks like when it owns a gate.
  local owned_bodies="cd '$disc' && bash '$disc/tests/owned.test.sh'"

  local found
  found="$(discover_gates "$disc" "$owned_bodies" | tr '\n' ' ')"
  assert_eq "discovered gates" "$found" \
    "tests/alpha.test.sh tests/beta.test.sh tests/test_gamma.py conformance/test_delta.py "

  local disc_py="${PYTHON_BIN:-$(resolve_python "$ROOT")}"
  PYTHON_BIN="$disc_py" run_discovered_gates "$disc" "$owned_bodies" >/dev/null 2>&1

  if [ -f "$disc/alpha.ran" ]; then
    printf '  ok   a synthetic tests/*.test.sh was discovered AND executed\n'
  else
    printf '  FAIL the synthetic tests/*.test.sh never ran\n'; fails=$((fails + 1))
  fi
  if [ -f "$disc/owned.ran" ]; then
    printf '  FAIL a gate an explicit lane owns ran a second time\n'; fails=$((fails + 1))
  else
    printf '  ok   a gate an explicit lane owns is not run twice\n'
  fi
  assert_eq "discovered FAILED" "$FAILED" "1"
  # The two Python gates pass or SKIP depending on this interpreter; either is
  # honest. What must hold is that all four discovered gates became lanes.
  assert_eq "discovered lanes (PASSED+FAILED+SKIPPED)" "$((PASSED + FAILED + SKIPPED))" "4"
  case "$FAILED_LANES" in
    *tests/beta.test.sh*) printf '  ok   the failing discovered gate is named in the report\n' ;;
    *) printf '  FAIL the failing discovered gate is not named\n'; fails=$((fails + 1)) ;;
  esac
  REQUIRE_ALL=0; summary >/dev/null 2>&1; rc=$?
  assert_eq "exit status with a failing discovered gate" "$rc" "1"

  # ---- agents: one lane per agents/*/package.json, failing npm test = FAILED ----
  printf '\n== agents self-test ==\n'
  PASSED=0; FAILED=0; SKIPPED=0; FAILED_LANES=""; SKIPPED_LANES=""
  local ag="$scratch_lanes/agents-root" pkg
  mkdir -p "$ag/agents/red-agent" "$ag/agents/green-agent" "$ag/agents/no-manifest"
  printf 'console.log(1)\n' > "$ag/agents/loose-script.js"
  for pkg in red-agent green-agent; do
    # A dependency-free lockfile, so `npm ci` succeeds offline.
    printf '{"name":"%s","version":"0.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"%s","version":"0.0.0"}}}\n' \
      "$pkg" "$pkg" > "$ag/agents/$pkg/package-lock.json"
  done
  # `build` leaves a marker, so the red agent also proves the chain STOPS at
  # the failing test instead of building past it.
  printf '{"name":"red-agent","version":"0.0.0","private":true,"scripts":{"typecheck":"exit 0","test":"echo planted agent test failure >&2; exit 7","build":"touch built.marker"}}\n' \
    > "$ag/agents/red-agent/package.json"
  printf '{"name":"green-agent","version":"0.0.0","private":true,"scripts":{"typecheck":"exit 0","test":"exit 0","build":"touch built.marker"}}\n' \
    > "$ag/agents/green-agent/package.json"

  npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false \
    run_agent_lanes "$ag" >/dev/null 2>&1

  if have npm; then
    assert_eq "agents FAILED" "$FAILED" "1"
    assert_eq "agents PASSED" "$PASSED" "1"
    case "$FAILED_LANES" in
      *agents/red-agent*) printf '  ok   the agent with a failing npm test is FAILED by name\n' ;;
      *) printf '  FAIL the failing agent is not named FAILED\n'; fails=$((fails + 1)) ;;
    esac
    if [ -f "$ag/agents/red-agent/built.marker" ]; then
      printf '  FAIL the red agent built past its failing test\n'; fails=$((fails + 1))
    else
      printf '  ok   the red agent stopped at its failing test\n'
    fi
    if [ -f "$ag/agents/green-agent/built.marker" ]; then
      printf '  ok   the green agent ran typecheck, test AND build\n'
    else
      printf '  FAIL the green agent never reached build\n'; fails=$((fails + 1))
    fi
    REQUIRE_ALL=0; summary >/dev/null 2>&1; rc=$?
    assert_eq "exit status with a failing agent lane" "$rc" "1"
  else
    # Without npm the lanes must SKIP by name — never pass.
    assert_eq "agents SKIPPED without npm" "$SKIPPED" "2"
    assert_eq "agents PASSED without npm" "$PASSED" "0"
    printf '  NOTE npm absent: the failing-agent control could not execute here\n'
  fi

  # ---- python resolution: .venv/bin/python preferred, sdks fallback, PYTHON_BIN override ----
  printf '\n== python resolution self-test ==\n'
  local pyroot="$scratch_lanes/pyroot"
  mkdir -p "$pyroot/.venv/bin" "$pyroot/sdks/python/.venv/bin"
  touch "$pyroot/.venv/bin/python" "$pyroot/sdks/python/.venv/bin/python"
  chmod +x "$pyroot/.venv/bin/python" "$pyroot/sdks/python/.venv/bin/python"

  local resolved
  resolved="$(PYTHON_BIN="" resolve_python "$pyroot")"
  assert_eq ".venv/bin/python preferred" "$resolved" "$pyroot/.venv/bin/python"

  rm -f "$pyroot/.venv/bin/python"
  resolved="$(PYTHON_BIN="" resolve_python "$pyroot")"
  assert_eq "sdks/python/.venv/bin/python fallback" "$resolved" "$pyroot/sdks/python/.venv/bin/python"

  resolved="$(PYTHON_BIN="/bin/sh" resolve_python "$pyroot")"
  assert_eq "PYTHON_BIN override respected" "$resolved" "/bin/sh"

  if [ "$fails" -eq 0 ]; then
    printf '\nok: test-all.sh engine is honest about pass, fail and skip\n'
    return 0
  fi
  printf '\nFAIL: %s engine assertion(s) failed\n' "$fails"
  return 1
}

# ---------------------------------------------------------------------------
# Preflight: resolve interpreters and SDK roots. NON-FATAL by design — an
# unresolved one turns into a named SKIP, not a dead run.
# ---------------------------------------------------------------------------

PYTHON_BIN="$(resolve_python "$ROOT")"
export PYTHON_BIN

if [ "${1:-}" = "--self-test" ]; then
  self_test
  exit $?
fi

if [ -z "${JAVA_HOME:-}" ] && [ -d /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ]; then
  export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
  export PATH=/opt/homebrew/opt/openjdk@17/bin:$PATH
fi

# Both Gradle SDKs build with `jvmToolchain(11)`. Homebrew JDKs are not on
# Gradle's auto-detection path on macOS, so name the ones this machine has,
# at invocation time. Never commit these paths to gradle.properties: that file
# is read on every machine, and a Windows build warns about paths it cannot have.
#
# The list itself lives in scripts/gradle-jdk-paths.sh, shared with
# tests/demo-e2e-record.test.sh, which runs the Kotlin contract suite through
# Gradle too and needs the same JDKs.
# shellcheck source=scripts/gradle-jdk-paths.sh
. "$ROOT/scripts/gradle-jdk-paths.sh"
GRADLE_JDK_ARGS=""
if [ -n "$GRADLE_JDK_PATHS" ]; then
  # %q because run_lane re-parses the lane with `bash -c`: a path with a space
  # must stay one argument.
  GRADLE_JDK_ARGS=$(printf '%q' "-Porg.gradle.java.installations.paths=$GRADLE_JDK_PATHS")
fi

if [ -z "${ANDROID_HOME:-}" ]; then
  if [ -d /opt/homebrew/share/android-commandlinetools/platforms/android-34 ]; then
    export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
  elif [ -d "$HOME/Library/Android/sdk/platforms/android-34" ]; then
    export ANDROID_HOME="$HOME/Library/Android/sdk"
  fi
fi

if [ -z "${PYTHON_BIN:-}" ]; then
  printf 'WARNING: no Python 3.10+ found; every Python lane will SKIP.\n' >&2
  printf '         Set PYTHON_BIN to the interpreter to use.\n' >&2
fi

# ---------------------------------------------------------------------------
# The lanes
# ---------------------------------------------------------------------------

run_lane "cross-SDK conformance" "python" \
  "'$PYTHON_BIN' '$ROOT/conformance/check_conformance.py' \
   && '$PYTHON_BIN' '$ROOT/conformance/check_conformance.py' --self-test"

# `pysdk` is what closes the dead gate: without the editable install this lane
# died in collection on `import httpx2`, and every spec assertion in
# tests/test_sdk_contract.py was unreachable.
# `py:yaml` is required, not optional: tests/test_tag_publish_gated.py PARSES the
# workflow YAML rather than scanning it as text — its first version passed under a
# widened tag pattern because the SDK path also appears a few lines below in the
# pull_request filter. Without PyYAML the lane must SKIP by name, not silently
# lose that check.
run_lane "repository contract and catalog guards" "$PY_GATE_REQS" \
  "cd '$ROOT' \
   && '$PYTHON_BIN' -m unittest tests/test_sdk_contract.py \
   && '$PYTHON_BIN' -m pytest -q tests/test_release_versions.py \
   && '$PYTHON_BIN' -m pytest -q tests/test_tag_publish_gated.py \
   && bash '$ROOT/tests/sdk-static-catalog-count.test.sh'"

run_lane "cross-language demo E2E" "pysdk node swift mvn jre" \
  "bash '$ROOT/tests/demo-e2e-record.test.sh'"

run_lane "dependency security audit" "osv-scanner pip-audit npm" \
  "'$ROOT/scripts/security-audit.sh'"

# SDKCI-004 — FIRST-PARTY static analysis, which the lane above does not do: it
# audits third-party advisories, this scans the code we wrote. It stands in for
# the CodeQL default setup while that hosted analysis is dormant. Its own
# --self-test plants a tracked injection and refuses to pass unless the gate
# reports it.
#
# THE LANE NAME SAYS "PARTIAL" AND MUST KEEP SAYING IT. It read "(CodeQL mirror)"
# and the Rule #31 review of 04d6664 called that a HIGH, correctly: sast.sh's
# header carries an honest per-language coverage table stating THIS IS NOT PARITY
# — Swift and Kotlin are thin, Dart and R are scanned by nothing — but the line a
# contributor actually reads is this one, printed green beside a checkmark. The
# honest text existed in a place nobody reaches. A green lane must not read as
# restored CodeQL coverage.
run_lane "first-party SAST (partial CodeQL stand-in; see scripts/sast.sh header)" "semgrep git" \
  "'$ROOT/scripts/sast.sh'"

run_lane "JavaScript / TypeScript" "npm" \
  "cd '$ROOT/sdks/js' && npm test"

run_lane "Python" "pysdk py:pytest py:pytest_asyncio py:mypy py:ruff pyfloor:openai" \
  "cd '$ROOT/sdks/python' && '$PYTHON_BIN' -m mypy nroutersdk && '$PYTHON_BIN' -m ruff check nroutersdk && '$PYTHON_BIN' -m pytest -q"

run_lane "Java" "mvn jre" \
  "cd '$ROOT/sdks/java' && mvn -q test"

run_lane "Kotlin" "jre" \
  "cd '$ROOT/sdks/kotlin' && ./gradlew $GRADLE_JDK_ARGS build publishToMavenLocal"

run_lane "Android" "jre android" \
  "cd '$ROOT/sdks/android' && ./gradlew $GRADLE_JDK_ARGS build"

run_lane "Go" "go" \
  "cd '$ROOT/sdks/go' && test -z \"\$(gofmt -l .)\" && go test ./... && go test -race ./... && go vet ./..."

run_lane "Rust" "cargo" \
  "cd '$ROOT/sdks/rust' \
   && cargo fmt --check \
   && cargo test --all-features \
   && cargo clippy --all-targets --all-features -- -D warnings"

run_lane "Swift" "swift" \
  "cd '$ROOT/sdks/swift' \
   && swift test \
   && swift build -Xswiftc -strict-concurrency=complete -Xswiftc -warnings-as-errors"

run_lane "Dart" "dart" \
  "cd '$ROOT/sdks/dart' && dart analyze && dart test"

run_lane "R" "Rscript" \
  "cd '$ROOT/sdks/r' && Rscript -e 'testthat::test_local(\".\", reporter=\"summary\")'"

# DISCOVERED repo gates. This MUST stay after every explicit lane: ownership is
# read from the bodies already handed to run_lane, so an explicit lane added
# below this line would run its gate a second time.
run_discovered_gates "$ROOT" "$LANE_BODIES"

# DISCOVERED agent packages.
run_agent_lanes "$ROOT"

summary
exit $?
