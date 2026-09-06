// The audio/media PARAM and RESULT types must be reachable from the package
// entry, not merely defined inside `src/multimodal.ts`.
//
// `index.ts` uses an explicit named export list rather than `export *`, so a
// type defined in a module is invisible to a package consumer until it appears
// on that list — the same DIPTESH-094 failure the `chatTextDiagnostic` comment
// records, pointed at types instead of values. It exported the multimodal
// CLASS and the audio-format helpers while withholding every shape those
// methods take and return, so a consumer writing a typed voice wrapper had to
// re-declare `SpeechParams` by hand and drift from the real one silently.
//
// WHY THIS TEST SHELLS OUT TO `tsc` INSTEAD OF IMPORTING THE TYPES.
// Node strips types; it does not check them. `import type { SpeechParams }`
// inside a `.test.ts` erases to nothing, so a test written that way passes
// whether or not the export exists — it would prove exactly nothing. The only
// way to observe a type export is to compile against it, so this compiles a
// fixture with the real `tsc` and reads the exit status.
//
// It compiles against `dist/index.d.ts` — the declaration file npm publishes
// and the one `package.json#types` points a consumer at — not against `src/`.
// A parity proof over the sources would pass while the shipped package
// disagreed with itself.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The declaration entry a consumer resolves through `package.json#types`.
const DIST_ENTRY = path.join(__dirname, '..', 'dist', 'index');

// `require.resolve` finds the devDependency copy of TypeScript, and invoking
// `tsc.js` through `process.execPath` avoids the `.bin` shell shim, which is a
// `.cmd` on Windows and not executable by `spawnSync` there.
const TSC_JS = path.join(path.dirname(require.resolve('typescript')), '..', 'bin', 'tsc');

/**
 * The types a caller needs to write a typed wrapper over the media surface.
 *
 * Every name is `export`ed from `src/multimodal.ts`; this list is about
 * whether the PACKAGE ENTRY re-exports them.
 */
const REQUIRED_TYPE_EXPORTS = [
  'SpeechParams',
  'SpeechResponseFormat',
  'BinaryResult',
  'TranscriptionParams',
  'TranslationParams',
  'TranscriptionFormat',
  'TranscriptionResult',
  'ImageParams',
  'VideoParams',
  'EmbeddingsParams',
  'CallOptions',
  'JsonObject',
  // `JsonObject` is `{ [key: string]: JsonValue }` and `CallOptions` is
  // `{ signal?: AbortSignalLike }`. Exporting a container type while
  // withholding the type of what goes IN it leaves the consumer able to
  // declare the object and unable to name its parts — half an export.
  'JsonValue',
  'AbortSignalLike',
];

/**
 * Typecheck `source` against the built declaration entry and return tsc's
 * result. Everything happens in a throwaway directory OUTSIDE the package, so
 * the fixture cannot be picked up by the package's own `tsconfig.json` and
 * cannot leave anything behind in the tree.
 */
function typecheck(source: string): { status: number; output: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nrouter-sdk-type-exports-'));
  try {
    // A TypeScript string literal, so a Windows path's backslashes would be
    // escape sequences. Import specifiers are POSIX-shaped on every platform.
    const specifier = DIST_ENTRY.split(path.sep).join('/');
    fs.writeFileSync(path.join(dir, 'fixture.ts'), source.replace(/__SDK__/g, specifier), 'utf8');
    fs.writeFileSync(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2020',
          module: 'CommonJS',
          moduleResolution: 'node',
          lib: ['ES2020', 'DOM'],
          // Empty for the same reason the package's own tsconfig sets it:
          // otherwise tsc walks UP collecting `@types` packages a clean
          // checkout does not have.
          types: [],
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        files: ['fixture.ts'],
      }),
      'utf8',
    );
    const run = spawnSync(process.execPath, [TSC_JS, '-p', path.join(dir, 'tsconfig.json')], {
      encoding: 'utf8',
    });
    return {
      status: run.status === null ? 1 : run.status,
      output: `${run.stdout ?? ''}${run.stderr ?? ''}`,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the harness reports a MISSING export as a failure', () => {
  // Without this control the whole file is vacuous: a fixture that resolves
  // nothing, or a tsc invocation that typechecks nothing, exits 0 and every
  // other assertion below passes while proving the opposite of what it claims.
  const result = typecheck(
    `import type { ThisNameIsNotExportedByTheSdk } from '__SDK__';\n` +
      `declare const v: ThisNameIsNotExportedByTheSdk;\n` +
      `export const used = v;\n`,
  );
  assert.notEqual(
    result.status,
    0,
    'tsc accepted an import of a name the SDK does not export, so this file ' +
      'cannot detect a missing type export at all:\n' + result.output,
  );
  assert.match(result.output, /ThisNameIsNotExportedByTheSdk/);
});

test('the harness reports an export that IS present as a pass', () => {
  // The other half of the control. `AudioFormat` has been on the entry list
  // since the multimodal surface landed, so a non-zero status here means the
  // fixture is broken (bad path, unresolved dependency) rather than the SDK.
  const result = typecheck(
    `import type { AudioFormat } from '__SDK__';\n` +
      `declare const v: AudioFormat;\n` +
      `export const used = v;\n`,
  );
  assert.equal(
    result.status,
    0,
    'typechecking a known-good import failed, so the fixture itself is ' +
      'broken and every other result in this file is meaningless:\n' + result.output,
  );
});

test('every media param and result type is importable from the package entry', () => {
  const names = REQUIRED_TYPE_EXPORTS.join(', ');
  const result = typecheck(
    `import type { ${names} } from '__SDK__';\n` +
      REQUIRED_TYPE_EXPORTS.map((n, i) => `declare const v${i}: ${n};\n`).join('') +
      `export const used = [${REQUIRED_TYPE_EXPORTS.map((_, i) => `v${i}`).join(', ')}];\n`,
  );
  assert.equal(
    result.status,
    0,
    `dist/index.d.ts does not export every media type a consumer needs. ` +
      `A TypeScript caller cannot name these without re-declaring them by hand:\n` +
      result.output,
  );
});

test('every exported media type carries its real shape', () => {
  // A name can be present and worthless. This builds an actual request object
  // and reads an actual result for EVERY name on the list, so an export that
  // resolved to a different type that merely shares the name fails here rather
  // than shipping as a green name check.
  //
  // All fourteen are exercised on purpose. Presence and shape are separate
  // properties, and covering only the ones a speech call happens to touch left
  // `ImageParams`, `VideoParams`, `TranscriptionFormat`, `JsonValue` and
  // `AbortSignalLike` proven to exist and not proven to be anything.
  const result = typecheck(
    `import type {\n` +
      `  SpeechParams, SpeechResponseFormat, BinaryResult,\n` +
      `  TranscriptionParams, TranslationParams, TranscriptionFormat, TranscriptionResult,\n` +
      `  ImageParams, VideoParams, EmbeddingsParams,\n` +
      `  CallOptions, JsonObject, JsonValue, AbortSignalLike,\n` +
      `} from '__SDK__';\n` +
      `const format: SpeechResponseFormat = 'mp3';\n` +
      `const heardAs: TranscriptionFormat = 'srt';\n` +
      `const scalar: JsonValue = [1, 'two', true, null, { deep: [] }];\n` +
      `const extra: JsonObject = { nested: scalar };\n` +
      `const speech: SpeechParams = {\n` +
      `  model: 'tts-1', input: 'hello', voice: 'alloy',\n` +
      `  response_format: format, speed: 1, extra,\n` +
      `};\n` +
      `const transcribe: TranscriptionParams = {\n` +
      `  file: new Uint8Array([0]), fileName: 'clip.mp3', model: 'whisper-1',\n` +
      `  language: 'en', response_format: heardAs,\n` +
      `  timestampGranularities: ['word'],\n` +
      `};\n` +
      // TranslationParams is TranscriptionParams minus `language`, so this
      // omission is the point: adding it back must not typecheck.
      `const translate: TranslationParams = {\n` +
      `  file: new Uint8Array([0]), fileName: 'clip.mp3', model: 'whisper-1',\n` +
      `};\n` +
      `const picture: ImageParams = {\n` +
      `  model: 'gpt-image-1', prompt: 'a cat', n: 1, size: '1024x1024',\n` +
      `  response_format: 'b64_json', extra,\n` +
      `};\n` +
      `const clip: VideoParams = { model: 'sora-2', prompt: 'a cat', seconds: 4, extra };\n` +
      `const embed: EmbeddingsParams = { model: 'e', input: ['a', 'b'] };\n` +
      `const signal: AbortSignalLike = { aborted: false };\n` +
      `const opts: CallOptions = { signal };\n` +
      `const stillRunning: boolean = signal.aborted;\n` +
      `declare const binary: BinaryResult;\n` +
      `const bytes: Uint8Array = binary.bytes;\n` +
      `const contentType: string | null = binary.contentType;\n` +
      `const cost: number | null = binary.meta.cost;\n` +
      `declare const heard: TranscriptionResult;\n` +
      `const text: string | null = heard.kind === 'json' ? heard.text : heard.text;\n` +
      `export const used = [speech, transcribe, translate, picture, clip, embed,\n` +
      `  opts, stillRunning, bytes, contentType, cost, text];\n`,
  );
  assert.equal(
    result.status,
    0,
    'the media types are exported but do not have the shape a caller needs:\n' + result.output,
  );
});

test('the exported media types are not `any`', () => {
  // The shape test above cannot see this on its own: `any` accepts every
  // assignment, so a type accidentally widened to `any` passes a fixture built
  // out of VALID objects. Only a WRONG value proves the type is still checking.
  // Each case below must be a compile error; a silent pass means that name is
  // no longer constraining anything a caller writes.
  const cases: Array<[string, string]> = [
    ['SpeechParams', `const v: SpeechParams = { model: 1, input: 'x', voice: 'alloy' };`],
    ['SpeechResponseFormat', `const v: SpeechResponseFormat = 'pcm';`],
    ['TranscriptionFormat', `const v: TranscriptionFormat = 'mp3';`],
    [
      'TranscriptionParams',
      `const v: TranscriptionParams = { file: 'not-bytes', fileName: 'c.mp3', model: 'w' };`,
    ],
    ['ImageParams', `const v: ImageParams = { model: 'm', prompt: 'p', n: 'one' };`],
    ['VideoParams', `const v: VideoParams = { model: 'm', prompt: 'p', seconds: true };`],
    ['EmbeddingsParams', `const v: EmbeddingsParams = { model: 'm', input: { not: 'text' } };`],
    ['CallOptions', `const v: CallOptions = { signal: 'not-a-signal' };`],
    ['AbortSignalLike', `const v: AbortSignalLike = { aborted: 'maybe' };`],
    ['JsonObject', `const v: JsonObject = { fn: () => 1 };`],
    ['JsonValue', `const v: JsonValue = () => 1;`],
    ['BinaryResult', `declare const b: BinaryResult; const v: string = b.bytes;`],
    ['TranscriptionResult', `declare const t: TranscriptionResult; const v: number = t.meta;`],
    [
      'TranslationParams',
      `const v: TranslationParams = { file: new Uint8Array([0]), fileName: 'c.mp3', model: 'w', timestampGranularities: ['word'] };`,
    ],
  ];

  const accepted: string[] = [];
  for (const [name, body] of cases) {
    const result = typecheck(`import type { ${name} } from '__SDK__';\n${body}\nexport const used = v;\n`);
    if (result.status === 0) accepted.push(name);
  }
  assert.deepEqual(
    accepted,
    [],
    `${accepted.join(', ')} accepted a value of the wrong type. A type that rejects ` +
      `nothing is either \`any\` or has been widened, and the export gives a caller ` +
      `no more safety than writing the object untyped.`,
  );
});

test('`language` is still rejected on TranslationParams', () => {
  // The narrowing is the whole reason TranslationParams is a distinct type:
  // /v1/audio/translations always outputs English and has no `language` input.
  // If this ever compiles, the type has been widened to the transcription one
  // and the compile error a caller relies on has become a silently dropped
  // argument.
  const result = typecheck(
    `import type { TranslationParams } from '__SDK__';\n` +
      `const bad: TranslationParams = {\n` +
      `  file: new Uint8Array([0]), fileName: 'clip.mp3', model: 'whisper-1',\n` +
      `  language: 'en',\n` +
      `};\n` +
      `export const used = bad;\n`,
  );
  assert.notEqual(result.status, 0, 'TranslationParams accepted a `language` field');
  assert.match(result.output, /language/);
});

test('the type exports add NO runtime export to either package entry', () => {
  // TypeScript interfaces and type aliases have no runtime value, so none of
  // these may appear as a key on the built entries. `src/index.mjs` is a
  // hand-written re-export list of runtime names; if a type ever showed up as
  // a runtime key here it would mean an accidental `const`/`class` export, and
  // `test/package-entry-parity.mjs` would then go red for a name nobody could
  // add to the .mjs shim. Failing here names the cause instead.
  const cjs = require('../dist/index.js');
  const leaked = REQUIRED_TYPE_EXPORTS.filter((name) => name in cjs);
  assert.deepEqual(
    leaked,
    [],
    `${leaked.join(', ')} appear as RUNTIME exports of dist/index.js. These are ` +
      `type-only names; a runtime export means the wrong thing was exported and ` +
      `src/index.mjs now has to carry it too.`,
  );
});
