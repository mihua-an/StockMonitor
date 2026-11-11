"""Session evidence rows, the materialization ledger and the WAL retention result are rewritten (`write_json_atomic`)
while other threads and processes read them: WAL retention reads every evidence row each minute, the 收盤整理 card
reads them on every poll. A Python reader that opens without delete sharing makes the writer's replace fail with
WinError 32 (10-29: eight evidence rows), so these readers open with `read_text_shared`, and the writer does not retry
a sharing violation (service/platform/atomic_files.py)."""
from __future__ import annotations

import os
import threading
from pathlib import Path

import pytest

from service.market.lifecycle import closing_progress
from service.market.shared import wal_retention
from service.platform import atomic_files
from service.platform.atomic_files import write_json_atomic

pytestmark = pytest.mark.skipif(os.name != "nt", reason="delete sharing is a Windows open mode")


def _rewrites_fail_while(read, target: Path, rewrites: int = 300) -> list[BaseException]:
    write_json_atomic(target, {"admitted": 0})
    stop = threading.Event()

    def poll() -> None:
        while not stop.is_set():
            read()

    readers = [threading.Thread(target=poll) for _ in range(3)]
    for reader in readers:
        reader.start()
    errors: list[BaseException] = []
    try:
        for n in range(rewrites):
            try:
                write_json_atomic(target, {"admitted": n})
            except OSError as exc:
                errors.append(exc)
    finally:
        stop.set()
        for reader in readers:
            reader.join()
    return errors


def test_evidence_rows_never_block_the_owner_rewriting_a_row(tmp_path):
    row = tmp_path / "futu" / "US" / "2026-10-29_FULL.json"
    assert _rewrites_fail_while(lambda: wal_retention.evidence_rows(tmp_path, ["futu"]), row) == []
    weekend = tmp_path / "shioaji" / "STK" / "2026-10-31_DAY.json"
    rows = lambda: wal_retention.non_business_sessions(wal_retention.evidence_rows(tmp_path, ["shioaji"]))
    assert _rewrites_fail_while(rows, weekend, rewrites=100) == []


def test_ledger_and_retention_result_reads_never_block_their_writers(tmp_path):
    ledger = tmp_path / "ledger" / "shioaji.json"
    assert _rewrites_fail_while(lambda: wal_retention.ledger_records(tmp_path, ["shioaji"]), ledger) == []
    progress = tmp_path / "progress.json"
    assert _rewrites_fail_while(lambda: closing_progress._read_json(progress, "progress"), progress) == []


def test_a_reader_without_delete_sharing_fails_the_replace_once_and_leaves_no_temporary(tmp_path, monkeypatch):
    target = tmp_path / "2026-10-29_NIGHT.json"
    write_json_atomic(target, {"admitted": 0})
    calls = []
    real_replace = atomic_files.replace_file
    monkeypatch.setattr(atomic_files, "replace_file", lambda s, d: (calls.append(d), real_replace(s, d)))
    with open(target, "rb"):
        with pytest.raises(PermissionError):
            write_json_atomic(target, {"admitted": 1})
    assert len(calls) == 1
    assert sorted(p.name for p in tmp_path.iterdir()) == [target.name]
