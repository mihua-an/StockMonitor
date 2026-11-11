from datetime import datetime
from zoneinfo import ZoneInfo

from service.market.lifecycle.rollover import SessionOrchestrator


def test_foreign_market_first_event_cannot_finalize_active_equity_preopen(tmp_path) -> None:
    zone = ZoneInfo("Asia/Taipei")
    orchestrator = SessionOrchestrator(
        app_provider=lambda: None,
        manifest_dir=tmp_path / "finalization",
        now_provider=lambda: datetime(2026, 9, 2, 8, 30, 5, tzinfo=zone),
    )
    orchestrator.reconcile(datetime(2026, 9, 2, 8, 30, 5, tzinfo=zone), markets={"STK"})
    before = orchestrator.lightweight_status()["active"]["STK"]

    # A FUT callback may carry a timestamp outside the STK pre-open window.
    # It must reconcile FUT only and leave STK ownership untouched.
    orchestrator.observe_first_market_event("FUT", "2026-09-02T05:00:00+08:00")
    after = orchestrator.lightweight_status()["active"]["STK"]

    assert after["stream_id"] == before["stream_id"]
    assert after["generation"] == before["generation"]
    assert orchestrator.lightweight_status()["session_lifecycle"]["STK"]["phase"] == "ACTIVE"


def test_partial_reconcile_preserves_other_market_health_context(tmp_path) -> None:
    zone = ZoneInfo("Asia/Taipei")
    orchestrator = SessionOrchestrator(
        app_provider=lambda: None,
        manifest_dir=tmp_path / "finalization",
        now_provider=lambda: datetime(2026, 9, 2, 9, 1, tzinfo=zone),
    )
    full = orchestrator.reconcile(datetime(2026, 9, 2, 9, 1, tzinfo=zone))
    assert full["active"]["STK"]["state"] == "ACTIVE"
    assert full["active"]["FUT"]["state"] == "ACTIVE"

    orchestrator.reconcile(datetime(2026, 9, 2, 9, 1, 1, tzinfo=zone), markets={"STK"})
    context = __import__("service.market.shared.dataflow_health", fromlist=["dataflow_health_ledger"]).dataflow_health_ledger.snapshot()["context"]
    assert context["expected_activity"] == {"STK": True, "FUT": True}
    assert "futures.quote" in context["expected_lanes"]


def test_callback_reconcile_never_waits_for_poll_reconcile_lock(tmp_path) -> None:
    zone = ZoneInfo("Asia/Taipei")
    orchestrator = SessionOrchestrator(
        app_provider=lambda: None,
        manifest_dir=tmp_path / "finalization",
        now_provider=lambda: datetime(2026, 9, 2, 9, 1, tzinfo=zone),
    )
    assert orchestrator._reconcile_lock.acquire(blocking=False)
    try:
        result = orchestrator.reconcile(
            datetime(2026, 9, 2, 9, 1, tzinfo=zone),
            markets={"STK"},
            wait=False,
        )
    finally:
        orchestrator._reconcile_lock.release()
    assert result == {"ok": True, "skipped": "RECONCILE_BUSY"}


def test_late_event_from_an_earlier_session_cannot_roll_the_active_session_back(tmp_path) -> None:
    # The day session's first callback was a delayed night print; it sealed DAY and re-activated NIGHT.
    zone = ZoneInfo("Asia/Taipei")
    orchestrator = SessionOrchestrator(
        app_provider=lambda: None,
        manifest_dir=tmp_path / "finalization",
        now_provider=lambda: datetime(2026, 9, 2, 9, 1, tzinfo=zone),
    )
    orchestrator.reconcile(datetime(2026, 9, 2, 9, 1, tzinfo=zone), markets={"FUT"})
    before = orchestrator.lightweight_status()["active"]["FUT"]
    assert before["session"] == "DAY"

    orchestrator.observe_first_market_event("FUT", "2026-09-02T04:59:00+08:00")
    after = orchestrator.lightweight_status()["active"]["FUT"]

    assert after["stream_id"] == before["stream_id"]
    assert after["generation"] == before["generation"]
    assert after["state"] == "ACTIVE"
