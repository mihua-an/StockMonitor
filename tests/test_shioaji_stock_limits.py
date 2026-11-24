"""Every subscribed stock's 漲停/跌停 reaches Market Runtime.

A Shioaji stock tick carries no limit prices and only TXFR1 published them, so no panel could mark a limit
price 紅底白字. The contract's limits are published as a reference event, dated by the contract's own
update_date: a contract still dated yesterday is not published under today.
"""
from __future__ import annotations

import threading
from types import SimpleNamespace

from service.market.shioaji.session import ShioajiBrokerService
from service.platform.remediation import Recovery


class VerdictSink:
    """The provider's queue to Market Runtime: `queued` says whether the queue takes an event, `verdict` what Market
    Runtime answers it -- (True, None), (False, reason), or None for no answer yet (kept in `waiting`)."""

    def __init__(self, published, *, queued=True, verdict=(True, None)):
        self.published, self.queued, self.verdict, self.waiting = published, queued, verdict, []

    def publish_with_verdict(self, event, on_verdict):
        if not self.queued:
            return False
        self.published.append(event)
        if self.verdict is None:
            self.waiting.append(on_verdict)
        else:
            on_verdict(*self.verdict)   # the sender may answer before publish returns
        return True


def service(info_by_code, published):
    svc = ShioajiBrokerService.__new__(ShioajiBrokerService)
    svc._lock = threading.RLock()
    svc._running = threading.Event(); svc._running.set()
    svc._reference_stream_seq = {}
    svc._stock_limits_published = {}
    svc._stock_limits_in_flight = {}
    svc._stock_limits_attempted = {}
    svc._stock_limits_worker = None
    svc._stock_limits_state = {}
    svc._stock_limits_recovery = Recovery(component="stock_limits", mechanism_id="provider.metadata_refetch")
    svc._session_generation = 3
    svc.price_scale = 10_000
    svc._api = SimpleNamespace(contracts=SimpleNamespace(info=lambda contract: info_by_code[contract.code]))
    svc.event_sink = VerdictSink(published)
    return svc


def test_today_limits_are_published_and_a_stale_contract_is_not():
    published = []
    info = {
        "3481": SimpleNamespace(update_date="2026/10/01", limit_up=54.7, limit_down=44.8),
        "2330": SimpleNamespace(update_date="2026/09/30", limit_up=1166.0, limit_down=954.0),
    }
    svc = service(info, published)
    contracts = {code: SimpleNamespace(code=code) for code in info}
    svc._publish_stock_limits(["2330", "3481"], contracts, "2026-10-01")
    assert [(e.code, e.describes_trading_date, e.event_type) for e in published] == [("3481", "2026-10-01", "reference")]
    assert published[0].data == {"limit_up": 547_000, "limit_down": 448_000}
    assert svc._stock_limits_published == {"3481": "2026-10-01"}
    assert set(svc._stock_limits_attempted) == {"2330", "3481"}, "the stale one is retried later, not forgotten"
    # Each code's state is stated; the refetch of the stale one is one open, recorded recovery.
    assert svc._stock_limits_state["2330"] == {"state": "NOT_UPDATED", "dated": "2026-09-30"}
    assert svc._stock_limits_state["3481"]["state"] == "PUBLISHED"
    assert svc._stock_limits_recovery.open
    info["2330"] = SimpleNamespace(update_date="2026/10/01", limit_up=1166.0, limit_down=954.0)
    svc._publish_stock_limits(["2330"], contracts, "2026-10-01")
    assert not svc._stock_limits_recovery.open, "finished once every code is published"


def test_a_limit_the_queue_did_not_take_is_not_published():
    """The provider's queue refusing the reference keeps the code waiting and the recovery open."""
    published = []
    info = {"3481": SimpleNamespace(update_date="2026/10/01", limit_up=54.7, limit_down=44.8)}
    svc = service(info, published)
    svc.event_sink = VerdictSink(published, queued=False)
    contracts = {"3481": SimpleNamespace(code="3481")}
    svc._publish_stock_limits(["3481"], contracts, "2026-10-01")
    assert svc._stock_limits_published == {}
    assert svc._stock_limits_state["3481"]["state"] == "PUBLISH_FAILED"
    assert svc._stock_limits_recovery.open
    svc.event_sink = VerdictSink(published)
    svc._publish_stock_limits(["3481"], contracts, "2026-10-01")
    assert svc._stock_limits_published == {"3481": "2026-10-01"}
    assert not svc._stock_limits_recovery.open


def test_a_limit_market_runtime_refused_is_not_published_and_is_sent_again():
    """11-23: the queue took the reference and Market Runtime refused it (a stale sequence); the provider marked it
    published on the queue's word, so it never sent it again and its status said PUBLISHED. Only Market Runtime's
    acceptance publishes it now."""
    published = []
    info = {"3481": SimpleNamespace(update_date="2026/10/01", limit_up=54.7, limit_down=44.8)}
    svc = service(info, published)
    contracts = {"3481": SimpleNamespace(code="3481")}
    svc.event_sink = VerdictSink(published, verdict=None)
    svc._publish_stock_limits(["3481"], contracts, "2026-10-01")
    assert svc._stock_limits_state["3481"] == {"state": "SENT", "dated": "2026-10-01"}, "queued is not published"
    assert not svc._stock_limits_recovery.open, "nothing to judge before Market Runtime answers"
    svc.event_sink.waiting.pop()(False, "RejectedSequence")
    assert svc._stock_limits_published == {}
    assert svc._stock_limits_state["3481"]["state"] == "PUBLISH_FAILED"
    assert "RejectedSequence" in svc._stock_limits_state["3481"]["reason"]
    assert svc._stock_limits_recovery.open
    svc.event_sink = VerdictSink(published)
    svc._publish_stock_limits(["3481"], contracts, "2026-10-01")
    assert len(published) == 2, "sent again"
    assert svc._stock_limits_published == {"3481": "2026-10-01"}
    assert not svc._stock_limits_recovery.open


def test_waiting_for_a_session_not_begun_is_the_schedule_not_a_recovery(monkeypatch):
    # From midnight (and all weekend) every pass found the contracts still dated yesterday: the broker publishes a
    # session's limits with its daily contract update (~07:45). Each night opened a provider.metadata_refetch that
    # ran until the morning, or until Monday (10-10..10-14).
    from datetime import datetime

    from service.market.lifecycle.resolver import TAIPEI

    at = lambda text: datetime.fromisoformat(text).replace(tzinfo=TAIPEI)  # noqa: E731
    begun = ShioajiBrokerService._stock_session_begun
    assert begun(today="2026-10-14", now=at("2026-10-14T00:00")) is False, "midnight: the day's limits are not out yet"
    assert begun(today="2026-10-14", now=at("2026-10-14T08:29")) is False
    assert begun(today="2026-10-14", now=at("2026-10-14T08:30")) is True, "from the pre-open the session needs them"
    assert begun(today="2026-10-11", now=at("2026-10-11T12:00")) is False, "a Sunday has no session"
    assert begun(today="2026-10-14", now=at("2026-10-15T01:00")) is True

    published = []
    info = {"2330": SimpleNamespace(update_date="2026/10/13", limit_up=1166.0, limit_down=954.0)}
    svc = service(info, published)
    contracts = {"2330": SimpleNamespace(code="2330")}
    monkeypatch.setattr(ShioajiBrokerService, "_stock_session_begun", staticmethod(lambda *, today, now=None: False))
    svc._publish_stock_limits(["2330"], contracts, "2026-10-14")
    assert svc._stock_limits_state["2330"] == {"state": "NOT_UPDATED", "dated": "2026-10-13"}, "still shown as waiting"
    assert not svc._stock_limits_recovery.open, "no recovery before the session begins"
    monkeypatch.setattr(ShioajiBrokerService, "_stock_session_begun", staticmethod(lambda *, today, now=None: True))
    svc._publish_stock_limits(["2330"], contracts, "2026-10-14")
    assert svc._stock_limits_recovery.open, "a begun session without its limits is a recorded recovery"


def test_limits_after_the_seal_belong_to_the_next_session(monkeypatch):
    # After the 14:40 seal of 10-28's day session, every reconnect (15:13..23:42, 13 times) published the 76 stocks'
    # limits again under 10-28 DAY: the contracts were still dated 10-28 and the pass dated itself by the wall clock.
    # A sealed partition takes no more events; after the seal the limits wanted are the next session's.
    from datetime import datetime

    import service.market.shioaji.session as session_module
    from service.market.lifecycle.resolver import TAIPEI

    at = lambda text: datetime.fromisoformat(text).replace(tzinfo=TAIPEI)  # noqa: E731
    business = ShioajiBrokerService._stock_business_date
    assert business(at("2026-10-28T08:00")) == "2026-10-28"
    assert business(at("2026-10-28T14:39")) == "2026-10-28", "held open for the after-hours print"
    assert business(at("2026-10-28T14:40")) == "2026-10-29", "sealed: the next session's"
    assert business(at("2026-10-30T15:13")) == "2026-11-02", "Friday evening: Monday's"
    assert business(at("2026-10-31T12:00")) == "2026-11-02", "a Saturday: Monday's"

    after_seal = at("2026-10-28T15:13")

    class Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return after_seal.astimezone(tz) if tz else after_seal.replace(tzinfo=None)

    monkeypatch.setattr(session_module, "datetime", Frozen)
    monkeypatch.setattr(session_module.time, "time_ns", lambda: int(after_seal.timestamp() * 1_000_000_000))
    published = []
    info = {"2330": SimpleNamespace(update_date="2026/10/28", limit_up=1166.0, limit_down=954.0)}
    svc = service(info, published)
    svc._stock_contracts = {"2330": SimpleNamespace(code="2330")}
    svc._active_subscription_keys = {"STK:2330:tick"}
    svc._refresh_stock_limits()
    svc._stock_limits_worker.join(5)
    assert published == [], "nothing goes into the sealed 10-28 session"
    assert svc._stock_limits_state["2330"] == {"state": "NOT_UPDATED", "dated": "2026-10-28"}
    assert not svc._stock_limits_recovery.open, "waiting for 10-29's limits before its pre-open is the schedule"
