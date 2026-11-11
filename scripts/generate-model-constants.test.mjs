import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  deriveConstantName,
  generateModelConstants,
} from './generate-model-constants.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'generate-model-constants.mjs');
const SNAPSHOT_PATH = path.join(ROOT, 'spec', 'model-catalog-snapshot.json');
const JS_MODELS_PATH = path.join(ROOT, 'sdks', 'js', 'src', 'models.ts');
const PY_MODELS_PATH = path.join(ROOT, 'sdks', 'python', 'nroutersdk', 'models.py');

// The compatibility baseline is FROZEN: the two files exactly as published before
// constants were generated. Reading the live branch instead would compare the
// generated files with themselves and could never detect a removed or changed value.
const BASELINES = {
  'sdks/js/src/models.ts': path.join(ROOT, 'spec', 'baselines', 'models.ts.before-generation.txt'),
  'sdks/python/nroutersdk/models.py': path.join(ROOT, 'spec', 'baselines', 'models.py.before-generation.txt'),
};

function gitShowHead(relPath) {
  const baseline = BASELINES[relPath];
  assert.ok(baseline, `no frozen baseline for ${relPath}`);
  return fs.readFileSync(baseline, 'utf8');
}

function parseJsConstants(source) {
  const entries = [];
  const re = /^export const (MODEL_[A-Z0-9_]+)\s*=\s*'([^']+)';$/gm;
  for (const m of source.matchAll(re)) entries.push([m[1], m[2]]);
  return entries;
}

function parsePyConstants(source) {
  const entries = [];
  const re = /^(MODEL_[A-Z0-9_]+)\s*=\s*"([^"]+)"$/gm;
  for (const m of source.matchAll(re)) entries.push([m[1], m[2]]);
  return entries;
}

function parseJsModelsMap(source) {
  const constants = Object.fromEntries(parseJsConstants(source));
  const blockMatch = source.match(/export const MODELS\s*=\s*\{([\s\S]*?)\}\s*as const;/);
  assert.ok(blockMatch, 'Expected export const MODELS = { ... } as const; block');
  const entries = [];
  const re = /^\s*([A-Z0-9_]+):\s*(?:(MODEL_[A-Z0-9_]+)|'([^']+)'),\s*$/gm;
  for (const m of blockMatch[1].matchAll(re)) {
    const key = m[1];
    const value = m[2] ? constants[m[2]] : m[3];
    assert.equal(typeof value, 'string', `Unresolved JS MODELS entry for ${key}`);
    entries.push([key, value]);
  }
  return entries;
}

function parsePyModelsMap(source) {
  const constants = Object.fromEntries(parsePyConstants(source));
  const blockMatch = source.match(/MODELS:\s*dict\[str,\s*str\]\s*=\s*\{([\s\S]*?)\}/);
  assert.ok(blockMatch, 'Expected MODELS: dict[str, str] = { ... } block');
  const entries = [];
  const re = /^\s*"([A-Z0-9_]+)":\s*(?:(MODEL_[A-Z0-9_]+)|"([^"]+)"),\s*$/gm;
  for (const m of blockMatch[1].matchAll(re)) {
    const key = m[1];
    const value = m[2] ? constants[m[2]] : m[3];
    assert.equal(typeof value, 'string', `Unresolved Python MODELS entry for ${key}`);
    entries.push([key, value]);
  }
  return entries;
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nrouter-sdk-models-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: 'utf8' });
}

test('pinned snapshot has expected shape, version 2026-11-11, models, and compat list', () => {
  const raw = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  assert.equal(raw.version, '2026-11-11');
  assert.ok(Array.isArray(raw.models) && raw.models.length === 27);
  for (const item of raw.models) {
    assert.deepEqual(Object.keys(item).sort(), ['id', 'retired']);
    assert.equal(typeof item.id, 'string');
    assert.equal(typeof item.retired, 'boolean');
  }
  assert.ok(Array.isArray(raw.compat) && raw.compat.length > 0, 'Expected explicit compat list in snapshot');
  for (const item of raw.compat) {
    assert.deepEqual(Object.keys(item).sort(), ['deprecated', 'name', 'value']);
    assert.equal(typeof item.name, 'string');
    assert.equal(typeof item.value, 'string');
    assert.equal(item.deprecated, true);
  }
  assert.ok(
    raw.compat.some((c) => c.name === 'GEMINI_2_5_FLASH' && c.value === 'gemini-2.5-flash' && c.deprecated === true),
    'compat list must retain GEMINI_2_5_FLASH -> gemini-2.5-flash',
  );
  assert.ok(
    raw.compat.some((c) => c.name === 'GEMINI_2_5_PRO' && c.value === 'gemini-2.5-pro' && c.deprecated === true),
    'compat list must retain GEMINI_2_5_PRO -> gemini-2.5-pro',
  );
});

test('output is deterministic and sorted regardless of input model order', () => {
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  const existingJs = fs.readFileSync(JS_MODELS_PATH, 'utf8');
  const reversed = {
    version: snapshot.version,
    models: [...snapshot.models].reverse(),
    compat: [...(snapshot.compat ?? [])].reverse(),
  };

  const first = generateModelConstants(snapshot, { existingJsSource: existingJs });
  const second = generateModelConstants(reversed, { existingJsSource: existingJs });

  assert.equal(first.jsContent, second.jsContent);
  assert.equal(first.pyContent, second.pyContent);
  assert.match(first.jsContent, /snapshot version:\s*2026-11-11/i);
  assert.match(first.pyContent, /snapshot version:\s*2026-11-11/i);

  const names = parseJsConstants(first.jsContent).map(([k]) => k);
  const sortedNames = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  assert.deepEqual(names, sortedNames);
});

test('JS and Python generated constant sets and MODELS maps are identical', () => {
  const jsSource = fs.readFileSync(JS_MODELS_PATH, 'utf8');
  const pySource = fs.readFileSync(PY_MODELS_PATH, 'utf8');

  const jsEntries = parseJsConstants(jsSource);
  const pyEntries = parsePyConstants(pySource);
  const jsModels = parseJsModelsMap(jsSource);
  const pyModels = parsePyModelsMap(pySource);

  assert.equal(jsEntries.length, 40);
  assert.deepEqual(jsEntries, pyEntries);
  assert.equal(jsModels.length, 40);
  assert.deepEqual(jsModels, pyModels);
  assert.match(jsSource, /export type NRouterModel\b/);
  assert.match(jsSource, /export type NRouterModelList\b/);
  assert.match(jsSource, /export type NRouterCapabilities\b/);
  assert.match(jsSource, /export interface RawRequester\b/);
  assert.match(jsSource, /export class NRouterModels\b/);
  assert.match(jsSource, /export type WellKnownModel\b/);
});

test('constant derivation rule normalizes ids and fails on collisions', () => {
  assert.equal(deriveConstantName('meta/llama-3.3-70b-instruct'), 'MODEL_META_LLAMA_3_3_70B_INSTRUCT');
  assert.equal(deriveConstantName('gpt-5.4-mini'), 'MODEL_GPT_5_4_MINI');

  assert.throws(
    () =>
      generateModelConstants({
        version: '2026-11-11',
        models: [
          { id: 'vendor/alpha-1.0', retired: false },
          { id: 'vendor-alpha_1.0', retired: false },
        ],
      }),
    /collision/i,
  );

  withTempDir((dir) => {
    const snapFile = path.join(dir, 'snap.json');
    fs.writeFileSync(
      snapFile,
      JSON.stringify({
        version: '2026-11-11',
        models: [
          { id: 'acme/x-1', retired: false },
          { id: 'acme_x.1', retired: false },
        ],
      }),
    );
    const res = runCli([
      '--snapshot',
      snapFile,
      '--js-out',
      path.join(dir, 'models.ts'),
      '--py-out',
      path.join(dir, 'models.py'),
    ]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /collision/i);
  });
});

test('retired models carry deprecation doc comments in both JS and Python', () => {
  const { jsContent, pyContent } = generateModelConstants({
    version: '2026-11-11',
    models: [
      { id: 'acme/active-v2', retired: false },
      { id: 'acme/retired-v1', retired: true },
    ],
  });

  assert.match(jsContent, /\/\*\*[^\n]*@deprecated[^\n]*retired[^\n]*\*\/\nexport const MODEL_ACME_RETIRED_V1 = 'acme\/retired-v1';/i);
  assert.doesNotMatch(jsContent, /@deprecated[^\n]*\*\/\nexport const MODEL_ACME_ACTIVE_V2/i);
  assert.match(pyContent, /#: [^\n]*deprecated[^\n]*retired[^\n]*\nMODEL_ACME_RETIRED_V1 = "acme\/retired-v1"/i);
  assert.doesNotMatch(pyContent, /deprecated[^\n]*\nMODEL_ACME_ACTIVE_V2/i);
});

test('HEAD constants, MODELS keys, and WellKnownModel literals keep identical values after generation', () => {
  const headJs = gitShowHead('sdks/js/src/models.ts');
  const headPy = gitShowHead('sdks/python/nroutersdk/models.py');
  const genJs = fs.readFileSync(JS_MODELS_PATH, 'utf8');
  const genPy = fs.readFileSync(PY_MODELS_PATH, 'utf8');

  const headJsConsts = Object.fromEntries(parseJsConstants(headJs));
  const headPyConsts = Object.fromEntries(parsePyConstants(headPy));
  const headJsModels = Object.fromEntries(parseJsModelsMap(headJs));
  const headPyModels = Object.fromEntries(parsePyModelsMap(headPy));
  const headWellKnownLiterals = new Set(Object.values(headJsModels));

  const genJsConsts = Object.fromEntries(parseJsConstants(genJs));
  const genPyConsts = Object.fromEntries(parsePyConstants(genPy));
  const genJsModels = Object.fromEntries(parseJsModelsMap(genJs));
  const genPyModels = Object.fromEntries(parsePyModelsMap(genPy));
  const genWellKnownLiterals = new Set(Object.values(genJsModels));

  for (const [name, expectedValue] of Object.entries(headJsConsts)) {
    assert.equal(genJsConsts[name], expectedValue, `JS constant ${name} changed from HEAD`);
    assert.equal(genPyConsts[name], expectedValue, `Python constant ${name} disagrees with JS HEAD`);
  }
  for (const [name, expectedValue] of Object.entries(headPyConsts)) {
    assert.equal(genPyConsts[name], expectedValue, `Python constant ${name} changed from HEAD`);
    assert.equal(genJsConsts[name], expectedValue, `JS constant ${name} disagrees with Python HEAD`);
  }
  for (const [key, expectedValue] of Object.entries(headJsModels)) {
    assert.equal(genJsModels[key], expectedValue, `JS MODELS.${key} changed from HEAD`);
    assert.equal(genPyModels[key], expectedValue, `Python MODELS["${key}"] disagrees with JS HEAD`);
  }
  for (const [key, expectedValue] of Object.entries(headPyModels)) {
    assert.equal(genPyModels[key], expectedValue, `Python MODELS["${key}"] changed from HEAD`);
    assert.equal(genJsModels[key], expectedValue, `JS MODELS.${key} disagrees with Python HEAD`);
  }
  for (const literal of headWellKnownLiterals) {
    assert.ok(
      genWellKnownLiterals.has(literal),
      `WellKnownModel literal "${literal}" from HEAD was dropped after generation`,
    );
  }

  // Rule-derived names exist alongside deprecated compat entries.
  assert.equal(genJsConsts.MODEL_META_LLAMA_3_2_11B_VISION_INSTRUCT, 'meta/llama-3.2-11b-vision-instruct');
  assert.equal(genJsConsts.MODEL_CLAUDE_SONNET_4_5_20250929, 'claude-sonnet-4-5-20250929');
  assert.match(genJs, /@deprecated[^\n]*\*\/\nexport const MODEL_META_LLAMA_3_2_11B_VISION\b/);
  assert.match(genJs, /@deprecated[^\n]*\*\/\n\s+GEMINI_2_5_FLASH:\s+'gemini-2\.5-flash',/);
  assert.match(genPy, /#: [^\n]*Deprecated[^\n]*\nMODEL_CLAUDE_SONNET_4_5\b/);
  assert.match(genPy, /#: [^\n]*Deprecated[^\n]*\n\s+"GEMINI_2_5_FLASH":\s+"gemini-2\.5-flash",/);
});

test('--check mode exits 0 when fresh and exits non-zero when files are stale', () => {
  const liveCheck = runCli(['--check']);
  assert.equal(liveCheck.status, 0, liveCheck.stderr);

  withTempDir((dir) => {
    const snapFile = path.join(dir, 'snapshot.json');
    const jsFile = path.join(dir, 'models.ts');
    const pyFile = path.join(dir, 'models.py');
    fs.copyFileSync(SNAPSHOT_PATH, snapFile);
    fs.copyFileSync(JS_MODELS_PATH, jsFile);
    fs.copyFileSync(PY_MODELS_PATH, pyFile);

    const args = ['--snapshot', snapFile, '--js-out', jsFile, '--py-out', pyFile];
    assert.equal(runCli([...args, '--check']).status, 0);

    const stalePy = fs.readFileSync(pyFile, 'utf8') + '\n# stale edit\n';
    fs.writeFileSync(pyFile, stalePy);
    const staleRes = runCli([...args, '--check']);
    assert.notEqual(staleRes.status, 0);
    assert.equal(fs.readFileSync(pyFile, 'utf8'), stalePy, '--check must not overwrite files');

    fs.copyFileSync(PY_MODELS_PATH, pyFile);
    const staleJs = fs.readFileSync(jsFile, 'utf8').replace('2026-11-11', '2025-01-01');
    fs.writeFileSync(jsFile, staleJs);
    assert.notEqual(runCli([...args, '--check']).status, 0);
  });
});
