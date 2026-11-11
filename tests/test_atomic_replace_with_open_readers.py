"""The daemon owner record is rewritten (heartbeat, lifecycle) while the API and Health poll it. On Windows a plain
replace fails while any process has the destination open, and the Futu daemon exited on that PermissionError at
startup; the writer renames with POSIX semantics and Python readers open with delete sharing
(service/platform/atomic_files.py)."""
from __future__ import annotations

import json
import threading

from service.market.shared.daemon_singleton import read_owner_metadata
from service.platform.atomic_files import read_bytes_shared, replace_file, write_json_atomic


def test_replace_goes_through_while_a_shared_reader_holds_the_file(tmp_path):
    target = tmp_path / "owner.json"
    target.write_text("{}", encoding="utf-8")
    newer = tmp_path / "newer.json"
    newer.write_text('{"lifecycle": "READY"}', encoding="utf-8")
    from service.platform import atomic_files

    kernel32_handle = None
    if atomic_files.os.name == "nt":
        kernel32, kernel32_handle = atomic_files._open_handle(target, 0x80000000)
    try:
        replace_file(newer, target)
    finally:
        if kernel32_handle is not None:
            kernel32.CloseHandle(kernel32_handle)
    assert json.loads(read_bytes_shared(target)) == {"lifecycle": "READY"}
    assert not newer.exists()


def test_owner_record_rewrites_never_fail_under_concurrent_readers(tmp_path):
    record = tmp_path / "moomoo_daemon_owner.json"
    write_json_atomic(record, {"n": 0})
    stop = threading.Event()
    read_errors: list[BaseException] = []

    def poll() -> None:
        while not stop.is_set():
            try:
                assert "n" in read_owner_metadata(record)
            except BaseException as exc:
                read_errors.append(exc)

    readers = [threading.Thread(target=poll) for _ in range(4)]
    for reader in readers:
        reader.start()
    try:
        for n in range(1, 500):
            write_json_atomic(record, {"n": n})
    finally:
        stop.set()
        for reader in readers:
            reader.join()
    assert read_errors == []
    assert read_owner_metadata(record) == {"n": 499}


def test_a_missing_record_reads_as_no_owner(tmp_path):
    assert read_owner_metadata(tmp_path / "absent.json") == {}
