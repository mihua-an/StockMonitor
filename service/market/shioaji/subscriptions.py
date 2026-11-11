from __future__ import annotations

from dataclasses import dataclass
from threading import RLock
from typing import Any, Iterable, Mapping

from service.market.shared.provider import ProviderSubscriptionManager
from service.market.shared.provider_contract import ProviderCapabilities, SHIOAJI_CAPABILITIES, SHIOAJI_LANE_KINDS, SubscriptionPlan


# The one owner of every desired stream: Market Runtime's plan. The product pages, holdings,
# workspace, focus and market context are not owner sets here: nothing is subscribed beside the plan.
PLAN = "PLAN"

# The broker's code of the TAIEX index (Market Runtime names it "TAIEX").
TAIEX_CODE = "IX0001"
# The market Market Runtime stores a stream's events under, per broker security type.
_WAL_MARKETS = {"STK": "STK", "IND": "IDX", "FUT": "FUT"}


def wal_instrument(security_type: str, code: str) -> tuple[str, str] | None:
    """(market, code) Market Runtime stores a stream's events under -- IX0001 is named "TAIEX", every other instrument
    by its own code -- or None for a security type it stores nothing of."""
    market = _WAL_MARKETS.get(str(security_type).upper())
    if market is None:
        return None
    return market, ("TAIEX" if market == "IDX" and code == TAIEX_CODE else str(code).strip().upper())


class SubscriptionCapacityError(RuntimeError):
    pass


@dataclass(frozen=True, order=True)
class StreamIdentity:
    security_type: str
    code: str
    quote_type: str
    intraday_odd: bool = False

    def __post_init__(self) -> None:
        object.__setattr__(self, "security_type", str(self.security_type or "").upper())
        object.__setattr__(self, "code", str(self.code or "").strip().upper())
        object.__setattr__(self, "quote_type", str(self.quote_type or "").strip())
        object.__setattr__(self, "intraday_odd", bool(self.intraday_odd))
        if not self.security_type or not self.code or not self.quote_type:
            raise ValueError("subscription stream identity is incomplete")

    @property
    def key(self) -> str:
        if self.security_type == "STK":
            odd = "odd" if self.intraday_odd else "regular"
            return f"{self.security_type}:{self.code}:{self.quote_type}:{odd}"
        return f"{self.security_type}:{self.code}:{self.quote_type}"

    def as_dict(self) -> dict[str, object]:
        return {
            "key": self.key,
            "security_type": self.security_type,
            "code": self.code,
            "quote_type": self.quote_type,
            "intraday_odd": self.intraday_odd,
        }


def regular_stock_lane(streams: dict[str, dict[str, Any]], code: str, lane: str) -> dict[str, Any]:
    """A stock's regular-session (not odd-lot) stream state for one lane, from the broker status' subscription_streams."""
    return dict(streams.get(StreamIdentity("STK", code, lane).key) or {})


class ShioajiSubscriptionManager(ProviderSubscriptionManager):
    """The streams Market Runtime's plan asks for (desired truth only).

    Each plan item names an instrument as Market Runtime does -- (market, code) -- and is resolved through the
    provider capabilities: one this provider cannot carry is refused with a reason, never guessed
    into a stock. Broker-side requested/confirmed state stays session-scoped in :class:`ShioajiBrokerService`.
    """

    # Shioaji counts subscriptions per connection (one api.login() session), Tick and BidAsk of a stock as two;
    # 200 is the ordinary account's limit (some accounts are raised by the broker). Past it the broker answers
    # "Max Num Subscriptions Exceeded".
    DEFAULT_LIMIT = 200

    def __init__(self, *, subscription_limit: int = DEFAULT_LIMIT, capabilities: ProviderCapabilities | None = None,
                 futures_table: Any = None) -> None:
        """futures_table(): the futures contract table (service/market/reference/futures_contracts.py) a dated futures
        month must be listed in to be planned."""
        super().__init__("shioaji")
        self.subscription_limit = max(1, int(subscription_limit))
        self.capabilities = capabilities or SHIOAJI_CAPABILITIES
        if futures_table is None:
            from service.market.reference.futures_contracts import current_table as futures_table
        self.futures_table = futures_table
        if self.capabilities.provider != self.provider:
            raise ValueError("capability provider does not match subscription manager provider")
        self._lock = RLock()
        self._identities: dict[str, StreamIdentity] = {}
        # (market, code) as Market Runtime names it -> the streams it maps to.
        self._instruments: dict[tuple[str, str], tuple[StreamIdentity, ...]] = {}

    def subscription_plan(self, security_type: str, code: str) -> SubscriptionPlan:
        return self.capabilities.plan_for(security_type, code)

    def streams_for(self, security_type: str, code: str) -> tuple[StreamIdentity, ...]:
        plan = self.subscription_plan(security_type, code)
        return tuple(StreamIdentity(plan.security_type, plan.logical_code, lane, False) for lane in plan.lanes)

    def is_allowed(self, identity: StreamIdentity) -> bool:
        return self.subscription_plan(identity.security_type, identity.code).allows(identity.quote_type)

    def stock_streams(self, code: str) -> tuple[StreamIdentity, ...]:
        return self.streams_for("STK", code)

    def resolve(self, market: str, code: str) -> tuple[StreamIdentity, ...]:
        """The streams of an instrument named as Market Runtime names it; () when this provider cannot carry it."""
        plan = self.capabilities.resolve(market, code)
        if plan is None:
            return ()
        # A dated futures month is planned only when the contract table lists it (TXFR1 has its own rule).
        if plan.security_type == "FUT" and not plan.fixed_context and plan.logical_code not in self.futures_table().by_symbol:
            return ()
        return tuple(StreamIdentity(plan.security_type, plan.logical_code, lane, False) for lane in plan.lanes)

    def set_subscription_limit(self, limit: int) -> None:
        """A new stream limit (設定 → 永豐行情連線). Taken under the plan's lock: a plan being laid out finishes on the
        limit it started with, and the next one uses this."""
        with self._lock:
            self.subscription_limit = max(1, int(limit))

    def replace_plan(self, items: Iterable[Mapping[str, Any]]) -> dict[tuple[str, str], str]:
        """Make the plan's instruments the desired streams: of each, the lanes of the kinds the plan asks for (a stock
        with its 五檔 off takes its Tick alone). Returns the items refused, with the reason: UNSUPPORTED_INSTRUMENT (no
        capability), UNSUPPORTED_KINDS (none of the kinds is one of its lanes) or QUOTA_EXCEEDED (past the
        subscription limit, in plan order). The whole plan is laid out and committed under the lock, against one
        reading of the limit."""
        items_seen = list(items)
        with self._lock:
            limit = self.subscription_limit
            refused: dict[tuple[str, str], str] = {}
            instruments: dict[tuple[str, str], tuple[StreamIdentity, ...]] = {}
            streams = 0
            for item in items_seen:
                key = (str(item.get("market") or "").strip().upper(), str(item.get("code") or "").strip().upper())
                if not key[1] or key in instruments or key in refused:
                    continue
                resolved = self.resolve(*key)
                if resolved and "kinds" in item:
                    kinds = {str(k).strip().lower() for k in item.get("kinds") or ()}
                    resolved = tuple(i for i in resolved if SHIOAJI_LANE_KINDS[i.quote_type] in kinds)
                    if not resolved:
                        refused[key] = "UNSUPPORTED_KINDS"
                        continue
                if not resolved:
                    refused[key] = "UNSUPPORTED_INSTRUMENT"
                elif streams + len(resolved) > limit:
                    refused[key] = "QUOTA_EXCEEDED"
                else:
                    instruments[key] = resolved
                    streams += len(resolved)
            self._instruments = instruments
            self._identities = {identity.key: identity for resolved in instruments.values() for identity in resolved}
        return refused

    def planned_instruments(self) -> dict[tuple[str, str], tuple[StreamIdentity, ...]]:
        with self._lock:
            return dict(self._instruments)

    def desired_identities(self) -> tuple[StreamIdentity, ...]:
        with self._lock:
            return tuple(sorted(self._identities.values(), key=lambda item: item.key))

    def owners_for(self, identity_or_key: StreamIdentity | str) -> tuple[str, ...]:
        key = identity_or_key.key if isinstance(identity_or_key, StreamIdentity) else str(identity_or_key)
        with self._lock:
            return (PLAN,) if key in self._identities else ()

    def contains(self, identity: StreamIdentity) -> bool:
        with self._lock:
            return identity.key in self._identities

    def capacity_snapshot(self) -> dict[str, object]:
        with self._lock:
            active = len(self._identities)
            return {
                "subscription_limit": self.subscription_limit,
                "active_subscription_count": active,
                "planned_instrument_count": len(self._instruments),
                "available_subscription_slots": max(0, self.subscription_limit - active),
            }

    def snapshot(self) -> dict[str, object]:
        with self._lock:
            streams = [{**identity.as_dict(), "owners": [PLAN]} for identity in sorted(self._identities.values(), key=lambda item: item.key)]
            plans = {
                "stock": self.subscription_plan("STK", "*").as_dict(),
                "taiex": self.subscription_plan("IND", "IX0001").as_dict(),
                "txf": self.subscription_plan("FUT", "TXFR1").as_dict(),
            }
            return {"provider": self.provider, **self.capacity_snapshot(), "plans": plans, "streams": streams}
