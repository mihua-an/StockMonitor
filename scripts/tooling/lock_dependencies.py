"""Export exact dependency closures from installed metadata, without SDK imports/network.

Run on the documented Windows CPython 3.14 environment. --check detects drift;
--write is an explicit lock refresh, not an upgrade or a package installation.

Every pin carries the sha256 of the PyPI wheels that fit this target, so
`pip install --require-hashes` refuses a wheel that was swapped under the same version.
--write fetches them from PyPI's JSON API for new or changed pins only; --check stays
offline and verifies that every pin has them.
"""
from __future__ import annotations

import argparse
from datetime import date
import importlib.metadata as metadata
import json
from pathlib import Path
import urllib.request
import sys
# A direct `python <this file>` run: every entry script sits two levels below the project root.
_ROOT = str(Path(__file__).resolve().parents[2])
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
from service.platform.project_root import PROJECT_ROOT
import platform
import sys

from packaging.markers import default_environment
from packaging.requirements import Requirement
from packaging.tags import sys_tags
from packaging.utils import canonicalize_name, parse_wheel_filename

ROOT = PROJECT_ROOT
DIRECTORY = ROOT / "requirements"
PROFILES = ("core", "shioaji", "futu", "models", "test")
HEADER = ("# Generated from installed metadata by scripts/tooling/lock_dependencies.py\n"
          "# Target: Windows x64 / CPython 3.14. Not a cross-platform lock.\n")
PYPI_RELEASE = "https://pypi.org/pypi/{name}/{version}/json"
# Published to PyPI as a source archive only (Moomoo's SDK is pure Python).
SDIST_ONLY = frozenset({"moomoo-api"})


def parse_lock(text):
    """{name: (version, [sha256, ...])} from a lock, joining its backslash continuation lines."""
    entries = {}
    for line in text.replace("\\\n", " ").splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        pin, *options = line.split()
        name, _, version = pin.partition("==")
        hashes = [option.split("sha256:", 1)[1] for option in options if option.startswith("--hash=sha256:")]
        entries[canonicalize_name(name)] = (version, hashes)
    return entries


def render_lock(entries):
    lines = []
    for name, (version, hashes) in sorted(entries.items()):
        lines.append(" \\\n".join([f"{name}=={version}", *(f"    --hash=sha256:{digest}" for digest in hashes)]))
    return HEADER + "".join(f"{line}\n" for line in lines)


def _fetch_json(url):
    with urllib.request.urlopen(url, timeout=30) as response:
        return json.load(response)


def wheel_hashes(name, version, fetch=_fetch_json):
    """sha256 of every PyPI wheel of name==version this interpreter can install (stage uses --only-binary).

    A package in SDIST_ONLY publishes no wheel at all; its source archive is pinned instead and
    stage_python_runtime.py installs it in a separate, still hash-checked pass.
    """
    supported = set(sys_tags())
    release = fetch(PYPI_RELEASE.format(name=name, version=version))
    files = [item for item in release.get("urls", []) if not item.get("yanked")]
    hashes = sorted({
        item["digests"]["sha256"] for item in files
        if item.get("packagetype") == "bdist_wheel"
        and supported.intersection(parse_wheel_filename(item["filename"])[3])
    })
    if not hashes and name in SDIST_ONLY:
        hashes = sorted({item["digests"]["sha256"] for item in files if item.get("packagetype") == "sdist"})
    if not hashes:
        raise SystemExit(f"No PyPI wheel of {name}=={version} fits Windows x64 / CPython 3.14")
    return hashes


def inputs(path):
    result = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("-r "):
            result.extend(inputs(path.parent / line[3:]))
        elif line and not line.startswith("#"):
            result.append(line)
    return result


def closure(requirements):
    pending = [Requirement(item) for item in requirements]
    visited, versions, evidence = set(), {}, {}
    environment = default_environment()
    while pending:
        request = pending.pop()
        name = canonicalize_name(request.name)
        key = (name, tuple(sorted(request.extras)))
        installed = metadata.distribution(name)
        if request.url or not request.specifier.contains(installed.version):
            raise ValueError(f"Installed {name}=={installed.version} does not satisfy {request}")
        if key in visited:
            continue
        visited.add(key)
        versions[name] = installed.version
        evidence[name] = {"version": installed.version, "requires_dist": installed.requires or []}
        for raw in installed.requires or []:
            dependency = Requirement(raw)
            if dependency.marker and not any(dependency.marker.evaluate({**environment, "extra": extra}) for extra in ("", *request.extras)):
                continue
            pending.append(dependency)
    return versions, evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--check-profile", choices=PROFILES, help="Check one installed profile; other optional groups need not be installed")
    args = parser.parse_args()
    if sum((args.write, args.check, bool(args.check_profile))) != 1:
        parser.error("Choose exactly one of --write / --check / --check-profile")
    if sys.platform != "win32" or sys.version_info[:2] != (3, 14) or platform.machine().lower() not in {"amd64", "x86_64"}:
        raise SystemExit("These locks target Windows x64 CPython 3.14; capture another platform separately")
    all_evidence = {}
    profiles = (args.check_profile,) if args.check_profile else PROFILES
    paths = [DIRECTORY / f"{profile}.in" for profile in sorted(profiles)]
    # A missing declaration must not turn a check into a successful empty loop.
    # Validate the complete requested inventory before --write changes any lock.
    for path in paths:
        if not path.is_file():
            raise SystemExit(f"Missing dependency declaration: {path.name}")
    known_hashes, rendered = {}, {}
    for path in paths:
        versions, evidence = closure(inputs(path))
        all_evidence.update(evidence)
        target = path.with_suffix(".lock")
        existing = parse_lock(target.read_text(encoding="utf-8")) if target.is_file() else {}
        if args.write:
            entries = {}
            for name, version in versions.items():
                previous_version, previous_hashes = existing.get(name, ("", []))
                if (name, version) not in known_hashes:
                    known_hashes[(name, version)] = (previous_hashes if previous_version == version and previous_hashes
                                                     else wheel_hashes(name, version))
                entries[name] = (version, known_hashes[(name, version)])
            # Written only after every profile resolved: a hash lookup failing halfway must not leave some
            # locks refreshed and others not.
            rendered[target] = render_lock(entries)
        else:
            if {name: version for name, (version, _) in existing.items()} != versions:
                raise SystemExit(f"Dependency drift: {target.name}")
            unhashed = sorted(name for name, (_, hashes) in existing.items() if not hashes)
            if unhashed:
                raise SystemExit(f"{target.name}: pins without wheel hashes: {', '.join(unhashed)}")
        print(f"{target.name}: {len(versions)} exact pins")
    if args.write:
        for target, content in rendered.items():
            target.write_text(content, encoding="utf-8")
        report = {"captured_on": date.today().isoformat(), "python": platform.python_version(), "platform": sys.platform,
                  "machine": platform.machine(), "packages": dict(sorted(all_evidence.items()))}
        (DIRECTORY / "environment-evidence.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
