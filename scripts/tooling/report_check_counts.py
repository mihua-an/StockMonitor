"""Report how many offline checks exist / passed, so README numbers are derived, not hand-maintained.

Those numbers had drifted badly (README claimed 278 Python + 24 JavaScript while
the suites had grown past 700 and 100), because nothing re-derived them. This
script is the single place that answers both halves:

* JavaScript: counted straight from the filesystem, using exactly the glob
  scripts/diagnostics/check_offline.py itself runs -- tests/*_contract.{cjs,mjs}.
  No suite execution needed, so it is instant and cannot disagree with reality.
* Python: read out of the JUnit XML that check_offline.py already writes
  (`--junitxml <run>/python.xml`). This script never runs pytest itself: a
  second, independently maintained pytest invocation would drift from
  check_offline.py's marker/deselect filters and quietly report a different
  number, which is the exact failure mode being fixed. With no --junit argument
  it picks the newest python.xml it can find under the temp directory tree
  check_offline.py prints as "Isolated check directory".

Read-only: it opens no sockets, imports no SDK, starts no service, and writes
nothing anywhere.

    python scripts/tooling/report_check_counts.py
    python scripts/tooling/report_check_counts.py --junit <run>/python.xml
    python scripts/tooling/report_check_counts.py --json
"""
from __future__ import annotations

import re

import argparse
import json
import os
import tempfile
from pathlib import Path
from xml.etree import ElementTree

PROJECT_ROOT = Path(__file__).resolve().parents[2]
# Must stay identical to check_offline.py's own selection:
#   sorted((project / "tests").glob("*_contract.*")) if p.suffix in {".cjs", ".mjs"}
CONTRACT_SUFFIXES = (".cjs", ".mjs")


def javascript_contract_files(root: Path = PROJECT_ROOT) -> list[Path]:
    return sorted(
        path for path in (root / "tests").glob("*_contract.*")
        if path.suffix in CONTRACT_SUFFIXES
    )


def find_junit_report(explicit: str | None) -> Path | None:
    if explicit:
        candidate = Path(explicit).expanduser()
        return candidate if candidate.is_file() else None
    roots = {Path(tempfile.gettempdir())}
    for name in ("TEMP", "TMP", "TMPDIR"):
        value = os.environ.get(name)
        if value:
            roots.add(Path(value))
    newest: Path | None = None
    for root in roots:
        if not root.is_dir():
            continue
        for candidate in root.glob("*/python.xml"):
            if newest is None or candidate.stat().st_mtime > newest.stat().st_mtime:
                newest = candidate
    return newest


def python_counts(report: Path) -> dict[str, int]:
    root = ElementTree.parse(report).getroot()
    suites = [root] if root.tag == "testsuite" else list(root.iter("testsuite"))
    totals = {"tests": 0, "failures": 0, "errors": 0, "skipped": 0}
    for suite in suites:
        for key in totals:
            totals[key] += int(suite.get(key, 0) or 0)
    totals["passed"] = totals["tests"] - totals["failures"] - totals["errors"] - totals["skipped"]
    return totals


def pinned_versions(root: Path = PROJECT_ROOT) -> dict[str, str | None]:
    """The version pins the README must not hard-code (Electron drifted 31.7.7 -> 44.4.3)."""
    versions: dict[str, str | None] = {"electron": None, "rust_toolchain": None}
    manifest_path = root / "package.json"
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for section in ("dependencies", "devDependencies"):
            found = (manifest.get(section) or {}).get("electron")
            if found:
                versions["electron"] = str(found)
                break
    toolchain = root / "native" / "market_runtime" / "rust-toolchain.toml"
    if toolchain.is_file():
        match = re.search(r'channel\s*=\s*"([^"]+)"', toolchain.read_text(encoding="utf-8"))
        if match:
            versions["rust_toolchain"] = match.group(1)
    return versions


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--junit", default=None,
                        help="path to a python.xml written by check_offline.py (default: newest found under TEMP)")
    parser.add_argument("--json", action="store_true", dest="as_json", help="emit machine-readable output")
    args = parser.parse_args()

    contracts = javascript_contract_files()
    payload: dict[str, object] = {
        "javascript_contract_files": len(contracts),
        "javascript_source": "tests/*_contract.{cjs,mjs}",
        "python": None,
        "python_source": None,
        **pinned_versions(),
    }
    report = find_junit_report(args.junit)
    if report is not None:
        payload["python"] = python_counts(report)
        payload["python_source"] = str(report)

    if args.as_json:
        print(json.dumps(payload, indent=2))
        return 0

    print(f"JavaScript contracts: {len(contracts)} files ({payload['javascript_source']})")
    print(f"Electron pinned      : {payload['electron'] or 'UNKNOWN'}")
    print(f"Rust toolchain       : {payload['rust_toolchain'] or 'UNKNOWN'}")
    if report is None:
        print("Python: no python.xml found -- run `npm run check:python` "
              "(python scripts/diagnostics/check_offline.py --only python) first, "
              "then pass its <run>/python.xml with --junit.")
        return 0
    counts = payload["python"]
    assert isinstance(counts, dict)
    print(f"Python tests: {counts['passed']} passed, {counts['skipped']} skipped, "
          f"{counts['failures']} failed, {counts['errors']} errored "
          f"({counts['tests']} collected) from {report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
