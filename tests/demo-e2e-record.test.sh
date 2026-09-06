#!/usr/bin/env bash
set -euo pipefail

# nRouter Multi-Language SDK End-to-End Demo Certification Test
# Verifies all active SDKs against demo key configuration
#
# Step 0 is a CHEAP STATIC preflight and runs no SDK and no network. Run it
# alone with `--static-only`. Step 3 runs against a local mock gateway; the
# other numbered steps make real, billed provider calls.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
cd "$ROOT_DIR"

# Step 0 covers EVERY shipped runnable example, and protects two different
# things across them.
#
# 1. SDK MAJOR + LOCKFILE, for examples/demo-e2e-sdk-example only. That is the
#    only example that INSTALLS the published package, so it is the only one a
#    major drift can break at a customer's `npm start` rather than here. The
#    other examples import `sdks/js/dist/` directly, so they always demonstrate
#    the SDK in this working tree and there is no spec to drift from.
#
# 2. ENV DOCUMENTATION + THE .env IGNORE RULE, for every example. This repo is
#    PUBLIC and every example's run instructions say `cp .env.example .env`, so
#    an example folder whose `.gitignore` misses `.env` turns the next `git add`
#    into a disclosed API key on nRouterAI/nrouter-sdk. That is the leak this
#    half exists to stop, and it must hold for the newest example as much as the
#    oldest.
#
# A listed example whose entry file does not exist yet is reported `pending`,
# not failed: the list is written ahead of the lanes that add the examples, so
# this gate lands first and is already armed when each one arrives.
static_preflight() {
  echo ""
  echo ">>> [0/6] Static: example SDK major, env documentation and .env ignore rules..."
  node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

// Every runnable example we ship, with the entry file whose env reads are the
// source of truth for what `.env.example` must document. `sdkMajor: true` marks
// the one example that installs the PUBLISHED package (see the comment above).
const EXAMPLES = [
  { dir: 'examples/demo-e2e-sdk-example', entry: 'index.mjs', sdkMajor: true },
  { dir: 'examples/typescript/voice-agent', entry: 'voice-agent.mjs' },
  { dir: 'examples/typescript/chat-agent', entry: 'chat-agent.mjs' },
  { dir: 'examples/typescript/image-agent', entry: 'image-agent.mjs' },
  { dir: 'examples/typescript/video-agent', entry: 'video-agent.mjs' },
];
const PKG_NAME = '@nrouter_ai/sdk';
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const failures = [];
const fail = (msg) => failures.push(msg);

// ---------------------------------------------------------------------------
// The published-package checks. Scoped to the one example that has a spec.
// ---------------------------------------------------------------------------
function checkSdkMajor(EXAMPLE_DIR) {
  const sdkVersion = read('sdks/js/package.json').version;
  const sdkMajor = Number(String(sdkVersion).split('.')[0]);
  if (!Number.isInteger(sdkMajor)) {
    fail(`sdks/js/package.json version is unparseable: ${sdkVersion}`);
    return;
  }

  const examplePkg = read(path.join(EXAMPLE_DIR, 'package.json'));
  const spec = (examplePkg.dependencies || {})[PKG_NAME];
  if (!spec) {
    fail(`${EXAMPLE_DIR}/package.json declares no ${PKG_NAME} dependency`);
    return;
  }

  // Resolve the spec to the major it will actually install. A `file:` spec
  // resolves through to the linked package's own version, so the check is
  // identical before and after the npm publish that lets the spec go back to a
  // plain `^N.x` range.
  let exampleMajor;
  let how;
  if (spec.startsWith('file:')) {
    const target = path.resolve(EXAMPLE_DIR, spec.slice('file:'.length));
    const targetPkgPath = path.join(target, 'package.json');
    if (!fs.existsSync(targetPkgPath)) {
      fail(`${spec} points at ${target}, which has no package.json`);
      return;
    }
    const targetPkg = read(targetPkgPath);
    if (targetPkg.name !== PKG_NAME) {
      fail(`${spec} points at package "${targetPkg.name}", not ${PKG_NAME}`);
      return;
    }
    exampleMajor = Number(String(targetPkg.version).split('.')[0]);
    how = `${spec} -> ${targetPkg.version}`;
  } else {
    const m = /^[\^~>=<\s v]*(\d+)\./.exec(spec);
    if (!m) {
      fail(`cannot read a major version out of ${PKG_NAME} spec "${spec}"`);
      return;
    }
    exampleMajor = Number(m[1]);
    how = spec;
  }

  if (exampleMajor !== sdkMajor) {
    fail(
      `${EXAMPLE_DIR} installs ${PKG_NAME} major ${exampleMajor} (${how}) but ` +
        `sdks/js is ${sdkVersion} (major ${sdkMajor}). The shipped example would ` +
        `demonstrate a different SDK than the one in this repo.`,
    );
    return;
  }

  // The lockfile must agree with package.json, or `npm ci` installs the old
  // major while package.json reads correct.
  const lockPath = path.join(EXAMPLE_DIR, 'package-lock.json');
  if (!fs.existsSync(lockPath)) {
    fail(`${lockPath} is missing; run \`npm install\` in ${EXAMPLE_DIR}`);
    return;
  }
  const lockSpec = ((read(lockPath).packages || {})[''] || {}).dependencies || {};
  if (lockSpec[PKG_NAME] !== spec) {
    fail(
      `${lockPath} is stale: it records ${PKG_NAME} "${lockSpec[PKG_NAME]}" but ` +
        `package.json says "${spec}". Run \`npm install\` in ${EXAMPLE_DIR}.`,
    );
    return;
  }

  console.log(`      ok: ${EXAMPLE_DIR} major ${exampleMajor} (${how}) == sdks/js ${sdkVersion}`);
}

// ---------------------------------------------------------------------------
// The checks every example gets.
// ---------------------------------------------------------------------------
function checkEnvContract(example) {
  const { dir, entry } = example;
  const entryPath = path.join(dir, entry);

  // Every env var the entry file reads must be documented, or it is invisible
  // to the reader. The list is DERIVED from the source, never hardcoded here: a
  // hardcoded list stays green when the example adds or renames a variable,
  // which is exactly the drift this is meant to catch.
  const envPath = path.join(dir, '.env.example');
  if (!fs.existsSync(envPath)) {
    fail(`${dir} ships ${entry} but no .env.example, so its configuration is undocumented`);
  } else {
    const env = fs.readFileSync(envPath, 'utf8');
    const src = fs.readFileSync(entryPath, 'utf8');
    const referenced = [...new Set(src.match(/NROUTER_[A-Z0-9_]+/g) || [])].sort();
    if (referenced.length === 0) {
      // Not a style rule: every example here talks to the gateway, so zero
      // matches means the pattern above stopped matching, not that the example
      // needs no key.
      fail(`${entryPath} references no NROUTER_* env var`);
    }
    for (const name of referenced) {
      if (!new RegExp(`^#?\\s*${name}=`, 'm').test(env)) {
        fail(`${entryPath} reads ${name} but ${dir}/.env.example does not document it`);
      }
    }
  }

  // This repo is PUBLIC and the run instructions say `cp .env.example .env`, so
  // a missing ignore rule turns the next `git add` into a disclosed API key.
  const ignorePath = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignorePath)) {
    fail(`${dir} has no .gitignore, so a copied .env would be committed — and this repo is public`);
    return;
  }
  const ignore = fs.readFileSync(ignorePath, 'utf8');
  if (!/^\.env\s*$/m.test(ignore)) {
    fail(`${dir}/.gitignore does not ignore .env, and this repo is public`);
  }
}

// ---------------------------------------------------------------------------
// Walk the list. Report EVERY failure, never just the first: fixing a leak one
// `bash tests/...` round trip at a time is how the second one gets missed.
// ---------------------------------------------------------------------------
const pending = [];
for (const example of EXAMPLES) {
  const entryPath = path.join(example.dir, example.entry);
  if (!fs.existsSync(entryPath)) {
    pending.push(entryPath);
    continue;
  }
  const before = failures.length;
  if (example.sdkMajor) checkSdkMajor(example.dir);
  checkEnvContract(example);
  // Only claim ok for an example that actually added no failure. A blanket ok
  // printed above the FAIL list reads as "these two are unrelated", which is
  // how a real leak gets scrolled past.
  if (failures.length === before) {
    console.log(`      ok: ${entryPath} — env documented, .env ignored`);
  }
}

for (const entryPath of pending) {
  console.log(`      pending: ${entryPath} does not exist yet (not a failure)`);
}

if (failures.length > 0) {
  for (const message of failures) console.error(`FAIL: ${message}`);
  process.exit(1);
}
NODE
}

echo "======================================================================"
echo "nRouter SDK Multi-Language Demo & End-to-End Test Suite"
echo "======================================================================"

static_preflight

if [ "${1:-}" = "--static-only" ]; then
  echo ""
  echo "STATIC PREFLIGHT PASSED (--static-only: skipping the 6 E2E suites)"
  exit 0
fi

# 1. Run Python Demo E2E
echo ""
echo ">>> [1/6] Executing Python SDK Demo E2E..."
"$PYTHON_BIN" examples/python/demo_e2e_suite.py

# 2. Run TypeScript/Node Demo E2E
echo ""
echo ">>> [2/6] Executing TypeScript/JavaScript SDK Demo E2E..."
node examples/typescript/demo_e2e_suite.js

# 3. Run the voice-agent example against a mock gateway.
#    Same dist/ build as step 2. Three billed wires (transcribe, chat, speak),
#    asserted for request ids, exact-cost summation and the unpriced case that
#    must NOT be summed as zero. No key, no network, about a second.
echo ""
echo ">>> [3/6] Executing voice-agent cost & usage certification..."
node examples/typescript/voice_agent_suite.js

# 4. Run Swift SDK E2E Contract Suite
echo ""
echo ">>> [4/6] Executing Swift SDK Contract & Wire Suite..."
swift test --filter ContractTests

# 5. Run Kotlin SDK E2E Contract Suite
echo ""
echo ">>> [5/6] Executing Kotlin SDK Contract & Wire Suite..."
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}"
export PATH="$JAVA_HOME/bin:$PATH"
(cd sdks/kotlin && ./gradlew test --tests "ai.nrouter.sdk.ContractTest")

# 6. Run Java SDK E2E Suite
echo ""
echo ">>> [6/6] Executing Java SDK Contract & Wire Suite..."
(cd sdks/java && mvn test -q)

echo ""
echo "======================================================================"
echo "ALL SDK DEMO & END-TO-END VERIFICATIONS PASSED"
echo "======================================================================"
