"""Cross-registry release-train invariants.

Package managers store versions differently, but one nRouter SDK generation
must have one public version.  This gate reads the actual distribution
metadata rather than a hand-maintained documentation table.
"""

from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python 3.10 CI
    import tomli as tomllib  # type: ignore[no-redef]


ROOT = Path(__file__).resolve().parents[1]


def _property(path: Path, name: str) -> str:
    for line in path.read_text().splitlines():
        key, separator, value = line.partition("=")
        if separator and key.strip() == name:
            return value.strip()
    raise AssertionError(f"{path.relative_to(ROOT)} has no {name}= property")


def _matched(path: Path, pattern: str) -> str:
    match = re.search(pattern, path.read_text(), flags=re.MULTILINE)
    if match is None:
        raise AssertionError(f"{path.relative_to(ROOT)} has no release version")
    return match.group(1)


def test_sdk_version_1_all_release_metadata_matches_contract() -> None:
    canonical = json.loads((ROOT / "spec/nrouter-sdk-spec.json").read_text())["version"]
    with (ROOT / "sdks/python/pyproject.toml").open("rb") as handle:
        python_version = tomllib.load(handle)["project"]["version"]
    with (ROOT / "sdks/rust/Cargo.toml").open("rb") as handle:
        rust_version = tomllib.load(handle)["package"]["version"]

    pom = ET.parse(ROOT / "sdks/java/pom.xml").getroot()
    namespace = {"m": "http://maven.apache.org/POM/4.0.0"}

    versions = {
        "javascript": json.loads((ROOT / "sdks/js/package.json").read_text())[
            "version"
        ],
        "python": python_version,
        "java": pom.findtext("m:version", namespaces=namespace),
        "kotlin": _property(ROOT / "sdks/kotlin/gradle.properties", "version"),
        "android": _property(ROOT / "sdks/android/gradle.properties", "version"),
        "android dependency lock": _matched(
            ROOT / "sdks/android/gradle.lockfile",
            r"^ai\.nrouter:nrouter-sdk-kotlin:([^=]+)=",
        ),
        "go": (ROOT / "sdks/go/VERSION").read_text().strip()
        if (ROOT / "sdks/go/VERSION").exists()
        else "<missing>",
        "rust": rust_version,
        "swift": (ROOT / "sdks/swift/VERSION").read_text().strip()
        if (ROOT / "sdks/swift/VERSION").exists()
        else "<missing>",
        "dart": _matched(ROOT / "sdks/dart/pubspec.yaml", r"^version:\s*([^\s]+)$"),
        "r": _matched(ROOT / "sdks/r/DESCRIPTION", r"^Version:\s*([^\s]+)$"),
    }

    assert versions == dict.fromkeys(versions, canonical), versions


def test_sdk_version_2_go_module_path_carries_the_release_major() -> None:
    version = (ROOT / "sdks/go/VERSION").read_text().strip()
    major = int(version.split(".", 1)[0])
    module = (
        (ROOT / "sdks/go/go.mod").read_text().splitlines()[0].removeprefix("module ")
    )

    if major >= 2:
        assert module.endswith(
            f"/v{major}"
        ), f"Go {version} requires a /v{major} module path; got {module}"


def test_sdk_version_3_source_only_workflows_cannot_publish() -> None:
    """Kotlin and Android stay source-only until Central signing is wired.

    Maven Central rejects unsigned artifacts and never lets one be replaced, so
    these two keep the credential-free shape until a `signing {}` block and a
    Central repository land together.  Rust and Dart left this set once their
    registry metadata was complete; see the publishable test below.
    """
    for sdk in ("android",):
        workflow = (ROOT / f".github/workflows/publish-{sdk}.yml").read_text()
        assert "publishToMavenLocal" in workflow
        assert "secrets." not in workflow, f"{sdk} workflow accepts release credentials"

    for sdk in ("android",):
        build = (ROOT / f"sdks/{sdk}/build.gradle.kts").read_text()
        assert "signing {" not in build


def test_sdk_version_5_kotlin_release_cannot_skip_signing_or_staging() -> None:
    """Kotlin publishes to Central, so the two irreversible mistakes get gates.

    Central assigns a coordinate permanently on release and rejects unsigned
    artifacts only after the upload has consumed the deployment name.  So the
    workflow must (a) verify a signature exists before uploading and (b) stage
    rather than auto-release.  Neither is provable by running the happy path.
    """
    workflow = (ROOT / ".github/workflows/publish-kotlin.yml").read_text()

    assert "publishingType=USER_MANAGED" in workflow, (
        "kotlin uploads must stage; AUTOMATIC makes the coordinate permanent"
    )
    assert "publishingType=AUTOMATIC" not in workflow
    assert "Refuse an unsigned bundle" in workflow, "no pre-upload signature check"
    # Asserting the step's NAME would pass against a step that checks nothing.
    # These two assert the mechanism that makes it non-vacuous: it counts the
    # artifacts first, so an empty staging directory fails instead of reporting
    # success after zero iterations.
    assert 'signable="$(find' in workflow, "signature check does not count artifacts"
    assert '"$signable" -lt 3' in workflow, "no floor on the artifact count"
    assert "no version= in" in workflow, "an empty version would release no coordinate"

    # A release step that runs on a pull request would leak release credentials
    # to any fork that opens one.
    assert "github.ref == 'refs/heads/main'" in workflow

    build = (ROOT / "sdks/kotlin/build.gradle.kts").read_text()
    assert "signing" in build
    assert "useInMemoryPgpKeys" in build, "a keyring import outlives the step"


def test_sdk_version_4_publishable_sdks_carry_registry_metadata() -> None:
    """A publishable SDK must be publishable for real, not merely unblocked.

    Removing `publish = false` or `publish_to: none` is one line; a registry
    rejects the upload for a different set of reasons, and on crates.io and
    pub.dev a version number is spent the moment it is accepted.  This asserts
    the fields those two registries actually require.
    """
    with (ROOT / "sdks/rust/Cargo.toml").open("rb") as handle:
        package = tomllib.load(handle)["package"]
    assert package.get("publish") is not False, "rust is blocked from publishing"
    for field in ("description", "license", "repository", "readme"):
        assert package.get(field), f"crates.io requires package.{field}"

    pubspec = (ROOT / "sdks/dart/pubspec.yaml").read_text()
    assert not re.search(r"^publish_to:", pubspec, re.M), "dart is blocked from publishing"
    for field in ("description", "homepage", "repository"):
        assert re.search(rf"^{field}:", pubspec, re.M), f"pub.dev requires {field}"

    # pub.dev warns when the CHANGELOG omits the version being published, and a
    # published version cannot be amended afterwards.
    version = json.loads((ROOT / "spec/nrouter-sdk-spec.json").read_text())["version"]
    changelog = (ROOT / "sdks/dart/CHANGELOG.md").read_text()
    assert re.search(rf"^##\s+{re.escape(version)}\s*$", changelog, re.M), (
        f"sdks/dart/CHANGELOG.md has no '## {version}' entry"
    )
