"""模型中心「今天的狀態」: the day's phase for the automatic training. Health starts it when the session owner
publishes the day materialized, so no start time is predicted from a clock; only a failed attempt's retry
(schedule.json next_due_at) is shown as a countdown."""
import json
from datetime import date, datetime
from zoneinfo import ZoneInfo

from service.analysis.online_training.today import training_today

TPE = ZoneInfo("Asia/Taipei")
DATA = {d: {"date": d, "instruments": 70 + i, "events": 1000 * (i + 1), "bytes": 10 * (i + 1)} for i, d in
        enumerate(["2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07"])}


def weekdays(day: date):
    return day.isoweekday() <= 5


def run(clock: str, *, day="2026-10-07", state=None, schedule=None, running=False, available=None, ready=(False, "not yet"),
        window=None):
    now = datetime.fromisoformat(f"{day}T{clock}:00").replace(tzinfo=TPE)
    available = available if available is not None else ["2026-10-02", "2026-10-05", "2026-10-06"]
    return training_today(now, schedule=schedule or {}, window_days=3, state=state or {}, job=None, running=running,
                          available=available, window=window or (available[-3:], []),
                          materialized=ready, is_trading=weekdays, data_of=lambda d: DATA[d])


def test_phases_through_a_trading_day_predict_no_clock_time():
    assert run("08:10")["phase"] == "BEFORE_OPEN"
    session = run("10:00")
    assert session["phase"] == "IN_SESSION" and session["next_run_at"] is None and session["seconds_until_next_run"] is None
    waiting = run("14:35")
    assert waiting["phase"] == "WAITING_SEAL" and waiting["next_run_at"] is None, "starts when materialized, not at 14:30"
    assert run("14:43", ready=(True, "materialized"))["phase"] == "WAITING_TRAINING"
    assert run("14:43", running=True)["phase"] == "TRAINING"
    done = run("15:00", state={"last_trained_trading_date": "2026-10-07"})
    assert done["phase"] == "TRAINED" and done["next_run_at"] is None


def test_a_not_ready_attempt_waits_for_the_next_settled_notice_without_a_countdown():
    out = run("14:45", schedule={"trading_date": "2026-10-07", "state": "WAITING", "next_due_at": None,
                                 "last_result": {"state": "NOT_READY"}})
    assert out["phase"] == "WAITING_SEAL" and out["next_run_at"] is None


def test_a_failed_attempt_shows_its_retry_time():
    out = run("14:50", ready=(True, "materialized"),
              schedule={"trading_date": "2026-10-07", "state": "WAITING", "next_due_at": "2026-10-07T07:13:00+00:00",
                        "last_result": {"state": "FAILED"}})
    assert out["phase"] == "RETRY_WAIT" and out["next_run_at"] == "2026-10-07T15:13:00+08:00"
    assert out["seconds_until_next_run"] == 23 * 60
    stale = run("14:50", schedule={"trading_date": "2026-10-06", "state": "WAITING", "next_due_at": "2026-10-06T07:13:00+00:00"})
    assert stale["phase"] == "WAITING_SEAL", "another date's retry is not today's"


def test_a_holiday():
    saturday = run("11:00", day="2026-10-10")
    assert saturday["phase"] == "HOLIDAY" and not saturday["is_trading_day"]


def test_the_window_is_the_newest_committed_days_with_their_sizes():
    out = run("15:10", available=["2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07"], ready=(True, "materialized"))
    window = out["window"]
    assert window["dates"] == ["2026-10-05", "2026-10-06", "2026-10-07"] and window["includes_today"]
    assert (window["events"], window["bytes"], window["instruments"]) == (2000 + 3000 + 4000, 20 + 30 + 40, 73)
    assert out["today_data"]["events"] == 4000
    assert run("10:00")["today_data"] is None, "nothing committed for today during the session"


def test_the_window_shows_the_complete_days_it_trains_on_and_the_incomplete_ones_it_tests_on():
    out = run("15:10", available=["2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07"], ready=(True, "materialized"),
              window=(["2026-10-05", "2026-10-07"], ["2026-10-06"]))["window"]
    assert out["dates"] == ["2026-10-05", "2026-10-06", "2026-10-07"]
    assert (out["trained_dates"], out["test_only_dates"]) == (["2026-10-05", "2026-10-07"], ["2026-10-06"])


def _date_dir(root, day):
    return root / "source=shioaji" / "market=STK" / f"trading_date={day}"


def _partition(root, day, code, events):
    folder = _date_dir(root, day) / "session=DAY" / code
    folder.mkdir(parents=True)
    (folder / "manifest.json").write_text(json.dumps({"event_count": events}), encoding="utf-8")


def _totals(root, day, partitions):
    """The date's index as Rust B writes it (historical_totals.rs): (code, events, bytes) per DAY partition."""
    _date_dir(root, day).mkdir(parents=True, exist_ok=True)
    doc = {"schema": "historical-date-totals-v3", "trading_date": day, "partitions": [
        {"session": "DAY", "code": code, "stamp_ns": 1, "events": events, "events_bytes": size // 2, "bytes": size,
         "lanes": {"trade": events}} for code, events, size in partitions]}
    (_date_dir(root, day) / "totals.json").write_text(json.dumps(doc), encoding="utf-8")


def test_a_date_s_data_is_its_owner_written_totals_not_a_scan_of_its_partitions(tmp_path):
    # The request reads one file the historical store's manager keeps current (historical_totals.rs); it never
    # lists the date's ~1000 partitions.
    from service.analysis.online_training.today import date_data

    _partition(tmp_path, "2026-10-08", "2330", 10)
    assert date_data(tmp_path, "2026-10-08") == {"date": "2026-10-08", "instruments": 0, "events": 0, "bytes": 0}, \
        "partitions without the totals file are not counted by the reader"
    _totals(tmp_path, "2026-10-08", [("2330", 7_000_000, 5_000_000_000), ("2317", 5_000_000, 4_000_000_000)])
    assert date_data(tmp_path, "2026-10-08") == {"date": "2026-10-08", "instruments": 2, "events": 12_000_000, "bytes": 9_000_000_000}
    _totals(tmp_path, "2026-10-08", [("2330", 7_000_000, 5_000_000_000), ("2317", 5_000_000, 4_000_000_000), ("2303", 100, 100)])
    assert date_data(tmp_path, "2026-10-08")["instruments"] == 3, "a date still materializing reads as it is now"
    assert date_data(tmp_path, "2026-10-09")["events"] == 0


def test_an_unreadable_totals_file_is_reported_not_shown_as_no_data(tmp_path):
    from service.analysis.online_training.today import date_data

    _date_dir(tmp_path, "2026-10-08").mkdir(parents=True)
    (_date_dir(tmp_path, "2026-10-08") / "totals.json").write_text("{broken", encoding="utf-8")
    assert date_data(tmp_path, "2026-10-08")["error"] == "TOTALS_UNREADABLE"
    (_date_dir(tmp_path, "2026-10-08") / "totals.json").write_text(json.dumps({"schema": "other", "events": 5}), encoding="utf-8")
    assert date_data(tmp_path, "2026-10-08")["error"] == "TOTALS_UNREADABLE"
    # The earlier schema is not read (B rewrites every date's index at its first start after the upgrade).
    (_date_dir(tmp_path, "2026-10-08") / "totals.json").write_text(json.dumps(
        {"schema": "historical-date-totals-v1", "instruments": 1, "events": 5, "bytes": 9, "sessions": {}}), encoding="utf-8")
    assert date_data(tmp_path, "2026-10-08")["error"] == "TOTALS_UNREADABLE"
