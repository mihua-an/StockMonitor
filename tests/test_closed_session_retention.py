"""A session's evidence row and ledger records go once its whole flow is over (sealed, materialized, out of the
WAL); a session still in its flow keeps both."""
from __future__ import annotations

import json
from datetime import datetime
from zoneinfo import ZoneInfo

from service.market.shared import materialization_ledger as ml
from service.market.shared.closed_session_retention import prune_closed_sessions
from tests.market_runtime_evidence_fake import FakeMarketRuntimeEvidence

TAIPEI = ZoneInfo("Asia/Taipei")
NOW = datetime(2026, 10, 28, 10, 0, tzinfo=TAIPEI)


def _ns(day: str) -> int:
    return int(datetime.fromisoformat(f"{day}T09:00").replace(tzinfo=TAIPEI).timestamp()) * 1_000_000_000


def _row(root, market, day, session, **fields):
    path = root / "shioaji" / market / f"{day}_{session}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"schema": "market-runtime-session-evidence-v1", "source": "shioaji", "market": market,
                                "trading_date": day, "session": session, "accepted": 5, "first_ts_ns": _ns(day),
                                "completeness": "complete", **fields}), encoding="utf-8")
    return path


def _record(market, day, session, state):
    key = ml.MaterializationKey.for_session("shioaji", market, day, session=session)
    return key.key_id, {**key.as_dict(), "key_id": key.key_id, "state": state}


def _setup(tmp_path, rows, records):
    evidence_root, jobs_root = tmp_path / "evidence", tmp_path / "jobs"
    paths = {name: _row(evidence_root, *spec[:3], **spec[3]) for name, spec in rows.items()}
    (jobs_root / "ledger").mkdir(parents=True)
    (jobs_root / "ledger" / "shioaji.json").write_text(json.dumps(dict(records)), encoding="utf-8")
    return paths, FakeMarketRuntimeEvidence(evidence_root), ml.MaterializationLedger("shioaji", jobs_root=jobs_root), jobs_root


def _kept(jobs_root):
    return {(r["market"], r["trading_date"]) for r in json.loads((jobs_root / "ledger" / "shioaji.json").read_text(encoding="utf-8")).values()}


def test_a_finished_session_goes_and_one_in_its_flow_stays(tmp_path):
    paths, evidence, ledger, jobs_root = _setup(tmp_path, {
        "done": ("STK", "2026-10-22", "DAY", {"sealed": True}),
        "shown": ("STK", "2026-10-27", "DAY", {"sealed": True}),                 # the session its market shows
        "failed": ("IDX", "2026-10-22", "DAY", {"sealed": True}),                # materialization not final, WAL keeps it
        "failed_shown": ("IDX", "2026-10-27", "DAY", {"sealed": True}),
        "unsealed": ("FUT", "2026-10-20", "NIGHT", {}),                           # the owner never closed it
        "fut_shown": ("FUT", "2026-10-27", "NIGHT", {"sealed": True}),
    }, [
        _record("STK", "2026-10-22", "DAY", ml.SUCCEEDED),
        _record("STK", "2026-10-27", "DAY", ml.SUCCEEDED),
        _record("IDX", "2026-10-22", "DAY", ml.FAILED_TERMINAL),
        _record("IDX", "2026-10-27", "DAY", ml.SUCCEEDED),
        _record("FUT", "2026-10-27", "NIGHT", ml.RUNNING),
        _record("STK", "2026-09-01", "DAY", ml.SUCCEEDED),                       # no evidence row, past the WAL cap
        _record("STK", "2026-10-25", "DAY", ml.SUCCEEDED),                       # no evidence row, inside the WAL cap
    ])

    result = prune_closed_sessions("shioaji", evidence=evidence, ledger=ledger, now=NOW)

    assert result == {"evidence_rows": 1, "ledger_records": 2}
    assert not paths["done"].exists()
    assert all(paths[name].exists() for name in ("shown", "failed", "failed_shown", "unsealed", "fut_shown"))
    assert _kept(jobs_root) == {("STK", "2026-10-27"), ("IDX", "2026-10-22"), ("IDX", "2026-10-27"),
                                ("FUT", "2026-10-27"), ("STK", "2026-10-25")}


def test_the_owner_forgets_every_session_whose_ledger_records_go(tmp_path):
    # A ledger record with no evidence row, past the WAL cap, goes with this pass: the owner must forget that session
    # too, or its own sealed record without a ledger record reads as sealed-never-submitted and is submitted again
    # (11-07: Futu CC 2026-10-29 re-materialized on every start, each run reading the whole WAL for nothing).
    _paths, evidence, ledger, jobs_root = _setup(tmp_path, {
        "done": ("STK", "2026-10-22", "DAY", {"sealed": True}),
        "shown": ("STK", "2026-10-27", "DAY", {"sealed": True}),
    }, [
        _record("STK", "2026-10-22", "DAY", ml.SUCCEEDED),
        _record("STK", "2026-10-27", "DAY", ml.SUCCEEDED),
        _record("STK", "2026-09-01", "DAY", ml.NO_INPUT),                        # no evidence row, past the WAL cap
        _record("STK", "2026-10-25", "DAY", ml.SUCCEEDED),                       # no evidence row, inside the WAL cap
    ])
    forgotten: list = []

    def forget(sessions):
        forgotten.append(set(sessions))
        return True

    result = prune_closed_sessions("shioaji", evidence=evidence, ledger=ledger, now=NOW, forget=forget)

    assert forgotten == [{("STK", "2026-10-22", "DAY"), ("STK", "2026-09-01", "DAY")}]
    assert result == {"evidence_rows": 1, "ledger_records": 2}
    assert _kept(jobs_root) == {("STK", "2026-10-27"), ("STK", "2026-10-25")}


def test_nothing_goes_when_the_owner_cannot_forget(tmp_path):
    _paths, evidence, ledger, jobs_root = _setup(tmp_path, {
        "shown": ("STK", "2026-10-27", "DAY", {"sealed": True}),
    }, [_record("STK", "2026-10-27", "DAY", ml.SUCCEEDED), _record("STK", "2026-09-01", "DAY", ml.NO_INPUT)])

    result = prune_closed_sessions("shioaji", evidence=evidence, ledger=ledger, now=NOW, forget=lambda sessions: False)

    assert result == {"evidence_rows": 0, "ledger_records": 0}
    assert _kept(jobs_root) == {("STK", "2026-10-27"), ("STK", "2026-09-01")}


def test_a_failed_materialization_goes_once_the_wal_is_past_it(tmp_path):
    paths, evidence, ledger, jobs_root = _setup(tmp_path, {
        "old": ("IDX", "2026-10-19", "DAY", {"sealed": True}),
        "shown": ("IDX", "2026-10-27", "DAY", {"sealed": True}),
    }, [_record("IDX", "2026-10-19", "DAY", ml.FAILED_TERMINAL), _record("IDX", "2026-10-27", "DAY", ml.SUCCEEDED)])

    prune_closed_sessions("shioaji", evidence=evidence, ledger=ledger, now=NOW)

    assert not paths["old"].exists() and paths["shown"].exists()
    assert _kept(jobs_root) == {("IDX", "2026-10-27")}


def test_a_row_kept_back_keeps_its_ledger_record(tmp_path):
    paths, evidence, ledger, jobs_root = _setup(tmp_path, {
        "done": ("STK", "2026-10-22", "DAY", {"sealed": True}),
        "shown": ("STK", "2026-10-27", "DAY", {"sealed": True}),
    }, [_record("STK", "2026-10-22", "DAY", ml.SUCCEEDED), _record("STK", "2026-10-27", "DAY", ml.SUCCEEDED)])
    evidence._command = lambda kind, payload: {"removed": []}   # Market Runtime keeps it back (counts not written yet)

    assert prune_closed_sessions("shioaji", evidence=evidence, ledger=ledger, now=NOW) == {"evidence_rows": 0, "ledger_records": 0}
    assert paths["done"].exists()
    assert _kept(jobs_root) == {("STK", "2026-10-22"), ("STK", "2026-10-27")}


def test_a_session_the_owner_still_tracks_stays(tmp_path):
    paths, evidence, ledger, jobs_root = _setup(tmp_path, {
        "done": ("STK", "2026-10-22", "DAY", {"sealed": True}),
        "shown": ("STK", "2026-10-27", "DAY", {"sealed": True}),
    }, [_record("STK", "2026-10-22", "DAY", ml.SUCCEEDED), _record("STK", "2026-10-27", "DAY", ml.SUCCEEDED)])

    prune_closed_sessions("shioaji", evidence=evidence, ledger=ledger, now=NOW, keep={("STK", "2026-10-22", "DAY")})

    assert paths["done"].exists()
    assert _kept(jobs_root) == {("STK", "2026-10-22"), ("STK", "2026-10-27")}


def test_the_owner_s_pass_quarantines_its_rows_of_a_day_with_no_session_through_its_ledger(tmp_path):
    # 2026-10-26 is a TWSE holiday (光復節 observed): a STK "DAY" row of it is no session, nothing seals it. The
    # owner's pass asks Market Runtime, the rows' one writer, to quarantine it; WAL retention only reads the result.
    paths, evidence, ledger, _jobs_root = _setup(tmp_path, {
        "holiday": ("STK", "2026-10-26", "DAY", {}),
        "shown": ("STK", "2026-10-27", "DAY", {"sealed": True}),
    }, [_record("STK", "2026-10-27", "DAY", ml.SUCCEEDED)])
    seen: list = []
    real = evidence.quarantine

    def quarantine(*args, **kwargs):
        seen.append(args)
        return real(*args, **kwargs)

    evidence.quarantine = quarantine

    prune_closed_sessions("shioaji", evidence=evidence, ledger=ledger, now=NOW)

    assert seen == [("shioaji", "STK", "2026-10-26", "DAY")]
    # Quarantined, it is closed and finished (no WAL session to materialize): the same pass deletes it.
    assert not paths["holiday"].exists()
    assert "quarantined" not in json.loads(paths["shown"].read_text(encoding="utf-8"))
