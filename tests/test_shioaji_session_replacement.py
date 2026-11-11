"""2026-10-13 09:36: Shioaji answered 401 about 24 h after the App's only login and dropped its quote session; the
provider stayed "connected" with no data for hours and recorded nothing. The broker session is now replaced when
the SDK reports it down, and once a day before the market opens so a login never ages into trading hours."""
from __future__ import annotations

import threading
from datetime import datetime

from service.market.shioaji.session import ShioajiBrokerService


def _service(logged_in_at: datetime | None, connected: bool = True) -> ShioajiBrokerService:
    service = object.__new__(ShioajiBrokerService)
    service._connected = threading.Event()
    if connected:
        service._connected.set()
    service._broker_session_down = threading.Event()
    service._wake = threading.Event()
    service._logged_in_at = logged_in_at
    service._lock = threading.RLock()
    service._broker_events = []
    service._broker_refusals = []
    service._sdk_reconnects = {}
    service._session_down_epoch_ns = None
    return service


def test_a_session_down_callback_wakes_the_session_thread_to_log_in_again():
    service = _service(datetime(2026, 10, 13, 9, 0))
    assert service._session_replacement_reason(datetime(2026, 10, 13, 9, 36)) is None
    service._on_broker_session_down()
    assert service._wake.is_set()
    assert service._session_replacement_reason(datetime(2026, 10, 13, 9, 36)) == "broker_session_down"


def test_yesterdays_login_is_replaced_before_the_open_never_during_trading():
    service = _service(datetime(2026, 10, 12, 9, 29))
    assert service._session_replacement_reason(datetime(2026, 10, 13, 4, 59)) is None   # TXF night session
    assert service._session_replacement_reason(datetime(2026, 10, 13, 8, 4)) is None    # the day's contracts not out yet
    assert service._session_replacement_reason(datetime(2026, 10, 13, 8, 5)) == "daily_relogin"
    assert service._session_replacement_reason(datetime(2026, 10, 13, 8, 24)) == "daily_relogin"
    assert service._session_replacement_reason(datetime(2026, 10, 13, 8, 25)) is None   # pre-open is near: too late
    assert service._session_replacement_reason(datetime(2026, 10, 13, 9, 30)) is None


def test_a_login_made_before_the_days_contracts_is_replaced_in_the_window():
    # A launch at 06:00 logged in before the broker published the day's contracts (07:50 futures, 08:00 stocks).
    service = _service(datetime(2026, 10, 13, 6, 0))
    assert service._session_replacement_reason(datetime(2026, 10, 13, 8, 5)) == "daily_relogin"


def test_a_login_made_in_this_mornings_window_is_kept():
    service = _service(datetime(2026, 10, 13, 8, 6))
    assert service._session_replacement_reason(datetime(2026, 10, 13, 8, 20)) is None


def test_nothing_is_replaced_while_disconnected():
    service = _service(datetime(2026, 10, 12, 9, 29), connected=False)
    service._broker_session_down.set()
    assert service._session_replacement_reason(datetime(2026, 10, 13, 6, 0)) is None


def test_login_registers_the_session_down_and_event_callbacks():
    calls = {}

    class Api:
        def set_session_down_callback(self, callback):
            calls["down"] = callback

        def set_event_callback(self, callback):
            calls["event"] = callback

    class Backend:
        def install_callbacks(self, api):
            calls["quotes"] = api

    service = _service(None)
    service.provider_backend = Backend()
    api = Api()
    service._register_callbacks(api)
    assert calls["quotes"] is api
    assert calls["down"] == service._on_broker_session_down and calls["event"] == service._on_broker_event
    service._on_broker_event(0, 13, "Session Up", "")
    assert service._broker_events[-1]["event"] == ["0", "13", "Session Up", ""]
