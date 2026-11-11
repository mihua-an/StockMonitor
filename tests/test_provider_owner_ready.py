"""realtime_api starts beside app_api, not after the provider daemons; its provider clients attach once the daemon's
owner record says READY (service/market/shared/daemon_singleton.py). A READY left behind by a dead daemon is not one."""
from __future__ import annotations

import json
import logging
import os
import re
import threading
from pathlib import Path

from service.market.shared.daemon_singleton import owner_ready, wait_until_owner_ready
from service.platform.process_observer import process_created_epoch_ns

ROOT = Path(__file__).resolve().parents[1]


def _record(path: Path, lifecycle: str, *, pid: int | None = None, created_ns: int | None = None) -> None:
    pid = os.getpid() if pid is None else pid
    created = process_created_epoch_ns(pid) if created_ns is None else created_ns
    path.write_text(json.dumps({"owner_pid": pid, "owner_created_ns": created, "lifecycle": lifecycle}), encoding="utf-8")


def test_only_a_ready_record_of_a_running_owner_is_ready(tmp_path):
    record = tmp_path / "market_daemon_owner.json"
    assert owner_ready(record) is False, "no record: no daemon yet"
    _record(record, "STARTING")
    assert owner_ready(record) is False
    _record(record, "READY")
    assert owner_ready(record) is True
    _record(record, "STOPPING")
    assert owner_ready(record) is False
    if os.name == "nt":
        _record(record, "READY", created_ns=(process_created_epoch_ns(os.getpid()) or 0) - 10_000_000_000)
        assert owner_ready(record) is False, "a reused pid (another creation time) is not the owner"
        _record(record, "READY", pid=2 ** 22 + 7, created_ns=1)
        assert owner_ready(record) is False, "a READY left by a daemon that is gone"


def test_the_wait_ends_when_the_daemon_is_ready_or_the_process_stops(tmp_path, caplog):
    record = tmp_path / "moomoo_daemon_owner.json"
    _record(record, "STARTING")
    shutdown = threading.Event()
    outcome: list[bool] = []
    worker = threading.Thread(target=lambda: outcome.append(
        wait_until_owner_ready(record, shutdown, label="futu", logger=logging.getLogger("t"), poll_s=0.01)))
    with caplog.at_level(logging.INFO):
        worker.start()
        _record(record, "READY")
        worker.join(5)
    assert outcome == [True]

    _record(record, "STARTING")
    stopping = threading.Event()
    stopping.set()
    assert wait_until_owner_ready(record, stopping, label="futu", logger=logging.getLogger("t"), poll_s=0.01) is False


def test_health_starts_realtime_api_without_waiting_for_the_providers():
    source = (ROOT / "health" / "main.js").read_text(encoding="utf-8")
    line = next(l for l in source.splitlines() if re.match(r"\s*realtime_api: \{ host:", l))
    assert "after" not in line and "requires" not in line, line
    quote = (ROOT / "api" / "services" / "quote_api.py").read_text(encoding="utf-8")
    assert "wait_until_owner_ready(owner_path()" in quote, "each client attaches only once its daemon is READY"


def test_a_ready_record_with_unreadable_identity_fields_is_not_ready_and_does_not_raise(tmp_path):
    record = tmp_path / "moomoo_daemon_owner.json"
    for fields in ({"owner_pid": " 12 ", "owner_created_ns": 1}, {"owner_pid": os.getpid(), "owner_created_ns": "x"},
                   {"owner_pid": [1], "owner_created_ns": 1}, {"owner_pid": True, "owner_created_ns": 1}):
        record.write_text(json.dumps({**fields, "lifecycle": "READY"}), encoding="utf-8")
        assert owner_ready(record) is False, fields
