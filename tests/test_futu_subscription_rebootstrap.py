from __future__ import annotations

from types import SimpleNamespace

from service.market.futu.subscriptions import FutuSubscriptionManager


class _Sdk:
    SubType = SimpleNamespace(
        QUOTE="QUOTE",
        RT_DATA="RT_DATA",
        TICKER="TICKER",
        ORDER_BOOK="ORDER_BOOK",
    )


def test_rebootstrap_preserves_desired_symbols_but_clears_session_confirmations() -> None:
    manager = FutuSubscriptionManager(minimum_subscription_seconds=0)
    manager.observe_quota({"total_used": 0, "remain": 1000, "own_used": 0})  # OpenD's quota, read before a context subscribes
    manager.replace_plan([{"market": "US", "code": "US.AAPL", "kinds": ["quote", "trade", "orderbook"]}])
    desired_before = manager.desired_pairs()
    calls: list[tuple[str, str]] = []

    manager.sync(
        context=object(),
        sdk=_Sdk,
        session_current=lambda: True, call=lambda _context, operation, codes, subtypes, **_kwargs: calls.extend(
            (code, str(subtype)) for code in codes for subtype in subtypes
        ),
        session_all="ALL",
    )
    assert manager.confirmed_pairs == desired_before

    manager.reset_session()

    assert manager.desired_pairs() == desired_before
    assert manager.confirmed_pairs == set()
    assert manager.subscription_objects == {}
    assert [row["code"] for row in manager.snapshot()["planned"]] == ["US.AAPL"]


def test_rebootstrap_sync_recreates_each_pair_once(tmp_path) -> None:
    manager = FutuSubscriptionManager(minimum_subscription_seconds=0)
    manager.observe_quota({"total_used": 0, "remain": 1000, "own_used": 0})  # OpenD's quota, read before a context subscribes
    manager.replace_plan([{"market": "US", "code": "US.AAPL", "kinds": ["quote", "trade"]}])
    calls: list[tuple[str, str]] = []
    call = lambda _context, operation, codes, subtypes, **_kwargs: calls.extend(
        (code, str(subtype)) for code in codes for subtype in subtypes
    )

    manager.sync(object(), _Sdk, session_current=lambda: True, call=call, session_all="ALL")
    first_count = len(calls)
    manager.sync(object(), _Sdk, session_current=lambda: True, call=call, session_all="ALL")

    assert first_count == len(manager.desired_pairs())
    assert len(calls) == first_count

    manager.reset_session()
    manager.observe_quota({"total_used": 0, "remain": 1000, "own_used": 0})  # the new context's quota
    manager.sync(object(), _Sdk, session_current=lambda: True, call=call, session_all="ALL")
    assert len(calls) == first_count * 2
