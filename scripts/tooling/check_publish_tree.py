"""Check what the open-source commit would contain (one clean commit, no build output, no broker
SDK files, no personal paths).

What is checked is what the commit would contain: every tracked file as staged in the index -- and, so a
fix made only in the working tree is not taken for a clean commit, as it is in the working tree too -- plus who the
commit would be by. It reports:

  - build output: dist/, var/, node_modules/, Rust target/, the staged packaging/python and packaging/vc_runtime,
    and binary build products (.exe .dll .pyd .whl .zip ...)
  - broker SDK files: an installed shioaji / moomoo / futu package (site-packages, *.dist-info), never our own
    backend/shioaji or service/market/futu modules
  - personal data: this machine's user name or home path, the git author's e-mail, and secrets shaped like a GAS
    deployment id or a bearer token. A "Copyright <year> <name>" line (NOTICE, LICENSE) is the declared author and
    allowed.
  - the commit's identity: the author and committer git would record must use a GitHub noreply address.

Usage: python scripts/tooling/check_publish_tree.py     (exit 1 and one line per problem when anything is found)
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BUILD_DIRS = ("dist/", "var/", "node_modules/", "packaging/python/", "packaging/vc_runtime/", "models/")
BUILD_SUFFIXES = (".exe", ".dll", ".pyd", ".so", ".whl", ".msi", ".zip", ".7z", ".lib", ".pdb")
SDK_PATTERNS = (
    re.compile(r"(^|/)site-packages/"),
    re.compile(r"(^|/)(shioaji|moomoo|futu|moomoo_api)[-_][^/]*\.dist-info/"),
    re.compile(r"(^|/)(moomoo|futu)/common/"),            # the SDK's own package layout
)
SECRET_PATTERNS = (
    ("GAS deployment id", re.compile(r"AKfycb[A-Za-z0-9_-]{30,}")),
    ("bearer token", re.compile(r"Bearer\s+[A-Za-z0-9._~+/=-]{32,}")),
)
COPYRIGHT_LINE = re.compile(r"^\s*Copyright\b.*\d{4}")


def personal_markers() -> list[tuple[str, re.Pattern[str]]]:
    markers = []
    user = (os.environ.get("USERNAME") or os.environ.get("USER") or "").strip()
    if len(user) >= 3:
        markers.append((f"user name {user!r}", re.compile(rf"(?<![A-Za-z0-9]){re.escape(user)}(?![A-Za-z0-9])", re.I)))
    home = str(Path.home())
    markers.append(("home path", re.compile(re.escape(home).replace(r"\\", r"[\\/]+"), re.I)))
    try:
        email = subprocess.run(["git", "config", "user.email"], cwd=ROOT, capture_output=True, text=True, check=False).stdout.strip()
    except OSError as exc:  # not an error for the check itself: without git there is no author e-mail to look for
        print(f"[check_publish_tree] git not runnable ({exc}); author e-mail not checked", file=sys.stderr)
        email = ""
    if email and not email.endswith("noreply.github.com"):
        markers.append(("git author e-mail", re.compile(re.escape(email), re.I)))
    return markers


def problems_in(files: dict[str, bytes], markers: list[tuple[str, re.Pattern[str]]]) -> list[str]:
    problems = []
    for name, data in sorted(files.items()):
        path = name.replace("\\", "/")
        if path.startswith(BUILD_DIRS) or "/target/" in f"/{path}" or path.lower().endswith(BUILD_SUFFIXES):
            problems.append(f"{path}: build output")
            continue
        if any(p.search(path) for p in SDK_PATTERNS):
            problems.append(f"{path}: broker SDK / installed package file")
            continue
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:  # not an error: a binary asset (icon, font) has no text to scan
            continue
        for number, line in enumerate(text.splitlines(), 1):
            for label, pattern in SECRET_PATTERNS:
                if pattern.search(line):
                    problems.append(f"{path}:{number}: {label}")
            if COPYRIGHT_LINE.match(line):
                continue
            for label, pattern in markers:
                if pattern.search(line):
                    problems.append(f"{path}:{number}: {label}")
    return problems


def tracked_files() -> dict[str, bytes]:
    """The tracked files as they are in the working tree."""
    names = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True).stdout.decode("utf-8").split("\0")
    return {name: (ROOT / name).read_bytes() for name in names if name and (ROOT / name).is_file()}


def index_files() -> dict[str, bytes]:
    """The tracked files as staged in the index: what a commit made now would contain."""
    listing = subprocess.run(["git", "ls-files", "-s", "-z"], cwd=ROOT, capture_output=True, check=True).stdout.decode("utf-8")
    entries = []
    for item in listing.split("\0"):
        if not item:
            continue
        meta, _, name = item.partition("\t")
        mode, sha, _stage = meta.split()
        if mode != "160000":   # a submodule has no blob
            entries.append((name, sha))
    batch = subprocess.run(["git", "cat-file", "--batch"], cwd=ROOT, capture_output=True, check=True,
                           input="".join(f"{sha}\n" for _, sha in entries).encode("ascii")).stdout
    files, offset = {}, 0
    for name, _sha in entries:
        header_end = batch.index(b"\n", offset)
        size = int(batch[offset:header_end].split()[2])
        files[name] = batch[header_end + 1:header_end + 1 + size]
        offset = header_end + 1 + size + 1
    return files


NOREPLY = re.compile(r"@users\.noreply\.github\.com$", re.I)


def identity_problems(var=lambda name: subprocess.run(["git", "var", name], cwd=ROOT, capture_output=True, text=True,
                                                       check=False).stdout) -> list[str]:
    """The author / committer git would record for the commit: a public commit carries only a noreply address."""
    problems = []
    for name, label in (("GIT_AUTHOR_IDENT", "author"), ("GIT_COMMITTER_IDENT", "committer")):
        match = re.search(r"<([^>]*)>", var(name) or "")
        email = match.group(1) if match else ""
        if not NOREPLY.search(email):
            problems.append(f"commit {label} e-mail {email or '(none)'!r} is not a GitHub noreply address")
    return problems


def content_problems() -> list[str]:
    markers = personal_markers()
    return sorted(set(problems_in(index_files(), markers)) | set(problems_in(tracked_files(), markers)))


def main() -> int:
    problems = content_problems() + identity_problems()
    for problem in problems:
        print(problem)
    print(f"[check_publish_tree] {len(problems)} problem(s)", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
