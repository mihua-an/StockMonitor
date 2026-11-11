"""The Shioaji SDK reconnects a dropped session by itself (event 12 "Session reconnecting", then 13 "Session
reconnected"): 10-29 08:30:40 connection 1 was down 48 ms and nothing was recorded. Each such reconnect is one
remediation (provider.shioaji_sdk_session_reconnect), apart from the App's own re-login (broker_session_down).

What the streams of a connection missed meanwhile is reported to Market Runtime as an outage of the codes that
connection carried (``ingest.loss``, reason broker_outage): it judges whether the span touched trading and keeps it in
those partitions' evidence (native/market_runtime/src/evidence.rs)."""
from __future__ import annotations

import threading
import time
from types import SimpleNamespace

from datetime import datetime
from zoneinfo import ZoneInfo

from service.market.shioaji import session as session_module
from service.market.shioaji.session import ShioajiBrokerService
from service.platform import remediation

TAIPEI = ZoneInfo("Asia/Taipei")
DATE = "2026-10-29"   # a Thursday, a TWSE trading day


def _ns(hour: int, minute: int, second: int = 0, ms: int = 0) -> int:
    moment = datetime.fromisoformat(DATE).replace(hour=hour, minute=minute, second=second, tzinfo=TAIPEI)
    return int(moment.timestamp()) * 1_000_000_000 + ms * 1_000_000


class _Sink:
    """The event sink's outage report: what the provider tells Market Runtime."""

    def __init__(self) -> None:
        self.outages: list[tuple[str, list[tuple[str, str]], int, int]] = []
        self.began: list[tuple[str, list[tuple[str, str]], int]] = []

    def report_outage(self, instruments, from_ns, to_ns, *, connection):
        self.outages.append((connection, sorted(instruments), from_ns, to_ns))

    def report_outage_began(self, instruments, from_ns, *, connection):
        self.began.append((connection, sorted(instruments), from_ns))

DOWN = ("0", "12", "Session '(c1,s1)_sinopac' keep-alive on tcp_TxRx detected session down, client name 'PYAPI/X'",
        "Session reconnecting")
UP = ("0", "13", "host '210.59.255.161:80' (total reconnection attempt 1 of 10)", "Session reconnected")


def _service(sink: _Sink | None = None) -> ShioajiBrokerService:
    service = object.__new__(ShioajiBrokerService)
    service.event_sink = sink or _Sink()
    # Connection 1 carries 2317, connection 2 carries 2330 and the TAIEX quotes.
    service._active_subscription_keys = {"STK:2317:Tick:regular", "STK:2330:Tick:regular", "STK:2330:BidAsk:regular",
                                         "IND:IX0001:Quote"}
    service._stream_connection = {"STK:2330:Tick:regular": 1, "STK:2330:BidAsk:regular": 1, "IND:IX0001:Quote": 1}
    service._stream_subscription_state = {}
    service._unrestored_outages = {}
    service._session_down_epoch_ns = None
    for name in ("_connection_cap", "_active_stream_contracts", "_stock_contracts", "_symbol_ids", "_extra_apis"):
        setattr(service, name, {})
    service._api = service._sj = None
    service._sync_mutex = threading.RLock()
    service._logout_extra_connections = lambda reason: None
    service._notify_subscriptions_changed = lambda: None
    service._connected = threading.Event()
    service._connected.set()
    service._broker_session_down = threading.Event()
    service._wake = threading.Event()
    service._lock = threading.RLock()
    service._broker_events = []
    service._broker_refusals = []
    service._sdk_reconnects = {}
    service._session_generation = 7
    return service


def _recorded(monkeypatch):
    events = []

    def emit_tracked(**fields):
        event = {"event_id": f"e{len(events)}", **fields}
        events.append(event)
        return event, True

    monkeypatch.setattr(remediation, "emitter", lambda: SimpleNamespace(
        begin=lambda **kw: remediation.RemediationOperation(SimpleNamespace(_emit_tracked=emit_tracked), **kw)))
    return events


def test_an_sdk_reconnect_is_one_remediation_with_its_connection_and_gap(monkeypatch):
    events = _recorded(monkeypatch)
    service = _service()
    service._on_broker_event(*DOWN, connection=0)
    service._on_broker_event(*UP, connection=0)
    assert [e["outcome"] for e in events] == ["started", "succeeded"]
    started, finished = events
    for event in events:
        assert event["mechanism_id"] == "provider.shioaji_sdk_session_reconnect"
        assert event["trigger_reason"] == "sdk_session_down"
        assert event["identity"]["source"] == "shioaji" and event["identity"]["connection_id"] == "connection 1"
    assert finished["related_upstream_event_id"] == started["event_id"]
    assert finished["detail"]["connection"] == 1 and finished["detail"]["gap_ms"] >= 0
    assert finished["detail"]["down_at"] and finished["detail"]["reconnected_at"]
    # The broker's text names the person ID in its client name: it never goes into the record.
    assert "PYAPI" not in repr(events)
    # The SDK's own reconnect is not the App's re-login.
    assert not service._broker_session_down.is_set()


def test_each_connection_keeps_its_own_reconnect(monkeypatch):
    events = _recorded(monkeypatch)
    service = _service()
    service._on_broker_event(*DOWN, connection=0)
    service._on_broker_event(*DOWN, connection=2)
    service._on_broker_event(*UP, connection=2)
    assert [(e["outcome"], e["identity"]["connection_id"]) for e in events] == [
        ("started", "connection 1"), ("started", "connection 3"), ("succeeded", "connection 3")]


def test_an_sdk_reconnect_that_gives_up_ends_failed_and_the_app_logs_in_again(monkeypatch):
    events = _recorded(monkeypatch)
    service = _service()
    service._on_broker_event(*DOWN, connection=1)
    service._on_broker_session_down()
    assert [e["outcome"] for e in events] == ["started", "failed"]
    assert service._session_replacement_reason(__import__("datetime").datetime(2026, 10, 29, 9, 0)) == "broker_session_down"


def test_other_broker_events_open_nothing(monkeypatch):
    events = _recorded(monkeypatch)
    service = _service()
    service._on_broker_event("0", "16", "Subscribe or Unsubscribe ok", "")
    service._on_broker_event(*UP, connection=0)       # a reconnected without a reconnecting before it
    assert events == []


def _clock(monkeypatch, *moments):
    """The wall clock the provider reads, one moment per call."""
    left = list(moments)
    monkeypatch.setattr(session_module, "time", SimpleNamespace(time_ns=lambda: left.pop(0), monotonic_ns=time.monotonic_ns))


def test_an_sdk_reconnect_is_reported_as_an_outage_of_that_connection_s_codes(monkeypatch):
    _recorded(monkeypatch)
    sink = _Sink()
    service = _service(sink)
    _clock(monkeypatch, _ns(10, 0), _ns(10, 0, 0, 48))
    service._on_broker_event(*DOWN, connection=1)
    service._on_broker_event(*UP, connection=1)
    assert sink.outages == [("connection 2", [("IDX", "TAIEX"), ("STK", "2330")], _ns(10, 0), _ns(10, 0, 0, 48))]


def test_an_sdk_reconnect_that_gives_up_is_reported_once_the_next_login_subscribed_again(monkeypatch):
    _recorded(monkeypatch)
    sink = _Sink()
    service = _service(sink)
    _clock(monkeypatch, _ns(10, 0), _ns(10, 0, 1), _ns(10, 0, 30))
    service._on_broker_event(*DOWN, connection=0)
    service._on_broker_session_down()
    assert sink.outages == []   # still open: no end known yet
    service._end_unrestored_outages()       # the next login's full resubscribe is done
    assert sink.outages == [("connection 1", [("STK", "2317")], _ns(10, 0), _ns(10, 0, 30))]


# The App's own re-login (broker_session_down: the SDK gave up, the 24 h token expired) logs out every connection and
# subscribes everything again: each connection's codes are an outage from the moment the broker reported the session
# down until that resubscribe is done -- not only the connection the SDK was reconnecting.

def test_a_relogin_after_the_session_went_down_is_an_outage_of_every_connection_s_codes(monkeypatch):
    _recorded(monkeypatch)
    sink = _Sink()
    service = _service(sink)
    _clock(monkeypatch, _ns(10, 0), _ns(10, 0, 30))
    service._on_broker_session_down()       # no SDK reconnect before it (the token expired)
    service._disconnect()                   # the session thread's next pass logs the session out
    assert sink.outages == []   # still open: no end known yet
    service._end_unrestored_outages()       # the next login's full resubscribe is done
    assert sorted(sink.outages) == [
        ("connection 1", [("STK", "2317")], _ns(10, 0), _ns(10, 0, 30)),
        ("connection 2", [("IDX", "TAIEX"), ("STK", "2330")], _ns(10, 0), _ns(10, 0, 30))]


def test_a_connection_the_sdk_gave_up_on_keeps_its_earlier_start(monkeypatch):
    _recorded(monkeypatch)
    sink = _Sink()
    service = _service(sink)
    _clock(monkeypatch, _ns(10, 0), _ns(10, 0, 5), _ns(10, 0, 30))
    service._on_broker_event(*DOWN, connection=0)
    service._on_broker_session_down()
    service._disconnect()
    service._end_unrestored_outages()
    assert {connection: start for connection, _codes, start, _end in sink.outages} == {
        "connection 1": _ns(10, 0), "connection 2": _ns(10, 0, 5)}


# What the connection's codes printed meanwhile is filled from the broker's history (market_runtime outage_gap.rs):
# Market Runtime takes each code's gap start when the connection goes down, so it is told at once -- by the outage's
# end the reconnected stream may already have stored newer prints.

def test_a_dropped_connection_is_told_to_market_runtime_when_it_goes_down(monkeypatch):
    _recorded(monkeypatch)
    sink = _Sink()
    service = _service(sink)
    _clock(monkeypatch, _ns(10, 0), _ns(10, 0, 0, 48))
    service._on_broker_event(*DOWN, connection=1)
    assert sink.began == [("connection 2", [("IDX", "TAIEX"), ("STK", "2330")], _ns(10, 0))]
    assert sink.outages == []
    service._on_broker_event(*UP, connection=1)
    assert sink.outages == [("connection 2", [("IDX", "TAIEX"), ("STK", "2330")], _ns(10, 0), _ns(10, 0, 0, 48))]


def test_a_relogin_tells_market_runtime_every_connection_went_down_when_the_session_did(monkeypatch):
    _recorded(monkeypatch)
    sink = _Sink()
    service = _service(sink)
    _clock(monkeypatch, _ns(10, 0), _ns(10, 0, 30))
    service._on_broker_session_down()
    service._disconnect()
    assert sorted(sink.began) == [("connection 1", [("STK", "2317")], _ns(10, 0)),
                                  ("connection 2", [("IDX", "TAIEX"), ("STK", "2330")], _ns(10, 0))]
