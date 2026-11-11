"""B14: the WAL retention cutoff is the session owners' decision, read from every source that writes the WAL."""
from __future__ import annotations

import json
from datetime import datetime
from zoneinfo import ZoneInfo

from service.market.shared import wal_retention as wr

TAIPEI = ZoneInfo("Asia/Taipei")


NOW = datetime(2026, 9, 30, 15, 0, tzinfo=TAIPEI)


def ns(*args) -> int:
    return int(datetime(*args, tzinfo=TAIPEI).timestamp()) * 1_000_000_000


def row(source, market, day, session, first, *, accepted=5, sealed=True, **extra):
    return {"source": source, "market": market, "trading_date": day, "session": session, "accepted": accepted,
            "first_ts_ns": first, "sealed": sealed, **extra}


def done(source, market, day, session, state="succeeded"):
    return {"source": source, "market": market, "trading_date": day, "session": session, "instrument": "", "state": state}


def test_nothing_shown_or_unmaterialized_holds_nothing():
    before, held = wr.retention_before_ns(NOW, [], [])
    assert before == int(NOW.timestamp()) * 1_000_000_000 and held == []


def test_a_materialized_session_no_longer_shown_goes_at_once():
    # User 10-14: once materialized and replaced by its market's next session, its WAL events are a duplicate.
    old = row("shioaji", "STK", "2026-09-29", "DAY", ns(2026, 9, 29, 8, 30))
    today = row("shioaji", "STK", "2026-09-30", "DAY", ns(2026, 9, 30, 8, 30), sealed=False)
    before, held = wr.retention_before_ns(NOW, [done("shioaji", "STK", "2026-09-29", "DAY")], [old, today])
    assert before == ns(2026, 9, 30, 8, 30), "only the shown session stays"
    assert held == ["shioaji:STK 2026-09-30 DAY shown"]


def test_the_shown_session_stays_even_when_materialized():
    # Market Runtime and Rust B rebuild the session the market still shows from the WAL after a restart.
    friday = row("shioaji", "STK", "2026-09-26", "DAY", ns(2026, 9, 26, 8, 30))
    before, held = wr.retention_before_ns(datetime(2026, 9, 28, 7, 0, tzinfo=TAIPEI),
                                          [done("shioaji", "STK", "2026-09-26", "DAY")], [friday])
    assert before == ns(2026, 9, 26, 8, 30) and held == ["shioaji:STK 2026-09-26 DAY shown"], "Friday stays over the weekend"


def test_an_unsealed_or_unfinished_or_terminally_failed_session_holds():
    rows = [row("futu", "US", "2026-09-26", "FULL", ns(2026, 9, 26, 21, 0), sealed=False),
            row("futu", "US", "2026-09-29", "FULL", ns(2026, 9, 29, 21, 0)),
            row("shioaji", "STK", "2026-09-25", "DAY", ns(2026, 9, 25, 8, 30)),
            row("shioaji", "STK", "2026-09-29", "DAY", ns(2026, 9, 29, 8, 30)),
            row("shioaji", "FUT", "2026-09-24", "DAY", ns(2026, 9, 24, 8, 45)),
            row("shioaji", "FUT", "2026-09-29", "DAY", ns(2026, 9, 29, 8, 45))]
    ledger = [done("shioaji", "STK", "2026-09-25", "DAY", "failed_retryable"), done("shioaji", "FUT", "2026-09-24", "DAY", "failed_terminal"),
              done("shioaji", "STK", "2026-09-29", "DAY"), done("shioaji", "FUT", "2026-09-29", "DAY"), done("futu", "US", "2026-09-29", "FULL")]
    before, held = wr.retention_before_ns(NOW, ledger, rows)
    assert before == ns(2026, 9, 24, 8, 45), "a terminal failure needs the WAL for an operator's retry"
    assert "futu:US 2026-09-26 FULL not sealed" in held
    assert "shioaji:STK 2026-09-25 DAY materialization failed_retryable" in held
    assert "shioaji:FUT 2026-09-24 DAY materialization failed_terminal" in held
    # sealed with no record yet is not materialized either
    lone = [row("shioaji", "IDX", "2026-09-28", "DAY", ns(2026, 9, 28, 9, 0)), row("shioaji", "IDX", "2026-09-29", "DAY", ns(2026, 9, 29, 9, 0))]
    assert "shioaji:IDX 2026-09-28 DAY materialization not recorded" in wr.retention_before_ns(NOW, [], lone)[1]
    # no_input is done: nothing of it to materialize
    assert wr.retention_before_ns(NOW, [done("shioaji", "IDX", "2026-09-28", "DAY", "no_input")], lone)[0] == ns(2026, 9, 29, 9, 0)


def test_nothing_is_held_past_the_hard_cap():
    # A stuck owner must not grow the WAL without bound.
    stuck = row("futu", "US", "2026-09-10", "FULL", ns(2026, 9, 10, 21, 0), sealed=False)
    newer = row("futu", "US", "2026-09-29", "FULL", ns(2026, 9, 29, 21, 0))
    before, held = wr.retention_before_ns(NOW, [], [stuck, newer], hard_cap_days=7)
    assert before == ns(2026, 9, 29, 21, 0) and held == ["futu:US 2026-09-29 FULL shown"]


def test_an_empty_session_does_not_hold_anything():
    empty = row("shioaji", "IDX", "2026-09-26", "DAY", ns(2026, 9, 26, 9, 0), accepted=0, sealed=False)
    assert wr.retention_before_ns(NOW, [], [empty])[1] == []


def test_the_request_carries_the_exact_cutoff(tmp_path):
    before = ns(2026, 9, 29, 8, 30)
    path = wr.request_retention(before, jobs_root=tmp_path, reason="x")
    request = json.loads(path.read_text(encoding="utf-8"))
    assert path == tmp_path / "wal_retention" / "request.json"
    assert request["before_ns"] == before and request["keep_from"] == "2026-09-29T08:30:00+08:00"


def test_policy_reads_both_sources_from_disk_and_requests_only_when_the_cutoff_moves(tmp_path):
    jobs, evidence = tmp_path / "jobs", tmp_path / "evidence"
    (jobs / "ledger").mkdir(parents=True)
    (jobs / "ledger" / "futu.json").write_text(json.dumps({"k": {"source": "futu", "market": "US", "trading_date": "2026-09-25",
                                                                 "session": "FULL", "state": "pending"}}), encoding="utf-8")
    (evidence / "futu" / "US").mkdir(parents=True)
    (evidence / "futu" / "US" / "2026-09-25_FULL.json").write_text(json.dumps({"accepted": 3, "sealed": True,
                                                                              "first_ts_ns": ns(2026, 9, 25, 21, 30)}), encoding="utf-8")
    (evidence / "futu" / "US" / "2026-09-29_FULL.json").write_text(json.dumps({"accepted": 3, "first_ts_ns": ns(2026, 9, 29, 21, 30)}),
                                                                  encoding="utf-8")
    (evidence / "shioaji" / "STK").mkdir(parents=True)
    (evidence / "shioaji" / "STK" / "2026-09-24_DAY.json").write_text(json.dumps({"accepted": 3, "first_ts_ns": ns(2026, 9, 24, 8, 30)}),
                                                                      encoding="utf-8")
    policy = wr.WalRetentionPolicy(jobs_root=jobs, evidence_root=evidence, interval_seconds=60)
    assert policy.maybe_request(NOW, 0.0)["keep_from"] == "2026-09-24T08:30:00+08:00", "Shioaji's shown session is the oldest held"
    assert json.loads((jobs / "wal_retention" / "request.json").read_text())["before_ns"] == ns(2026, 9, 24, 8, 30)
    (jobs / "wal_retention" / "request.json").unlink()
    assert policy.maybe_request(NOW, 30.0) is None, "throttled"
    assert policy.maybe_request(NOW, 120.0) is None, "same cutoff: no new request"
    assert not (jobs / "wal_retention" / "request.json").exists()
    # The row file is only read: nothing is written back into another provider's evidence.
    assert json.loads((evidence / "shioaji" / "STK" / "2026-09-24_DAY.json").read_text())["accepted"] == 3


def test_materialization_status_names_the_oldest_unmerged_event_and_the_next_seal():
    # 連線診斷 WAL 待合併／下次合併: an unsealed session holds from its first event; the next merge is its window close.
    now = datetime(2026, 10, 3, 2, 0, tzinfo=TAIPEI)
    evidence = [{"source": "shioaji", "market": "FUT", "trading_date": "2026-10-02", "session": "NIGHT", "accepted": 9, "first_ts_ns": 300},
                {"source": "shioaji", "market": "FUT", "trading_date": "2026-10-02", "session": "DAY", "accepted": 9, "first_ts_ns": 100, "sealed": True},
                {"source": "futu", "market": "US", "trading_date": "2026-09-29", "session": "FULL", "accepted": 4, "first_ts_ns": 200},
                {"source": "shioaji", "market": "IDX", "trading_date": "2026-10-01", "session": "DAY", "accepted": 0}]
    status = wr.materialization_status(now, [], evidence)
    assert status["pending_from_ns"] == 200, "a sealed session is not pending; a stuck unsealed one is"
    assert status["next_materialization_at"] == "2026-10-03T05:00:00+08:00", "TXF night (dated by its open) closes 05:00"
    assert "NIGHT" in status["next_session"]
    assert status["next"] == {"source": "shioaji", "market": "FUT", "trading_date": "2026-10-02", "session": "NIGHT", "accepted": 9}
    # A queued job is the next merge, now; a retry waits for its attempt time.
    ledger = [{"source": "shioaji", "market": "STK", "trading_date": "2026-10-01", "session": "DAY", "state": "pending"}]
    assert wr.materialization_status(now, ledger, [])["next_materialization_at"] == now.isoformat(timespec="seconds")
    assert wr.materialization_status(now, [], [])["pending_from_ns"] is None


def test_materialization_status_ignores_sessions_nobody_seals():
    # A retired FUT FULL label and Saturday STK rows never seal, and made the whole 19.5 GB
    # WAL read 待合併. They still count toward accepted_spans: their events are in the WAL bytes.
    now = datetime(2026, 10, 8, 13, 0, tzinfo=TAIPEI)
    evidence = [{"source": "shioaji", "market": "FUT", "trading_date": "2026-10-01", "session": "FULL", "accepted": 5, "first_ts_ns": 10, "last_ts_ns": 20},
                {"source": "shioaji", "market": "STK", "trading_date": "2026-10-03", "session": "DAY", "accepted": 5, "first_ts_ns": 30, "last_ts_ns": 40,
                 "quarantined": {"reason": "NOT_A_BUSINESS_SESSION"}},
                {"source": "shioaji", "market": "FUT", "trading_date": "2026-10-08", "session": "DAY", "accepted": 7, "first_ts_ns": 500, "last_ts_ns": 600}]
    status = wr.materialization_status(now, [], evidence)
    assert status["pending_from_ns"] == 500
    assert status["next"]["session"] == "DAY" and status["next"]["accepted"] == 7
    assert status["accepted_spans"] == [[5, 10, 20], [5, 30, 40], [7, 500, 600]]


def test_session_end_per_market():
    # sealed after the after-hours match, so the 下次合併 forecast is 14:40, not the 13:30 close
    assert wr.session_end("shioaji", "STK", "2026-10-02", "DAY") == datetime(2026, 10, 2, 14, 40, tzinfo=TAIPEI)
    assert wr.session_end("shioaji", "FUT", "2026-10-02", "DAY") == datetime(2026, 10, 2, 13, 45, tzinfo=TAIPEI)
    # Futu: the owner's own seal time (end of the venue-local date + grace), not the venue close.
    assert wr.session_end("futu", "US", "2026-10-02", "FULL") == datetime(2026, 10, 3, 0, 10, tzinfo=ZoneInfo("America/New_York"))
    assert wr.session_end("futu", "HK", "2026-10-02", "DAY") == datetime(2026, 10, 3, 0, 10, tzinfo=ZoneInfo("Asia/Hong_Kong"))
    assert wr.session_end("shioaji", "XYZ", "2026-10-02", "DAY") is None


def test_futu_forecast_is_the_owners_seal_time():
    from service.market.futu.session_lifecycle import seal_due_at
    for market in ("US", "HK", "CC"):
        assert wr.session_end("futu", market, "2026-10-02", "FULL") == seal_due_at(market, "2026-10-02")


def test_next_merge_kind_tells_waiting_from_running():
    now = datetime(2026, 10, 3, 2, 0, tzinfo=TAIPEI)
    overdue = [{"source": "shioaji", "market": "FUT", "trading_date": "2026-10-02", "session": "DAY", "accepted": 1, "first_ts_ns": 5}]
    status = wr.materialization_status(datetime(2026, 10, 2, 13, 50, tzinfo=TAIPEI), [], overdue)
    assert status["next_kind"] == "session_close", "a session past its seal time is still waiting, not running"
    key = {"source": "shioaji", "market": "STK", "trading_date": "2026-10-01", "session": "DAY"}
    assert wr.materialization_status(now, [{**key, "state": "running"}], [])["next_kind"] == "running"
    assert wr.materialization_status(now, [{**key, "state": "pending"}], [])["next_kind"] == "queued"
    retry = wr.materialization_status(now, [{**key, "state": "failed_retryable", "next_attempt_at": now.timestamp() + 600}], [])
    assert retry["next_kind"] == "retry"
    assert wr.materialization_status(now, [], [])["next_kind"] is None


def test_policy_writes_the_status_more_often_than_it_requests(tmp_path):
    jobs, evidence = tmp_path / "jobs", tmp_path / "evidence"
    policy = wr.WalRetentionPolicy(jobs_root=jobs, evidence_root=evidence, interval_seconds=1800, status_interval_seconds=60)
    now = datetime(2026, 9, 30, 15, 0, tzinfo=TAIPEI)
    policy.maybe_request(now, 0.0)
    status_path = jobs / "wal_retention" / "status.json"
    assert json.loads(status_path.read_text())["schema"] == wr.STATUS_SCHEMA
    status_path.unlink()
    assert policy.maybe_request(now, 90.0) is None
    assert status_path.exists(), "status rewritten after 60 s while the request stays throttled"


def test_policy_retries_a_failed_matching_cutoff_after_health_consumed_the_request(tmp_path):
    policy = wr.WalRetentionPolicy(jobs_root=tmp_path / "jobs", evidence_root=tmp_path / "evidence", interval_seconds=60)
    now = datetime(2026, 10, 3, tzinfo=TAIPEI)
    policy.maybe_request(now, 0)
    root = tmp_path / "jobs" / "wal_retention"
    request = json.loads((root / "request.json").read_text())
    (root / "request.json").unlink()
    (root / "result.json").write_text(json.dumps({"request": request, "ok": False, "error": "runtime offline"}))
    assert policy.maybe_request(now, 30) is None, "retry remains throttled"
    assert policy.maybe_request(now, 60)["keep_from"] == request["keep_from"]
    assert policy.maybe_request(now, 120) is None, "never overwrite an outstanding request"
    (root / "request.json").unlink()
    (root / "result.json").write_text(json.dumps({"request": request, "ok": True}))
    assert policy.maybe_request(now, 180) is None, "successful prune needs no same-cutoff retry"
    request["before_ns"] -= 1
    (root / "result.json").write_text(json.dumps({"request": request, "ok": False}))
    assert policy.maybe_request(now, 240) is None, "a stale failure is not this request's failure"


def test_a_retired_session_label_never_holds_the_wal():
    # The pre-split shioaji FUT "FULL" evidence is never sealed by anyone and held every
    # WAL segment since that date (14 GB) until the hard cap. A label the market no longer has holds nothing.
    now = datetime(2026, 10, 6, 12, 0, tzinfo=TAIPEI)
    stale = row("shioaji", "FUT", "2026-10-01", "FULL", ns(2026, 10, 1, 8, 45), accepted=357877, sealed=False)
    live = row("shioaji", "FUT", "2026-10-02", "NIGHT", ns(2026, 10, 2, 15, 0), accepted=9, sealed=False)
    assert wr.retention_before_ns(now, [], [stale]) == (int(now.timestamp()) * 1_000_000_000, [])
    before, held = wr.retention_before_ns(now, [], [stale, live])
    assert before == ns(2026, 10, 2, 15, 0) and held == ["shioaji:FUT 2026-10-02 NIGHT shown"], "a real session still holds"
    futu = row("futu", "US", "2026-10-02", "FULL", ns(2026, 10, 2, 21, 30), accepted=3)
    assert wr.retention_before_ns(now, [], [futu])[0] == ns(2026, 10, 2, 21, 30), "Futu US is FULL"


def test_a_shioaji_row_on_a_non_trading_day_is_quarantined_by_its_ledger_then_never_holds_the_wal(tmp_path):
    # Weekend reconnect snapshots became STK / IDX "DAY" sessions of a Saturday; nothing seals those,
    # and they held the whole WAL from that day (18 GB). Such a row is not skipped silently by each reader;
    # retention names it a candidate and the row's one writer, its source's ledger, quarantines it once, in its
    # own file, with the reason and its event count. A trading day's session holds.
    import json

    root = tmp_path / "evidence"
    for market, day, admitted in (("IDX", "2026-10-03", 124), ("STK", "2026-10-04", 9), ("STK", "2026-10-02", 9)):
        (root / "shioaji" / market).mkdir(parents=True, exist_ok=True)
        (root / "shioaji" / market / f"{day}_DAY.json").write_text(json.dumps({"accepted": admitted}), encoding="utf-8")
    for path in (root / "shioaji").glob("*/*.json"):
        stored = json.loads(path.read_text(encoding="utf-8"))
        path.write_text(json.dumps({**stored, "first_ts_ns": ns(*map(int, path.stem[:10].split("-")), 9, 0)}), encoding="utf-8")
    now = datetime(2026, 10, 8, 12, 0, tzinfo=TAIPEI)
    evidence = wr.evidence_rows(root, sources=("shioaji",))
    held_before = wr.retention_before_ns(now, [], evidence)[0]
    assert held_before == ns(2026, 10, 2, 9, 0), "until quarantined, an unsealed row holds like any other"
    candidates = wr.non_business_sessions(evidence)
    assert sorted(candidates) == [("shioaji", "IDX", "2026-10-03", "DAY"), ("shioaji", "STK", "2026-10-04", "DAY")]
    # The owner asks Market Runtime, the rows' one writer, to quarantine them (evidence.quarantine): as it writes them.
    for _src, market, day, _session in candidates:
        path = root / "shioaji" / market / f"{day}_DAY.json"
        stored = json.loads(path.read_text(encoding="utf-8"))
        path.write_text(json.dumps({**stored, "quarantined": {"reason": wr.NOT_A_BUSINESS_SESSION, "at_ns": 1,
                                                             "accepted": stored["accepted"], "sealed": False}}), encoding="utf-8")
    assert wr.non_business_sessions(wr.evidence_rows(root, sources=("shioaji",))) == [], "once"
    weekend = [r for r in wr.evidence_rows(root, sources=("shioaji",)) if r["trading_date"] != "2026-10-02"]
    assert wr.retention_before_ns(now, [], weekend) == (int(now.timestamp()) * 1_000_000_000, [])
    friday = [row("shioaji", "STK", "2026-10-02", "DAY", ns(2026, 10, 2, 9, 0), accepted=9)]
    assert wr.retention_before_ns(now, [], friday)[0] == ns(2026, 10, 2, 9, 0), "the shown Friday holds"


def test_retention_never_writes_an_evidence_row(tmp_path):
    # Retention and the ledger both rewrote whole evidence files with no shared version or lock: the later writer
    # dropped the other's counts, sealed or quarantined. Market Runtime is now the rows' one writer; retention reads.
    root = tmp_path / "evidence"
    path = root / "shioaji" / "STK" / "2026-10-03_DAY.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"schema": "market-runtime-session-evidence-v1", "accepted": 1,
                                "first_ts_ns": ns(2026, 10, 3, 10, 0)}), encoding="utf-8")
    before = path.read_bytes()
    policy = wr.WalRetentionPolicy(jobs_root=tmp_path / "jobs", evidence_root=root)
    policy.maybe_request(datetime(2026, 10, 8, 12, 0, tzinfo=TAIPEI), 0.0)
    assert path.read_bytes() == before, "retention only reads the evidence"


def test_a_failed_write_leaves_its_step_due_so_the_next_call_retries_at_once(tmp_path, monkeypatch):
    import pytest

    policy = wr.WalRetentionPolicy(jobs_root=tmp_path / "jobs", evidence_root=tmp_path / "evidence",
                                   interval_seconds=1800, status_interval_seconds=60)
    now = datetime(2026, 10, 3, tzinfo=TAIPEI)
    real_write = wr.write_json_atomic
    failing = {"status.json", "request.json"}

    def write(path, payload, **kwargs):
        if path.name in failing:
            raise PermissionError(13, "the file is open in another process")
        return real_write(path, payload, **kwargs)

    monkeypatch.setattr(wr, "write_json_atomic", write)
    with pytest.raises(PermissionError):
        policy.maybe_request(now, 0.0)
    root = tmp_path / "jobs" / "wal_retention"
    assert not (root / "status.json").exists() and not (root / "request.json").exists()
    failing.clear()
    assert policy.maybe_request(now, 1.0) is not None, "the request is made one second later, not 30 minutes later"
    assert (root / "status.json").exists() and (root / "request.json").exists()
    assert policy.maybe_request(now, 2.0) is None, "both steps done: throttled again"


def test_a_crypto_session_is_sealed_after_its_new_york_day():
    from datetime import datetime, timedelta
    from zoneinfo import ZoneInfo

    from service.market.shared.wal_retention import session_end

    due = session_end("futu", "CC", "2026-10-05", "FULL")
    new_york_midnight = datetime(2026, 10, 6, tzinfo=ZoneInfo("America/New_York"))
    assert due is not None and due - new_york_midnight == timedelta(minutes=10)
    assert due > datetime(2026, 10, 6, tzinfo=ZoneInfo("Asia/Taipei")), "not Taipei's day end"
