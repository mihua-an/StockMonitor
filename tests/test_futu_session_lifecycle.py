"""FutuSessionLifecycleCoordinator: sessions as Market Runtime records them (it names each partition from the
exchange time), per-session completeness as it judged it, bounded retry, previous-session promotion, retention
ordering, single intent owner. Market Runtime's records are written here by tests/market_runtime_evidence_fake.py."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from service.market.futu.callback import FutuThinCallbackAdapter, _market_zone
from service.market.shared.session_identity_contract import MARKET_TIMEZONES
from service.market.futu.session_lifecycle import FutuSessionLifecycleCoordinator
from service.market.futu.store import FutuControlStore
from service.market.shared import materialization_ledger as ml
from service.market.shared.materialization_jobs import request_materialization
from tests.market_runtime_evidence_fake import FakeMarketRuntimeEvidence, FakeSink
from service.market.shared.wal_retention import evidence_rows, retention_before_ns


class Sink(FakeSink):
    """Event-sink stand-in: Market Runtime's partition records (the fake writes them as it does) and what was published."""

    def __init__(self, root) -> None:
        super().__init__(FakeMarketRuntimeEvidence(root))
        self.events = []

    def publish(self, event):
        self.events.append(event)
        return True

    def stop_admission(self):
        pass


def feed(sink, market, date, *, acked=3, dropped=0, rejected=0, duplicate=0, restarts=()):
    """What Market Runtime records for the partition: events stored, lost, refused, resent, provider restarts."""
    if market == "CC":
        return   # never stored: Market Runtime keeps no partition of it
    record = sink.evidence._load("futu", market, date, "FULL")
    sink.evidence.record("futu", market, date, "FULL", accepted=record["accepted"] + acked, first_ts_ns=1, last_ts_ns=1,
                         dropped=record["dropped"] + dropped,
                         rejected={"RejectedGeneration": record["rejected"].get("RejectedGeneration", 0) + rejected} if rejected
                         else record["rejected"], duplicates=record["duplicates"] + duplicate,
                         restarts=[*record["restarts"], *restarts])


def seen(sink, code, date):
    """A print of ``code`` that Market Runtime stored in the partition of ``date``."""
    feed(sink, code.split(".", 1)[0], date, acked=1)


class Clock:
    def __init__(self, when: datetime) -> None:
        self.when = when

    def __call__(self) -> datetime:
        return self.when


def _coordinator(tmp_path, when, sink=None):
    store = FutuControlStore(tmp_path / "c.db")
    store.initialize_schema()
    clock = Clock(when)
    sink = sink or Sink(tmp_path / "evidence")
    submitted = []
    ledger = ml.MaterializationLedger(
        "futu", jobs_root=tmp_path / "jobs", clock=lambda: clock.when.timestamp(),
        submit_job=lambda **kw: submitted.append(kw) or request_materialization(**kw),
    )
    coord = FutuSessionLifecycleCoordinator(store, event_sink=sink, now=clock, tick_seconds=0, ledger=ledger,
                                            jobs_root=tmp_path / "jobs")
    return coord, clock, sink, submitted, store


def utc(*a):
    return datetime(*a, tzinfo=timezone.utc)


def test_arrival_time_does_not_decide_the_session_date_exchange_time_does(tmp_path):
    """A US callback ARRIVING after midnight Eastern but stamped 15:59 ET on 09-08 belongs to 09-08: it carries that
    exchange time, Market Runtime files it there, and the owner takes the session from that record."""
    coord, clock, sink, submitted, _ = _coordinator(tmp_path, utc(2026, 9, 9, 5, 30))  # 01:30 ET on 09-09
    adapter = FutuThinCallbackAdapter(sink, generation=lambda: 1, observe=lambda code, kind: None)
    adapter._publish("trade", [{"code": "US.AAPL", "price": 100.0, "volume": 1,
                                "time": "2026-09-08 15:59:59", "ticker_direction": "BUY"}])
    event = sink.events[0]
    assert event.exchange_ts_ns == int(datetime(2026, 9, 8, 19, 59, 59, tzinfo=timezone.utc).timestamp() * 1_000_000_000)
    assert not {"trading_date", "session"} & set(event.as_dict())
    feed(sink, "US", "2026-09-08")   # as Market Runtime records it
    coord.tick(force=True)
    assert list(coord._sessions["US"]) == ["2026-09-08"]  # NOT 2026-09-09 (arrival-based)
    assert submitted and submitted[0]["trading_date"] == "2026-09-08" and submitted[0]["session"] == "FULL"


def test_session_not_sealed_before_its_grace(tmp_path):
    """Late cross-midnight callback: still lands in the open session inside the grace; sealed after it."""
    coord, clock, sink, submitted, _ = _coordinator(tmp_path, utc(2026, 9, 9, 4, 5))  # 00:05 ET 09-09
    feed(sink, "US", "2026-09-08")
    coord.tick(force=True)
    assert submitted == [], "within the 10 minute late-callback grace the date stays open"
    clock.when = utc(2026, 9, 9, 4, 20)
    coord.tick(force=True)
    assert len(submitted) == 1 and submitted[0]["trading_date"] == "2026-09-08"
    assert sink.evidence.summary("futu", "US", "2026-09-08", "FULL")["sealed"], "frozen by Market Runtime at the seal"


@pytest.mark.parametrize("market,zone", [("US", "America/New_York"), ("HK", "Asia/Hong_Kong"),
                                         ("SH", "Asia/Shanghai"), ("SZ", "Asia/Shanghai"), ("CC", "America/New_York")])
def test_each_market_uses_its_own_exchange_timezone(market, zone):
    assert MARKET_TIMEZONES[market] == zone and str(_market_zone(market)) == zone
    assert str(_market_zone("XX")) == "UTC", "an unknown venue must never silently become US time"


def test_sh_sz_seal_at_their_own_local_midnight_not_utc(tmp_path):
    # 2026-09-08 16:30 UTC == 2026-09-09 00:30 Shanghai: sealed for SH, but still open for US (12:30 ET).
    coord, clock, sink, submitted, _ = _coordinator(tmp_path, utc(2026, 9, 8, 16, 30))
    seen(sink, "SH.600000", "2026-09-08")
    seen(sink, "US.AAPL", "2026-09-08")
    feed(sink, "SH", "2026-09-08")
    feed(sink, "US", "2026-09-08")
    coord.tick(force=True)
    assert [s["market"] for s in submitted] == ["SH"]


def test_a_loss_only_taints_its_own_session_identity_not_every_later_session(tmp_path):
    coord, clock, sink, submitted, _ = _coordinator(tmp_path, utc(2026, 9, 8, 15, 0))
    seen(sink, "US.AAPL", "2026-09-08")
    feed(sink, "US", "2026-09-08", dropped=1)  # genuine evidence loss during 09-08
    clock.when = utc(2026, 9, 9, 6, 0)
    seen(sink, "US.AAPL", "2026-09-09")
    feed(sink, "US", "2026-09-09")
    coord.tick(force=True)
    assert submitted[-1]["completeness"] == "gap_detected"
    clock.when = utc(2026, 9, 10, 6, 0)
    coord.tick(force=True)
    assert submitted[-1]["trading_date"] == "2026-09-09" and submitted[-1]["completeness"] == "complete"


def test_loss_in_another_market_does_not_taint_this_one(tmp_path):
    coord, clock, sink, submitted, _ = _coordinator(tmp_path, utc(2026, 9, 8, 15, 0))
    for code in ("US.AAPL", "HK.00700"):
        seen(sink, code, "2026-09-08")
    feed(sink, "US", "2026-09-08")
    feed(sink, "HK", "2026-09-08", rejected=1)
    clock.when = utc(2026, 9, 9, 16, 0)
    coord.tick(force=True)
    assert {s["market"]: s["completeness"] for s in submitted} == {"US": "complete", "HK": "gap_detected"}


def test_resent_duplicates_are_not_evidence_loss(tmp_path):
    coord, clock, sink, submitted, _ = _coordinator(tmp_path, utc(2026, 9, 8, 15, 0))
    seen(sink, "US.AAPL", "2026-09-08")
    feed(sink, "US", "2026-09-08", duplicate=7)
    clock.when = utc(2026, 9, 9, 6, 0)
    coord.tick(force=True)
    assert submitted[0]["completeness"] == "complete"


def test_evidence_window_spanning_a_daemon_restart_is_gap_detected(tmp_path):
    coord, clock, sink, submitted, store = _coordinator(tmp_path, utc(2026, 9, 8, 15, 0))
    seen(sink, "US.AAPL", "2026-09-08")
    feed(sink, "US", "2026-09-08")
    # A new provider process said who it is while the session still traded: Market Runtime records the restart.
    restarted_sink = Sink(tmp_path / "evidence")
    feed(restarted_sink, "US", "2026-09-08", restarts=[{"from_ns": 1, "to_ns": 2, "during_trading": True}])
    restarted = FutuSessionLifecycleCoordinator(store, event_sink=restarted_sink, now=clock, tick_seconds=0,
                                                ledger=coord._ledger, jobs_root=tmp_path / "jobs")
    clock.when = utc(2026, 9, 9, 6, 0)
    restarted.tick(force=True)
    assert submitted[0]["completeness"] == "gap_detected"


def _finish(tmp_path, coord, market, date, body):
    record = coord._ledger.status(coord._key(market, date))
    done = tmp_path / "jobs" / "done"
    done.mkdir(parents=True, exist_ok=True)
    pending = tmp_path / "jobs" / "pending" / f"{record['job_id']}.json"
    # Like Health: the result echoes the request it answers, and a finished job is not pending (one job, one place).
    result = {"schema": "materialization-job-result-v1", "job_id": record["job_id"],
              "request": json.loads(pending.read_text(encoding="utf-8")), **json.loads(body)}
    (done / f"{record['job_id']}.json").write_text(json.dumps(result))
    pending.unlink()


def test_failed_job_retries_with_bounded_backoff_not_every_tick(tmp_path):
    coord, clock, sink, submitted, _ = _coordinator(tmp_path, utc(2026, 9, 8, 15, 0))
    seen(sink, "US.AAPL", "2026-09-08")
    feed(sink, "US", "2026-09-08")
    clock.when = utc(2026, 9, 9, 6, 0)
    coord.tick(force=True)
    _finish(tmp_path, coord, "US", "2026-09-08", '{"ok": false, "status": "retryable", "error": "x"}')
    for _ in range(25):
        coord.tick(force=True)
    assert len(submitted) == 1, "no relaunch inside the backoff window"
    assert coord._sessions["US"]["2026-09-08"]["materialization"] == "retryable"


def test_no_input_is_not_a_materialized_previous_session(tmp_path):
    coord, clock, sink, submitted, _ = _coordinator(tmp_path, utc(2026, 9, 8, 15, 0))
    seen(sink, "US.AAPL", "2026-09-08")
    feed(sink, "US", "2026-09-08")
    clock.when = utc(2026, 9, 10, 6, 0)
    coord.tick(force=True)
    _finish(tmp_path, coord, "US", "2026-09-08", '{"ok": false, "status": "no_matching_input"}')
    coord.tick(force=True)
    assert coord._sessions["US"]["2026-09-08"]["materialization"] == "no_input"


def _materialized_and_pruned(tmp_path, monkeypatch):
    """09-08 sealed, materialized and pruned with its ledger record, as on the day after it (11-05 in the App)."""
    _close_recoveries(monkeypatch)
    coord, clock, sink, submitted, store = _coordinator(tmp_path, utc(2026, 9, 8, 15, 0))
    feed(sink, "US", "2026-09-08")
    clock.when = utc(2026, 9, 10, 6, 0)
    coord.tick(force=True)
    _finish(tmp_path, coord, "US", "2026-09-08", '{"ok": true, "status": "materialized"}')
    feed(sink, "US", "2026-09-09")
    coord._pruned_for = None
    coord.tick(force=True)
    assert ("futu", "US", "2026-09-08", "FULL") not in sink.evidence.sessions("futu")
    assert coord._ledger.status(coord._key("US", "2026-09-08")) is None
    return coord, clock, sink, submitted, store


def test_a_restart_after_a_materialized_session_was_pruned_neither_seals_nor_materializes_it_again(tmp_path, monkeypatch):
    """OpenD re-sends its last print (the 16:00 close of the finished day) on the new subscription after a restart.
    Market Runtime refuses it (PARTITION_CLOSED) and makes no record, so the restarted owner takes in no session, sends
    no seal and opens no job: the published day is never rebuilt from the WAL cut since."""
    coord, clock, sink, submitted, store = _materialized_and_pruned(tmp_path, monkeypatch)
    jobs_before = [r["trading_date"] for r in submitted].count("2026-09-08")
    seen(sink, "US.AAPL", "2026-09-08")   # the re-sent close print
    assert ("futu", "US", "2026-09-08", "FULL") not in sink.evidence.sessions("futu")
    restarted = FutuSessionLifecycleCoordinator(store, event_sink=sink, now=clock, ledger=coord._ledger,
                                               jobs_root=tmp_path / "jobs")
    sink.evidence.commands.clear()
    restarted.tick(force=True)
    restarted.tick(force=True)
    assert "2026-09-08" not in restarted._sessions.get("US", {})
    assert not [c for c in sink.evidence.commands if c[0] == "evidence.seal" and c[1]["trading_date"] == "2026-09-08"]
    assert [r["trading_date"] for r in submitted].count("2026-09-08") == jobs_before == 1
    assert restarted._ledger.status(restarted._key("US", "2026-09-08")) is None


def test_an_intent_for_a_session_market_runtime_no_longer_holds_is_not_materialized(tmp_path, monkeypatch):
    """The WAL no longer holds a pruned session whole: an intent for it (a reader, a route) opens no job over the
    complete history; the owner says so and the intent is settled."""
    coord, clock, sink, submitted, _ = _materialized_and_pruned(tmp_path, monkeypatch)
    ml.propose_intent("futu", "US", "2026-09-08", jobs_root=tmp_path / "jobs")
    coord.tick(force=True)
    coord.tick(force=True)
    assert [r["trading_date"] for r in submitted].count("2026-09-08") == 1
    assert coord._ledger.status(coord._key("US", "2026-09-08")) is None
    assert "2026-09-08" not in coord._sessions["US"]
    assert ml.drain_intents("futu", jobs_root=tmp_path / "jobs") == []


def test_intents_are_decided_by_this_owner_and_only_when_sealed(tmp_path):
    coord, clock, sink, submitted, _ = _coordinator(tmp_path, utc(2026, 9, 8, 15, 0))
    feed(sink, "US", "2026-09-08")
    ml.propose_intent("futu", "US", "2026-09-08", jobs_root=tmp_path / "jobs")
    coord.tick(force=True)
    assert submitted == [], "an unsealed session's intent waits"
    clock.when = utc(2026, 9, 9, 6, 0)
    coord.tick(force=True)
    assert len(submitted) == 1
    coord.tick(force=True)
    assert len(submitted) == 1 and ml.drain_intents("futu", jobs_root=tmp_path / "jobs") == []


def test_a_start_takes_its_sessions_from_market_runtime_s_records_and_releases_retention(tmp_path):
    """9/29 records + empty lifecycle DB + offline OpenD must not hold the shared WAL forever."""
    sink = Sink(tmp_path / "evidence")
    feed(sink, "US", "2026-09-29")
    feed(sink, "US", "2026-10-02")  # still inside this date in New York
    feed(sink, "HK", "2026-10-01")
    sink.evidence.record("shioaji", "STK", "2026-09-28", "DAY", accepted=1)   # another source's
    restarted_sink = Sink(tmp_path / "evidence")
    coord, clock, _, submitted, store = _coordinator(tmp_path, utc(2026, 10, 3, 2), sink=restarted_sink)
    assert coord.status()["markets"] == 0
    coord.tick(force=True)  # no callback, no SDK connection
    assert {(r["market"], r["trading_date"]) for r in submitted} == {("US", "2026-09-29"), ("HK", "2026-10-01")}
    assert coord._sessions["US"]["2026-10-02"]["state"] == "open", "expiry/grace still applies"
    assert set(coord._sessions) == {"US", "HK"}, "this owner cannot seal another source"
    for market, day in [("US", "2026-09-29"), ("HK", "2026-10-01")]:
        assert restarted_sink.evidence.summary("futu", market, day, "FULL")["sealed"]
    coord.tick(force=True)
    assert len(submitted) == 2, "recovery and submission dedupe"
    # A sealed session still holds retention while its job is pending.
    rows = evidence_rows(tmp_path / "evidence", sources=("futu",))
    # The fake events carry exchange time 1 (1970): no hard cap here, the rule itself is under test.
    held = lambda: retention_before_ns(datetime(2026, 10, 3, 12, tzinfo=timezone.utc), coord._ledger.records(), rows,  # noqa: E731
                                       hard_cap_days=30_000)[1]
    assert "futu:US 2026-09-29 FULL materialization pending" in held()
    _finish(tmp_path, coord, "US", "2026-09-29", '{"ok": true, "status": "materialized"}')
    _finish(tmp_path, coord, "HK", "2026-10-01", '{"ok": true, "status": "materialized"}')
    coord.tick(force=True)
    # Materialized and no longer shown (US 10-02 is): it goes; the HK session is still its market's shown one.
    assert not any(h.startswith("futu:US 2026-09-29") for h in held())
    assert "futu:HK 2026-10-01 FULL shown" in held()
    restarted = FutuSessionLifecycleCoordinator(store, event_sink=restarted_sink, now=clock,
                                               ledger=coord._ledger, jobs_root=tmp_path / "jobs")
    restarted.tick(force=True)
    assert len(submitted) == 2, "persisted recovery survives a second restart"


def _close_recoveries(monkeypatch):
    """The session.close_recovery remediation events emitted while the test runs."""
    from service.platform import remediation

    emitted = []
    monkeypatch.setattr(remediation, "emitter", lambda: SimpleNamespace(emit=lambda **kw: emitted.append(kw)))
    return lambda: [e for e in emitted if e.get("mechanism_id") == "session.close_recovery"]


def test_a_closed_session_older_than_the_kept_records_is_not_adopted_again(tmp_path, monkeypatch):
    """Only the newest KEEP_DATES lifecycle records are persisted. A session closed long ago (its record sealed, its job
    in the ledger) is missing from them on every start: it must not be taken in again (10-18: US 09-29 / 09-30 were,
    on every start). Taking a session from Market Runtime's records is the normal way, no close recovery."""
    recoveries = _close_recoveries(monkeypatch)
    coord, clock, sink, submitted, _ = _coordinator(tmp_path, utc(2026, 10, 3, 2))
    feed(sink, "US", "2026-09-29")
    coord.tick(force=True)
    assert len(submitted) == 1 and recoveries() == []
    assert sink.evidence.summary("futu", "US", "2026-09-29", "FULL")["sealed"]
    # The next start: the lifecycle store no longer holds the date (pruned past KEEP_DATES), the evidence and ledger do.
    fresh = FutuControlStore(tmp_path / "pruned.db")
    fresh.initialize_schema()
    restarted = FutuSessionLifecycleCoordinator(fresh, event_sink=sink, now=clock, tick_seconds=0, ledger=coord._ledger,
                                               jobs_root=tmp_path / "jobs")
    restarted.tick(force=True)
    assert "2026-09-29" not in restarted._sessions.get("US", {})
    assert recoveries() == []
    assert len(submitted) == 1


def test_sealed_evidence_without_a_ledger_job_is_still_adopted(tmp_path, monkeypatch):
    """The crash between sealing and submitting: sealed evidence, no job, no lifecycle record -- recovered."""
    recoveries = _close_recoveries(monkeypatch)
    coord, _, sink, submitted, _ = _coordinator(tmp_path, utc(2026, 10, 3, 2))
    feed(sink, "US", "2026-09-29")
    sink.evidence.seal("futu", "US", "2026-09-29", "FULL")
    coord.tick(force=True)
    assert [(r["market"], r["trading_date"]) for r in submitted] == [("US", "2026-09-29")]
    assert recoveries() == []


def test_sealed_lifecycle_without_a_ledger_job_is_resubmitted(tmp_path):
    coord, _, sink, submitted, _ = _coordinator(tmp_path, utc(2026, 9, 9, 6))
    feed(sink, "US", "2026-09-08")
    sink.evidence.seal("futu", "US", "2026-09-08", "FULL")
    coord._sessions = {"US": {"2026-09-08": {"state": "sealed", "completeness": "complete"}}}
    coord.tick(force=True)
    coord.tick(force=True)
    assert len(submitted) == 1
    assert coord._sessions["US"]["2026-09-08"]["materialization"] == "pending"


def test_crypto_is_never_sealed_or_materialized(tmp_path):
    # User rule: Futu crypto is never stored -- Market Runtime keeps it out of the WAL, so there is no
    # session to seal and no partition to materialize.
    coord, clock, sink, submitted, _ = _coordinator(tmp_path, utc(2026, 9, 9, 5, 30))
    seen(sink, "CC.BTCUSD", "2026-09-07")
    seen(sink, "US.AAPL", "2026-09-07")
    feed(sink, "US", "2026-09-07")
    coord.tick(force=True)
    assert "CC" not in coord._sessions
    assert [job["market"] for job in submitted] == ["US"]


def test_a_materialized_us_session_reads_no_history_in_the_provider(tmp_path, monkeypatch):
    """The provider re-read a whole materialized US session (gigabytes of events.jsonl, in Python) to build 量變's
    baseline: the Futu daemon stalled for seconds (its client lease heartbeat timed out). The baseline is the
    materialization's own output now (native/analysis_runtime/src/baseline_publish.rs); the lifecycle reads nothing."""
    import threading

    from service.market.history import historical_store

    reads = []
    monkeypatch.setattr(historical_store.HistoricalStore, "iter_events", lambda *a, **k: reads.append(a) or iter(()))
    coord, clock, sink, submitted, _ = _coordinator(tmp_path, utc(2026, 10, 7, 15, 0))
    seen(sink, "US.TSM", "2026-10-07")
    feed(sink, "US", "2026-10-07")
    clock.when = utc(2026, 10, 9, 6, 0)
    coord.tick(force=True)
    _finish(tmp_path, coord, "US", "2026-10-07", '{"ok": true, "status": "materialized"}')
    coord.tick(force=True)
    coord.tick(force=True)
    assert coord._sessions["US"]["2026-10-07"]["materialization"] == "materialized"
    assert reads == [], "the tick reads no materialized history"
    assert not [t for t in threading.enumerate() if "baseline" in t.name], "no background history reader"


def test_an_unreadable_lifecycle_state_is_kept_never_overwritten(tmp_path):
    """A read error or broken JSON became {} and the next save wrote over the real state."""
    from service.market.futu.session_lifecycle import STATE_KEY

    when = datetime(2026, 9, 23, 15, 0, tzinfo=timezone.utc)
    store = FutuControlStore(tmp_path / "c.db")
    store.initialize_schema()
    store.write_state(STATE_KEY, "{not json")
    coordinator = FutuSessionLifecycleCoordinator(store, event_sink=Sink(tmp_path / "evidence"), now=lambda: when)
    with store.write_session() as db:
        backups = [row[0] for row in db.execute("SELECT key FROM runtime_state WHERE key LIKE ?", (f"{STATE_KEY}.unreadable.%",))]
    assert len(backups) == 1 and store.read_state(backups[0]) == "{not json", "the unreadable content is kept"
    assert coordinator.status()["state_error"] is None

    class Flaky:
        """A store that cannot be read at all until it recovers."""

        def __init__(self, inner):
            self.inner, self.broken, self.writes = inner, True, 0

        def read_state(self, key):
            if self.broken:
                raise OSError("disk busy")
            return self.inner.read_state(key)

        def write_state(self, key, value):
            self.writes += 1
            return self.inner.write_state(key, value)

    store.write_state(STATE_KEY, json.dumps({"US": {"2026-09-22": {"state": "sealed"}}}))
    flaky = Flaky(store)
    coordinator = FutuSessionLifecycleCoordinator(flaky, event_sink=Sink(tmp_path / "evidence2"), now=lambda: when)
    assert "read failed" in coordinator.status()["state_error"]
    coordinator._sessions.setdefault("US", {})["2026-09-23"] = {"state": "open"}
    coordinator._save()
    assert flaky.writes == 0, "nothing is written over a state that could not be read"
    flaky.broken = False
    coordinator._save()
    saved = json.loads(store.read_state(STATE_KEY))
    assert set(saved["US"]) == {"2026-09-22", "2026-09-23"}, "the re-read state is merged, not lost"
    assert coordinator.status()["state_error"] is None

    # The same date, sealed and materialized on disk, "open" in memory while the store could not be read: the
    # persisted terminal state wins.
    store.write_state(STATE_KEY, json.dumps({"US": {"2026-09-24": {"state": "sealed", "materialization": "materialized"}}}))
    flaky.broken = True
    again = FutuSessionLifecycleCoordinator(flaky, event_sink=Sink(tmp_path / "evidence3"), now=lambda: when)
    again._sessions.setdefault("US", {})["2026-09-24"] = {"state": "open"}
    flaky.broken = False
    again._save()
    record = json.loads(store.read_state(STATE_KEY))["US"]["2026-09-24"]
    assert (record["state"], record["materialization"]) == ("sealed", "materialized"), record


def test_a_slow_tick_never_blocks_a_status_read_and_expires_intents(tmp_path):
    """Tick held the records lock through ledger, intent-file and SQLite I/O, so everything else that reads the records
    waited on it; and nothing ever expired intents by their TTL."""
    import threading
    import time as time_module

    coord, _clock, sink, _submitted, _store = _coordinator(tmp_path, utc(2026, 9, 23, 15, 0))
    feed(sink, "US", "2026-09-23")
    entered, release = threading.Event(), threading.Event()
    pruned = []

    def slow_ledger_tick():
        entered.set()
        release.wait(5)

    coord._ledger.tick = slow_ledger_tick
    coord._ledger.prune_intents = lambda: pruned.append(1) or 0
    ticker = threading.Thread(target=lambda: coord.tick(force=True), daemon=True)
    ticker.start()
    assert entered.wait(5)
    started = time_module.monotonic()
    coord.status()
    assert time_module.monotonic() - started < 0.5, "a status read does not wait for the tick's I/O"
    release.set()
    ticker.join(5)
    assert pruned == [1], "the owner expires intents on its tick"
    assert coord.status()["open"] >= 1
    saved = json.loads(_store.read_state("session_lifecycle_v2"))
    assert "2026-09-23" in saved.get("US", {}), "the session taken from Market Runtime's record is persisted by the tick"


def test_a_finished_session_goes_with_its_lifecycle_record_and_is_never_submitted_again(tmp_path, monkeypatch):
    """Materialized and no longer shown: the lifecycle record, Market Runtime's record (at the owner's prune) and the
    ledger record all go, and a restart neither takes in nor resubmits the session."""
    recoveries = _close_recoveries(monkeypatch)
    coord, clock, sink, submitted, store = _coordinator(tmp_path, utc(2026, 9, 8, 15, 0))
    seen(sink, "US.AAPL", "2026-09-08")
    feed(sink, "US", "2026-09-08")
    clock.when = utc(2026, 9, 10, 6, 0)
    coord.tick(force=True)
    _finish(tmp_path, coord, "US", "2026-09-08", '{"ok": true, "status": "materialized"}')
    seen(sink, "US.AAPL", "2026-09-09")
    feed(sink, "US", "2026-09-09")
    coord._pruned_for = None
    coord.tick(force=True)
    assert "2026-09-08" not in coord._sessions["US"]
    assert ("futu", "US", "2026-09-08", "FULL") not in sink.evidence.sessions("futu")
    assert coord._ledger.status(coord._key("US", "2026-09-08")) is None
    restarted = FutuSessionLifecycleCoordinator(store, event_sink=sink, now=clock, ledger=coord._ledger,
                                               jobs_root=tmp_path / "jobs")
    restarted.tick(force=True)
    assert "2026-09-08" not in restarted._sessions.get("US", {})
    assert [r["trading_date"] for r in submitted].count("2026-09-08") == 1 and recoveries() == []
