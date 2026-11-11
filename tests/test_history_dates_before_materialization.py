"""歷史回放 lists a day Market Runtime recorded before it is materialized (A plays it from its WAL), and needs no restart
of the service for a day to appear or to become a materialized one."""
from __future__ import annotations

import json

from service.market.history.history_replay_service import HistoryReplayService
from service.market.shared.partition_evidence import ENV_ROOT, SCHEMA


class _Historical:
    def __init__(self, dates):
        self.dates = dates

    def list_dates(self, market=None):
        assert market == "STK"
        return list(self.dates)


class _Repository:
    def __init__(self, dates):
        self.historical = _Historical(dates)


def _record(root, date, *, accepted=10, market="STK", session="DAY", quarantined=None):
    path = root / "shioaji" / market / f"{date}_{session}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"schema": SCHEMA, "accepted": accepted, "quarantined": quarantined}), encoding="utf-8")


def test_a_recorded_day_is_listed_before_its_materialization_and_once_after_it(tmp_path, monkeypatch):
    monkeypatch.setenv(ENV_ROOT, str(tmp_path))
    repository = _Repository(["2026-11-06"])
    service = HistoryReplayService(lambda: repository)
    assert service.list_dates() == ["2026-11-06"]

    _record(tmp_path, "2026-11-09")
    assert service.list_dates() == ["2026-11-09", "2026-11-06"], "a day that has traded appears with no restart"

    repository.historical.dates = ["2026-11-09", "2026-11-06"]
    assert service.list_dates() == ["2026-11-09", "2026-11-06"], "materialized: listed once"


def test_only_a_stock_day_with_stored_events_counts(tmp_path, monkeypatch):
    monkeypatch.setenv(ENV_ROOT, str(tmp_path))
    _record(tmp_path, "2026-11-07", accepted=0)
    _record(tmp_path, "2026-11-08", quarantined={"reason": "not a session"})
    _record(tmp_path, "2026-11-09", market="IDX")
    _record(tmp_path, "2026-11-10", market="FUT", session="NIGHT")
    assert HistoryReplayService(lambda: _Repository([])).list_dates() == []


def test_no_repository_lists_nothing(tmp_path, monkeypatch):
    monkeypatch.setenv(ENV_ROOT, str(tmp_path))
    _record(tmp_path, "2026-11-09")
    assert HistoryReplayService(lambda: None).list_dates() == []
