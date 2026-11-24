"""TXF limit prices are published for the trading date whose quotes state the contract's own reference.

Shioaji's futures quote carries no limits; they are the contract's (``contracts.info``). On the night that opened
2026-11-06 15:00 (trading date 11-09) the contract read 11-07 03:00 said reference 39652, limits 43617 / 35687 and
update_date 2026-11-06 -- the day the broker updated it, not the trading date it is for -- and the night's quotes
stated the same 39652 (close - price_chg). The provider matched update_date against the trading date, so the limits
of a correct contract were never published, and it cached the first read for good, so nothing asked again. On a
closure the provider once re-published limits dated by the wall clock at every subscription attempt (a FUT "DAY"
that never traded): limits are only ever published for a trading date whose quotes have traded.
"""
from datetime import date, datetime
from types import SimpleNamespace
from unittest.mock import MagicMock

from service.market.lifecycle.calendar import MarketSessionCalendar
from service.market.shioaji import callback
from service.market.shioaji import session as module

SCALE = 10_000


def test_a_closures_daytime_is_not_a_trading_date():
    calendar = MarketSessionCalendar()
    assert calendar.trading_date_for_timestamp(datetime(2026, 10, 9, 10, 0)) == (date(2026, 10, 8), "official_calendar")
    assert calendar.trading_date_for_timestamp(datetime(2026, 10, 9, 16, 0)) == (date(2026, 10, 12), "official_calendar")


def _frozen(at: datetime):
    class FrozenNow(datetime):
        @classmethod
        def now(cls, tz=None):
            return at
    return FrozenNow


class Sink:
    """The provider's queue to Market Runtime: `queued` says whether the queue takes an event, `verdict` what Market
    Runtime answers it -- (True, None), (False, reason), or None for no answer yet (kept in `waiting`)."""

    def __init__(self):
        self.events, self.queued, self.verdict, self.waiting = [], True, (True, None), []

    def publish(self, event):
        return True                     # the market events (quotes): not what these tests look at

    def publish_with_verdict(self, event, on_verdict):
        if not self.queued:
            return False
        self.events.append(event)
        if self.verdict is None:
            self.waiting.append(on_verdict)
        else:
            on_verdict(*self.verdict)   # the sender may answer before publish returns
        return True


class Clock:
    def __init__(self):
        self.t = 1000.0

    def monotonic(self):
        return self.t


def _broker(monkeypatch, at=datetime(2026, 11, 7, 3, 0), info=None):
    monkeypatch.setattr(module, "datetime", _frozen(at))
    clock = Clock()
    monkeypatch.setattr(module.time, "monotonic", clock.monotonic)
    sink = Sink()                           # Market Runtime accepts every event
    broker = module.ShioajiBrokerService(event_sink=sink, credential_service=MagicMock())
    reads = []

    def read(contract):
        reads.append(contract.code)
        if isinstance(broker.info, Exception):
            raise broker.info
        return broker.info

    broker.info = info if info is not None else _info()
    broker._api = SimpleNamespace(contracts=SimpleNamespace(info=read))
    broker._txf_contract = SimpleNamespace(code="TXFR1")
    recovery = []
    broker._txf_limits_recovery = SimpleNamespace(
        open=False, failed=lambda trigger, detail=None: recovery.append(("failed", trigger)),
        finish=lambda outcome, detail=None: recovery.append((outcome, None)))
    return broker, sink, reads, recovery, clock


def _info(reference=39652.0, update_date="2026/11/06", up=43617.0, down=35687.0):
    return SimpleNamespace(code="TXFR1", target_code="TXFK6", reference=reference, limit_up=up, limit_down=down,
                           update_date=update_date)


def _ns(at: datetime) -> int:
    return int(at.timestamp() * 1_000_000_000)


def test_the_nights_limits_are_published_for_its_trading_date_though_the_contract_is_dated_the_day_before(monkeypatch):
    broker, sink, reads, recovery, _ = _broker(monkeypatch)
    broker.note_txf_stated_reference(39652 * SCALE, _ns(datetime(2026, 11, 7, 2, 59)))
    broker._refresh_txf_limits()
    events = sink.events
    assert [(e.describes_trading_date, e.time_quality, e.event_type, e.data) for e in events] == [
        ("2026-11-09", "backend_clock", "reference", {"limit_up": 43617 * SCALE, "limit_down": 35687 * SCALE})]
    assert not {"trading_date", "session"} & set(events[0].as_dict()), "Market Runtime files it under both sessions"
    assert broker._txf_limits_summary()["state"] == "PUBLISHED"
    assert broker._txf_limits_summary()["contract"] == "TXFK6"
    broker._refresh_txf_limits()
    assert len(sink.events) == 1 and reads == ["TXFR1"], "published once per trading date, read once"
    assert recovery == [("succeeded", None)]


def test_nothing_is_read_before_a_quote_of_the_trading_date_states_its_reference(monkeypatch):
    # 15:00:02: the night of 11-09 has opened, the newest quote is still the day's (13:44, trading date 11-06).
    broker, sink, reads, recovery, _ = _broker(monkeypatch, at=datetime(2026, 11, 6, 15, 0, 2))
    broker._refresh_txf_limits()
    broker.note_txf_stated_reference(39500 * SCALE, _ns(datetime(2026, 11, 6, 13, 44)))
    broker._refresh_txf_limits()
    assert reads == [] and len(sink.events) == 0 and recovery == []
    assert broker._txf_limits_summary() == {"state": "WAITING_QUOTE", "trading_date": "2026-11-09", "refetch_open": False}


def test_a_closure_with_no_quote_publishes_nothing(monkeypatch):
    broker, sink, reads, _, _ = _broker(monkeypatch, at=datetime(2026, 10, 9, 10, 0), info=_info(update_date="2026/10/08"))
    broker._refresh_txf_limits()
    assert len(sink.events) == 0 and reads == []


def test_a_contract_not_updated_yet_is_read_again_and_its_wait_recorded(monkeypatch, caplog):
    broker, sink, reads, recovery, clock = _broker(monkeypatch, info=_info(reference=39500.0, up=43450.0, down=35550.0,
                                                                          update_date="2026/11/05"))
    broker.note_txf_stated_reference(39652 * SCALE, _ns(datetime(2026, 11, 7, 2, 59)))
    broker._refresh_txf_limits()
    broker._refresh_txf_limits()
    assert len(sink.events) == 0 and reads == ["TXFR1"], "asked again only after the retry interval"
    state = broker._txf_limits_summary()
    assert (state["state"], state["contract_reference"], state["stated_reference"]) == (
        "REFERENCE_MISMATCH", 39500 * SCALE, 39652 * SCALE)
    assert recovery == [("failed", "txf_limits_not_updated")]
    assert "TXF limits REFERENCE_MISMATCH" in caplog.text
    broker.info = _info()
    clock.t += module.ShioajiBrokerService.TXF_LIMITS_RETRY_S
    broker._refresh_txf_limits()
    assert sink.events[-1].describes_trading_date == "2026-11-09"
    assert recovery[-1] == ("succeeded", None)


def test_a_failed_read_is_recorded_and_never_raised_into_the_session_loop(monkeypatch):
    broker, sink, _, recovery, _ = _broker(monkeypatch)
    broker.info = RuntimeError("timeout")
    broker.note_txf_stated_reference(39652 * SCALE, _ns(datetime(2026, 11, 7, 2, 59)))
    broker._refresh_txf_limits()
    assert broker._txf_limits_summary()["state"] == "UNAVAILABLE"
    assert recovery == [("failed", "txf_limits_unavailable")] and len(sink.events) == 0


def test_limits_the_ingress_refused_are_published_again_and_keep_the_reference_recovery_open(monkeypatch):
    broker, sink, _, recovery, clock = _broker(monkeypatch)
    outcomes = []
    broker._reference_publish_recovery = SimpleNamespace(
        failed=lambda trigger, detail=None: outcomes.append(("failed", tuple(detail.get("pending", ())))),
        finish=lambda outcome, detail=None: outcomes.append((outcome, ())))
    broker.note_txf_stated_reference(39652 * SCALE, _ns(datetime(2026, 11, 7, 2, 59)))
    sink.queued = False                               # the queue did not take it (full)
    broker._refresh_txf_limits()
    assert outcomes == [("failed", ("limits:TXFK6:2026-11-09",))]
    assert broker._txf_limits_summary()["state"] == "PUBLISH_FAILED" and recovery == []
    sink.queued = True
    clock.t += module.ShioajiBrokerService.TXF_LIMITS_RETRY_S
    broker._refresh_txf_limits()
    assert outcomes[-1] == ("succeeded", ()), "closed once the refused limits are in"
    clock.t += module.ShioajiBrokerService.TXF_LIMITS_RETRY_S
    broker._refresh_txf_limits()
    assert len(sink.events) == 1, "the queue never took the first: one sent, nothing more once accepted"


def test_limits_market_runtime_refused_are_not_published_and_are_sent_again(monkeypatch, caplog):
    # 11-23 night: the queue took the limits, Market Runtime refused them (a stale sequence), and the provider -- on
    # the queue's word -- said PUBLISHED and never sent them again: 漲停 was never shown.
    broker, sink, _, recovery, clock = _broker(monkeypatch)
    outcomes = []
    broker._reference_publish_recovery = SimpleNamespace(
        failed=lambda trigger, detail=None: outcomes.append(("failed", tuple(detail.get("pending", ())))),
        finish=lambda outcome, detail=None: outcomes.append((outcome, ())))
    broker.note_txf_stated_reference(39652 * SCALE, _ns(datetime(2026, 11, 7, 2, 59)))
    sink.verdict = None
    broker._refresh_txf_limits()
    assert broker._txf_limits_summary()["state"] == "SENT", "queued is not published"
    clock.t += module.ShioajiBrokerService.TXF_LIMITS_RETRY_S
    broker._refresh_txf_limits()
    assert len(sink.events) == 1, "not sent again while Market Runtime's answer is pending"
    sink.waiting.pop()(False, "RejectedSequence")
    state = broker._txf_limits_summary()
    assert state["state"] == "PUBLISH_FAILED" and "RejectedSequence" in state["reason"]
    assert outcomes == [("failed", ("limits:TXFK6:2026-11-09",))]
    assert "TXF limits PUBLISH_FAILED" in caplog.text, "the refusal is logged"
    sink.verdict = (True, None)
    clock.t += module.ShioajiBrokerService.TXF_LIMITS_RETRY_S
    broker._refresh_txf_limits()
    assert len(sink.events) == 2, "sent again"
    assert broker._txf_limits_summary()["state"] == "PUBLISHED"
    assert outcomes[-1] == ("succeeded", ()) and recovery[-1] == ("succeeded", None)


def test_a_real_futures_quote_hands_its_stated_reference_to_the_session(monkeypatch):
    monkeypatch.setattr(callback, "exchange_timestamp_ns", lambda value: 1_794_000_000_000_000_000)
    broker, sink, _, _, _ = _broker(monkeypatch)
    quote = SimpleNamespace(code="TXFK6", close=40334, price_chg=682, open=39742, high=42196, low=39129, total_volume=68049,
                            total_amount=0, simtrade=False, volume=1, amount=0, avg_price=40292)
    broker.thin_callback.on_futures_quote("TAIFEX", quote)
    assert broker._txf_stated_reference == (39652 * SCALE, 1_794_000_000_000_000_000)
    trial = SimpleNamespace(**{**vars(quote), "simtrade": True, "close": 40000})
    broker.thin_callback.on_futures_quote("TAIFEX", trial)
    assert broker._txf_stated_reference == (39652 * SCALE, 1_794_000_000_000_000_000), "a 試撮 quote states none"
