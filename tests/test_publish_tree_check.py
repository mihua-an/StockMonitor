"""The open-source commit check (scripts/tooling/check_publish_tree.py) finds build output, SDK files and personal data."""
from __future__ import annotations

import importlib.util
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _module():
    spec = importlib.util.spec_from_file_location("check_publish_tree", ROOT / "scripts" / "tooling" / "check_publish_tree.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_each_kind_of_problem_is_reported_and_our_own_modules_are_not():
    module = _module()
    markers = [("user name 'alice'", re.compile(r"(?<![A-Za-z0-9])alice(?![A-Za-z0-9])", re.I)),
               ("home path", re.compile(r"C:[\\/]+Users[\\/]+alice", re.I))]
    files = {
        "dist/StockMonitor Setup.exe": b"MZ",
        "native/analysis_runtime/target/release/analysis_runtime.exe": b"MZ",
        "packaging/python/python.exe": b"MZ",
        "lib/site-packages/shioaji/__init__.py": b"",
        "vendor/moomoo_api-10.0.dist-info/METADATA": b"",
        "backend/shioaji/__init__.py": b"",                         # ours
        "service/market/futu/callback.py": b"x = 1\n",            # ours
        "docs/notes.md": "見 C:\\Users\\alice\\Desktop\nalice 的筆記\n".encode("utf-8"),
        # built at run time: a complete secret-shaped id written here made the check fail on this very file
        "config/gas.json": ('{"url": "https://script.google.com/macros/s/' + "AKfy" + "cb" + "A" * 40 + '/exec"}').encode(),
        "NOTICE": b"StockMonitor\nCopyright 2026 alice\n",           # the declared author
        "ui/icon.png": b"\x89PNG\xff\xfe",
        "tests/fixtures/model.onnx": b"\x08\x01",                   # a tracked test fixture
    }
    problems = module.problems_in(files, markers)
    assert "dist/StockMonitor Setup.exe: build output" in problems
    assert "native/analysis_runtime/target/release/analysis_runtime.exe: build output" in problems
    assert "packaging/python/python.exe: build output" in problems
    assert "lib/site-packages/shioaji/__init__.py: broker SDK / installed package file" in problems
    assert "vendor/moomoo_api-10.0.dist-info/METADATA: broker SDK / installed package file" in problems
    assert "docs/notes.md:1: home path" in problems and "docs/notes.md:2: user name 'alice'" in problems
    assert "config/gas.json:1: GAS deployment id" in problems
    assert not [p for p in problems if p.startswith(("backend/", "service/", "NOTICE", "ui/", "tests/"))], problems


def test_the_commit_identity_must_be_a_noreply_address():
    # The author e-mail was only looked for in file contents, never in the commit metadata itself.
    module = _module()
    idents = {"GIT_AUTHOR_IDENT": "alice <alice@example.com> 1 +0800", "GIT_COMMITTER_IDENT": "alice <123+alice@users.noreply.github.com> 1 +0800"}
    assert module.identity_problems(var=idents.get) == ["commit author e-mail 'alice@example.com' is not a GitHub noreply address"]


def test_the_repository_itself_has_no_content_problem():
    # The check run over this repository (index and working tree) finds nothing in the files.
    assert _module().content_problems() == []
