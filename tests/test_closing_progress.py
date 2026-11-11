"""收盤整理 (資料中心's top card): the next close (Shioaji and Futu) to be materialized, as its owners recorded it."""
from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path

from service.market.lifecycle.closing_progress import closing_progress
from service.market.shared.wal_retention import TAIPEI

DATE = "2026-10-29"


def _write(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def _evidence(root: Path, market: str, date: str, *, sealed: bool, admitted: int = 100, session: str = "DAY",
              source: str = "shioaji") -> None:
    _write(root / source / market / f"{date}_{session}.json", {"accepted": admitted, "sealed": sealed, "first_ts_ns": 1, "last_ts_ns": 2})


def _record(market: str, state: str, *, date: str = DATE, session: str = "DAY", job_id: str = "", **extra) -> dict:
    return {"source": "shioaji", "market": market, "trading_date": date, "session": session, "instrument": "", "state": state,
            "attempts": 1, "job_id": job_id or f"{market}-{session}-{date}", "created_at": 1.0, "updated_at": 2.0, **extra}


def _ledger(jobs: Path, *records: dict, source: str = "shioaji") -> None:
    _write(jobs / "ledger" / f"{source}.json", {f"k{i}": record for i, record in enumerate(records)})


def _at(day: int, hour: int, minute: int) -> datetime:
    return datetime(2026, 10, day, hour, minute, tzinfo=TAIPEI)


def test_no_record_yet_is_waiting_for_the_close(tmp_path):
    view = closing_progress(_at(29, 10, 0), jobs_root=tmp_path / "jobs", evidence_root=tmp_path / "ev")
    assert (view["id"], view["stage"], view["sessions"], view["history"]) == (None, "waiting_close", [], [])
    # Nothing recorded yet: the next close is the calendar's (10-29 is a Thursday: FUT's day at 13:45).
    assert view["next"] == {"id": "FUT:DAY", "source": "shioaji", "trading_date": DATE, "seal_due_at": "2026-10-29T13:45:00+08:00"}


def test_the_card_follows_the_next_close_through_the_day(tmp_path):
    ev, jobs = tmp_path / "ev", tmp_path / "jobs"
    for market in ("STK", "IDX", "FUT"):
        _evidence(ev, market, DATE, sealed=False)
    # 10:00: FUT's day closes first (13:45); STK and IDX are one close at 14:40.
    view = closing_progress(_at(29, 10, 0), jobs_root=jobs, evidence_root=ev)
    assert (view["id"], view["stage"], [s["id"] for s in view["sessions"]]) == ("FUT:DAY", "waiting_close", ["FUT:DAY"])
    assert view["seal_due_at"] == "2026-10-29T13:45:00+08:00"
    assert view["next"]["id"] == "FUT:DAY", "a close waiting for its seal time is the next one"

    # 13:46: FUT's day is materialized -> the card moves to 台股 and names what was done last.
    _evidence(ev, "FUT", DATE, sealed=True)
    _ledger(jobs, _record("FUT", "succeeded", result={"codes_materialized": 1, "total_event_count": 169268,
                                                      # 11 of the events written are Market Runtime's own coverage and
                                                      # loss records: the card counts the market events.
                                                      "market_event_count": 169257, "control_event_count": 11,
                                                      "backfill_event_count": 0, "completeness": "complete", "completed_at": "2026-10-29T05:46:00Z"}))
    view = closing_progress(_at(29, 13, 46), jobs_root=jobs, evidence_root=ev)
    assert (view["id"], [s["id"] for s in view["sessions"]], view["stage"]) == ("STK:DAY", ["STK:DAY", "IDX:DAY"], "waiting_close")
    assert view["history"] == [{"id": "FUT:DAY", "trading_date": DATE, "stage": "done", "ended_at": "2026-10-29T05:46:00Z",
                                "codes": 1, "events": 169257, "backfilled": 0, "gaps": []}]
    # Past 14:40, an unsealed session is waiting for its owner.
    assert closing_progress(_at(29, 14, 41), jobs_root=jobs, evidence_root=ev)["stage"] == "waiting_seal"

    # 台股 settled; the night session (dated by its open) is next, sealed at 05:00 the next day.
    _evidence(ev, "STK", DATE, sealed=True)
    _evidence(ev, "IDX", DATE, sealed=True)
    _evidence(ev, "FUT", DATE, sealed=False, session="NIGHT")
    _ledger(jobs, _record("FUT", "succeeded"), _record("STK", "succeeded"), _record("IDX", "succeeded"))
    _write(jobs / "settled" / "shioaji.json", {"sessions": {"STK:DAY": {"trading_date": DATE, "settled_at": "2026-10-29T14:43:26+08:00"}}})
    view = closing_progress(_at(29, 16, 0), jobs_root=jobs, evidence_root=ev)
    assert (view["id"], view["stage"], view["seal_due_at"]) == ("FUT:NIGHT", "waiting_close", "2026-10-30T05:00:00+08:00")
    assert [(row["id"], row["ended_at"]) for row in view["history"]] == [("STK:DAY", "2026-10-29T14:43:26+08:00"), ("FUT:DAY", None)]

    # Every recorded close over: the newest one is shown, done.
    _evidence(ev, "FUT", DATE, sealed=True, session="NIGHT")
    _ledger(jobs, _record("FUT", "succeeded"), _record("STK", "succeeded"), _record("IDX", "succeeded"),
            _record("FUT", "succeeded", session="NIGHT"))
    view = closing_progress(_at(30, 5, 10), jobs_root=jobs, evidence_root=ev)
    assert (view["id"], view["stage"]) == ("FUT:NIGHT", "done")
    assert [row["id"] for row in view["history"]] == ["FUT:NIGHT", "STK:DAY", "FUT:DAY"]
    # Everything over: the next close is the calendar's after it -- 10-30's FUT day.
    assert view["next"] == {"id": "FUT:DAY", "source": "shioaji", "trading_date": "2026-10-30", "seal_due_at": "2026-10-30T13:45:00+08:00"}

    # One of each kind: a newer day's FUT close ends the list before the older one repeats.
    _evidence(ev, "FUT", "2026-10-30", sealed=True)
    _ledger(jobs, _record("FUT", "succeeded"), _record("STK", "succeeded"), _record("IDX", "succeeded"),
            _record("FUT", "succeeded", session="NIGHT"), _record("FUT", "succeeded", date="2026-10-30"))
    view = closing_progress(_at(30, 14, 0), jobs_root=jobs, evidence_root=ev)
    assert [(row["id"], row["trading_date"]) for row in view["history"]] == [
        ("FUT:DAY", "2026-10-30"), ("FUT:NIGHT", DATE), ("STK:DAY", DATE)]


def test_a_running_job_carries_the_progress_health_recorded(tmp_path):
    ev, jobs = tmp_path / "ev", tmp_path / "jobs"
    _evidence(ev, "STK", DATE, sealed=True, admitted=2_900_000)
    _evidence(ev, "IDX", DATE, sealed=True)
    _ledger(jobs, _record("STK", "running", job_id="stk-a1"), _record("IDX", "succeeded",
            result={"codes_materialized": 15, "total_event_count": 49546, "market_event_count": 49276,
                    "backfill_event_count": 0, "completeness": "complete", "completed_at": "x"}))
    phases = {"scan": {"done": 9, "total": 9, "elapsed_ms": 800, "started_at": "t0"},
              "read": {"done": 500, "total": 1000, "elapsed_ms": 4000, "started_at": "t1"}}
    _write(jobs / "progress.json", {"schema": "materialization-progress-v2", "jobs": {
        "stk-a1": {"job_id": "stk-a1", "status": "running", "started_at": "t0", "phase": "read", "phases": phases}}})
    view = closing_progress(_at(29, 14, 42), jobs_root=jobs, evidence_root=ev)
    assert (view["id"], view["stage"]) == ("STK:DAY", "materializing")
    stk, idx = view["sessions"]
    assert (stk["state"], stk["accepted"], stk["job"]["phase"], stk["job"]["phases"]["read"]["done"]) == ("running", 2_900_000, "read", 500)
    assert idx["job"] is None and idx["result"] == {"codes": 15, "events": 49276, "backfilled": 0, "completeness": "complete", "completed_at": "x"}


def test_a_failure_waiting_for_its_retry_holds_the_card_and_a_terminal_one_does_not(tmp_path):
    ev, jobs = tmp_path / "ev", tmp_path / "jobs"
    _evidence(ev, "STK", DATE, sealed=True)
    _evidence(ev, "FUT", DATE, sealed=False, session="NIGHT")
    _ledger(jobs, _record("STK", "failed_retryable", next_attempt_at=99.0, last_error="boom"))
    view = closing_progress(_at(29, 15, 0), jobs_root=jobs, evidence_root=ev)
    assert (view["id"], view["stage"], view["sessions"][0]["last_error"]) == ("STK:DAY", "retry_wait", "boom")

    _ledger(jobs, _record("STK", "failed_terminal"))
    view = closing_progress(_at(29, 15, 0), jobs_root=jobs, evidence_root=ev)
    assert (view["id"], view["history"][0]["id"], view["history"][0]["stage"]) == ("FUT:NIGHT", "STK:DAY", "failed")
    # A settled notice of another day is not this day's.
    _ledger(jobs, _record("STK", "succeeded"))
    _write(jobs / "settled" / "shioaji.json", {"sessions": {"STK:DAY": {"trading_date": "2026-10-28", "settled_at": "y"}}})
    assert closing_progress(_at(29, 15, 0), jobs_root=jobs, evidence_root=ev)["history"][0]["ended_at"] is None


def test_a_label_no_owner_seals_is_not_a_close(tmp_path):
    ev, jobs = tmp_path / "ev", tmp_path / "jobs"
    _evidence(ev, "STK", DATE, sealed=False, session="NIGHT")   # STK has no night session
    assert closing_progress(_at(29, 15, 0), jobs_root=jobs, evidence_root=ev)["id"] is None


def test_the_last_close_comes_whole_for_the_log(tmp_path):
    ev, jobs = tmp_path / "ev", tmp_path / "jobs"
    _evidence(ev, "FUT", DATE, sealed=True)
    _evidence(ev, "FUT", DATE, sealed=False, session="NIGHT")
    _ledger(jobs, _record("FUT", "succeeded"))
    view = closing_progress(_at(29, 16, 0), jobs_root=jobs, evidence_root=ev)
    assert (view["id"], view["stage"]) == ("FUT:NIGHT", "waiting_close")
    assert (view["last"]["id"], view["last"]["stage"], [s["state"] for s in view["last"]["sessions"]]) == ("FUT:DAY", "done", ["succeeded"])
    assert closing_progress(_at(29, 10, 0), jobs_root=tmp_path / "none", evidence_root=tmp_path / "none")["last"] is None


def test_futu_us_is_a_close_of_its_own_and_crypto_is_not(tmp_path):
    ev, jobs = tmp_path / "ev", tmp_path / "jobs"
    # The US day of 10-29 (New York) is sealed 10 minutes after it ends: 10-30 12:10 Taipei.
    _evidence(ev, "US", DATE, sealed=False, admitted=1_691_282, session="FULL", source="futu")
    _ledger(jobs, {**_record("CC", "no_input", session="FULL"), "source": "futu"}, source="futu")
    _evidence(ev, "FUT", DATE, sealed=True, session="NIGHT")
    _ledger(jobs, _record("FUT", "succeeded", session="NIGHT"))
    view = closing_progress(_at(30, 6, 0), jobs_root=jobs, evidence_root=ev)
    assert (view["id"], view["source"], view["stage"], view["seal_due_at"]) == ("US:FULL", "futu", "waiting_close", "2026-10-30T12:10:00+08:00")
    assert view["sessions"][0]["accepted"] == 1_691_282
    # Recorded and before the calendar's next Shioaji close (13:45): it is 下次物化.
    assert view["next"] == {"id": "US:FULL", "source": "futu", "trading_date": DATE, "seal_due_at": "2026-10-30T12:10:00+08:00"}
    assert [row["id"] for row in view["history"]] == ["FUT:NIGHT"], "crypto is never stored: no close"

    _evidence(ev, "US", DATE, sealed=True, admitted=1_691_282, session="FULL", source="futu")
    _ledger(jobs, {**_record("US", "succeeded", session="FULL", result={"codes_materialized": 12, "total_event_count": 1_694_121,
                                                                         "market_event_count": 1_694_000, "backfill_event_count": 2_718,
                                                                         "completeness": "gap_detected", "completed_at": "u"}),
                   "source": "futu"}, source="futu")
    view = closing_progress(_at(30, 12, 20), jobs_root=jobs, evidence_root=ev)
    # A result that does not state its market events (an older job's) is unknown, never 0 筆.
    night = next(row for row in view["history"] if row["id"] == "FUT:NIGHT")
    assert (night["events"], night["backfilled"]) == (None, None), night
    assert view["history"][0] == {"id": "US:FULL", "trading_date": DATE, "stage": "done", "ended_at": "u", "codes": 12,
                                  "events": 1_694_000, "backfilled": 2_718, "gaps": ["US:FULL"]}
    assert view["next"]["id"] == "FUT:DAY"


# 10-30's real 台股 job (progress.json): read 7,086,938 WAL records in 49.3 s, write 3,113,766 events in 72.2 s.
STK_1030 = {"scan": (87, 3282), "read": (7_086_938, 49_260), "write": (3_113_766, 72_177), "summary": (1, 38)}


def _phases(upto: str, done: int, elapsed_ms: int) -> dict:
    """The phases a job like STK_1030 reports while it is ``done`` events into ``upto``."""
    phases = {}
    for phase, (total, took) in STK_1030.items():
        if phase == upto:
            phases[phase] = {"done": done, "total": total, "elapsed_ms": elapsed_ms, "started_at": "t"}
            return phases
        phases[phase] = {"done": total, "total": total, "elapsed_ms": took, "started_at": "t"}
    return phases


def test_the_time_left_is_one_estimate_that_holds_across_phases(tmp_path):
    """One estimate for the card and the job's row, steady when ``write`` begins (it counts events, as ``read`` does)."""
    ev, jobs = tmp_path / "ev", tmp_path / "jobs"
    _evidence(ev, "STK", "2026-10-30", sealed=True, admitted=3_113_766)
    _evidence(ev, "IDX", "2026-10-30", sealed=True)
    _ledger(jobs, _record("STK", "running", date="2026-10-30", job_id="stk-now"),
            _record("IDX", "succeeded", date="2026-10-30", result={"completeness": "complete"}))
    measured = {"job_id": "stk-before", "source": "shioaji", "market": "STK", "status": "materialized",
                "started_at": "2026-10-29T06:40:02Z", "phases": _phases("none", 0, 0)}
    whole = sum(took for _, took in STK_1030.values()) / 1000
    start = _at(30, 14, 40)
    estimates = []
    # Every 5 s of a job that runs as 10-30's did: its total (spent + left) stays that job's length.
    for second in range(5, int(whole), 5):
        clock, phase, done, into = 0.0, None, 0, 0
        for name, (total, took) in STK_1030.items():
            if second * 1000 < clock + took:
                phase, into = name, int(second * 1000 - clock)
                done = int(total * into / took)
                break
            clock += took
        now = start + timedelta(seconds=second)
        entry = {"job_id": "stk-now", "source": "shioaji", "market": "STK", "status": "running", "started_at": start.isoformat(),
                 "updated_at": now.isoformat(), "phase": phase, "phases": _phases(phase, done, into)}
        _write(jobs / "progress.json", {"schema": "materialization-progress-v2", "jobs": {"stk-before": measured, "stk-now": entry}})
        view = closing_progress(now, jobs_root=jobs, evidence_root=ev)
        stk = view["sessions"][0]
        assert view["estimate"]["remaining_s"] == stk["remaining_s"], "the card shows the job's own estimate"
        estimates.append((second, phase, view["estimate"]["elapsed_s"] + view["estimate"]["remaining_s"]))
    for second, phase, total in estimates:
        assert abs(total - whole) < 0.05 * whole, (second, phase, total, whole)
    assert {phase for _, phase, _ in estimates} >= {"read", "write"}


def test_a_market_never_measured_goes_by_the_jobs_own_rate(tmp_path):
    ev, jobs = tmp_path / "ev", tmp_path / "jobs"
    _evidence(ev, "FUT", DATE, sealed=True, admitted=1000)
    _ledger(jobs, _record("FUT", "running", job_id="fut-1"))
    entry = {"job_id": "fut-1", "source": "shioaji", "market": "FUT", "status": "running", "started_at": "t", "phase": "scan",
             "phases": {"scan": {"done": 0, "total": 0, "elapsed_ms": 0}}}
    _write(jobs / "progress.json", {"schema": "materialization-progress-v2", "jobs": {"fut-1": entry}})
    view = closing_progress(_at(29, 13, 46), jobs_root=jobs, evidence_root=ev)
    assert view["sessions"][0]["remaining_s"] is None and view["estimate"]["remaining_s"] is None, "nothing to go by yet"
    entry["phase"], entry["phases"]["read"] = "read", {"done": 500, "total": 2000, "elapsed_ms": 1000}
    entry["phases"]["scan"] = {"done": 3, "total": 3, "elapsed_ms": 100}
    _write(jobs / "progress.json", {"schema": "materialization-progress-v2", "jobs": {"fut-1": entry}})
    view = closing_progress(_at(29, 13, 46), jobs_root=jobs, evidence_root=ev)
    # read: 1500 left at 500/s; write: the 1000 admitted events at the same rate.
    assert view["sessions"][0]["remaining_s"] == 5.0
