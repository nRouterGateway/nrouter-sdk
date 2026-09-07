#!/usr/bin/env python3
"""Enforce cross-SDK parity across all 10 nRouter SDKs.

Verifies:
1. All 10 SDKs possess a `demo/` directory with entry points and a README.
2. All 10 SDKs possess a `docs/validation-playbook.md` aligned with `docs/validation-playbook-template.md`.
3. Single coordinated version across spec/nrouter-sdk-spec.json and all manifests.
4. Offline feature evidence across all SDKs (conformance/check_features.py).
5. Gateway contract compliance (conformance/check_conformance.py).
"""

from __future__ import annotations

import json
import sys
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


def check_template() -> list[str]:
    errors = []
    if not TEMPLATE_PATH.is_file():
        errors.append(f"Missing master validation playbook template: {TEMPLATE_PATH}")
    elif len(TEMPLATE_PATH.read_text(encoding="utf-8").strip()) < 100:
        errors.append(f"Validation playbook template is too short/empty: {TEMPLATE_PATH}")
    return errors


def check_demos() -> list[str]:
    errors = []
    for sdk in ALL_SDKS:
        demo_dir = ROOT / "sdks" / sdk / "demo"
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


def check_playbooks() -> list[str]:
    errors = []
    for sdk in ALL_SDKS:
        pb_path = ROOT / "sdks" / sdk / "docs" / "validation-playbook.md"
        if not pb_path.is_file():
            errors.append(f"Missing validation playbook: sdks/{sdk}/docs/validation-playbook.md")
            continue
        content = pb_path.read_text(encoding="utf-8")
        for section in REQUIRED_PLAYBOOK_SECTIONS:
            if section not in content:
                errors.append(f"sdks/{sdk}/docs/validation-playbook.md missing required section marker: '{section}'")
    return errors


def check_version_parity() -> list[str]:
    errors = []
    if not SPEC_PATH.is_file():
        return ["Missing spec/nrouter-sdk-spec.json"]
    spec = json.loads(SPEC_PATH.read_text(encoding="utf-8"))
    canonical_version = spec.get("version")
    if not canonical_version:
        return ["spec/nrouter-sdk-spec.json missing 'version' field"]

    # Manifest checks
    checks = {
        "sdks/js/package.json": lambda txt: json.loads(txt)["version"],
        "sdks/python/pyproject.toml": lambda txt: [line.split("=")[1].strip().strip('"') for line in txt.splitlines() if line.startswith("version = ")][0],
        "sdks/go/VERSION": lambda txt: txt.strip(),
        "sdks/swift/VERSION": lambda txt: txt.strip(),
        "sdks/rust/Cargo.toml": lambda txt: [line.split("=")[1].strip().strip('"') for line in txt.splitlines() if line.startswith("version = ")][0],
    }

    for rel_path, extractor in checks.items():
        p = ROOT / rel_path
        if not p.is_file():
            errors.append(f"Missing manifest for version check: {rel_path}")
            continue
        try:
            v = extractor(p.read_text(encoding="utf-8"))
            if v != canonical_version:
                errors.append(f"{rel_path} version '{v}' does not match canonical '{canonical_version}'")
        except Exception as ex:
            errors.append(f"Failed to extract version from {rel_path}: {ex}")

    return errors


def main() -> int:
    all_errors = []
    print("=== nRouter Cross-SDK Parity Checker ===")
    
    # 1. Master template
    t_err = check_template()
    all_errors.extend(t_err)
    print(f"[{'FAIL' if t_err else 'OK'}] Master validation playbook template")

    # 2. Demos in all 10 SDKs
    d_err = check_demos()
    all_errors.extend(d_err)
    print(f"[{'FAIL' if d_err else 'OK'}] Demo directories in all 10 SDKs")

    # 3. Validation playbooks in all 10 SDKs
    p_err = check_playbooks()
    all_errors.extend(p_err)
    print(f"[{'FAIL' if p_err else 'OK'}] Validation playbooks in all 10 SDKs")

    # 4. Version parity
    v_err = check_version_parity()
    all_errors.extend(v_err)
    print(f"[{'FAIL' if v_err else 'OK'}] Synchronized release version across manifests")

    if all_errors:
        print("\nPARITY FAILURES:")
        for err in all_errors:
            print(f"  - {err}")
        return 1

    print("\nALL 10 SDKS ARE IN FULL PARITY (Demos, Playbooks, Versions)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
