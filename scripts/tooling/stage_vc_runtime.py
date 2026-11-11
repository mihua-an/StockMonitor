"""Stage the Microsoft Visual C++ runtime DLLs the installed App needs.

analysis_runtime.exe links the ONNX Runtime prebuilt (ort-sys), which is compiled against the dynamic CRT, so the
Rust executables cannot switch to a static CRT (+crt-static would mix CRTs at link time); the bundled Python's
onnxruntime.dll needs the same C++ runtime. A clean Windows has neither MSVCP140.dll nor MSVCP140_1.dll, so the
installer carries them next to the executables that load them ("app-local" deployment, which the Visual Studio
license allows for the files in its VC\\Redist folder -- they are copied from there, never from System32).

Output: packaging/vc_runtime/<dll> plus VC_RUNTIME.json (source folder, version, sizes, sha256); package.json
copies them to resources/native/ (the Rust executables). The same four also replace the older vcruntime140*.dll
the python.org embeddable package brought into packaging/python/ (python.exe's folder, where onnxruntime.dll looks):
msvcp140 must never run on an older vcruntime140, and the runtime is backward compatible. Run it after
stage_python_runtime.py. The check fails the build when a packaged binary imports a VC runtime DLL that is not
staged next to it, or the two copies differ.

Usage: python scripts/tooling/stage_vc_runtime.py [--check]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import struct
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "packaging" / "vc_runtime"
PYTHON_DIR = ROOT / "packaging" / "python"
MANIFEST = OUT / "VC_RUNTIME.json"
DLLS = ("vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll", "msvcp140_1.dll")
# The packaged binaries that load a VC runtime DLL from their own folder (or python.exe's).
BINARIES = (
    "native/market_runtime/target/release/market_runtime_daemon.exe",
    "native/analysis_runtime/target/release/analysis_runtime.exe",
    "packaging/python/Lib/site-packages/onnxruntime/capi/onnxruntime.dll",
)
VSWHERE = Path(r"C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe")


def pe_imports(path: Path) -> list[str]:
    """The DLL names in a PE file's import table (lower case)."""
    data = path.read_bytes()
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    if data[pe:pe + 4] != b"PE\0\0":
        raise ValueError(f"{path} is not a PE file")
    sections = struct.unpack_from("<H", data, pe + 6)[0]
    optional_size = struct.unpack_from("<H", data, pe + 20)[0]
    optional = pe + 24
    magic = struct.unpack_from("<H", data, optional)[0]
    directories = optional + (112 if magic == 0x20B else 96)
    import_rva = struct.unpack_from("<I", data, directories + 8)[0]
    table = optional + optional_size

    def offset(rva: int) -> int:
        for i in range(sections):
            entry = table + 40 * i
            vsize, vaddr, rsize, raw = struct.unpack_from("<IIII", data, entry + 8)
            if vaddr <= rva < vaddr + max(vsize, rsize):
                return rva - vaddr + raw
        raise ValueError(f"{path}: RVA {rva:#x} outside every section")

    names = []
    if not import_rva:
        return names
    cursor = offset(import_rva)
    while True:
        descriptor = struct.unpack_from("<IIIII", data, cursor)
        if not any(descriptor):
            break
        start = offset(descriptor[3])
        names.append(data[start:data.index(b"\0", start)].decode("ascii").lower())
        cursor += 20
    return names


def vc_runtime_imports(path: Path) -> set[str]:
    return {name for name in pe_imports(path) if name.startswith(("vcruntime140", "msvcp140", "concrt140"))}


def redist_folder() -> Path:
    """The newest x64 CRT folder of the installed Visual Studio / Build Tools (the C++ toolchain cargo links with)."""
    if not VSWHERE.is_file():
        raise SystemExit(f"[stage_vc_runtime] {VSWHERE} not found: install Visual Studio Build Tools (C++ workload)")
    found = subprocess.run([str(VSWHERE), "-latest", "-products", "*", "-find", r"VC\Redist\MSVC\*\x64\Microsoft.VC14*.CRT"],
                           check=True, capture_output=True, text=True).stdout.split("\n")
    folders = sorted({Path(line.strip()) for line in found if line.strip()}, key=lambda p: [int(x) for x in p.parents[1].name.split(".") if x.isdigit()])
    if not folders:
        raise SystemExit("[stage_vc_runtime] no VC\\Redist\\MSVC\\*\\x64\\Microsoft.VC14*.CRT folder: install the C++ workload")
    return folders[-1]


def check() -> list[str]:
    """Problems that would ship a binary whose VC runtime DLL is not in the installer."""
    problems = []
    staged = {p.name.lower() for p in OUT.glob("*.dll")} if OUT.is_dir() else set()
    for rel in BINARIES:
        path = ROOT / rel
        if not path.is_file():
            problems.append(f"{rel} missing (build it first)")
            continue
        missing = sorted(vc_runtime_imports(path) - staged)
        if missing:
            problems.append(f"{rel} imports {', '.join(missing)}, not staged in packaging/vc_runtime")
    if not MANIFEST.is_file():
        problems.append("packaging/vc_runtime/VC_RUNTIME.json missing")
        return problems
    for name, entry in json.loads(MANIFEST.read_text(encoding="utf-8"))["files"].items():
        for folder in (OUT, PYTHON_DIR):
            path = folder / name
            if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != entry["sha256"]:
                problems.append(f"{path.relative_to(ROOT)} is not the staged {name} (run stage_vc_runtime.py after stage_python_runtime.py)")
    return problems


def stage() -> dict:
    source = redist_folder()
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    files = {}
    for name in DLLS:
        src = source / name
        if not src.is_file():
            raise SystemExit(f"[stage_vc_runtime] {src} missing")
        shutil.copy2(src, OUT / name)
        if PYTHON_DIR.is_dir():
            shutil.copy2(src, PYTHON_DIR / name)
        files[name] = {"bytes": src.stat().st_size, "sha256": hashlib.sha256(src.read_bytes()).hexdigest()}
    manifest = {"source": str(source), "msvc_redist_version": source.parents[1].name, "files": files}
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="only verify the staged DLLs cover every packaged binary")
    args = parser.parse_args()
    if not args.check:
        manifest = stage()
        print(f"[stage_vc_runtime] staged {', '.join(manifest['files'])} from {manifest['source']}")
    problems = check()
    for problem in problems:
        print(f"[stage_vc_runtime] {problem}", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
