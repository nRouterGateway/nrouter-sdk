#!/usr/bin/env python3
"""Check that model names in SDK examples and documentation match served models from /v1/models."""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

# Directories to skip when scanning example and documentation files
IGNORED_DIRS = {
    "node_modules",
    "target",
    "dist",
    ".venv",
    "venv",
    "__pycache__",
    ".git",
    ".pytest_cache",
    ".ruff_cache",
    ".mypy_cache",
    ".build",
    "build",
    ".gradle",
    ".dart_tool",
    ".kotlin",
}

# Vendored lockfiles to skip
IGNORED_FILES = {
    "package-lock.json",
    "Cargo.lock",
    "poetry.lock",
    "Pipfile.lock",
    "yarn.lock",
    "pnpm-lock.yaml",
    "composer.lock",
}

# Conservative candidate extraction patterns across languages
MODEL_PATTERNS = [
    # model="..." or model='...' or Model = "..."
    re.compile(r"""(?i)\bmodel\s*=\s*["']([^"']+)["']"""),
    # model: "..." or "model": "..." or 'model': '...'
    re.compile(r"""(?i)(?:["']model["']|\bmodel)\s*:\s*["']([^"']+)["']"""),
    # "model" => "..."
    re.compile(r"""(?i)["']model["']\s*=>\s*["']([^"']+)["']"""),
    # .model("...")
    re.compile(r"""(?i)\.model\s*\(\s*["']([^"']+)["']\s*\)"""),
    # .put("model", "...") or put("model", "...")
    re.compile(r"""(?i)(?:\.put|\.set|\.add|\.with|\bput)\s*\(\s*["']model["']\s*,\s*["']([^"']+)["']\s*\)"""),
    # model <- "..." (R)
    re.compile(r"""(?i)\bmodel\s*<-\s*["']([^"']+)["']"""),
]


def is_placeholder_or_router(candidate: str) -> bool:
    """Return True if candidate is an obvious placeholder or router id."""
    candidate = candidate.strip()
    if not candidate:
        return True
    if any(ch in candidate for ch in ("<", "{", "$")):
        return True
    if "YOUR_" in candidate:
        return True
    if "your-model" in candidate.lower():
        return True
    if "…" in candidate or "..." in candidate:
        return True
    if candidate.startswith("nrouter/"):
        return True
    return False


def https_only_opener() -> urllib.request.OpenerDirector:
    """Return an opener that can speak https and nothing else.

    It is assembled handler by handler instead of taken from `build_opener()`,
    whose defaults also open http://, ftp://, file:// and data: URLs and follow
    redirects. This one has no handler for any of those: another scheme is an
    "unknown url type" error, and a redirect is an HTTP error, never a second
    request. An https proxy from the environment is still honoured.
    """
    proxies = urllib.request.getproxies()
    opener = urllib.request.OpenerDirector()
    for handler in (
        urllib.request.ProxyHandler({"https": proxies["https"]} if "https" in proxies else {}),
        urllib.request.UnknownHandler(),
        urllib.request.HTTPSHandler(),
        urllib.request.HTTPDefaultErrorHandler(),
        urllib.request.HTTPErrorProcessor(),
    ):
        opener.add_handler(handler)
    return opener


def _without_credentials(target: str) -> str:
    """The URL as it may be shown in an error: any ``user:password@`` removed.

    Done on the text, not on a parsed URL, so it also works for a URL that does
    not parse (a bad port), which is exactly when an error quotes it.
    """
    scheme, sep, rest = target.partition("://")
    if not sep:
        return target
    authority, slash, tail = rest.partition("/")
    return f"{scheme}://{authority.rpartition('@')[2]}{slash}{tail}"


def fetch_served_models(target: str) -> str:
    """Fetch the served-model document from an https:// URL and return its text.

    The URL comes from the command line, so it is validated before anything is
    opened: https only, a host, no embedded credentials, a valid port. The
    request is then made to exactly that host over TLS. A redirect is not
    followed; it is reported as a failure, so the check never reads a list from
    a host the caller did not name.
    """
    shown = _without_credentials(target)
    try:
        parts = urllib.parse.urlsplit(target)
        port = parts.port
    except ValueError as err:
        raise ValueError(f"Invalid served models URL {shown}: {err}") from err

    if parts.scheme != "https":
        raise ValueError(
            f"Refusing to fetch served models from {shown}: only https:// URLs are accepted"
        )
    if not parts.hostname:
        raise ValueError(f"Invalid served models URL {shown}: no host")
    if parts.username is not None or parts.password is not None:
        raise ValueError("Invalid served models URL: credentials in the URL are not accepted")

    # Rebuilt from the validated parts, so what is requested is what was checked.
    host = parts.hostname if ":" not in parts.hostname else f"[{parts.hostname}]"
    netloc = host if port is None else f"{host}:{port}"
    url = urllib.parse.urlunsplit(("https", netloc, parts.path or "/", parts.query, ""))

    req = urllib.request.Request(url, headers={"User-Agent": "nrouter-sdk-conformance"})
    try:
        with https_only_opener().open(req, timeout=30) as resp:
            return resp.read().decode("utf-8")
    except Exception as err:
        raise ValueError(f"Failed to fetch served models from {shown}: {err}") from err


def load_served_models(target: str) -> set[str]:
    """Load served models from a local file or https:// URL.

    Accepts OpenAI-shaped {"object":"list","data":[{"id":"..."}]} or a plain JSON array of ids.
    """
    if target.startswith(("http://", "https://")):
        content = fetch_served_models(target)
    else:
        file_path = Path(target)
        if not file_path.exists():
            raise ValueError(f"Served models file does not exist: {target}")
        try:
            content = file_path.read_text(encoding="utf-8")
        except Exception as err:
            raise ValueError(f"Failed to read served models file {target}: {err}") from err

    try:
        data = json.loads(content)
    except Exception as err:
        raise ValueError(f"Invalid JSON in served models from {target}: {err}") from err

    raw_ids: list[Any] = []
    if isinstance(data, list):
        for item in data:
            if isinstance(item, str):
                raw_ids.append(item)
            elif isinstance(item, dict) and "id" in item:
                raw_ids.append(item["id"])
    elif isinstance(data, dict):
        if "data" in data and isinstance(data["data"], list):
            for item in data["data"]:
                if isinstance(item, dict) and "id" in item:
                    raw_ids.append(item["id"])
                elif isinstance(item, str):
                    raw_ids.append(item)
        elif "model_names" in data and isinstance(data["model_names"], list):
            for item in data["model_names"]:
                if isinstance(item, str):
                    raw_ids.append(item)

    served = {str(item).strip() for item in raw_ids if str(item).strip()}
    if not served:
        raise ValueError(f"Empty served model list from {target}")

    return served


class CheckResult(tuple):
    """Result tuple of (exit_code, findings, scanned_count, served_count) with optional error message."""

    error: str | None

    def __new__(
        cls,
        values: tuple[int, list[dict[str, Any]], int, int],
        error: str | None = None,
    ) -> CheckResult:
        inst = super().__new__(cls, values)
        inst.error = error
        return inst


def should_scan_file(p: Path, root: Path) -> bool:
    """Determine whether a file is an example or documentation file under root.

    Scope includes:
    - Root README files and SDK/agent README files
    - Paths under sdks/ (and agents/ if present) whose segments include examples, example, or demo
    - Documentation files under docs/ or sdks/**/docs/
    - OpenAPI/JSON specifications under spec/**/*.json
    """
    try:
        rel = p.relative_to(root)
    except ValueError:
        return False

    for part in rel.parts[:-1]:
        if part in IGNORED_DIRS:
            return False

    # Skip test fixtures of other checks
    if "fixtures" in rel.parts[:-1]:
        return False

    if p.name in IGNORED_FILES or p.name.endswith(".lock"):
        return False

    parts = rel.parts
    parts_set = set(parts[:-1])

    # 1. Root README* or SDK/agent README*
    if p.name.startswith("README"):
        if len(parts) == 1 or parts[0] in ("sdks", "agents"):
            return True

    # 2. Paths under sdks/ or agents/ whose segments include examples, example, or demo
    if parts[0] in ("sdks", "agents") and bool(parts_set & {"examples", "example", "demo"}):
        return True

    # 3. docs/** or sdks/**/docs/** or agents/**/docs/**
    if parts[0] in ("docs", "doc") or (parts[0] in ("sdks", "agents") and bool(parts_set & {"docs", "doc"})):
        return True

    # 4. spec/**/*.json
    if parts[0] == "spec" and p.suffix == ".json":
        return True

    return False


def discover_files(root: Path) -> list[Path]:
    """Discover all example and documentation files under root."""
    matched: list[Path] = []
    for p in root.rglob("*"):
        if p.is_file() and should_scan_file(p, root):
            matched.append(p)
    return sorted(matched)


def scan_file_for_models(file_path: Path) -> list[tuple[int, str]]:
    """Extract (line_number, model_id) candidates from file."""
    candidates: list[tuple[int, str]] = []
    with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
        for line_no, line in enumerate(f, 1):
            seen_on_line: set[str] = set()
            for pat in MODEL_PATTERNS:
                for m in pat.finditer(line):
                    val = m.group(1).strip()
                    if val and not is_placeholder_or_router(val):
                        if val not in seen_on_line:
                            seen_on_line.add(val)
                            candidates.append((line_no, val))
    return candidates


def run_check(
    root_path: Path,
    served_target: str,
    as_json: bool = False,
) -> CheckResult:
    """Run the conformance check and return (exit_code, findings, scanned_count, served_count)."""
    try:
        served_models = load_served_models(served_target)
    except ValueError as err:
        err_msg = f"Error loading served models: {err}"
        sys.stderr.write(f"{err_msg}\n")
        return CheckResult((2, [], 0, 0), error=err_msg)

    if not root_path.exists():
        err_msg = f"Root directory does not exist: {root_path}"
        sys.stderr.write(f"Error: {err_msg}\n")
        return CheckResult((2, [], 0, 0), error=err_msg)

    files = discover_files(root_path)
    findings: list[dict[str, Any]] = []

    for file_path in files:
        try:
            rel_path = str(file_path.relative_to(root_path))
        except ValueError:
            rel_path = str(file_path)

        try:
            candidates = scan_file_for_models(file_path)
        except OSError as err:
            err_msg = f"Failed to read file {rel_path}: {err}"
            sys.stderr.write(f"Error: {err_msg}\n")
            return CheckResult((2, [], 0, 0), error=err_msg)

        for line_no, model_id in candidates:
            if model_id not in served_models:
                findings.append({
                    "file": rel_path,
                    "line": line_no,
                    "model": model_id,
                })

    findings.sort(key=lambda x: (x["file"], x["line"], x["model"]))
    exit_code = 1 if findings else 0
    return CheckResult((exit_code, findings, len(files), len(served_models)))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Verify that model names in SDK examples and documentation match served models."
    )
    parser.add_argument(
        "--served",
        required=True,
        help="Path or URL returning served models (OpenAI list or plain array).",
    )
    parser.add_argument(
        "--root",
        default=None,
        help="Root directory of the SDK (defaults to repo root).",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output findings as JSON.",
    )

    args = parser.parse_args(argv)

    if args.root:
        root_path = Path(args.root).resolve()
    else:
        root_path = Path(__file__).resolve().parent.parent

    res = run_check(
        root_path=root_path,
        served_target=args.served,
        as_json=args.json,
    )
    exit_code, findings, scanned_count, served_count = res

    if exit_code == 2:
        if args.json:
            error_msg = getattr(res, "error", None) or "Fatal error"
            out = {
                "error": error_msg,
                "findings": [],
                "scanned_files": 0,
                "served_count": 0,
            }
            print(json.dumps(out, indent=2))
        return 2

    if args.json:
        out = {
            "findings": findings,
            "scanned_files": scanned_count,
            "served_count": served_count,
        }
        print(json.dumps(out, indent=2))
    else:
        for f in findings:
            print(f"{f['file']}:{f['line']}: model id \"{f['model']}\" is not served by /v1/models")

    return exit_code


if __name__ == "__main__":
    sys.exit(main())

