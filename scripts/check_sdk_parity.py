#!/usr/bin/env python3
"""Enforce cross-SDK parity across all 10 nRouter SDKs.

Verifies:
1. Master validation playbook template (docs/validation-playbook-template.md).
2. All 10 SDKs possess a `demo/` directory with entry points and README.
3. All 10 SDKs possess a `docs/validation-playbook.md` aligned with master template.
4. Single coordinated release version across spec/nrouter-sdk-spec.json and all 10 SDK manifests and lockfiles.
5. All 10 SDK READMEs and root README link to demos, playbooks, show canonical release version, and adhere to open-source standards.
6. Offline feature evidence across all SDKs (conformance/check_features.py).
7. Gateway contract compliance (conformance/check_conformance.py).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC_PATH = ROOT / "spec" / "nrouter-sdk-spec.json"
TEMPLATE_PATH = ROOT / "docs" / "validation-playbook-template.md"

ALL_SDKS = (
    "android",
    "dart",
    "go",
    "java",
    "js",
    "kotlin",
    "python",
    "r",
    "rust",
    "swift",
)

REQUIRED_PLAYBOOK_SECTIONS = (
    "## 1. Start from the Correct Branch",
    "## 2. Run the Existing",
    "## 3. Validate",
    "## 4. Validate",
    "## 5. Fresh Consumer Installation",
    "## 6. Live Core API Validation",
    "## 7.",
    "## 8. Error Matrix",
    "## 9. Cache Validation",
    "## 10. Guardrail Validation",
    "## 11. Routing / Model Validation",
    "# Manual Dashboard Verification",
)

PLAYBOOK_DIR = {"dart": "doc"}
ROUTING_HEADING = "## How guardrails, budgets and routing work"
ROUTING_LINK = "https://nrouter.ai/docs/guides/router-settings"


def check_template(root: Path = ROOT) -> list[str]:
    errors = []
    template_path = root / "docs" / "validation-playbook-template.md"
    if not template_path.is_file():
        errors.append(f"Missing master validation playbook template: {template_path}")
    elif len(template_path.read_text(encoding="utf-8").strip()) < 100:
        errors.append(f"Validation playbook template is too short/empty: {template_path}")
    return errors


def check_demos(root: Path = ROOT) -> list[str]:
    errors = []
    for sdk in ALL_SDKS:
        demo_dir = root / "sdks" / sdk / "demo"
        if not demo_dir.is_dir():
            errors.append(f"Missing demo directory: sdks/{sdk}/demo")
            continue
        readme = demo_dir / "README.md"
        if not readme.is_file():
            errors.append(f"Missing README.md in demo directory: sdks/{sdk}/demo/README.md")
        files = [f for f in demo_dir.iterdir() if f.name != "README.md" and not f.name.startswith(".")]
        if not files:
            errors.append(f"Demo directory contains no runnable files: sdks/{sdk}/demo")
    return errors


def check_playbooks(root: Path = ROOT) -> list[str]:
    errors = []
    for sdk in ALL_SDKS:
        rel = f"sdks/{sdk}/{PLAYBOOK_DIR.get(sdk, 'docs')}/validation-playbook.md"
        pb_path = root / rel
        if not pb_path.is_file():
            errors.append(f"Missing validation playbook: {rel}")
            continue
        content = pb_path.read_text(encoding="utf-8")
        for section in REQUIRED_PLAYBOOK_SECTIONS:
            if section not in content:
                errors.append(f"{rel} missing required section marker: '{section}'")
    return errors


def check_version_parity(root: Path = ROOT) -> list[str]:
    errors = []
    spec_path = root / "spec" / "nrouter-sdk-spec.json"
    if not spec_path.is_file():
        return [f"Missing {spec_path}"]
    try:
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
    except Exception as e:
        return [f"Unparseable {spec_path}: {e}"]
    canonical_version = spec.get("version")
    if not canonical_version:
        return [f"{spec_path} missing 'version' field"]

    def read_file(rel: str) -> str | None:
        p = root / rel
        if not p.is_file():
            errors.append(f"Missing manifest for version check: {rel}")
            return None
        return p.read_text(encoding="utf-8")

    # 1. JavaScript
    js_pkg = read_file("sdks/js/package.json")
    if js_pkg:
        v = json.loads(js_pkg).get("version")
        if v != canonical_version:
            errors.append(f"sdks/js/package.json version '{v}' != canonical '{canonical_version}'")

    js_lock = read_file("sdks/js/package-lock.json")
    if js_lock:
        lock_data = json.loads(js_lock)
        v = lock_data.get("version")
        root_v = ((lock_data.get("packages") or {}).get("") or {}).get("version")
        if v != canonical_version or root_v != canonical_version:
            errors.append(f"sdks/js/package-lock.json version '{v}'/'{root_v}' != canonical '{canonical_version}'")

    # 2. Python
    pyproject = read_file("sdks/python/pyproject.toml")
    if pyproject:
        m = re.search(r'^version\s*=\s*"([^"]+)"', pyproject, re.M)
        if not m or m.group(1) != canonical_version:
            v = m.group(1) if m else "unparseable"
            errors.append(f"sdks/python/pyproject.toml version '{v}' != canonical '{canonical_version}'")

    py_ver = read_file("sdks/python/nroutersdk/_version.py")
    if py_ver:
        m = re.search(r'^__version__\s*=\s*"([^"]+)"', py_ver, re.M)
        if not m or m.group(1) != canonical_version:
            v = m.group(1) if m else "unparseable"
            errors.append(f"sdks/python/nroutersdk/_version.py version '{v}' != canonical '{canonical_version}'")

    # 3. Java
    java_pom = read_file("sdks/java/pom.xml")
    if java_pom:
        try:
            pom = ET.fromstring(java_pom)
            v = pom.findtext("{http://maven.apache.org/POM/4.0.0}version")
            if v != canonical_version:
                errors.append(f"sdks/java/pom.xml version '{v}' != canonical '{canonical_version}'")
        except ET.ParseError:
            errors.append("sdks/java/pom.xml unparseable XML")

    # 4. Kotlin
    kot_prop = read_file("sdks/kotlin/gradle.properties")
    if kot_prop:
        m = re.search(r"^version\s*=\s*([^\s]+)$", kot_prop, re.M)
        if not m or m.group(1) != canonical_version:
            v = m.group(1) if m else "unparseable"
            errors.append(f"sdks/kotlin/gradle.properties version '{v}' != canonical '{canonical_version}'")

    # 5. Android
    and_prop = read_file("sdks/android/gradle.properties")
    if and_prop:
        m = re.search(r"^version\s*=\s*([^\s]+)$", and_prop, re.M)
        if not m or m.group(1) != canonical_version:
            v = m.group(1) if m else "unparseable"
            errors.append(f"sdks/android/gradle.properties version '{v}' != canonical '{canonical_version}'")

    and_build = read_file("sdks/android/build.gradle.kts")
    if and_build:
        m = re.search(r'nrouter-sdk-kotlin:([^"]+)"', and_build)
        if not m or m.group(1) != canonical_version:
            v = m.group(1) if m else "unparseable"
            errors.append(f"sdks/android/build.gradle.kts kotlin dependency version '{v}' != canonical '{canonical_version}'")

    # 6. Go
    go_ver = read_file("sdks/go/VERSION")
    if go_ver:
        v = go_ver.strip()
        if v != canonical_version:
            errors.append(f"sdks/go/VERSION '{v}' != canonical '{canonical_version}'")

    # 7. Rust
    rust_toml = read_file("sdks/rust/Cargo.toml")
    if rust_toml:
        m = re.search(r'^version\s*=\s*"([^"]+)"', rust_toml, re.M)
        if not m or m.group(1) != canonical_version:
            v = m.group(1) if m else "unparseable"
            errors.append(f"sdks/rust/Cargo.toml version '{v}' != canonical '{canonical_version}'")

    rust_lock = read_file("sdks/rust/Cargo.lock")
    if rust_lock:
        m = re.search(r'\[\[package\]\]\s+name = "nrouter"\s+version = "([^"]+)"', rust_lock)
        if not m or m.group(1) != canonical_version:
            v = m.group(1) if m else "unparseable"
            errors.append(f"sdks/rust/Cargo.lock version '{v}' != canonical '{canonical_version}'")

    # 8. Swift
    swift_ver = read_file("sdks/swift/VERSION")
    if swift_ver:
        v = swift_ver.strip()
        if v != canonical_version:
            errors.append(f"sdks/swift/VERSION '{v}' != canonical '{canonical_version}'")

    # 9. Dart
    dart_pub = read_file("sdks/dart/pubspec.yaml")
    if dart_pub:
        m = re.search(r"^version:\s*([^\s]+)$", dart_pub, re.M)
        if not m or m.group(1) != canonical_version:
            v = m.group(1) if m else "unparseable"
            errors.append(f"sdks/dart/pubspec.yaml version '{v}' != canonical '{canonical_version}'")

    # 10. R
    r_desc = read_file("sdks/r/DESCRIPTION")
    if r_desc:
        m = re.search(r"^Version:\s*([^\s]+)$", r_desc, re.M)
        if not m or m.group(1) != canonical_version:
            v = m.group(1) if m else "unparseable"
            errors.append(f"sdks/r/DESCRIPTION version '{v}' != canonical '{canonical_version}'")

    return errors


def check_readme_parity(root: Path = ROOT) -> list[str]:
    errors = []
    spec_path = root / "spec" / "nrouter-sdk-spec.json"
    canonical_version = "3.1.2"
    if spec_path.is_file():
        try:
            canonical_version = json.loads(spec_path.read_text(encoding="utf-8")).get("version", canonical_version)
        except Exception:
            pass

    for sdk in ALL_SDKS:
        readme_path = root / "sdks" / sdk / "README.md"
        if not readme_path.is_file():
            errors.append(f"sdks/{sdk}: missing README.md")
            continue
        text = readme_path.read_text(encoding="utf-8")
        if len(text.strip()) < 200:
            errors.append(f"sdks/{sdk}/README.md is too short (< 200 characters)")

        # Link to demos
        if "demo/" not in text:
            errors.append(f"sdks/{sdk}/README.md does not link to demo/ directory")

        # Link to validation playbook
        playbook_name = "validation-playbook"
        if playbook_name not in text:
            errors.append(f"sdks/{sdk}/README.md does not link to validation playbook")

        # Check for stale versions
        for stale in ("3.0.0", "3.1.0"):
            if stale != canonical_version and stale in text:
                errors.append(f"sdks/{sdk}/README.md contains stale version {stale!r} (expected {canonical_version!r})")

        # Check for obsolete publishing claims
        if "publish = false" in text:
            errors.append(f"sdks/{sdk}/README.md contains obsolete 'publish = false'")
        if "publish_to: none" in text:
            errors.append(f"sdks/{sdk}/README.md contains obsolete 'publish_to: none'")

        # Required routing section & link
        if ROUTING_HEADING not in text:
            errors.append(f"sdks/{sdk}/README.md missing required section: {ROUTING_HEADING!r}")
        if ROUTING_LINK not in text:
            errors.append(f"sdks/{sdk}/README.md does not link to {ROUTING_LINK}")

        # Open-source license / repo link
        if "license" not in text.lower():
            errors.append(f"sdks/{sdk}/README.md missing License section/link")

    # Root README check
    root_readme = root / "README.md"
    if not root_readme.is_file():
        errors.append("Root README.md is missing")
    else:
        root_text = root_readme.read_text(encoding="utf-8")
        if canonical_version not in root_text:
            errors.append(f"Root README.md does not reference canonical version {canonical_version!r}")
        if "3.1.0 |" in root_text or "3.0.0 |" in root_text:
            errors.append("Root README.md table contains stale version reference")

    return errors


def check_feature_parity(root: Path = ROOT) -> list[str]:
    sys.path.insert(0, str(root / "conformance"))
    try:
        import check_features
        rows = check_features.report(root)
        missing = [r for r in rows if r.get("status") == "MISSING"]
        if missing:
            return [f"Feature {m['feature']} MISSING for {m['sdk']}" for m in missing]
        return []
    except Exception as e:
        return [f"Feature parity check failed with error: {e}"]


def check_gateway_conformance(root: Path = ROOT) -> list[str]:
    sys.path.insert(0, str(root / "conformance"))
    try:
        import check_conformance
        failures = check_conformance.check(root)
        return [f"Conformance failure: {f}" for f in failures]
    except Exception as e:
        return [f"Conformance check failed with error: {e}"]


def self_test() -> int:
    print("=== check_sdk_parity --self-test ===")
    with tempfile.TemporaryDirectory() as td:
        fake_root = Path(td)
        
        # 1. Test template check bites
        assert check_template(fake_root), "check_template must fail on missing template"
        
        # Build minimal valid skeleton
        (fake_root / "docs").mkdir(parents=True)
        (fake_root / "docs" / "validation-playbook-template.md").write_text("# Template\n" + "x" * 200, encoding="utf-8")
        assert not check_template(fake_root), "check_template must pass on valid template"

        # 2. Test demo check bites
        (fake_root / "sdks").mkdir()
        for sdk in ALL_SDKS:
            d = fake_root / "sdks" / sdk / "demo"
            d.mkdir(parents=True)
            (d / "README.md").write_text("# Demo", encoding="utf-8")
            (d / "run.txt").write_text("entry", encoding="utf-8")
        assert not check_demos(fake_root), "check_demos must pass on valid demos"
        
        # Break one demo
        (fake_root / "sdks" / "go" / "demo" / "run.txt").unlink()
        assert check_demos(fake_root), "check_demos must fail on missing runnable files"
        (fake_root / "sdks" / "go" / "demo" / "run.txt").write_text("entry", encoding="utf-8")

        # 3. Test playbook check bites
        for sdk in ALL_SDKS:
            pb_dir = fake_root / "sdks" / sdk / PLAYBOOK_DIR.get(sdk, "docs")
            pb_dir.mkdir(parents=True, exist_ok=True)
            pb_text = "\n".join(REQUIRED_PLAYBOOK_SECTIONS)
            (pb_dir / "validation-playbook.md").write_text(pb_text, encoding="utf-8")
        assert not check_playbooks(fake_root), "check_playbooks must pass on valid playbooks"

        (fake_root / "sdks" / "rust" / "docs" / "validation-playbook.md").write_text("empty", encoding="utf-8")
        assert check_playbooks(fake_root), "check_playbooks must fail on missing sections"
        (fake_root / "sdks" / "rust" / "docs" / "validation-playbook.md").write_text("\n".join(REQUIRED_PLAYBOOK_SECTIONS), encoding="utf-8")

        # 4. Test version check bites
        (fake_root / "spec").mkdir()
        (fake_root / "spec" / "nrouter-sdk-spec.json").write_text(json.dumps({"version": "3.1.2"}), encoding="utf-8")
        (fake_root / "sdks" / "go" / "VERSION").write_text("3.1.0", encoding="utf-8")
        assert check_version_parity(fake_root), "check_version_parity must fail on mismatched version"
        (fake_root / "sdks" / "go" / "VERSION").write_text("3.1.2", encoding="utf-8")

        # 5. Test readme parity bites
        valid_readme = (
            "# nRouter SDK\n"
            + "x" * 250
            + "\n[demo/](demo/)\n[validation-playbook](docs/validation-playbook.md)\n"
            + f"version 3.1.2\n{ROUTING_HEADING}\n{ROUTING_LINK}\nLicense: MIT\n"
        )
        for sdk in ALL_SDKS:
            r = fake_root / "sdks" / sdk / "README.md"
            r.write_text(valid_readme, encoding="utf-8")
        (fake_root / "README.md").write_text("# Root\n3.1.2\n", encoding="utf-8")
        assert not check_readme_parity(fake_root), "check_readme_parity must pass on valid readmes"

        # Stale version in README must fail
        (fake_root / "sdks" / "python" / "README.md").write_text(valid_readme + "version 3.1.0\n", encoding="utf-8")
        assert check_readme_parity(fake_root), "check_readme_parity must fail on stale version"

    print("[OK] check_sdk_parity self-test passed")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Enforce cross-SDK parity across all 10 nRouter SDKs.")
    parser.add_argument("--self-test", action="store_true", help="Run self-test suite")
    parser.add_argument("--offline", action="store_true", help="Run structural parity checks without full conformance suite")
    args = parser.parse_args()

    if args.self_test:
        return self_test()

    all_errors = []
    print("=== nRouter Cross-SDK Parity Checker ===")

    # 1. Master template
    t_err = check_template(ROOT)
    all_errors.extend(t_err)
    print(f"[{'FAIL' if t_err else 'OK'}] Master validation playbook template")

    # 2. Demos in all 10 SDKs
    d_err = check_demos(ROOT)
    all_errors.extend(d_err)
    print(f"[{'FAIL' if d_err else 'OK'}] Demo directories in all 10 SDKs")

    # 3. Validation playbooks in all 10 SDKs
    p_err = check_playbooks(ROOT)
    all_errors.extend(p_err)
    print(f"[{'FAIL' if p_err else 'OK'}] Validation playbooks in all 10 SDKs")

    # 4. Version parity across manifests & lockfiles
    v_err = check_version_parity(ROOT)
    all_errors.extend(v_err)
    print(f"[{'FAIL' if v_err else 'OK'}] Synchronized release version across all 10 manifests & lockfiles")

    # 5. README & open-source documentation parity
    r_err = check_readme_parity(ROOT)
    all_errors.extend(r_err)
    print(f"[{'FAIL' if r_err else 'OK'}] Open-source README parity (demos, playbooks, versions, routing)")

    # 6. Feature surface parity
    f_err = check_feature_parity(ROOT)
    all_errors.extend(f_err)
    print(f"[{'FAIL' if f_err else 'OK'}] Feature surface parity across all 10 SDKs (check_features)")

    # 7. Gateway contract compliance
    if not args.offline:
        c_err = check_gateway_conformance(ROOT)
        all_errors.extend(c_err)
        print(f"[{'FAIL' if c_err else 'OK'}] Gateway contract compliance across all 10 SDKs (check_conformance)")

    if all_errors:
        print("\nPARITY FAILURES:")
        for err in all_errors:
            print(f"  - {err}")
        return 1

    print("\nALL 10 SDKS ARE IN FULL PARITY (Demos, Playbooks, Manifests, READMEs, Features, Conformance)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

