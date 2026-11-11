"""A repeated failure is counted, and the count is written when its minute is over or at
shutdown -- not only when the same failure happens again."""
from __future__ import annotations

import logging

from service.platform import failure_record


def _records(caplog):
    return [r.getMessage() for r in caplog.records if r.name == "test.failure_record"]


def test_repeats_are_written_when_the_minute_ends_and_at_shutdown(caplog, monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(failure_record.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(failure_record, "_ensure_sweeper", lambda: None)
    failure_record._seen.clear()
    log = logging.getLogger("test.failure_record")
    caplog.set_level(logging.WARNING, logger="test.failure_record")

    for _ in range(3):
        failure_record.record_failure(log, "reading x", OSError("disk"))
    assert _records(caplog) == ["reading x failed: OSError: disk"]

    # inside the minute nothing is due; once it is over the sweep writes the count
    assert failure_record.flush_failure_repeats(force=False, now=clock[0] + 10) == 0
    assert failure_record.flush_failure_repeats(force=False, now=clock[0] + 61) == 1
    assert _records(caplog)[-1] == "reading x failed: OSError: disk (repeated 2 more time(s) in the minute after the record above)"

    # a process that shuts down inside the minute still writes its count
    failure_record.record_failure(log, "writing y", ValueError("bad"))
    failure_record.record_failure(log, "writing y", ValueError("bad"))
    assert failure_record.flush_failure_repeats() == 1
    assert _records(caplog)[-1].startswith("writing y failed: ValueError: bad (repeated 1 more")
    failure_record._seen.clear()
