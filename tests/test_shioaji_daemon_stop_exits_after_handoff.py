"""The Shioaji provider exits once its durable handoff is done, even when the native stop reports trouble or
rebuildable background work is abandoned at the deadline.

Both conditions failed the whole stop: the daemon had logged out and handed off but stayed
alive, 完整關閉 left it running, and the next launch refused to start a replacement next to it -- no Shioaji data
at the open.
"""
from types import SimpleNamespace

from backend.shioaji.daemon_context import create_daemon_context
from backend.shioaji.daemon_shutdown import shutdown_daemon


def _isolate(*, runtime_ok: bool, forced: int):
    """A daemon context of its own: the stop under test touches nothing of the process's."""
    calls = []
    history = SimpleNamespace(
        freeze_historical_work=lambda: {},
        shutdown_historical_work=lambda timeout: {"forced_abandon_count": forced},
    )
    ctx = create_daemon_context(runtime=SimpleNamespace(
        service=SimpleNamespace(historical_repository=history),
        stop=lambda **kwargs: calls.append("stop") or {"ok": runtime_ok, "shutdown": {}},
        finalize_broker_logout=lambda busy=(): calls.append("logout" if not busy else f"logout skipped: {','.join(busy)}")
        or ({"ok": True} if not busy else {"ok": False, "skipped": f"{', '.join(busy)} still running"}),
    ))
    ctx.server_exit_callback = lambda: calls.append("exit")
    return ctx, calls


def test_a_native_stop_reporting_trouble_still_exits() -> None:
    ctx, calls = _isolate(runtime_ok=False, forced=0)
    result = shutdown_daemon(ctx, "user_full_shutdown")
    assert result["ok"] is True
    assert result["stopped"] is True
    assert "native runtime stop reported not ok" in result["shutdown_warnings"]
    assert calls == ["stop", "logout", "exit"], "logged out, then uvicorn asked to exit"
    # It exits, but the answer says the stop was not clean (these used to be hard-coded True).
    assert result["clean"] is False
    assert result["durable_handoff_complete"] is False and result["pipeline_drained"] is False


def test_abandoned_rebuildable_work_still_exits() -> None:
    ctx, calls = _isolate(runtime_ok=True, forced=2)
    result = shutdown_daemon(ctx, "user_full_shutdown")
    assert result["ok"] is True
    assert result["shutdown_warnings"] == ["2 rebuildable background job(s) abandoned",
                                           "broker logout not done: history_work still running"]
    assert calls == ["stop", "logout skipped: history_work", "exit"],         "CX-157: never logged out under history work that may still call the broker"
    assert result["clean"] is False


def test_a_clean_stop_has_no_warnings() -> None:
    ctx, _calls = _isolate(runtime_ok=True, forced=0)
    result = shutdown_daemon(ctx, "explicit_stop")
    assert result["ok"] is True and result["shutdown_warnings"] == []
    assert result["clean"] is True and result["durable_handoff_complete"] is True and result["pipeline_drained"] is True


def test_the_deferred_logout_runs_only_when_the_shutdown_left_it_pending() -> None:
    """The daemon logged out unconditionally, even after the service's shutdown had skipped the
    logout because a K-bar download was still calling the broker."""
    import threading

    from service.market.shioaji.service import ShioajiMarketService

    logouts = []
    service = object.__new__(ShioajiMarketService)
    service._shutdown_lock = threading.RLock()
    service.broker_service = SimpleNamespace(logout_after_drain=lambda: logouts.append(1))
    service._broker_logout_pending = False
    assert service.finalize_broker_logout()["logged_out"] is False and logouts == [], "busy at shutdown: not pending"
    service._broker_logout_pending = True
    assert service.finalize_broker_logout(busy=["route_work"])["logged_out"] is False and logouts == []
    service._broker_logout_pending = True
    assert service.finalize_broker_logout() == {"ok": True, "logged_out": True} and logouts == [1]
    assert service.finalize_broker_logout()["logged_out"] is False and logouts == [1], "once"
