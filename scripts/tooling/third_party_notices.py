"""Generate THIRD_PARTY_NOTICES.md: what the installer ships that this project did not write.

- Python packages: the runtime locks that stage_python_runtime.py installs. Versions come from the locks and
  license metadata from the STAGED runtime (packaging/python), so both describe the same files; their own
  license files also ship inside each package's .dist-info.
- Broker SDKs (shioaji, moomoo-api) are listed as NOT bundled: the user installs them.
- ONNX Runtime: statically linked into analysis_runtime.exe by the ort crate; its MIT license and third-party
  notices ship under licenses/onnxruntime-<version>/.
- Rust crates compiled into market_runtime / analysis_runtime: listed, and their license files reproduced,
  since a compiled binary carries no copy of them.
- Electron / Chromium: electron-builder ships LICENSE.electron.txt and LICENSES.chromium.html next to the exe.
- CPython (embeddable distribution): its LICENSE.txt ships in the python/ directory.

Usage: python scripts/tooling/third_party_notices.py --write | --check
Run after stage_python_runtime.py (it reads packaging/python), with cargo on PATH.
"""
from __future__ import annotations

import argparse
import importlib.metadata as metadata
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "THIRD_PARTY_NOTICES.md"
CRATES = ("native/market_runtime", "native/analysis_runtime")
LICENSE_FILE_PREFIXES = ("license", "licence", "copying", "unlicense", "notice")


def _stage_module():
    spec = importlib.util.spec_from_file_location("stage_python_runtime", ROOT / "scripts/tooling/stage_python_runtime.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


STAGED_SITE_PACKAGES = ROOT / "packaging" / "python" / "Lib" / "site-packages"
ONNXRUNTIME_LICENSES = ROOT / "packaging" / "licenses"


def _staged_distribution(name: str, version: str, site_packages: Path):
    canonical = lambda value: re.sub(r"[-_.]+", "-", str(value)).lower()  # PEP 503: jaraco.classes == jaraco-classes
    for distribution in metadata.distributions(path=[str(site_packages)]):
        if canonical(distribution.metadata["Name"]) == canonical(name):
            if distribution.version != version:
                raise SystemExit(f"staged {name} is {distribution.version}, the lock pins {version}; re-stage")
            return distribution
    raise SystemExit(f"{name}=={version} is not in {site_packages}; run stage_python_runtime.py --force first")


def python_packages(site_packages: Path = STAGED_SITE_PACKAGES) -> list[tuple[str, str, str]]:
    if not site_packages.is_dir():
        raise SystemExit(f"{site_packages} missing; run scripts/tooling/stage_python_runtime.py first")
    rows = []
    for name, line in sorted(_stage_module()._locked_entries().items()):
        version = line.split()[0].partition("==")[2]
        distribution = _staged_distribution(name, version, site_packages)
        meta = distribution.metadata
        license_text = (meta.get("License-Expression") or (meta.get("License") or "").split("\n")[0].strip()
                        or ", ".join(c.split("::")[-1].strip() for c in meta.get_all("Classifier") or [] if c.startswith("License ::"))
                        or _license_file_title(distribution) or "NOT DECLARED")
        rows.append((name, version, license_text))
    return rows


def _license_file_title(distribution) -> str:
    """No declared license, but a shipped license file: name it by its first line ("MIT License", ...)."""
    for file in distribution.files or []:
        if "licen" in str(file).lower():
            for line in Path(distribution.locate_file(file)).read_text(encoding="utf-8", errors="replace").splitlines():
                if line.strip():
                    return f"{line.strip()[:60]} (from its license file)"
    return ""


def rust_crates() -> list[dict]:
    crates: dict[tuple[str, str], dict] = {}
    for crate in CRATES:
        data = json.loads(subprocess.run(
            # The installer is Windows x64 only: macOS / Linux-only dependencies are not linked into it.
            ["cargo", "metadata", "--format-version", "1", "--locked", "--filter-platform", "x86_64-pc-windows-msvc"],
            cwd=ROOT / crate,
            capture_output=True, text=True, check=True).stdout)
        packages = {p["id"]: p for p in data["packages"]}
        members = set(data["workspace_members"])
        nodes = {n["id"]: n for n in data["resolve"]["nodes"]}
        # Only what is linked into the shipped binaries: normal dependencies, transitively.
        pending, seen = list(members), set()
        while pending:
            node_id = pending.pop()
            if node_id in seen:
                continue
            seen.add(node_id)
            for dep in nodes[node_id]["deps"]:
                if any(kind.get("kind") in (None, "normal") for kind in dep["dep_kinds"]):
                    pending.append(dep["pkg"])
        for package_id in seen - members:
            package = packages[package_id]
            if package.get("source") is None:  # a path dependency is this project's own code
                continue
            directory = Path(package["manifest_path"]).parent
            files = sorted(p for p in directory.iterdir()
                           if p.is_file() and p.name.lower().startswith(LICENSE_FILE_PREFIXES))
            crates[(package["name"], package["version"])] = {
                "name": package["name"], "version": package["version"],
                "license": package.get("license") or "NOT DECLARED",
                "texts": [(p.name, p.read_text(encoding="utf-8", errors="replace").strip()) for p in files],
            }
    return [crates[key] for key in sorted(crates)]


def provider_sdk_rows() -> list[tuple[str, str, str]]:
    rows = []
    for provider, lines in _stage_module().provider_sdk_requirements().items():
        for line in lines:
            name, _, version = line.split()[0].partition("==")
            rows.append((name, version, provider))
    return sorted(set(rows))


def onnxruntime_licenses() -> list[tuple[str, str]]:
    """(version, directory) for every vendored ONNX Runtime license directory."""
    return [(d.name.partition("-")[2], d.name) for d in sorted(ONNXRUNTIME_LICENSES.glob("onnxruntime-*")) if d.is_dir()]


def render(python_rows, crates, sdk_rows=(), onnxruntime=()) -> str:
    out = ["# Third-party notices", "",
           "StockMonitor is licensed under the Apache License 2.0 (see LICENSE). The installer also ships the",
           "third-party software below, each under its own license. Generated by",
           "`scripts/tooling/third_party_notices.py`; do not edit by hand.", "",
           "Electron and Chromium: see `LICENSE.electron.txt` and `LICENSES.chromium.html` next to the executable.",
           "CPython (embeddable distribution): see `python/LICENSE.txt`.",
           "Microsoft Visual C++ runtime (`vcruntime140*.dll`, `msvcp140*.dll` in `native/` and `app-runtime/python/`):",
           "redistributable files of Microsoft Visual Studio, deployed app-locally under its license terms.", "",
           "## Python packages", "",
           "Each package's own license file ships in its `.dist-info` directory under `python/Lib/site-packages`.", "",
           "| Package | Version | License |", "|---|---|---|"]
    out += [f"| {name} | {version} | {license_text} |" for name, version, license_text in python_rows]
    out += ["", "## Not bundled: broker SDKs you install yourself", "",
            "The installer does not contain these (their redistribution terms are not confirmed). "
            "`install_provider_sdk.ps1` installs them from PyPI into your own profile; they are covered by their "
            "publishers' terms, not by this project's license.", "",
            "| Package | Version | Needed for |", "|---|---|---|"]
    out += [f"| {name} | {version} | {provider} |" for name, version, provider in sdk_rows]
    for version, directory in onnxruntime:
        out += ["", "## ONNX Runtime", "",
                f"ONNX Runtime {version} (MIT License, Copyright (c) Microsoft Corporation) is statically linked into "
                "`analysis_runtime.exe` through the `ort` crate (prebuilt by pyke, pinned and sha256-checked by "
                f"`ort-sys`). Its license and third-party notices ship as `licenses/{directory}/LICENSE` and "
                f"`licenses/{directory}/ThirdPartyNotices.txt`. `analysis_runtime.exe` loads Windows' own "
                "`DirectML.dll`, which the installer does not ship."]
    out += ["", "## Rust crates (compiled into market_runtime and analysis_runtime)", "",
            "| Crate | Version | License |", "|---|---|---|"]
    out += [f"| {c['name']} | {c['version']} | {c['license']} |" for c in crates]
    out += ["", "## Rust crate license texts", ""]
    for c in crates:
        for file_name, text in c["texts"]:
            out += [f"### {c['name']} {c['version']} — {file_name}", "", "```text", text, "```", ""]
        if not c["texts"]:
            out += [f"### {c['name']} {c['version']}", "", f"No license file in the crate; declared license: {c['license']}.", ""]
    return "\n".join(out).rstrip() + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true")
    group.add_argument("--check", action="store_true")
    args = parser.parse_args()
    content = render(python_packages(), rust_crates(), provider_sdk_rows(), onnxruntime_licenses())
    if args.write:
        TARGET.write_text(content, encoding="utf-8", newline="\n")
        print(f"wrote {TARGET.name}")
    elif not TARGET.is_file() or TARGET.read_text(encoding="utf-8") != content:
        raise SystemExit(f"{TARGET.name} is out of date; run third_party_notices.py --write")
    else:
        print(f"{TARGET.name} is up to date")


if __name__ == "__main__":
    sys.exit(main())
