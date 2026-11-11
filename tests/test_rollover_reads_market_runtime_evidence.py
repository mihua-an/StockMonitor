"""The Shioaji session owner reads each partition's completeness from Market Runtime's records and decides through its
commands: it seals a partition before it reads it (so what it reads is final), hands the partition's gap codes to the
materialization job, and waits for what Market Runtime has not answered yet before it finalizes a close."""
from __future__ import annotations

import json
from datetime import datetime
from types import SimpleNamespace
from zoneinfo import ZoneInfo

from service.market.lifecycle import rollover
from service.market.shared.materialization_jobs import request_materialization
from tests.market_runtime_evidence_fake import FakeMarketRuntimeEvidence, FakeSink

TAIPEI = ZoneInfo("Asia/Taipei")
DATE = "2026-10-29"


def _ns(hour: int, minute: int) -> int:
    return int(datetime.fromisoformat(DATE).replace(hour=hour, minute=minute, tzinfo=TAIPEI).timestamp()) * 1_000_000_000


def _owner(monkeypatch, evidence, submitted, jobs, *, sink=None):
    class Ledger:
        def status(self, key):
            return None

        def submit(self, key, **kw):
            submitted.append((key.market, kw["completeness"], kw["gap_codes"]))
            request_materialization(source=key.source, market=key.market, code="*", trading_date=key.trading_date,
                                    session=key.session, completeness=kw["completeness"], gap_codes=kw["gap_codes"],
                                    jobs_root=jobs)

    owner = object.__new__(rollover.SessionOrchestrator)
    owner._ledger = Ledger()
    app = SimpleNamespace(live_event_sink=sink or FakeSink(evidence))
    monkeypatch.setattr(owner, "_app", lambda: app, raising=False)
    monkeypatch.setattr(owner, "close_operation_id", lambda key: "close-1", raising=False)
    return owner


def test_the_sealed_session_job_carries_its_gap_codes_and_the_partitions_are_sealed_first(tmp_path, monkeypatch):
    evidence = FakeMarketRuntimeEvidence(tmp_path / "evidence")
    evidence.record("shioaji", "STK", DATE, "DAY", accepted=10, outages=[
        {"connection": "connection 2", "from_ns": _ns(10, 0), "to_ns": _ns(10, 1), "codes": ["2330"]}])
    evidence.record("shioaji", "IDX", DATE, "DAY", accepted=4)
    submitted, jobs = [], tmp_path / "jobs"
    owner = _owner(monkeypatch, evidence, submitted, jobs)
    owner._submit_sealed_materialization({"completeness": "complete", "session_key": "STK"},
                                         SimpleNamespace(market="STK", trading_date=DATE))
    assert submitted == [("STK", "complete", ["2330"]), ("IDX", "complete", [])]
    assert [kind for kind, _ in evidence.commands] == ["evidence.seal", "evidence.seal"]
    assert evidence.summary("shioaji", "STK", DATE, "DAY")["sealed"] is True
    requests = {json.loads(p.read_text(encoding="utf-8"))["market"]: json.loads(p.read_text(encoding="utf-8"))
                for p in (jobs / "pending").glob("*.json")}
    assert requests["STK"]["gap_codes"] == ["2330"] and requests["IDX"]["gap_codes"] == []


def test_a_close_waits_for_what_market_runtime_has_not_answered_before_the_session_ends(tmp_path, monkeypatch):
    evidence = FakeMarketRuntimeEvidence(tmp_path / "evidence")
    evidence.record("shioaji", "STK", DATE, "DAY", accepted=10)
    active = SimpleNamespace(market="STK", trading_date=DATE, session="DAY", activated_at=None)
    # One 13:30 print not answered yet holds the close; a futures print of 13:44 (another market) does not.
    sink = FakeSink(evidence, unconfirmed={"STK": [_ns(13, 30)], "FUT": [_ns(13, 44)]})
    owner = _owner(monkeypatch, evidence, [], tmp_path / "jobs", sink=sink)
    monkeypatch.setattr(owner, "_await_sink_drain", lambda app, timeout: None, raising=False)
    held = owner._collect_evidence(owner._app(), active)
    assert held.in_flight == 1 and held.evidence["completeness"] == "complete"
    sink.unconfirmed = {"STK": [_ns(15, 0)]}   # the next day's pre-open is no event of this session
    assert owner._collect_evidence(owner._app(), active).in_flight == 0
