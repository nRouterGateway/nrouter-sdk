#!/usr/bin/env node
/**
 * Generate JavaScript/TypeScript and Python SDK model constants from
 * `spec/model-catalog-snapshot.json`.
 *
 * Constant naming rule: `MODEL_` + uppercase model `id` with non-alphanumerics -> `_`.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const DEFAULT_SNAPSHOT_PATH = path.join(REPO_ROOT, 'spec', 'model-catalog-snapshot.json');
const DEFAULT_JS_PATH = path.join(REPO_ROOT, 'sdks', 'js', 'src', 'models.ts');
const DEFAULT_PY_PATH = path.join(REPO_ROOT, 'sdks', 'python', 'nroutersdk', 'models.py');
const JS_BEGIN_MARKER = '// BEGIN GENERATED: model-catalog-snapshot';
const JS_END_MARKER = '// END GENERATED: model-catalog-snapshot';

const compareAscii = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function assertSafeValue(value, label) {
  if (typeof value !== 'string' || value.trim() === '' || value.trim() !== value) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  if (/[\x00-\x1f\x7f]/.test(value) || value.includes('*/')) {
    throw new Error(`Unsafe characters in ${label}: ${JSON.stringify(value)}`);
  }
}

/** Derive `MODEL_*` from a model id: uppercase, non-alphanumerics -> `_`, `MODEL_` prefix. */
export function deriveConstantName(id) {
  assertSafeValue(id, 'model id');
  const stem = id.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!stem) throw new Error(`Model id ${JSON.stringify(id)} contains no alphanumeric characters`);
  return `MODEL_${stem}`;
}

function validateSnapshot(snapshot) {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new Error('Snapshot must be a JSON object.');
  }
  if (typeof snapshot.version !== 'string' || !/^[A-Za-z0-9._-]+$/.test(snapshot.version)) {
    throw new Error(`Invalid snapshot version: ${JSON.stringify(snapshot.version)}`);
  }
  if (!Array.isArray(snapshot.models)) throw new Error('Snapshot "models" field must be an array.');
  const seenIds = new Set();
  for (const entry of snapshot.models) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('Each snapshot model entry must be an object.');
    }
    assertSafeValue(entry.id, 'model id');
    if (typeof entry.retired !== 'boolean') {
      throw new Error(`Snapshot model "${entry.id}" must have a boolean "retired" field.`);
    }
    if (seenIds.has(entry.id)) throw new Error(`Duplicate model id in snapshot (collision): "${entry.id}"`);
    seenIds.add(entry.id);
  }
  if (snapshot.compat !== undefined) {
    if (!Array.isArray(snapshot.compat)) throw new Error('Snapshot "compat" field must be an array when provided.');
    const seenCompatNames = new Set();
    for (const item of snapshot.compat) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new Error('Each snapshot compat entry must be an object.');
      }
      if (typeof item.name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(item.name)) {
        throw new Error(`Invalid compat entry name: ${JSON.stringify(item.name)}`);
      }
      assertSafeValue(item.value, `compat value for ${item.name}`);
      if (typeof item.deprecated !== 'boolean') {
        throw new Error(`Compat entry "${item.name}" must have a boolean "deprecated" field.`);
      }
      if (seenCompatNames.has(item.name)) throw new Error(`Duplicate compat entry name (collision): "${item.name}"`);
      seenCompatNames.add(item.name);
    }
  }
}

export function buildConstantEntries(snapshot) {
  validateSnapshot(snapshot);
  const sortedModels = [...snapshot.models].sort((a, b) => compareAscii(a.id, b.id));
  const sortedCompat = [...(snapshot.compat ?? [])].sort((a, b) => compareAscii(a.name, b.name));

  const canonicalByModelId = new Map();
  const constantsByName = new Map();
  const mapEntriesByKey = new Map();

  const registerConstant = (entry) => {
    const existing = constantsByName.get(entry.constantName);
    if (existing) {
      throw new Error(`Constant name collision: "${existing.id}" and "${entry.id}" both map to ${entry.constantName}`);
    }
    constantsByName.set(entry.constantName, entry);
  };

  for (const model of sortedModels) {
    const constantName = deriveConstantName(model.id);
    const keyName = constantName.slice('MODEL_'.length);
    registerConstant({
      constantName,
      keyName,
      id: model.id,
      retired: model.retired,
      deprecated: model.retired,
      canonicalName: null,
    });
    canonicalByModelId.set(model.id, { constantName, keyName, retired: model.retired });
    mapEntriesByKey.set(keyName, { keyName, constantName, value: model.id, deprecated: false, canonicalKeyName: null });
  }

  for (const item of sortedCompat) {
    if (!item.name.startsWith('MODEL_')) continue;
    const constantName = item.name;
    const keyName = constantName.slice('MODEL_'.length);
    const canonical = canonicalByModelId.get(item.value) ?? null;
    const retired = canonical ? canonical.retired : false;
    registerConstant({
      constantName,
      keyName,
      id: item.value,
      retired,
      deprecated: Boolean(item.deprecated || retired),
      canonicalName: canonical ? canonical.constantName : null,
    });
    if (!mapEntriesByKey.has(keyName)) {
      mapEntriesByKey.set(keyName, {
        keyName,
        constantName,
        value: item.value,
        deprecated: false,
        canonicalKeyName: canonical ? canonical.keyName : null,
      });
    }
  }

  for (const item of sortedCompat) {
    if (item.name.startsWith('MODEL_')) continue;
    const keyName = item.name;
    const prefixed = `MODEL_${keyName}`;
    const existingConst = constantsByName.get(prefixed) ?? null;
    const canonical =
      canonicalByModelId.get(item.value) ??
      (existingConst?.canonicalName ? { keyName: existingConst.canonicalName.slice('MODEL_'.length) } : null);
    const matchesConst = existingConst !== null && existingConst.id === item.value;
    mapEntriesByKey.set(keyName, {
      keyName,
      constantName: matchesConst ? prefixed : null,
      value: item.value,
      deprecated: Boolean(item.deprecated),
      canonicalKeyName: canonical ? canonical.keyName : null,
    });
  }

  return {
    constants: [...constantsByName.values()].sort((a, b) => compareAscii(a.constantName, b.constantName)),
    mapEntries: [...mapEntriesByKey.values()].sort((a, b) => compareAscii(a.keyName, b.keyName)),
  };
}

const escapeJs = (v) => v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const formatJsKey = (k) => (/^[A-Z_$][A-Z0-9_$]*$/i.test(k) ? k : `'${escapeJs(k)}'`);

function renderJsBlock(version, { constants, mapEntries }) {
  const lines = [
    JS_BEGIN_MARKER,
    `// Generated from spec/model-catalog-snapshot.json (snapshot version: ${version}).`,
    '// Do not edit by hand; run `node scripts/generate-model-constants.mjs` to regenerate.',
    '// Naming rule: `MODEL_` + uppercase model id with non-alphanumeric runs replaced by `_`.',
    '',
  ];
  for (const e of constants) {
    if (e.retired && e.canonicalName) {
      lines.push(`/** @deprecated Model \`${e.id}\` is retired; compatibility alias for \`${e.canonicalName}\`. */`);
    } else if (e.retired) {
      lines.push(`/** @deprecated Model \`${e.id}\` is retired. */`);
    } else if (e.deprecated && e.canonicalName) {
      lines.push(`/** @deprecated Compatibility alias; use \`${e.canonicalName}\` instead. */`);
    } else if (e.deprecated) {
      lines.push(`/** @deprecated Compatibility alias for \`${e.id}\`. */`);
    }
    lines.push(`export const ${e.constantName} = '${escapeJs(e.id)}';`);
  }
  lines.push('', 'export const MODELS = {');
  for (const e of mapEntries) {
    if (e.deprecated) {
      const hint = e.canonicalKeyName
        ? `Compatibility alias; use \`${e.canonicalKeyName}\` instead.`
        : `Compatibility alias for \`${e.value}\`.`;
      lines.push(`  /** @deprecated ${hint} */`);
    }
    lines.push(`  ${formatJsKey(e.keyName)}: ${e.constantName ?? `'${escapeJs(e.value)}'`},`);
  }
  lines.push('} as const;', '', 'export type WellKnownModel = (typeof MODELS)[keyof typeof MODELS];', JS_END_MARKER);
  return lines.join('\n');
}

function injectJsBlock(existingJsSource, generatedBlock) {
  if (!existingJsSource) return `${generatedBlock}\n`;
  const beginIdx = existingJsSource.indexOf(JS_BEGIN_MARKER);
  const endIdx = existingJsSource.indexOf(JS_END_MARKER);
  if (beginIdx !== -1 && endIdx !== -1 && beginIdx < endIdx) {
    return `${existingJsSource.slice(0, beginIdx)}${generatedBlock}${existingJsSource.slice(endIdx + JS_END_MARKER.length)}`;
  }
  throw new Error('Cannot locate generated model constants markers in TypeScript target file.');
}

function renderPythonModule(version, { constants, mapEntries }) {
  const lines = [
    `"""Model constants generated from spec/model-catalog-snapshot.json (snapshot version: ${version}).`,
    '',
    'Do not edit by hand; run `node scripts/generate-model-constants.mjs` to regenerate.',
    'Naming rule: `MODEL_` + uppercase model id with non-alphanumeric runs replaced by `_`.',
    '"""',
    '',
    'from __future__ import annotations',
    '',
  ];
  for (const e of constants) {
    if (e.retired && e.canonicalName) {
      lines.push(`#: Deprecated: model '${e.id}' is retired; compatibility alias for ${e.canonicalName}.`);
    } else if (e.retired) {
      lines.push(`#: Deprecated: model '${e.id}' is retired.`);
    } else if (e.deprecated && e.canonicalName) {
      lines.push(`#: Deprecated compatibility alias; use ${e.canonicalName} instead.`);
    } else if (e.deprecated) {
      lines.push(`#: Deprecated compatibility alias for '${e.id}'.`);
    }
    lines.push(`${e.constantName} = ${JSON.stringify(e.id)}`);
  }
  lines.push('', 'MODELS: dict[str, str] = {');
  for (const e of mapEntries) {
    if (e.deprecated) {
      const hint = e.canonicalKeyName
        ? `Deprecated compatibility alias; use ${e.canonicalKeyName} instead.`
        : `Deprecated compatibility alias for '${e.value}'.`;
      lines.push(`    #: ${hint}`);
    }
    lines.push(`    ${JSON.stringify(e.keyName)}: ${e.constantName ?? JSON.stringify(e.value)},`);
  }
  lines.push('}', '', '__all__ = [', '    "MODELS",');
  for (const e of constants) lines.push(`    ${JSON.stringify(e.constantName)},`);
  lines.push(']', '');
  return lines.join('\n');
}

export function generateModelConstants(snapshot, options = {}) {
  const built = buildConstantEntries(snapshot);
  const jsBlock = renderJsBlock(snapshot.version, built);
  const jsContent = injectJsBlock(options.existingJsSource ?? '', jsBlock);
  const pyContent = renderPythonModule(snapshot.version, built);
  return { entries: built.constants, mapEntries: built.mapEntries, jsContent, pyContent };
}

function parseArgs(argv) {
  const opts = { snapshotPath: DEFAULT_SNAPSHOT_PATH, jsPath: DEFAULT_JS_PATH, pyPath: DEFAULT_PY_PATH, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') opts.check = true;
    else if (arg === '--snapshot' && argv[i + 1]) opts.snapshotPath = path.resolve(argv[++i]);
    else if (arg === '--js-out' && argv[i + 1]) opts.jsPath = path.resolve(argv[++i]);
    else if (arg === '--py-out' && argv[i + 1]) opts.pyPath = path.resolve(argv[++i]);
    else throw new Error(`Unknown or incomplete CLI argument: ${arg}`);
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  const snapshot = JSON.parse(fs.readFileSync(opts.snapshotPath, 'utf8'));
  const existingJs = fs.existsSync(opts.jsPath) ? fs.readFileSync(opts.jsPath, 'utf8') : '';
  const { jsContent, pyContent } = generateModelConstants(snapshot, { existingJsSource: existingJs });

  if (opts.check) {
    const currentPy = fs.existsSync(opts.pyPath) ? fs.readFileSync(opts.pyPath, 'utf8') : null;
    const stale = [];
    if (!fs.existsSync(opts.jsPath) || existingJs !== jsContent) stale.push(opts.jsPath);
    if (currentPy === null || currentPy !== pyContent) stale.push(opts.pyPath);
    if (stale.length > 0) {
      process.stderr.write(`Stale generated model constants (${stale.join(', ')}); run node scripts/generate-model-constants.mjs\n`);
      return 1;
    }
    return 0;
  }

  fs.writeFileSync(opts.jsPath, jsContent, 'utf8');
  fs.writeFileSync(opts.pyPath, pyContent, 'utf8');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
