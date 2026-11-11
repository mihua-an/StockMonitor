"""Exercise the safety boundary only inside the disposable contract runner."""
import asyncio
import os
from pathlib import Path
import socket
import sqlite3

import pytest

from scripts.diagnostics import check_offline

inside_runner = pytest.mark.skipif(os.environ.get("STOCK_MONITOR_OFFLINE_CHECK") != "1", reason="Run via scripts/diagnostics/check_offline.py")


@inside_runner
def test_runner_uses_source_copy_and_blocks_original_storage():
    original = Path(os.environ["STOCK_MONITOR_CHECK_ORIGINAL"])
    assert not Path(__file__).resolve().is_relative_to(original)
    for action in (
        lambda: (original / "data" / "offline-check-must-not-open").read_bytes(),
        lambda: sqlite3.connect(str(original / "data" / "offline-check-must-not-create.db")),
    ):
        with pytest.raises(RuntimeError, match="forbids original project access"):
            action()


@inside_runner
def test_runner_blocks_backend_connection_but_allows_asyncio_wakeup():
    with socket.socket() as connection:
        with pytest.raises(RuntimeError, match="forbids network"):
            connection.connect(("127.0.0.1", 8000))

    async def local_task():
        await asyncio.sleep(0)
        return "local"

    assert asyncio.run(local_task()) == "local"


def test_snapshot_inventory_declares_every_top_level_path_the_suites_need():
    """A new top-level directory imported by tests/ must be declared before it can go missing."""
    root = Path(__file__).resolve().parents[1]
    required = check_offline.required_top_level_paths(root)
    assert "tests" in required and "service" in required, "the scanner found nothing: it has stopped being meaningful"
    declared = check_offline.snapshot_inventory()
    undeclared = {name: users for name, users in required.items() if name not in declared}
    assert not undeclared, "\n".join(
        f"{name} is read by {', '.join(users[:4])} but is neither copied into nor deliberately "
        f"withheld from the offline snapshot (scripts/diagnostics/check_offline.py)"
        for name, users in undeclared.items())


@inside_runner
def test_snapshot_carries_every_declared_source_path():
    """The copy really happened: a wrong SOURCE_DIRS or SUFFIXES leaves a declared path absent."""
    project = Path(__file__).resolve().parents[1]
    declared = sorted(set(check_offline.SOURCE_DIRS) | set(check_offline.ROOT_FILES))
    absent = [name for name in declared if not (project / name).exists()]
    empty = [name for name in declared
             if (project / name).is_dir() and not any((project / name).iterdir())]
    assert not absent and not empty, f"absent={absent} empty={empty}"


def test_preflight_reports_a_missing_directory_as_an_inventory_error(tmp_path):
    """The failure mode is a named inventory error before the suites run, not ModuleNotFoundError."""
    source = tmp_path / "source"
    (source / "tests").mkdir(parents=True)
    (source / "tests" / "test_uses_new_package.py").write_text("from brandnew.thing import value\n", encoding="utf-8")
    (source / "brandnew").mkdir()
    (source / "brandnew" / "thing.py").write_text("value = 1\n", encoding="utf-8")
    (source / "service").mkdir()
    (source / "service" / "kept.py").write_text("", encoding="utf-8")
    project = tmp_path / "snapshot"
    project.mkdir()

    problems = check_offline.snapshot_inventory_problems(source, project)
    assert any(p.startswith("brandnew:") and "tests/test_uses_new_package.py" in p for p in problems), problems
    assert any(p.startswith("service:") and "missing from" in p for p in problems), problems

    # An empty copy of a declared source directory is reported too, not silently accepted.
    (project / "service").mkdir()
    assert any(p.startswith("service:") and "copied empty" in p
               for p in check_offline.snapshot_inventory_problems(source, project))
    (project / "service" / "kept.py").write_text("", encoding="utf-8")
    assert not [p for p in check_offline.snapshot_inventory_problems(source, project) if p.startswith("service:")]
