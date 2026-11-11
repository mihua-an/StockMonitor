"""Both provider daemons write their detached output through one bounded log (backend/shared/detached_output.py).

The Futu daemon appended to its log forever; the Shioaji one rotated only when it opened the file, so neither
bounded a long-running session.
"""
from __future__ import annotations

from pathlib import Path

from backend.shared.detached_output import BoundedLogFile

from service.platform.atomic_files import ROTATED_GENERATIONS

ROOT = Path(__file__).resolve().parents[1]


def test_the_log_rotates_before_it_passes_its_limit(tmp_path):
    path = tmp_path / "daemon.log"
    log = BoundedLogFile(path, limit=100)
    for _ in range(25):
        log.write("0123456789\n")          # 11 bytes a line
    log.write("台積電\n")                  # 10 bytes: counted in UTF-8, not characters
    log.flush()
    generations = list(tmp_path.glob("daemon.log.*"))
    assert path.stat().st_size <= 100 and generations and all(item.stat().st_size <= 100 for item in generations)
    assert log.rotations >= 2
    assert len(generations) <= ROTATED_GENERATIONS, "older generations are removed"
    assert path.read_text(encoding="utf-8").endswith("台積電\n")
    log.close()


def test_a_reopened_log_counts_what_it_already_holds(tmp_path):
    path = tmp_path / "daemon.log"
    path.write_text("x" * 95, encoding="utf-8")
    log = BoundedLogFile(path, limit=100)
    log.write("0123456789\n")
    log.close()
    [generation] = list(tmp_path.glob("daemon.log.*"))
    assert generation.read_text(encoding="utf-8") == "x" * 95


def test_both_daemons_use_the_shared_bounded_log():
    for name in ("backend/shared/provider_main.py",):
        source = (ROOT / name).read_text(encoding="utf-8")
        assert "redirect_detached_output(" in source, name
        assert ".open(\"a\"" not in source, f"{name} opens no log of its own"
