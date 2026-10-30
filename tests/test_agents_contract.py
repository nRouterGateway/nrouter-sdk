"""Agent package contract.

Every directory under ``agents/`` that carries a ``package.json`` is a public
npm package built on ``@nrouter_ai/sdk``.  This gate reads each package's real
manifest, lockfile and sources (never a hand-maintained table) and holds it to
five rules:

1. ``dependencies["@nrouter_ai/sdk"]`` is an exact ``MAJOR.MINOR.PATCH`` pin
   with the spec's MAJOR and no newer than ``spec/nrouter-sdk-spec.json``
   ``version``.  An agent may lag while a new SDK release is being published;
   it may never point at a version that has not been released.
2. ``package-lock.json`` exists and resolves ``@nrouter_ai/sdk`` to that pin.
3. ``license`` is MIT, ``engines.node`` is set, ``repository.directory`` names
   the package's own folder, and every ``files`` entry exists (``dist`` is a
   build output and is exempt).
4. Every relative import in ``src/**/*.ts`` and ``test/**/*.ts`` resolves to a
   file the package actually has.  Scaffold copies that import modules the
   package does not ship fail here instead of at ``vitest`` time.
5. No Rule #38 rewriter scripts live under ``agents/``.

Each check is a function over a path that returns a list of problems, so the
bite tests at the bottom can prove it rejects a broken synthetic package.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
AGENTS = ROOT / "agents"
SDK_PACKAGE = "@nrouter_ai/sdk"
EXACT_SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")

# Rule #38: edits are made in place, never by one-shot rewriter scripts or
# patch files.  Names are matched against the file's basename.
REWRITER_PATTERNS = (
    re.compile(r"^fix(?!ture).*\.(?:js|mjs|cjs|py|sh)$"),  # fixture*.js is data
    re.compile(r"^iterate-.*\.(?:js|mjs|cjs)$"),
    re.compile(r"^apply-.*\.sh$"),
    re.compile(r"\.(?:patch|diff)$"),
)

# Relative module specifiers in static/dynamic imports, re-exports, side-effect
# imports, require() and vitest's module-mocking helpers.
_IMPORT_SPECIFIER = re.compile(
    r"""(?:
        \bfrom\s*
      | \bimport\s*\(\s*
      | \bimport\s+
      | \b(?:vi\.(?:mock|doMock|unmock|doUnmock|importActual|importMock)|require)\s*\(\s*
    )(['"])(\.{1,2}/[^'"\n]*)\1""",
    re.VERBOSE,
)
_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)
_LINE_COMMENT = re.compile(r"^\s*//.*$", re.MULTILINE)


def _display(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def _version_tuple(version: str) -> tuple[int, int, int]:
    major, minor, patch = (int(part) for part in version.split("."))
    return major, minor, patch


def _load_json(path: Path) -> tuple[dict | None, str | None]:
    try:
        return json.loads(path.read_text()), None
    except FileNotFoundError:
        return None, f"{_display(path)} is missing"
    except json.JSONDecodeError as error:
        return None, f"{_display(path)} is not valid JSON ({error})"


def discover_agents(agents_root: Path) -> list[Path]:
    """Every immediate child of ``agents_root`` that has a package.json."""
    if not agents_root.is_dir():
        return []
    return sorted(
        child
        for child in agents_root.iterdir()
        if child.is_dir() and (child / "package.json").is_file()
    )


def spec_version(root: Path = ROOT) -> str:
    return json.loads((root / "spec/nrouter-sdk-spec.json").read_text())["version"]


# --------------------------------------------------------------------------
# Check 1 — the SDK pin.
# --------------------------------------------------------------------------


def check_sdk_pin(agent: Path, spec: str) -> list[str]:
    manifest_path = agent / "package.json"
    manifest, error = _load_json(manifest_path)
    if manifest is None:
        assert error is not None
        return [error]
    where = _display(manifest_path)
    pin = (manifest.get("dependencies") or {}).get(SDK_PACKAGE)
    if pin is None:
        return [
            (
                f'{where}: dependencies["{SDK_PACKAGE}"] is missing — fix: add '
                f'"{SDK_PACKAGE}": "{spec}" to dependencies'
            )
        ]
    if not isinstance(pin, str) or not EXACT_SEMVER.match(pin):
        return [
            (
                f'{where}: dependencies["{SDK_PACKAGE}"] is {pin!r}, not an exact '
                f'MAJOR.MINOR.PATCH (no ^, ~, *, x, ranges, tags or prereleases) — '
                f'fix: pin "{spec}" and run npm install to refresh package-lock.json'
            )
        ]
    problems = []
    pinned, canonical = _version_tuple(pin), _version_tuple(spec)
    if pinned[0] != canonical[0]:
        problems.append(
            f'{where}: dependencies["{SDK_PACKAGE}"] is {pin}, major {pinned[0]}, '
            f"but the spec is {spec}, major {canonical[0]} — fix: pin \"{spec}\" "
            f"and port the agent to the current SDK major"
        )
    if pinned > canonical:
        problems.append(
            f'{where}: dependencies["{SDK_PACKAGE}"] is {pin}, newer than the '
            f'spec version {spec}; that SDK is unreleased — fix: pin "{spec}" or older'
        )
    return problems


# --------------------------------------------------------------------------
# Check 2 — the lockfile agrees with the pin.
# --------------------------------------------------------------------------


def check_lockfile(agent: Path) -> list[str]:
    manifest, error = _load_json(agent / "package.json")
    if manifest is None:
        assert error is not None
        return [error]
    pin = (manifest.get("dependencies") or {}).get(SDK_PACKAGE)
    lock_path = agent / "package-lock.json"
    where = _display(lock_path)
    if not lock_path.is_file():
        return [
            (
                f"{where} is missing — fix: run npm install in {_display(agent)} "
                f"and commit the lockfile"
            )
        ]
    lock, error = _load_json(lock_path)
    if lock is None:
        return [f"{error} — fix: regenerate it with npm install"]

    problems = []
    packages = lock.get("packages")
    if isinstance(packages, dict):  # lockfileVersion 2 and 3
        root_pin = (packages.get("", {}).get("dependencies") or {}).get(SDK_PACKAGE)
        if root_pin != pin:
            problems.append(
                f'{where}: root package records "{SDK_PACKAGE}": {root_pin!r} but '
                f"package.json pins {pin!r} — fix: run npm install so the "
                f"lockfile matches package.json"
            )
        sdk_entry = packages.get(f"node_modules/{SDK_PACKAGE}", {})
        resolved = sdk_entry.get("version")
        resolved_url = sdk_entry.get("resolved")
        integrity = sdk_entry.get("integrity")
    else:  # lockfileVersion 1
        sdk_entry = (lock.get("dependencies") or {}).get(SDK_PACKAGE, {})
        resolved = sdk_entry.get("version")
        resolved_url = sdk_entry.get("resolved")
        integrity = sdk_entry.get("integrity")
    if resolved is None:
        problems.append(
            f"{where}: has no resolved node_modules/{SDK_PACKAGE} entry — fix: "
            f"run npm install in {_display(agent)}"
        )
    elif resolved != pin:
        problems.append(
            f"{where}: resolves {SDK_PACKAGE} to {resolved} but package.json pins "
            f"{pin!r} — fix: run npm install so the lockfile resolves the pin"
        )
    elif not isinstance(resolved_url, str) or not resolved_url.endswith(
        f"/-/{SDK_PACKAGE.split('/')[-1]}-{pin}.tgz"
    ):
        problems.append(
            f"{where}: resolved tarball URL {resolved_url!r} does not match pinned "
            f"version {pin!r} — fix: remove node_modules and package-lock.json, then run npm install"
        )
    elif not isinstance(integrity, str) or not integrity.startswith("sha512-"):
        problems.append(
            f"{where}: integrity hash {integrity!r} is missing or not sha512 — "
            f"fix: remove node_modules and package-lock.json, then run npm install"
        )
    return problems


# --------------------------------------------------------------------------
# Check 3 — package metadata.
# --------------------------------------------------------------------------


def _files_entry_exists(agent: Path, entry: str) -> bool:
    pattern = entry.removeprefix("./").rstrip("/")
    if any(char in pattern for char in "*?["):
        return any(agent.glob(pattern))
    return (agent / pattern).exists()


def check_metadata(agent: Path) -> list[str]:
    manifest_path = agent / "package.json"
    manifest, error = _load_json(manifest_path)
    if manifest is None:
        assert error is not None
        return [error]
    where = _display(manifest_path)
    problems = []

    if manifest.get("license") != "MIT":
        problems.append(
            f'{where}: license is {manifest.get("license")!r} — fix: set "license": "MIT"'
        )
    if not (manifest.get("engines") or {}).get("node"):
        problems.append(
            f'{where}: engines.node is missing — fix: declare the supported Node '
            f'range, e.g. "engines": {{"node": ">=22.18"}}'
        )
    expected_directory = f"agents/{agent.name}"
    repository = manifest.get("repository")
    directory = repository.get("directory") if isinstance(repository, dict) else None
    if directory != expected_directory:
        problems.append(
            f"{where}: repository.directory is {directory!r} — fix: set it to "
            f'"{expected_directory}"'
        )
    files = manifest.get("files")
    if not isinstance(files, list):
        problems.append(
            f'{where}: "files" is missing — fix: list what the package publishes'
        )
    else:
        for entry in files:
            first_segment = entry.removeprefix("./").split("/", 1)[0]
            if first_segment == "dist":
                continue  # build output, absent from a clean checkout
            if not _files_entry_exists(agent, entry):
                problems.append(
                    f'{where}: "files" lists {entry!r} but '
                    f"{_display(agent / entry)} does not exist — fix: add it or "
                    f'drop it from "files"'
                )
    return problems


# --------------------------------------------------------------------------
# Check 4 — relative imports resolve.
# --------------------------------------------------------------------------


def _relative_specifiers(source: str) -> list[str]:
    stripped = _LINE_COMMENT.sub("", _BLOCK_COMMENT.sub("", source))
    return [match.group(2) for match in _IMPORT_SPECIFIER.finditer(stripped)]


def _resolve(importer: Path, specifier: str) -> Path | None:
    base = importer.parent / specifier
    suffix = base.suffix
    candidates: list[Path] = []
    if suffix in {".js", ".jsx"}:
        stem = base.with_suffix("")
        candidates += [stem.with_suffix(".ts"), stem.with_suffix(".tsx"), base]
    elif suffix == ".mjs":
        candidates += [base.with_suffix(".mts"), base]
    elif suffix == ".cjs":
        candidates += [base.with_suffix(".cts"), base]
    elif suffix in {".ts", ".tsx", ".mts", ".cts", ".json"}:
        candidates.append(base)
    else:
        candidates += [
            Path(f"{base}.ts"),
            Path(f"{base}.tsx"),
            base / "index.ts",
            base / "index.tsx",
        ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def check_relative_imports(agent: Path) -> list[str]:
    problems = []
    agent_root = agent.resolve()
    sources = sorted({
        path
        for folder in ("src", "test")
        if (agent / folder).is_dir()
        for pattern in ("*.ts", "*.tsx", "*.mts", "*.cts")
        for path in (agent / folder).rglob(pattern)
        if "node_modules" not in path.parts
    })
    for source in sources:
        for specifier in _relative_specifiers(source.read_text()):
            target = _resolve(source, specifier)
            if target is None:
                expected = _display(
                    (source.parent / specifier).with_suffix(".ts")
                    if specifier.endswith(".js")
                    else source.parent / specifier
                )
                problems.append(
                    f"{_display(source)}: imports {specifier!r} but {expected} does "
                    f"not exist — fix: import a module this package has, or "
                    f"delete the scaffold-copied code that needs it"
                )
            elif agent_root not in target.resolve().parents:
                problems.append(
                    f"{_display(source)}: imports {specifier!r}, which resolves "
                    f"outside {_display(agent)} — fix: depend on a published "
                    f"package instead of a sibling's files"
                )
    return problems


# --------------------------------------------------------------------------
# Check 5 — no Rule #38 rewriter scripts.
# --------------------------------------------------------------------------


def check_no_rewriters(agents_root: Path) -> list[str]:
    if not agents_root.is_dir():
        return []
    problems = []
    for path in sorted(agents_root.rglob("*")):
        relative_parts = path.relative_to(agents_root).parts
        if "node_modules" in relative_parts or not path.is_file():
            continue
        if any(pattern.search(path.name) for pattern in REWRITER_PATTERNS):
            problems.append(
                f"{_display(path)}: is a rewriter script or patch file (Rule #38 "
                f"bans fix*/iterate-*/apply-* scripts and *.patch/*.diff) — fix: "
                f"delete it and make the edit in place"
            )
    return problems


# --------------------------------------------------------------------------
# The real tree.
# --------------------------------------------------------------------------

REAL_AGENTS = discover_agents(AGENTS)
_AGENT_PARAMS = pytest.mark.parametrize(
    "agent", REAL_AGENTS, ids=[agent.name for agent in REAL_AGENTS]
)


def _report(problems: list[str]) -> str:
    return "\n" + "\n".join(f"  - {problem}" for problem in problems)


def test_agents_contract_0_agents_discovered() -> None:
    assert len(REAL_AGENTS) >= 1, (
        f"No agent packages discovered under {AGENTS}. "
        "At least one agent package with package.json must exist."
    )


@_AGENT_PARAMS
def test_agents_contract_1_sdk_pin_is_exact_and_released(agent: Path) -> None:
    problems = check_sdk_pin(agent, spec_version())
    assert not problems, _report(problems)


@_AGENT_PARAMS
def test_agents_contract_2_lockfile_resolves_the_pin(agent: Path) -> None:
    problems = check_lockfile(agent)
    assert not problems, _report(problems)


@_AGENT_PARAMS
def test_agents_contract_3_package_metadata(agent: Path) -> None:
    problems = check_metadata(agent)
    assert not problems, _report(problems)


@_AGENT_PARAMS
def test_agents_contract_4_relative_imports_resolve(agent: Path) -> None:
    problems = check_relative_imports(agent)
    assert not problems, _report(problems)


def test_agents_contract_5_no_rewriter_scripts() -> None:
    problems = check_no_rewriters(AGENTS)
    assert not problems, _report(problems)


# --------------------------------------------------------------------------
# Bite tests — each check rejects a broken synthetic package.
# --------------------------------------------------------------------------

FIXTURE_SPEC = "3.1.3"


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def _write_json(path: Path, data: dict) -> None:
    _write(path, json.dumps(data, indent=2))


def _manifest(agent: Path) -> dict:
    return json.loads((agent / "package.json").read_text())


def _lock(
    pin: str,
    *,
    root_pin: str | None = None,
    resolved_url: str | None = "default",
    integrity: str | None = "sha512-fixture",
) -> dict:
    sdk_entry: dict[str, str] = {"version": pin}
    if resolved_url == "default":
        sdk_entry["resolved"] = (
            f"https://registry.npmjs.org/@nrouter_ai/sdk/-/sdk-{pin}.tgz"
        )
    elif resolved_url is not None:
        sdk_entry["resolved"] = resolved_url
    if integrity is not None:
        sdk_entry["integrity"] = integrity
    return {
        "name": "@nrouter_ai/example-agent",
        "lockfileVersion": 3,
        "packages": {
            "": {"dependencies": {SDK_PACKAGE: root_pin if root_pin else pin}},
            f"node_modules/{SDK_PACKAGE}": sdk_entry,
        },
    }


@pytest.fixture
def good_agent(tmp_path: Path) -> Path:
    agent = tmp_path / "agents" / "example-agent"
    _write_json(
        agent / "package.json",
        {
            "name": "@nrouter_ai/example-agent",
            "version": "0.1.0",
            "license": "MIT",
            "engines": {"node": ">=22.18"},
            "files": ["dist", "README.md", "LICENSE", "skills"],
            "dependencies": {SDK_PACKAGE: FIXTURE_SPEC},
            "repository": {
                "type": "git",
                "url": "git+https://github.com/nRouterGateway/nrouter-sdk.git",
                "directory": "agents/example-agent",
            },
        },
    )
    _write_json(agent / "package-lock.json", _lock(FIXTURE_SPEC))
    _write(agent / "README.md", "# example\n")
    _write(agent / "LICENSE", "MIT\n")
    _write(agent / "skills" / "brand.md", "brand\n")
    _write(agent / "src" / "index.ts", "export * from './agent.js';\n")
    _write(
        agent / "src" / "agent.ts",
        "import { NRouter } from '@nrouter_ai/sdk';\n"
        "import type { Options } from './types/index.js';\n"
        "export const make = (o: Options) => new NRouter(o);\n",
    )
    _write(agent / "src" / "types" / "index.ts", "export type Options = {};\n")
    _write(
        agent / "test" / "agent.test.ts",
        "import { describe, it, vi } from 'vitest';\n"
        "// import { gone } from '../src/commented-out.js';\n"
        "import {\n  make,\n} from '../src/agent.js';\n"
        "import { helper } from './helpers.js';\n"
        "vi.mock('../src/types');\n"
        "const lazy = () => import('../src/index.js');\n",
    )
    _write(agent / "test" / "helpers.ts", "export const helper = 1;\n")
    return agent


def test_bite_0_good_fixture_passes_every_check(good_agent: Path) -> None:
    """Without this, every rejection below could be a checker that rejects all."""
    assert discover_agents(good_agent.parent) == [good_agent]
    assert check_sdk_pin(good_agent, FIXTURE_SPEC) == []
    assert check_lockfile(good_agent) == []
    assert check_metadata(good_agent) == []
    assert check_relative_imports(good_agent) == []
    assert check_no_rewriters(good_agent.parent) == []


@pytest.mark.parametrize(
    "pin",
    [
        "^3.1.3",
        "~3.1.3",
        "*",
        "latest",
        "3.x",
        "3",
        ">=3.1.0",
        "3.1.3 - 3.2.0",
        "3.1.3-beta.1",
        "v3.1.3",
        "file:../../sdks/js",
    ],
)
def test_bite_1_non_exact_pin_is_rejected(good_agent: Path, pin: str) -> None:
    manifest = _manifest(good_agent)
    manifest["dependencies"][SDK_PACKAGE] = pin
    _write_json(good_agent / "package.json", manifest)
    problems = check_sdk_pin(good_agent, FIXTURE_SPEC)
    assert problems and "not an exact" in problems[0], problems
    assert "package.json" in problems[0] and "fix:" in problems[0]


@pytest.mark.parametrize(
    ("pin", "reason"),
    [
        ("3.1.4", "unreleased"),
        ("3.2.0", "unreleased"),
        ("4.0.0", "major"),
        ("2.9.9", "major"),
    ],
)
def test_bite_1_wrong_major_or_future_pin_is_rejected(
    good_agent: Path, pin: str, reason: str
) -> None:
    manifest = _manifest(good_agent)
    manifest["dependencies"][SDK_PACKAGE] = pin
    _write_json(good_agent / "package.json", manifest)
    problems = check_sdk_pin(good_agent, FIXTURE_SPEC)
    assert any(reason in problem for problem in problems), problems


@pytest.mark.parametrize("pin", ["3.1.2", "3.0.0"])
def test_bite_1_lagging_pin_within_the_major_is_allowed(
    good_agent: Path, pin: str
) -> None:
    manifest = _manifest(good_agent)
    manifest["dependencies"][SDK_PACKAGE] = pin
    _write_json(good_agent / "package.json", manifest)
    assert check_sdk_pin(good_agent, FIXTURE_SPEC) == []


def test_bite_1_missing_sdk_dependency_is_rejected(good_agent: Path) -> None:
    manifest = _manifest(good_agent)
    manifest["dependencies"] = {}
    _write_json(good_agent / "package.json", manifest)
    problems = check_sdk_pin(good_agent, FIXTURE_SPEC)
    assert problems and "is missing" in problems[0], problems


def test_bite_1_missing_manifest_is_rejected(good_agent: Path) -> None:
    (good_agent / "package.json").unlink()
    problems = check_sdk_pin(good_agent, FIXTURE_SPEC)
    assert problems and "package.json is missing" in problems[0], problems


def test_bite_1_corrupt_manifest_is_rejected(good_agent: Path) -> None:
    _write(good_agent / "package.json", "{not valid json\n")
    problems = check_sdk_pin(good_agent, FIXTURE_SPEC)
    assert problems and "not valid JSON" in problems[0], problems


def test_bite_2_missing_lockfile_is_rejected(good_agent: Path) -> None:
    (good_agent / "package-lock.json").unlink()
    problems = check_lockfile(good_agent)
    assert problems and "package-lock.json is missing" in problems[0], problems


def test_bite_2_lockfile_resolving_another_version_is_rejected(
    good_agent: Path,
) -> None:
    _write_json(good_agent / "package-lock.json", _lock("3.1.2", root_pin=FIXTURE_SPEC))
    problems = check_lockfile(good_agent)
    assert any("resolves @nrouter_ai/sdk to 3.1.2" in p for p in problems), problems


def test_bite_2_stale_lockfile_root_is_rejected(good_agent: Path) -> None:
    _write_json(good_agent / "package-lock.json", _lock(FIXTURE_SPEC, root_pin="3.1.2"))
    problems = check_lockfile(good_agent)
    assert any("root package records" in p for p in problems), problems


def test_bite_2_lockfile_without_the_sdk_is_rejected(good_agent: Path) -> None:
    lock = _lock(FIXTURE_SPEC)
    del lock["packages"][f"node_modules/{SDK_PACKAGE}"]
    _write_json(good_agent / "package-lock.json", lock)
    problems = check_lockfile(good_agent)
    assert any("no resolved node_modules/@nrouter_ai/sdk" in p for p in problems), problems


def test_bite_2_corrupt_lockfile_is_rejected(good_agent: Path) -> None:
    _write(good_agent / "package-lock.json", "{not valid json\n")
    problems = check_lockfile(good_agent)
    assert problems and "not valid JSON" in problems[0], problems
    assert "fix: regenerate it" in problems[0]


def test_bite_2_lockfile_missing_or_mismatched_resolved_url_is_rejected(
    good_agent: Path,
) -> None:
    _write_json(
        good_agent / "package-lock.json",
        _lock(FIXTURE_SPEC, resolved_url=None),
    )
    problems = check_lockfile(good_agent)
    assert any("resolved tarball URL None" in p for p in problems), problems

    _write_json(
        good_agent / "package-lock.json",
        _lock(
            FIXTURE_SPEC,
            resolved_url="https://registry.npmjs.org/@nrouter_ai/sdk/-/sdk-3.1.2.tgz",
        ),
    )
    problems = check_lockfile(good_agent)
    assert any("does not match pinned version" in p for p in problems), problems

    _write_json(
        good_agent / "package-lock.json",
        _lock(FIXTURE_SPEC, integrity=None),
    )
    problems = check_lockfile(good_agent)
    assert any("integrity hash None" in p for p in problems), problems


@pytest.mark.parametrize(
    ("mutate", "needle"),
    [
        (lambda m: m.__setitem__("license", "Apache-2.0"), "license is 'Apache-2.0'"),
        (lambda m: m.pop("license"), "license is None"),
        (lambda m: m.pop("engines"), "engines.node is missing"),
        (lambda m: m.__setitem__("engines", {"npm": ">=10"}), "engines.node is missing"),
        (
            lambda m: m["repository"].__setitem__("directory", "agents/support-agent"),
            "repository.directory is 'agents/support-agent'",
        ),
        (
            lambda m: m.__setitem__("repository", "nRouterGateway/nrouter-sdk"),
            "repository.directory is None",
        ),
        (lambda m: m["files"].append("bin"), "\"files\" lists 'bin'"),
        (lambda m: m.pop("files"), '"files" is missing'),
    ],
)
def test_bite_3_bad_metadata_is_rejected(good_agent: Path, mutate, needle: str) -> None:
    manifest = _manifest(good_agent)
    mutate(manifest)
    _write_json(good_agent / "package.json", manifest)
    problems = check_metadata(good_agent)
    assert any(needle in problem for problem in problems), problems
    assert all("fix:" in problem for problem in problems), problems


def test_bite_3_dist_and_globs_are_handled(good_agent: Path) -> None:
    manifest = _manifest(good_agent)
    manifest["files"] += ["dist/**/*.js", "./dist", "skills/*.md", "./README.md"]
    _write_json(good_agent / "package.json", manifest)
    assert not (good_agent / "dist").exists()
    assert check_metadata(good_agent) == []
    manifest["files"].append("prompts/*.md")
    _write_json(good_agent / "package.json", manifest)
    assert any("prompts/*.md" in p for p in check_metadata(good_agent))


@pytest.mark.parametrize(
    ("relative", "source", "missing"),
    [
        ("test/store.test.ts", "import { s } from '../src/knowledge/store.js';\n", "store.js"),
        ("test/client.test.ts", "vi.mock('../src/client.js', () => ({}));\n", "client.js"),
        ("test/sse.test.ts", "const m = await import('../src/sse.js');\n", "sse.js"),
        ("test/side.test.ts", "import '../src/polyfill.js';\n", "polyfill.js"),
        ("test/req.test.ts", "const r = require('./missing.js');\n", "missing.js"),
        ("src/index.ts", "export { x } from './missing.js';\n", "missing.js"),
        ("src/export_star.ts", "export * from './missing.js';\n", "missing.js"),
        (
            "src/deep/thing.ts",
            "import {\n  a,\n  b,\n} from '../types/other.js';\n",
            "other.js",
        ),
    ],
)
def test_bite_4_unresolvable_relative_import_is_rejected(
    good_agent: Path, relative: str, source: str, missing: str
) -> None:
    _write(good_agent / relative, source)
    problems = check_relative_imports(good_agent)
    assert len(problems) == 1, problems
    assert relative in problems[0] and missing in problems[0], problems
    assert "fix:" in problems[0]


def test_bite_4_import_escaping_the_package_is_rejected(good_agent: Path) -> None:
    sibling = good_agent.parent / "other-agent" / "src" / "shared.ts"
    _write(sibling, "export const shared = 1;\n")
    _write(
        good_agent / "src" / "leak.ts",
        "export { shared } from '../../other-agent/src/shared.js';\n",
    )
    problems = check_relative_imports(good_agent)
    assert len(problems) == 1 and "resolves outside" in problems[0], problems


@pytest.mark.parametrize(
    "relative",
    [
        "fix-playwright.js",
        "iterate-skills.js",
        "apply-rename.sh",
        "fix_imports.py",
        "fixall.sh",
        "example-agent/scripts/fix-tests.mjs",
        "example-agent/change.patch",
        "example-agent/src/edit.diff",
    ],
)
def test_bite_5_rewriter_script_is_rejected(good_agent: Path, relative: str) -> None:
    agents_root = good_agent.parent
    _write(agents_root / relative, "// rewrite\n")
    problems = check_no_rewriters(agents_root)
    assert len(problems) == 1 and Path(relative).name in problems[0], problems
    assert "fix: delete it" in problems[0]


def test_bite_5_node_modules_and_lookalikes_are_ignored(good_agent: Path) -> None:
    agents_root = good_agent.parent
    _write(good_agent / "node_modules" / "pkg" / "fix-path.js", "x\n")
    _write(good_agent / "node_modules" / "pkg" / "a.patch", "x\n")
    _write(good_agent / "src" / "prefix.ts", "export {};\n")
    _write(good_agent / "test" / "fixtures.test.ts", "export {};\n")
    _write(good_agent / "test" / "fixtures.js", "export {};\n")
    _write(good_agent / ".gitignore", "node_modules\n")
    _write(good_agent / "e2e" / "fixtures" / "docs.md", "x\n")
    assert check_no_rewriters(agents_root) == []
