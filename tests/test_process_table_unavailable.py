"""A failed process-table read returned an empty set, so every owner read as gone."""
from __future__ import annotations

import pytest

from service.market.shared import daemon_probe, daemon_process_identity
from service.platform import process_observer


def test_an_unreadable_process_table_is_unknown_never_gone(monkeypatch):
    def unreadable():
        raise process_observer.ProcessTableUnavailable("snapshot failed")

    monkeypatch.setattr(process_observer, "process_ids", unreadable)
    with pytest.raises(process_observer.ProcessTableUnavailable):
        process_observer.process_exists(1234)

    def unknown(pid):
        raise process_observer.ProcessTableUnavailable("snapshot failed")

    monkeypatch.setattr(daemon_process_identity, "process_exists", unknown)
    verdict = daemon_process_identity.classify_owner_metadata({"owner_pid": 1234}, known_patterns=("daemon",))
    assert verdict == "OWNER_UNVERIFIABLE", "a held singleton is never cleared on an unknown"

    monkeypatch.setattr(daemon_probe, "process_exists", unknown)
    import time
    result = daemon_probe.assess_passive_health_snapshot(
        {"generated_epoch_ns": time.time_ns(), "process": {"pid": 1234}}, now_epoch_ns=time.time_ns(), max_age_seconds=30)
    assert result["snapshot_fresh"] is False and result["process_state"] == "UNVERIFIABLE"


@pytest.mark.parametrize("snapshot", [
    {"generated_epoch_ns": "soon", "process": {"pid": 1234}},
    {"generated_epoch_ns": 1, "process": {"pid": "abc"}},
    {"generated_epoch_ns": 1, "process": {"pid": {"n": 1}}},
])
def test_a_snapshot_with_unreadable_fields_is_not_fresh_and_says_why(snapshot):
    import time
    result = daemon_probe.assess_passive_health_snapshot(snapshot, now_epoch_ns=time.time_ns(), max_age_seconds=30)
    assert result["snapshot_fresh"] is False and result["snapshot_error"].startswith("unreadable snapshot fields")
