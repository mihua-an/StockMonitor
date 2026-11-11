"""Build the Windows installer from a clean checkout.

`npm run dist` only runs electron-builder: it expects the three Rust executables and packaging/python/ to exist
already, and a clean checkout has neither. This script is the whole pipeline, in order, each step failing the
build:

  1. toolchain check   -- node, npm, cargo (rustup picks native/*/rust-toolchain.toml), Windows x64
  2. npm ci            -- Electron and electron-builder exactly as package-lock.json pins them
  3. cargo build       -- native/market_runtime and native/analysis_runtime, --release --locked.
                          analysis_runtime's ort-sys downloads the ONNX Runtime prebuilt it pins (URL + sha256 inside
                          the crate, the crate itself pinned by Cargo.lock's checksum) and refuses a mismatch; set
                          ORT_LIB_LOCATION to link a local ONNX Runtime build instead (offline builds)
  4. Python runtime    -- scripts/tooling/stage_python_runtime.py --force (pinned CPython + pip, hash-checked locks,
                          no broker SDKs)
  4b. VC++ runtime    -- scripts/tooling/stage_vc_runtime.py: the MSVC runtime DLLs the Rust executables and the
                          bundled onnxruntime need, from the Visual Studio Redist folder (app-local deployment)
  5. notices check     -- THIRD_PARTY_NOTICES.md must match the staged runtime and the crates
  6. electron-builder  -- `--win` (NSIS installer) or `--win --dir` (unpacked only); its beforePack hook runs
                          scripts/tooling/audit_packaging.cjs
  7. report            -- sizes of the executables, the Python runtime and the output, in dist/build_report.json

Usage (from the repository root):
    python scripts/tooling/build_release.py [--dir] [--skip-npm-ci] [--reuse-python-runtime]

`npm run release` / `npm run release:dir` call it. The two --skip/--reuse flags are for iterating on a machine
that already ran the full pipeline; a release build runs without them.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CRATES = {
    "native/market_runtime": ("market_runtime_daemon.exe",),
    "native/analysis_runtime": ("analysis_runtime.exe",),
}
STAGE_DIR = ROOT / "packaging" / "python"
DIST = ROOT / "dist"


def _log(message: str) -> None:
    print(f"[build_release] {message}", flush=True)


def _tool(name: str) -> str:
    found = shutil.which(name) or shutil.which(f"{name}.cmd") or shutil.which(f"{name}.exe")
    if not found:
        raise SystemExit(f"[build_release] {name} not found on PATH")
    return found


def _run(args: list[str], *, cwd: Path = ROOT, env: dict | None = None) -> None:
    _log(f"+ {' '.join(str(a) for a in args)}  (in {cwd.relative_to(ROOT) if cwd != ROOT else '.'})")
    started = time.monotonic()
    subprocess.run([str(a) for a in args], cwd=cwd, env=env, check=True)
    _log(f"  done in {time.monotonic() - started:.0f}s")


def _capture(args: list[str], *, cwd: Path = ROOT) -> str:
    return subprocess.run([str(a) for a in args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def check_toolchain() -> dict[str, str]:
    if sys.platform != "win32" or platform.machine().upper() not in ("AMD64", "X86_64"):
        raise SystemExit("[build_release] the installer targets Windows x64; build on Windows x64")
    if sys.version_info < (3, 11):
        raise SystemExit("[build_release] needs Python 3.11+ to run the build scripts")
    versions = {
        "python (build scripts)": platform.python_version(),
        "node": _capture([_tool("node"), "--version"]),
        "npm": _capture([_tool("npm"), "--version"]),
    }
    for crate in CRATES:
        versions[f"cargo ({crate})"] = _capture([_tool("cargo"), "--version"], cwd=ROOT / crate)
    for name, value in versions.items():
        _log(f"{name}: {value}")
    return versions


def npm_ci() -> None:
    _run([_tool("npm"), "ci", "--no-audit", "--no-fund"])


def cargo_build() -> None:
    for crate, exes in CRATES.items():
        _run([_tool("cargo"), "build", "--release", "--locked"], cwd=ROOT / crate)
        for exe in exes:
            path = ROOT / crate / "target" / "release" / exe
            if not path.is_file():
                raise SystemExit(f"[build_release] cargo build did not produce {path}")


def stage_python_runtime(reuse: bool) -> None:
    if reuse:
        # Reused only when it is the runtime the current pins and locks describe (stage_python_runtime --check),
        # never because the directory exists.
        _run([sys.executable, "scripts/tooling/stage_python_runtime.py", "--check"])
        _log("reusing packaging/python (--reuse-python-runtime; --check passed)")
        return
    _run([sys.executable, "scripts/tooling/stage_python_runtime.py", "--force"])


def stage_vc_runtime() -> None:
    _run([sys.executable, "scripts/tooling/stage_vc_runtime.py"])


def check_notices() -> None:
    _run([sys.executable, "scripts/tooling/third_party_notices.py", "--check"])


def check_installed_flavor() -> None:
    # The uninstaller's and the SDK installer's directory names must equal config/var_layout.json.
    _run([sys.executable, "scripts/tooling/installed_flavor.py", "--check"])


def electron_builder(unpacked_only: bool) -> None:
    builder = ROOT / "node_modules" / ".bin" / "electron-builder.cmd"
    if not builder.is_file():
        raise SystemExit("[build_release] node_modules/.bin/electron-builder.cmd missing; run without --skip-npm-ci")
    args = [builder, "--win", "--publish=never"]
    if unpacked_only:
        args.insert(2, "--dir")
    # electron-builder is a .cmd shim; run it through cmd so Windows resolves it.
    _run(["cmd", "/c", *args])


def _size(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file())


def report(unpacked_only: bool, versions: dict[str, str]) -> dict:
    unpacked = DIST / "win-unpacked"
    resources = unpacked / "resources"
    out = {
        "toolchain": versions,
        "executables": {exe: _size(ROOT / crate / "target" / "release" / exe)
                        for crate, exes in CRATES.items() for exe in exes},
        "python_runtime": _size(STAGE_DIR),
        "win_unpacked": _size(unpacked) if unpacked.is_dir() else None,
        "resources_app_runtime": _size(resources / "app-runtime") if resources.is_dir() else None,
        "installers": {p.name: p.stat().st_size for p in DIST.glob("*.exe")} if not unpacked_only else {},
    }
    staged = STAGE_DIR / "STAGED_RUNTIME.json"
    if staged.is_file():
        out["staged_runtime"] = json.loads(staged.read_text(encoding="utf-8"))
    DIST.mkdir(exist_ok=True)
    (DIST / "build_report.json").write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    mib = lambda value: "-" if value is None else f"{value / 1048576:.1f} MiB"
    for exe, size in out["executables"].items():
        _log(f"{exe}: {mib(size)}")
    _log(f"packaging/python: {mib(out['python_runtime'])}")
    _log(f"dist/win-unpacked: {mib(out['win_unpacked'])}")
    for name, size in out["installers"].items():
        _log(f"dist/{name}: {mib(size)}")
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dir", action="store_true", help="unpacked build only (dist/win-unpacked), no NSIS installer")
    parser.add_argument("--skip-npm-ci", action="store_true", help="keep the existing node_modules")
    parser.add_argument("--reuse-python-runtime", action="store_true",
                        help="keep packaging/python when stage_python_runtime.py --check says it is current")
    args = parser.parse_args()
    os.chdir(ROOT)
    started = time.monotonic()
    versions = check_toolchain()
    if not args.skip_npm_ci:
        npm_ci()
    cargo_build()
    check_installed_flavor()
    stage_python_runtime(args.reuse_python_runtime)
    stage_vc_runtime()
    check_notices()
    electron_builder(args.dir)
    report(args.dir, versions)
    _log(f"finished in {(time.monotonic() - started) / 60:.1f} min")
    return 0


if __name__ == "__main__":
    sys.exit(main())
