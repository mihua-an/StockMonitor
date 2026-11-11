from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from service.market.shared.market_identity_authority import MarketIdentityAuthority, StaleMarketIdentityError
from service.market.lifecycle.session import SessionIdentity, SessionLifecycleRegistry
from service.market.lifecycle.rollover import ActiveMarketSession, SessionOrchestrator
from tests.market_runtime_evidence_fake import FakeMarketRuntimeEvidence, FakeSink


ROOT = Path(__file__).resolve().parents[1]


def _sink() -> SimpleNamespace:
    """The broker app's event sink: the owner reads the process's one evidence ledger from it."""
    import tempfile

    return FakeSink(FakeMarketRuntimeEvidence(tempfile.mkdtemp(prefix="evidence-")))


def _identity(day: str) -> SessionIdentity:
    return SessionIdentity("shioaji", "STK", day, "DAY", session_order=1)


def test_session_orchestrator_is_the_only_rollover_implementation() -> None:
    assert SessionOrchestrator.__name__ == "SessionOrchestrator"
    source = (ROOT / "backend" / "shioaji" / "daemon_context.py").read_text(encoding="utf-8")
    assert "from service.market.lifecycle.rollover import SessionOrchestrator" in source
    assert "MarketSessionRolloverCoordinator(" not in source
    # The pre-lifecycle compatibility module was deliberately removed.  Do not
    # recreate it merely to make architecture tests inspect an obsolete path.
    assert not (ROOT / "service" / "market_session_rollover.py").exists()


def test_rotation_keeps_old_identity_sealing_and_rejects_late_reactivation() -> None:
    registry = SessionLifecycleRegistry()
    old = _identity("2026-09-01")
    new = _identity("2026-09-02")

    assert registry.observe("STK", old).generation == 1
    transition = registry.observe("STK", new)
    assert transition.rotated
    assert registry.state("STK").active == new
    assert old.key in registry.state("STK").sealing

    late = registry.observe("STK", old)
    assert not late.rotated
    assert registry.state("STK").active == new


def test_market_identity_authority_rejects_old_generation() -> None:
    authority = MarketIdentityAuthority("shioaji")
    authority.transition(
        market="STK", trading_date="2026-09-02", session="DAY",
        generation=2, logical_code="*", live=True,
    )
    with pytest.raises(StaleMarketIdentityError):
        authority.transition(
            market="STK", trading_date="2026-09-01", session="DAY",
            generation=1, logical_code="*", live=True,
        )


def test_automatic_finalizer_runs_full_post_session_maintenance(tmp_path) -> None:
    recorder = SimpleNamespace(
        flush=Mock(return_value={"ok": True}),
        evaluate_session=Mock(return_value={
            "ok": True, "materialized": {"ok": True},
        }),
    )
    authority_identity = SimpleNamespace(
        generation=1, live=False, as_dict=lambda: {"generation": 1, "live": False},
    )
    broker = SimpleNamespace(
        market_identity_authority=SimpleNamespace(current=lambda _market: authority_identity),
        status=lambda: {"txf": {}},
    )
    app = SimpleNamespace(live_event_sink=_sink(), session_evidence_gate=recorder, broker_service=broker)
    orchestrator = SessionOrchestrator(
        app_provider=lambda: app,
        finalization_grace_seconds=0, manifest_dir=tmp_path / "finalization",
        materialization_jobs_root=tmp_path / "materialization_jobs",
    )
    active = ActiveMarketSession(
        market="FUT", trading_date="2026-09-14", session="DAY",
        actual_contract="TXFI6", generation=1,
        stream_id="FUT:TXFR1:2026-09-14:DAY:TXFI6",
    )

    result = orchestrator._finalize_prepared({
        "active": active, "keys": [], "closing": [], "quiesce": {}, "attempt": 0,
    })

    recorder.evaluate_session.assert_called_once_with(
        market="FUT", trading_date="2026-09-14", session="DAY",
        actual_contract="TXFI6",
    )
    assert result["post_session_maintenance"]["ok"] is True
    assert result["cache_cleanup_allowed"] is True


def test_restart_after_close_recovers_persisted_session_intent(tmp_path) -> None:
    broker = SimpleNamespace(mark_market_session_transition=Mock())
    app = SimpleNamespace(live_event_sink=_sink(), broker_service=broker)
    active = ActiveMarketSession(
        market="FUT", trading_date="2026-09-14", session="DAY",
        actual_contract="TXFI6", generation=3,
        stream_id="FUT:TXFR1:2026-09-14:DAY:TXFI6",
    )
    writer = SessionOrchestrator(
        app_provider=lambda: app,
        manifest_dir=tmp_path / "finalization",
    )
    writer._write_session_intent(active)

    restarted = SessionOrchestrator(
        app_provider=lambda: app,
        manifest_dir=tmp_path / "finalization",
    )
    restarted._resolver = Mock(return_value=SimpleNamespace(
        resolve=lambda *_args, **_kwargs: SimpleNamespace(
            live=False, trading_date="2026-09-14", session="CLOSED",
        )
    ))
    prepared = {"job_id": active.stream_id, "active": active}
    restarted._prepare_finalization = Mock(return_value=prepared)
    restarted._schedule_finalization = Mock(return_value=True)

    restarted._recover_session_intents()

    restarted._prepare_finalization.assert_called_once()
    restarted._schedule_finalization.assert_called_once_with(prepared)
    broker.mark_market_session_transition.assert_called_once_with(
        market="FUT", trading_date="2026-09-14", session="DAY",
        generation=3, live=False, actual_contract="TXFI6",
    )


def test_recovered_old_session_is_committed_once_the_authority_moved_to_another_session(tmp_path) -> None:
    # Sessions recovered from earlier processes kept generation 1 while today's live STK
    # was also generation 1, so "1 > 1" never held and every old session stayed FAILED forever.
    today = SimpleNamespace(trading_date="2026-09-30", session="DAY", generation=1, live=True,
                            as_dict=lambda: {"trading_date": "2026-09-30", "generation": 1, "live": True})
    recorder = SimpleNamespace(evaluate_session=Mock(return_value={"ok": True}))
    app = SimpleNamespace(live_event_sink=_sink(), session_evidence_gate=recorder, broker_service=SimpleNamespace(
        market_identity_authority=SimpleNamespace(current=lambda _market: today), status=lambda: {"txf": {}}))
    orchestrator = SessionOrchestrator(
        app_provider=lambda: app, finalization_grace_seconds=0, manifest_dir=tmp_path / "finalization",
        materialization_jobs_root=tmp_path / "materialization_jobs",
    )
    old = ActiveMarketSession(market="STK", trading_date="2026-09-21", session="DAY", generation=1,
                              stream_id="shioaji:STK:*:2026-09-21:DAY")

    result = orchestrator._finalize_prepared({"active": old, "quiesce": {}, "attempt": 0})

    assert result["finalization_barrier"]["authority_transition_committed"] is True
    assert result["finalization_barrier"]["generation_transition_committed"] is True
    assert result["cache_cleanup_allowed"] is True


def test_the_same_live_session_is_not_committed_by_identity(tmp_path) -> None:
    same = SimpleNamespace(trading_date="2026-09-30", session="DAY", generation=1, live=True, as_dict=lambda: {})
    app = SimpleNamespace(live_event_sink=_sink(), session_evidence_gate=None, broker_service=SimpleNamespace(
        market_identity_authority=SimpleNamespace(current=lambda _market: same), status=lambda: {"txf": {}}))
    orchestrator = SessionOrchestrator(
        app_provider=lambda: app, finalization_grace_seconds=0, manifest_dir=tmp_path / "finalization",
        materialization_jobs_root=tmp_path / "materialization_jobs",
    )
    active = ActiveMarketSession(market="STK", trading_date="2026-09-30", session="DAY", generation=1)

    result = orchestrator._finalize_prepared({"active": active, "quiesce": {}, "attempt": 0})

    assert result["finalization_barrier"]["authority_transition_committed"] is False


def test_recovered_intent_generation_seeds_the_next_activation(tmp_path) -> None:
    broker = SimpleNamespace(mark_market_session_transition=Mock())
    app = SimpleNamespace(live_event_sink=_sink(), broker_service=broker)
    old = ActiveMarketSession(market="STK", trading_date="2026-09-21", session="DAY", generation=4,
                              stream_id="shioaji:STK:*:2026-09-21:DAY")
    SessionOrchestrator(app_provider=lambda: app, manifest_dir=tmp_path / "finalization")._write_session_intent(old)
    restarted = SessionOrchestrator(app_provider=lambda: app, manifest_dir=tmp_path / "finalization")
    restarted._resolver = Mock(return_value=SimpleNamespace(
        resolve=lambda *_a, **_k: SimpleNamespace(market="STK", live=True, reason="", session_end="",
                                                  trading_date="2026-09-30", session="DAY"),
    ))
    restarted._prepare_finalization = Mock(return_value={"job_id": old.stream_id, "active": old})
    restarted._schedule_finalization = Mock(return_value=True)

    restarted._recover_session_intents()

    assert restarted.generation_for("STK") == 4, "the next STK activation must be generation 5, above the old one"


def test_a_session_recovered_after_close_seals_when_this_process_never_activated_the_market(tmp_path) -> None:
    # The provider restarted in the evening; STK was never activated in the new process, so the
    # identity authority had no STK entry at all and the recovered close stayed "not committed" forever.
    recorder = SimpleNamespace(evaluate_session=Mock(return_value={"ok": True}))
    app = SimpleNamespace(live_event_sink=_sink(), session_evidence_gate=recorder, broker_service=SimpleNamespace(
        market_identity_authority=SimpleNamespace(current=lambda _market: None), status=lambda: {"txf": {}}))
    orchestrator = SessionOrchestrator(
        app_provider=lambda: app, finalization_grace_seconds=0, manifest_dir=tmp_path / "finalization",
        materialization_jobs_root=tmp_path / "materialization_jobs",
    )
    old = ActiveMarketSession(market="STK", trading_date="2026-09-30", session="DAY", generation=1,
                              stream_id="shioaji:STK:*:2026-09-30:DAY")

    recovered = orchestrator._finalize_prepared({"active": old, "quiesce": {}, "attempt": 0, "recovered": True})
    live = orchestrator._finalize_prepared({"active": old, "quiesce": {}, "attempt": 0})

    assert recovered["cache_cleanup_allowed"] is True and recovered["lifecycle_state"] == "sealed"
    assert live["cache_cleanup_allowed"] is False, "an in-process close still waits for the authority"


def test_a_finalization_is_never_dropped_by_a_full_queue_or_an_error(tmp_path) -> None:
    """QUEUE_FULL only marked the session, and an exception was only `_last_error`: the session stayed
    unfinalized for good."""
    import queue as queue_module
    import time as time_module

    from service.market.lifecycle import rollover

    orchestrator = SessionOrchestrator(app_provider=lambda: None, finalization_grace_seconds=0,
                                       manifest_dir=tmp_path / "finalization", materialization_jobs_root=tmp_path / "jobs")
    orchestrator._finalization_queue = queue_module.Queue(maxsize=1)
    orchestrator._finalization_queue.put_nowait({"job_id": "blocker"})
    job = {"job_id": "FUT:TXFR1:2026-09-14:DAY:TXFI6", "attempt": 0}
    orchestrator._pending_finalizations[job["job_id"]] = {"state": "PENDING"}
    assert orchestrator._schedule_finalization(job) is False
    assert orchestrator._pending_finalizations[job["job_id"]]["state"] == "QUEUE_FULL"
    assert orchestrator.status()["deferred_finalizations"] == [job["job_id"]], "kept, not dropped"
    orchestrator._finalization_queue.get_nowait()
    assert orchestrator._schedule_deferred_finalizations() == 1, "the next pass queues it"
    assert orchestrator._finalization_queue.get_nowait() is job
    assert orchestrator.status()["deferred_finalizations"] == []

    orchestrator._running.set()
    try:
        orchestrator._finalization_failed(job, result=None, error="OSError: disk full")
        assert orchestrator._pending_finalizations[job["job_id"]]["state"] == "FAILED_RETRY"
        retry, due = orchestrator._deferred_finalizations[job["job_id"]]
        assert retry["attempt"] == 1 and due > time_module.monotonic(), "retried later, with backoff"
        last = dict(job, attempt=rollover.FINALIZATION_MAX_ATTEMPTS - 1)
        orchestrator._deferred_finalizations.clear()
        orchestrator._finalization_failed(last, result=None, error="OSError: disk full")
        state = orchestrator._pending_finalizations[job["job_id"]]
        assert state["state"] == "FAILED" and "disk full" in state["last_error"], "stated, not left pending"
        assert not orchestrator._deferred_finalizations
    finally:
        orchestrator._running.clear()


def test_a_startup_reconcile_that_fails_stops_the_service_from_starting(tmp_path, monkeypatch):
    """bind_service kept the error and returned, so the runtime started the broker without a session."""
    import pytest
    from types import SimpleNamespace

    orchestrator = SessionOrchestrator(app_provider=lambda: None, manifest_dir=tmp_path / "finalization")
    monkeypatch.setattr(orchestrator, "reconcile", lambda *_a, **_k: (_ for _ in ()).throw(OSError("calendar unreadable")))
    app = SimpleNamespace(live_event_sink=_sink(), broker_service=SimpleNamespace(set_market_session_event_listener=lambda listener: None))
    with pytest.raises(OSError, match="calendar unreadable"):
        orchestrator.bind_service(app)
    assert "startup reconcile" in orchestrator.lightweight_status().get("last_error", "")


def test_a_recovered_intent_is_removed_by_the_file_it_was_read_from(tmp_path) -> None:
    # Intents written by an earlier naming ("F_U_T___T_X_F_R_1___2_0_2_6...") were finalized at every start: the
    # cleanup removed the name recomputed from the session, which was not that file.
    import json

    recorder = SimpleNamespace(evaluate_session=Mock(return_value={"ok": True}))
    app = SimpleNamespace(live_event_sink=_sink(), session_evidence_gate=recorder, broker_service=SimpleNamespace(
        market_identity_authority=SimpleNamespace(current=lambda _market: None), status=lambda: {"txf": {}},
        mark_market_session_transition=Mock()))
    orchestrator = SessionOrchestrator(
        app_provider=lambda: app, finalization_grace_seconds=0, manifest_dir=tmp_path / "finalization",
        materialization_jobs_root=tmp_path / "materialization_jobs",
    )
    legacy = orchestrator._intent_dir / "F_U_T___T_X_F_R_1___2_0_2_6_-_0_9_-_0_2___D_A_Y.json"
    legacy.parent.mkdir(parents=True, exist_ok=True)
    legacy.write_text(json.dumps({"schema": "session-intent-v1", "state": "ACTIVE", "active": {
        "market": "FUT", "trading_date": "2026-09-02", "session": "DAY", "actual_contract": "", "generation": 1,
        "state": "ACTIVE", "stream_id": "FUT:TXFR1:2026-09-02:DAY", "activated_at": "2026-09-14T16:35:16.276+08:00"}}),
        encoding="utf-8")
    orchestrator._resolver = Mock(return_value=SimpleNamespace(
        resolve=lambda *_a, **_k: SimpleNamespace(live=False, trading_date="2026-10-14", session="CLOSED")))
    scheduled = []
    orchestrator._schedule_finalization = lambda prepared, **_k: scheduled.append(prepared) or True

    orchestrator._recover_session_intents()
    assert len(scheduled) == 1 and scheduled[0]["intent_path"] == str(legacy)
    result = orchestrator._finalize_prepared(scheduled[0])

    assert result["cache_cleanup_allowed"] is True and result["failed_because"] == []
    assert not legacy.exists(), "the file the intent was read from is gone: the next start finds nothing to redo"


def test_a_finalization_that_fails_states_which_gate_stopped_it(tmp_path) -> None:
    # Recorded only as "not complete: FAILED" before: the cause of a failed first attempt was lost.
    app = SimpleNamespace(live_event_sink=_sink(), broker_service=SimpleNamespace(
        market_identity_authority=SimpleNamespace(current=lambda _market: None), status=lambda: {"txf": {}}))
    orchestrator = SessionOrchestrator(
        app_provider=lambda: app, finalization_grace_seconds=0, manifest_dir=tmp_path / "finalization",
        materialization_jobs_root=tmp_path / "materialization_jobs",
    )
    old = ActiveMarketSession(market="FUT", trading_date="2026-09-02", session="DAY", generation=1,
                              stream_id="FUT:TXFR1:2026-09-02:DAY")
    result = orchestrator._finalize_prepared({"active": old, "quiesce": {}, "attempt": 0, "recovered": True})
    assert result["finalization_status"] == "FAILED"
    assert any(reason.startswith("evidence_gate_not_run") for reason in result["failed_because"]), result["failed_because"]
    # The manifest a restart reads holds the cause too, not only this attempt's return value (R13-03).
    import json

    (manifest,) = (tmp_path / "finalization").glob("*.json")
    assert json.loads(manifest.read_text(encoding="utf-8"))["failed_because"] == result["failed_because"]


def test_a_close_recovered_at_startup_waits_for_the_service_graph_and_seals_on_the_first_attempt(tmp_path) -> None:
    # The daemon starts the owner while its runtime is still building the service on another thread: the intent
    # was recovered with no service, the closing manifest was skipped, and the first finalization ran before the
    # recorder existed (evidence_gate_not_run: POST_SESSION_MAINTENANCE_UNAVAILABLE), sealing only on a retry.
    import json
    import time as time_module

    holder: dict[str, object] = {"app": None}
    recorder = SimpleNamespace(evaluate_session=Mock(return_value={"ok": True}))
    broker = SimpleNamespace(
        market_identity_authority=SimpleNamespace(current=lambda _market: None), status=lambda: {"txf": {}},
        mark_market_session_transition=Mock(), set_market_session_event_listener=Mock())
    app = SimpleNamespace(live_event_sink=_sink(), session_evidence_gate=recorder, broker_service=broker)
    orchestrator = SessionOrchestrator(
        app_provider=lambda: holder["app"], finalization_grace_seconds=0, poll_seconds=0.2,
        manifest_dir=tmp_path / "finalization", materialization_jobs_root=tmp_path / "materialization_jobs",
    )
    intent = orchestrator._intent_dir / "FUT_TXFR1_2026-10-19_DAY.json"
    intent.parent.mkdir(parents=True, exist_ok=True)
    intent.write_text(json.dumps({"schema": "session-intent-v1", "state": "ACTIVE", "active": {
        "market": "FUT", "trading_date": "2026-10-19", "session": "DAY", "actual_contract": "TXFK6", "generation": 4,
        "state": "ACTIVE", "stream_id": "FUT:TXFR1:2026-10-19:DAY:TXFK6", "activated_at": "2026-10-19T08:45:00.000+08:00"}}),
        encoding="utf-8")
    closed = SimpleNamespace(
        resolve=lambda *_a, **_k: SimpleNamespace(live=False, trading_date="2026-10-19", session="CLOSED"))
    orchestrator._resolver = Mock(return_value=closed)
    reconciles = []
    orchestrator._reconcile_locked = lambda *_a, **_k: reconciles.append(holder["app"]) or {"ok": True}

    orchestrator.start()
    try:
        time_module.sleep(0.5)
        assert intent.exists() and not orchestrator._pending_finalizations, "nothing is recovered without the service"
        assert reconciles == [], "no session decision runs before the service graph is bound"

        holder["app"] = app
        orchestrator.bind_service(app)
        orchestrator.bind_service(app)
        broker.mark_market_session_transition.assert_called_once_with(
            market="FUT", trading_date="2026-10-19", session="DAY", generation=4, live=False, actual_contract="TXFK6")
        deadline = time_module.monotonic() + 5.0
        while time_module.monotonic() < deadline and orchestrator._pending_finalizations.get(
                "FUT:TXFR1:2026-10-19:DAY:TXFK6", {}).get("state") != "COMPLETE":
            time_module.sleep(0.05)
        state = orchestrator._pending_finalizations["FUT:TXFR1:2026-10-19:DAY:TXFK6"]
        assert state["state"] == "COMPLETE" and state["attempt"] == 0, state
        assert not intent.exists()
        assert reconciles and all(seen is app for seen in reconciles)
    finally:
        orchestrator.stop(timeout=2.0)
    recorder.evaluate_session.assert_called_once()


@pytest.mark.parametrize("clock, finalized", [("13:49", False), ("14:41", True)])
def test_a_restart_in_the_after_hours_hold_keeps_the_stock_day_open_until_14_40(tmp_path, clock, finalized) -> None:
    # Finalizing the STK day at a restart right after 13:30 would write its history without the 14:30 盤後定價 print.
    # Until STK_AFTER_HOURS_END the day is taken back, and the regular pass seals it at 14:40.
    from datetime import datetime
    from zoneinfo import ZoneInfo

    broker = SimpleNamespace(mark_market_session_transition=Mock())
    app = SimpleNamespace(live_event_sink=_sink(), broker_service=broker)
    active = ActiveMarketSession(market="STK", trading_date="2026-10-20", session="DAY", actual_contract="",
                                 generation=2, stream_id="STK:*:2026-10-20:DAY")
    SessionOrchestrator(app_provider=lambda: app, manifest_dir=tmp_path / "finalization")._write_session_intent(active)
    hour, minute = map(int, clock.split(":"))
    restarted = SessionOrchestrator(app_provider=lambda: app, manifest_dir=tmp_path / "finalization",
                                    now_provider=lambda: datetime(2026, 10, 20, hour, minute, tzinfo=ZoneInfo("Asia/Taipei")))
    restarted._resolver = Mock(return_value=SimpleNamespace(
        resolve=lambda *_args, **_kwargs: SimpleNamespace(
            market="STK", live=False, reason="outside_day_session", session_end="2026-10-20T13:30:00+08:00",
            trading_date="2026-10-20", session="DAY", session_start="2026-10-20T09:00:00+08:00"),
    ))
    prepared = {"active": active}
    restarted._prepare_finalization = Mock(return_value=prepared)
    restarted._schedule_finalization = Mock(return_value=True)

    restarted._recover_session_intents()

    held = restarted._active.get("STK")
    if finalized:
        restarted._prepare_finalization.assert_called_once()
        assert restarted._prepare_finalization.call_args.args[0].stream_id == active.stream_id
        restarted._schedule_finalization.assert_called_once_with(prepared)
        assert prepared["recovered"] is True and prepared["intent_path"].endswith(".json")
        assert held is None, "a finalized day is not taken back as the active session"
    else:
        restarted._prepare_finalization.assert_not_called()
        restarted._schedule_finalization.assert_not_called()
        assert held is not None and held.stream_id == active.stream_id and held.state == "ACTIVE"
