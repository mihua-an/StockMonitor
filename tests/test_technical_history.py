"""技術分析's history: the local days of a product, a page at a time, and the earlier bars a download brings into that store."""
from __future__ import annotations

import json
import os
import threading
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from api.routes.history_routes import HistoryRouteDependencies, create_history_router
from config import kbar_retention_settings as krs
from config.config_revisions import ConfigRevisionStore
from service.market.history.history_replay_service import HistoryReplayService
from service.market.history.technical_history import TechnicalHistoryReader
from service.market.shioaji import history_download
from service.market.shioaji.history_download import KBarDownloadManager, technical_history_job
from service.platform.http.errors import ValidationError
from tests.support.kbar_download_fakes import FakeAPI, FakeRepository

STOCK_SEGMENTS = [[[540, 810]]]
ROW = [540, 99.5, 101.0, 99.0, 100.0, 10.0]


def write_kbars(root: Path, code: str, sessions: dict, source="shioaji", market="STK") -> Path:
    path = root / f"source={source}" / f"market={market}" / f"{code}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"schema": "kbar-code-v1", "source": source, "market": market, "code": code, "sessions": sessions}), encoding="utf-8")
    return path


def day_session(dates, close=100.0, timeframe=1):
    return {"DAY": {"daily": {date: [close - 1, close + 2, close - 2, close, 50.0] for date in dates},
                    "intraday": {date: {"timeframe": timeframe, "bars": [ROW]} for date in dates}}}


@pytest.fixture
def reader(tmp_path):
    return TechnicalHistoryReader(tmp_path / "kbars")


def minute_days(reader, before=None, limit=5, code="2330", market="STK", session="DAY"):
    return reader.minute_days(market, session, code, before, limit)


def daily_bars(reader, before=None, limit=5, code="2330", market="STK", session="DAY"):
    return reader.daily_bars(market, session, code, before, limit)


def test_a_day_goes_out_at_the_timeframe_it_is_held_with_the_session_minutes(reader, tmp_path):
    write_kbars(tmp_path / "kbars", "2330", {"DAY": {"daily": {}, "intraday": {
        "2026-11-05": {"timeframe": 1, "bars": [ROW]}, "2026-08-03": {"timeframe": 5, "bars": [ROW]}}}})
    page = minute_days(reader, "2026-11-06")
    assert page["segments"] == STOCK_SEGMENTS
    assert page["next_before"] is None
    assert page["days"] == [{"trading_date": "2026-08-03", "source": "kbar_store", "timeframe": 5, "bars": [ROW]},
                            {"trading_date": "2026-11-05", "source": "kbar_store", "timeframe": 1, "bars": [ROW]}]


def test_a_page_stops_before_the_date_and_names_the_next_page(reader, tmp_path):
    write_kbars(tmp_path / "kbars", "2330", day_session(["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"]))
    page = minute_days(reader, "2026-11-06", 2)
    assert [day["trading_date"] for day in page["days"]] == ["2026-11-04", "2026-11-05"], "strictly before, oldest first"
    assert page["next_before"] == "2026-11-04"
    older = minute_days(reader, page["next_before"], 2)
    assert [day["trading_date"] for day in older["days"]] == ["2026-11-02", "2026-11-03"]
    assert older["next_before"] is None


def test_a_date_past_every_intraday_tier_still_has_its_daily_bar(reader, tmp_path):
    write_kbars(tmp_path / "kbars", "2330", {"DAY": {"daily": {"2024-01-02": [1.0, 2.0, 0.5, 1.5, 9.0]}, "intraday": {}}})
    assert minute_days(reader)["days"] == []
    assert daily_bars(reader)["bars"] == [{"trading_date": "2024-01-02", "open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5, "volume": 9, "source": "kbar_store"}]


def test_each_session_of_a_future_is_its_own_chart_with_its_own_minutes(reader, tmp_path):
    write_kbars(tmp_path / "kbars", "TXFR1", {"DAY": {"daily": {"2026-11-05": [1.0, 1.0, 1.0, 1.0, 1.0]}, "intraday": {}},
                                              "NIGHT": {"daily": {"2026-11-05": [2.0, 2.0, 2.0, 2.0, 2.0]}, "intraday": {"2026-11-05": {"timeframe": 1, "bars": [[900, 2.0, 2.0, 2.0, 2.0, 1.0]]}}}}, market="FUT")
    assert daily_bars(reader, code="TXFR1", market="FUT", session="NIGHT")["bars"][0]["open"] == 2.0
    night = minute_days(reader, code="TXFR1", market="FUT", session="NIGHT")
    assert night["segments"] == [[[900, 1740]]] and night["days"][0]["bars"][0][0] == 900
    assert minute_days(reader, code="TXFR1", market="FUT", session="DAY")["days"] == []


def test_a_futu_product_reads_its_own_source(reader, tmp_path):
    write_kbars(tmp_path / "kbars", "US.TSM", {"FULL": {"daily": {"2026-11-05": [1.0, 1.0, 1.0, 1.0, 1.0]}, "intraday": {}}}, source="futu", market="US")
    assert len(daily_bars(reader, code="US.TSM", market="US", session="FULL")["bars"]) == 1


def test_a_rewritten_file_is_read_again(reader, tmp_path):
    path = write_kbars(tmp_path / "kbars", "2330", day_session(["2026-11-05"], close=100.0))
    assert daily_bars(reader)["bars"][0]["close"] == 100.0
    path.write_text(json.dumps({"sessions": day_session(["2026-11-05"], close=123.456)}), encoding="utf-8")
    assert daily_bars(reader)["bars"][0]["close"] == 123.456


def test_an_unreadable_file_is_recorded_once_and_answers_nothing(reader, tmp_path, caplog):
    write_kbars(tmp_path / "kbars", "2330", day_session(["2026-11-05"])).write_text("{broken", encoding="utf-8")
    for _ in range(2):
        assert daily_bars(reader)["bars"] == []
    assert sum("reading the K-bar file" in record.getMessage() for record in caplog.records) == 1


def route(replay):
    router = create_history_router(HistoryRouteDependencies(runtime=SimpleNamespace(app=None), replay=replay, account=None))
    return next(item.endpoint for item in router.routes if item.path == "/api/history/kline")


def service(tmp_path, monkeypatch):
    import service.market.history.history_replay_service as module
    monkeypatch.setattr(module, "process_kbar_root", lambda: tmp_path / "kbars")
    return HistoryReplayService(lambda: SimpleNamespace())


def test_the_route_answers_a_page(tmp_path, monkeypatch):
    write_kbars(tmp_path / "kbars", "2330", day_session(["2026-11-05"]))
    answer = route(service(tmp_path, monkeypatch))(code="2330", resolution="day", before="2026-11-06", limit=None)
    assert answer["ok"] is True and answer["resolution"] == "day" and len(answer["bars"]) == 1


def test_the_route_answers_nothing_for_a_product_with_no_local_history(tmp_path, monkeypatch):
    answer = route(service(tmp_path, monkeypatch))(code="US.AAPL", market="US", session="FULL", resolution="minute", before="2026-11-06", limit=None)
    assert answer["days"] == [] and answer["next_before"] is None


@pytest.mark.parametrize("arguments", [
    {"code": "2330", "resolution": "hour", "before": None, "limit": None},
    {"code": "2330", "resolution": "day", "before": "2026-13-01", "limit": None},
    {"code": "../../secrets", "resolution": "minute", "before": None, "limit": None},
    {"code": "..", "resolution": "minute", "before": None, "limit": None},
    {"code": "", "resolution": "minute", "before": None, "limit": None},
    {"code": "2330", "market": "../x", "resolution": "minute", "before": None, "limit": None},
    {"code": "2330", "session": "../x", "resolution": "minute", "before": None, "limit": None},
])
def test_the_route_refuses_what_is_not_a_query(tmp_path, monkeypatch, arguments):
    with pytest.raises(ValidationError):
        route(service(tmp_path, monkeypatch))(**arguments)


def test_the_route_calls_no_broker(tmp_path, monkeypatch):
    def refuse(*_args, **_kwargs):
        raise AssertionError("a chart read asked the broker")
    replay = service(tmp_path, monkeypatch)
    router = create_history_router(HistoryRouteDependencies(runtime=SimpleNamespace(app=SimpleNamespace(create_kbar_download_job=refuse)), replay=replay, account=None))
    endpoint = next(item.endpoint for item in router.routes if item.path == "/api/history/kline")
    assert endpoint(code="2330", resolution="minute", before="2026-11-06", limit=None)["next_before"] is None


def test_the_job_covers_trading_days_before_the_date_within_one_broker_request(monkeypatch):
    monkeypatch.setattr(history_download, "tw_is_trading_day", lambda day: day.weekday() < 5 and day.isoformat() != "2026-11-04")
    job = technical_history_job("2330", "2026-11-09", trading_days=3)
    assert job == {"code": "2330", "start_date": "2026-11-03", "end_date": "2026-11-06", "auto_resume": False}, "weekend and the closed day skipped"
    wide = technical_history_job("2330", "2026-11-09", trading_days=500)
    span = datetime.fromisoformat(wide["end_date"]) - datetime.fromisoformat(wide["start_date"])
    assert span.days < history_download.MAX_KBARS_DAYS


def manager_on(tmp_path, repository, runner, usage_sample=True):
    clock = lambda: datetime(2026, 11, 8, 2, 0, tzinfo=timezone.utc)  # noqa: E731
    manager = KBarDownloadManager(lambda: repository.api, repository, db_path=tmp_path / "meta.sqlite",
                                  kbar_root=lambda: tmp_path / "kbars", import_runner=runner, clock=clock)
    if usage_sample:
        manager.jobs.connect().execute("INSERT INTO kbar_usage_samples(observed_at,model_version,observed_bytes,day_count) VALUES(?,?,?,?)", ("2026-11-08T02:00:00+00:00", "m", 1000, 1)).connection.commit()
    return manager


def store_writing_runner(calls):
    """Rust B's import, standing in where the test is about the job: each date at 1 minute, in the store's file. The
    daily bar is Rust B's to fold from the minutes (kbar_store.rs `daily_of`): the stand-in writes none."""
    def run(root, payload):
        calls.append(payload)
        sessions = {"DAY": {"daily": {},
                            "intraday": {day["date"]: {"timeframe": 1, "bars": day["minutes"]} for day in payload["days"]}}}
        write_kbars(root, payload["code"], sessions)
        return {"ok": True, "imported": len(payload["days"]), "held": 0}
    return run


QUOTA = {"bytes": 0, "limit_bytes": 10**9, "remaining_bytes": 10**9}


def finished(manager, code="2330"):
    for thread in threading.enumerate():
        if thread.name.startswith("kbar-older-"):
            thread.join(10)
    return manager.older_status(code)


def test_a_download_reaches_the_chart_through_the_store_it_reads(tmp_path, monkeypatch):
    """The whole pipe: the request, the budgeted download, the store file and the chart's reader."""
    monkeypatch.setattr(history_download, "tw_is_trading_day", lambda day: day.weekday() < 5)
    repository = FakeRepository(tmp_path, FakeAPI([QUOTA]))
    calls = []
    manager = manager_on(tmp_path, repository, store_writing_runner(calls))
    assert manager.request_older("2330", "2026-11-06")["state"] == "RUNNING"
    status = finished(manager)
    assert status["state"] == "DONE" and status["rows"] > 0
    assert calls[0]["days"][0]["minutes"][0][0] == 539, "the broker's minute-end stamp is the minute the bar covers"
    reader = TechnicalHistoryReader(tmp_path / "kbars")
    assert all(set(day) == {"date", "minutes"} for day in calls[0]["days"]), "the daily bar is folded by Rust B, not sent"
    assert reader.minute_days("STK", "DAY", "2330", "2026-11-06", None)["days"][0]["source"] == "kbar_store"


def test_a_range_the_broker_answers_empty_is_the_end_and_is_not_asked_again(tmp_path, monkeypatch):
    monkeypatch.setattr(history_download, "tw_is_trading_day", lambda day: day.weekday() < 5)
    repository = FakeRepository(tmp_path, FakeAPI([QUOTA]), rows=0)
    manager = manager_on(tmp_path, repository, store_writing_runner([]))
    manager.request_older("2330", "2026-11-06")
    assert finished(manager)["state"] == "END"
    asked = len(repository.calls)
    assert asked >= 1
    assert manager.request_older("2330", "2026-11-06")["state"] == "END"
    assert manager.request_older("2330", "2026-10-01")["state"] == "END", "older still: past the floor"
    assert len(repository.calls) == asked


def test_a_quota_too_small_for_the_estimate_is_quota_full_and_nothing_is_fetched(tmp_path, monkeypatch):
    monkeypatch.setattr(history_download, "tw_is_trading_day", lambda day: day.weekday() < 5)
    repository = FakeRepository(tmp_path, FakeAPI([{"bytes": 10**9, "limit_bytes": 10**9, "remaining_bytes": 0}]))
    manager = manager_on(tmp_path, repository, store_writing_runner([]))
    assert manager.request_older("2330", "2026-11-06")["state"] == "QUOTA_FULL"
    assert repository.calls == []
    assert manager.jobs.history_floor("2330") == "", "a full quota is not the end"


def test_a_refusal_with_the_quota_gone_is_quota_full(tmp_path, monkeypatch):
    monkeypatch.setattr(history_download, "tw_is_trading_day", lambda day: day.weekday() < 5)
    # Enough at the plan and at the reservation; used up by the time the broker refuses.
    repository = FakeRepository(tmp_path, FakeAPI([QUOTA, QUOTA, {"bytes": 10**9, "limit_bytes": 10**9, "remaining_bytes": 0}]))
    repository.fetch_broker_kbars_for_download = lambda *_a: (_ for _ in ()).throw(RuntimeError("流量超過"))
    manager = manager_on(tmp_path, repository, store_writing_runner([]))
    manager.request_older("2330", "2026-11-06")
    assert finished(manager)["state"] == "QUOTA_FULL"


def test_any_other_failure_is_recorded_and_is_not_the_end(tmp_path, monkeypatch, caplog):
    monkeypatch.setattr(history_download, "tw_is_trading_day", lambda day: day.weekday() < 5)
    repository = FakeRepository(tmp_path, FakeAPI([QUOTA]))
    repository.fetch_broker_kbars_for_download = lambda *_a: (_ for _ in ()).throw(ConnectionError("broker down"))
    manager = manager_on(tmp_path, repository, store_writing_runner([]))
    manager.request_older("2330", "2026-11-06")
    status = finished(manager)
    assert status["state"] == "FAILED" and "broker down" in status["error"]
    assert manager.jobs.history_floor("2330") == ""
    assert any("downloading the K bars of 2330" in record.getMessage() for record in caplog.records)


def test_an_unreadable_quota_is_a_failure_not_a_full_quota(tmp_path, monkeypatch):
    monkeypatch.setattr(history_download, "tw_is_trading_day", lambda day: day.weekday() < 5)
    repository = FakeRepository(tmp_path, FakeAPI([RuntimeError("usage unavailable")]))
    manager = manager_on(tmp_path, repository, store_writing_runner([]))
    assert manager.request_older("2330", "2026-11-06")["state"] == "FAILED"


def test_the_first_download_has_an_estimate_to_reserve_against(tmp_path, monkeypatch):
    monkeypatch.setattr(history_download, "tw_is_trading_day", lambda day: day.weekday() < 5)
    repository = FakeRepository(tmp_path, FakeAPI([QUOTA]))
    manager = manager_on(tmp_path, repository, store_writing_runner([]), usage_sample=False)
    manager.request_older("2330", "2026-11-06")
    assert finished(manager)["state"] == "DONE"


def test_a_running_download_is_joined_not_started_again(tmp_path, monkeypatch):
    monkeypatch.setattr(history_download, "tw_is_trading_day", lambda day: day.weekday() < 5)
    release = threading.Event()
    repository = FakeRepository(tmp_path, FakeAPI([QUOTA]))
    fetch = repository.fetch_broker_kbars_for_download
    repository.fetch_broker_kbars_for_download = lambda *args: (release.wait(10), fetch(*args))[1]
    manager = manager_on(tmp_path, repository, store_writing_runner([]))
    assert manager.request_older("2330", "2026-11-06")["state"] == "RUNNING"
    assert manager.request_older("2330", "2026-11-06")["state"] == "RUNNING"
    assert manager.older_status("2330")["state"] == "RUNNING"
    assert len(manager.list_jobs()) == 1
    release.set()
    assert finished(manager)["state"] == "DONE"


def test_a_date_the_store_holds_is_not_asked_for(tmp_path, monkeypatch):
    monkeypatch.setattr(history_download, "tw_is_trading_day", lambda day: day.weekday() < 5)
    job = technical_history_job("2330", "2026-11-06")
    start, end = datetime.fromisoformat(job["start_date"]).date(), datetime.fromisoformat(job["end_date"]).date()
    dates = [(start + timedelta(days=n)).isoformat() for n in range((end - start).days + 1)]
    write_kbars(tmp_path / "kbars", "2330", day_session(dates))
    repository = FakeRepository(tmp_path, FakeAPI([QUOTA]))
    manager = manager_on(tmp_path, repository, store_writing_runner([]))
    assert manager.request_older("2330", "2026-11-06")["state"] == "DONE"
    assert repository.calls == []


def test_the_older_route_refuses_what_is_no_date():
    router = create_history_router(HistoryRouteDependencies(runtime=SimpleNamespace(app=SimpleNamespace(request_older_kbars=lambda *_a: {"ok": True})), replay=None, account=None))
    endpoint = next(item.endpoint for item in router.routes if item.path == "/api/history/kline/older" and "POST" in item.methods)
    with pytest.raises(ValidationError):
        endpoint({"code": "2330", "before": "nope"})
    assert endpoint({"code": "2330", "before": "2026-11-06"}) == {"ok": True}


@pytest.mark.parametrize(("day", "months", "expected"), [("2026-05-31", 3, "2026-02-28"), ("2026-02-15", 3, "2025-11-15"), ("2026-11-08", 11, "2025-12-08")])
def test_months_before_is_the_rule_rust_ages_by(day, months, expected):
    """The same cases as kbar_store.rs a_month_shorter_than_the_day_ends_at_its_last_day."""
    assert krs.months_before(date.fromisoformat(day), months).isoformat() == expected


def test_each_minute_timeframe_reaches_its_own_retention(tmp_path, reader):
    horizons = krs.horizons(date(2026, 11, 8), tmp_path)
    assert horizons == {"1": "2026-08-08", "3": "2026-08-08", "5": "2026-06-08", "15": "2026-04-08", "30": "2026-02-08", "60": "2025-12-08"}
    write_kbars(tmp_path / "kbars", "2330", day_session(["2026-11-05"]))
    assert set(minute_days(reader, "2026-11-06")["horizons"]) == {"1", "3", "5", "15", "30", "60"}


@pytest.mark.skipif(not os.environ.get("STOCK_MONITOR_B_RELEASE"), reason="needs a Rust B built from this checkout (STOCK_MONITOR_B_RELEASE)")
def test_the_real_import_keeps_a_date_at_the_finest_timeframe_it_may_hold(tmp_path, monkeypatch):
    monkeypatch.setattr("config.config_revisions.config_root", lambda: tmp_path / "config")
    minutes = [[m, 10.0, 11.0, 9.0, 10.5, 1.0] for m in range(540, 560)]
    payload = {"source": "shioaji", "market": "STK", "session": "DAY", "code": "2330", "days": [{"date": "2020-01-02", "minutes": minutes}]}
    assert history_download.import_into_kbar_store(tmp_path / "kbars", payload)["imported"] == 1
    reader = TechnicalHistoryReader(tmp_path / "kbars")
    assert minute_days(reader)["days"] == [], "past every tier: only the daily bar"
    assert daily_bars(reader)["bars"][0] == {"trading_date": "2020-01-02", "open": 10.0, "high": 11.0, "low": 9.0, "close": 10.5,
                                             "volume": 20, "source": "kbar_store"}, "folded from the minutes"


def test_the_retention_defaults_are_the_contract_and_valid():
    assert krs.defaults() == {"months": {"1": 3, "5": 5, "15": 7, "30": 9, "60": 11}}
    assert krs.validate(krs.defaults()) == []


def test_the_retention_is_validated_strictly():
    codes = lambda values: {p["code"] for p in krs.validate(values)}  # noqa: E731
    good = krs.defaults()["months"]
    assert codes({"months": {**good, "1": 0}}) == {"MONTHS"}
    assert codes({"months": {**good, "1": True}}) == {"MONTHS"}
    assert codes({"months": {**good, "1": "3"}}) == {"MONTHS"}
    assert codes({"months": {**good, "3": 4}}) == {"MONTHS"}, "3 minutes shares 1 minute's value"
    assert codes({"months": {k: v for k, v in good.items() if k != "60"}}) == {"MONTHS"}
    assert codes({"months": {**good, "D": 12}}) == {"MONTHS"}, "daily bars are kept forever, no field"
    assert codes({"months": {**good, "1": 6}}) == {"MONTHS_ORDER"}, "a date is folded along the chain"
    assert codes({"months": good, "extra": 1}) == {"UNKNOWN_FIELD"}
    assert codes({}) == {"MONTHS"}


def test_the_retention_domain_is_served_and_seeded(tmp_path):
    from api.routes.config_routes import DOMAINS, seed_defaults
    assert DOMAINS["kbar_retention"].effect_contract == "storage_retention"
    seed_defaults(tmp_path)
    assert ConfigRevisionStore(tmp_path, "kbar_retention").active()["values"] == krs.defaults()
