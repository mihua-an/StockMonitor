from __future__ import annotations

import json
import time
from datetime import datetime
from service.platform.project_root import project_root
from dataclasses import dataclass
from functools import cached_property
from typing import Any, Callable, Iterable, Mapping


class ProviderContractError(ValueError):
    """config/provider_contract.json is unusable; `code` is the same classification the Node loader reports."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code


SUPPORTED_PROVIDER_CONTRACT_VERSIONS = frozenset({1})


def validate_provider_contract(contract: Any) -> dict[str, Any]:
    """Every field is required and checked; nothing is defaulted (config/js/provider_contract.js applies the same
    rules, tests/test_provider_contract_parity.py holds both to the same cases)."""
    if not isinstance(contract, Mapping):
        raise ProviderContractError("CONTRACT_NOT_OBJECT")
    version = contract.get("contract_version")
    if type(version) is not int or version not in SUPPORTED_PROVIDER_CONTRACT_VERSIONS:
        raise ProviderContractError("CONTRACT_VERSION_UNSUPPORTED", repr(version))
    canonical = contract.get("canonical_sources")
    if (not isinstance(canonical, list) or not canonical
            or not all(isinstance(x, str) and x and x == x.lower() for x in canonical)
            or len(set(canonical)) != len(canonical)):
        raise ProviderContractError("CANONICAL_SOURCES_INVALID", repr(canonical))
    default = contract.get("default_source")
    if not isinstance(default, str) or default not in canonical:
        raise ProviderContractError("DEFAULT_SOURCE_INVALID", repr(default))
    return dict(contract)


# The cross-language contract lives in config/, next to system_contract.json.
_CONTRACT = validate_provider_contract(
    json.loads((project_root() / "config" / "provider_contract.json").read_text(encoding="utf-8")))
PROVIDER_STATUS_CONTRACT_VERSION = int(_CONTRACT["contract_version"])
CANONICAL_PROVIDER_SOURCES = frozenset(str(item) for item in _CONTRACT["canonical_sources"])
_DEFAULT_PROVIDER_SOURCE = str(_CONTRACT["default_source"])


def normalize_provider_source(raw_source: Any = "") -> str:
    """A provider source read at an I/O boundary: a canonical name, or the default when none is given."""

    source = str(raw_source or "").strip().lower()
    if not source:
        return _DEFAULT_PROVIDER_SOURCE
    if source not in CANONICAL_PROVIDER_SOURCES:
        raise ProviderContractError("SOURCE_UNKNOWN", repr(raw_source))
    return source


# --- Lane staleness tiers ---------------------------------------------------
#
# Every lane can go stale; none is exempt.  Two tiers, per
# the product ruling: high-frequency lanes ~30s, ordinary stocks ~120s, and a
# closed market is ``IDLE`` rather than stale (see ``expected_active`` in
# :func:`provider_lane_freshness`).  The split is derived from the capability
# contract below, never from a hardcoded symbol list -- see
# :func:`lane_stale_after_seconds` for the two rules and their evidence.
HIGH_FREQUENCY_STALE_SECONDS = 30.0
ORDINARY_STALE_SECONDS = 120.0


def provider_link_online(*, connected: bool, worker_alive: bool = True) -> bool:
    """Is the broker link up: logged in (``connected``) with its SDK worker running."""
    return bool(connected) and bool(worker_alive)


def provider_readiness(
    *,
    provider: str,
    connected: bool,
    worker_alive: bool = True,
    market_data_ready: bool = False,
    focused_market_ready: bool = False,
    focused_book_ready: bool = False,
    canonical_ready: bool = True,
    market_closed: bool = False,
    waiting_session: bool = False,
    stale_reason: str | None = None,
) -> dict[str, Any]:
    """Build the provider-neutral connection and data-readiness contract."""

    online = provider_link_online(connected=connected, worker_alive=worker_alive)
    ready = bool(online and market_data_ready and canonical_ready)
    reason = str(stale_reason or "").strip().upper() or None
    if not online:
        state = "DISCONNECTED"
    elif market_closed:
        state = "MARKET_CLOSED"
    elif reason:
        state = "STALE"
    elif waiting_session or not ready:
        state = "STARTING"
    else:
        state = "READY"
    return {
        "contract_version": PROVIDER_STATUS_CONTRACT_VERSION,
        "provider": normalize_provider_source(provider),
        "state": state,
        "connected": online,
        "market_data_ready": ready,
        "focused_market_ready": bool(online and focused_market_ready and canonical_ready),
        "focused_book_ready": bool(online and focused_book_ready and canonical_ready),
        "canonical_ready": bool(canonical_ready),
        "stale": state == "STALE",
        "reason": reason,
    }


def provider_lane_freshness(
    *,
    provider: str,
    code: str,
    lane: str,
    desired: bool,
    confirmed: bool,
    last_event_at: str | None = None,
    age_seconds: float | None = None,
    expected_active: bool = True,
    stale_after_seconds: float = ORDINARY_STALE_SECONDS,
    reported_state: str | None = None,
) -> dict[str, Any]:
    """Normalize provider-specific subscription/callback health per data lane.

    Evaluation order is the contract, and it is deliberately evidence-first:

    1. ``desired`` -- nothing is claimed about a lane nobody asked for.
    2. ``expected_active`` -- a closed/quiesced session is ``IDLE``, never
       ``SUBSCRIPTION_PENDING`` and never ``STALE``.  Silence is correct then.
    3. Delivery evidence.  ``last_event_at`` is the authority from here on:

       * no evidence + not confirmed -> ``SUBSCRIPTION_PENDING`` (never started)
       * no evidence + confirmed     -> ``CONFIRMED_AWAITING_EVENT``
       * evidence, aged out          -> ``STALE`` (started, then stopped)
       * evidence, fresh             -> ``HEALTHY``

    ``confirmed`` is checked only in the no-evidence case.  Testing it before
    the age test would make "never started" and "started then stopped" the same
    state and suppress staleness for a lane dropped from ``confirmed_pairs`` by
    a failing resubscribe, which keeps its counters.  A lane that has ever
    delivered can never fall back to "pending"; that is what makes the two
    distinguishable.
    """
    state = str(reported_state or "").strip().upper()
    if not desired:
        state = "NOT_DESIRED"
    elif not expected_active:
        state = "IDLE"
    elif not last_event_at:
        state = "CONFIRMED_AWAITING_EVENT" if confirmed else "SUBSCRIPTION_PENDING"
    elif age_seconds is not None and age_seconds > max(0.1, float(stale_after_seconds)):
        state = "STALE"
    elif state not in {"HEALTHY", "STALE"}:
        state = "HEALTHY"
    return {
        "contract_version": PROVIDER_STATUS_CONTRACT_VERSION,
        "provider": normalize_provider_source(provider),
        "code": str(code or "").strip().upper(),
        "lane": str(lane or "").strip(),
        "state": state,
        "desired": bool(desired),
        "confirmed": bool(confirmed),
        "expected_active": bool(expected_active),
        "last_event_at": last_event_at or None,
        "age_seconds": round(max(0.0, float(age_seconds)), 3) if age_seconds is not None else None,
        "stale": state == "STALE",
    }


def lane_stale_after_seconds(plan: Any, lane: str) -> float:
    """Tier one lane's staleness budget from the capability contract.

    High frequency (:data:`HIGH_FREQUENCY_STALE_SECONDS`):

    * ``plan.fixed_context`` instruments -- the two session-pinned quote lanes,
      Shioaji ``IND/IX0001`` (TAIEX) and ``FUT/TXFR1``.  ``fixed_context=True``
      is set on exactly those two rules in ``SHIOAJI_CAPABILITIES`` and on
      nothing else, so "index/futures" needs no symbol list here.
    * lanes a plan carries but does *not* expose to the watchlist, i.e.
      ``lane in plan.lanes and lane not in plan.watchlist_lanes``.  Today that
      is exactly Futu's ``ORDER_BOOK``: ``FUTU_CAPABILITIES`` gives US/CC
      ``("QUOTE", "RT_DATA", "TICKER", "ORDER_BOOK")`` but only the first three
      as ``watchlist_lanes``, because the order book is subscribed for the
      focused instrument alone.  A focused book is the fastest lane the app
      carries, and its silence is the one the user notices first.

    Ordinary (:data:`ORDINARY_STALE_SECONDS`): every lane an ordinary watchlist
    instrument carries -- Shioaji ``STK`` ``Tick``/``BidAsk`` and Futu
    ``QUOTE``/``RT_DATA``/``TICKER``.  Individual stocks trade in bursts with
    long legitimate gaps, so they get the wider budget.
    """

    lanes = tuple(getattr(plan, "lanes", ()) or ())
    watchlist_lanes = tuple(getattr(plan, "watchlist_lanes", ()) or ())
    normalized = str(lane or "").strip()
    if bool(getattr(plan, "fixed_context", False)):
        return HIGH_FREQUENCY_STALE_SECONDS
    if normalized in lanes and watchlist_lanes and normalized not in watchlist_lanes:
        return HIGH_FREQUENCY_STALE_SECONDS
    return ORDINARY_STALE_SECONDS


def lanes_market_data_ready(rows: Iterable[Mapping[str, Any]]) -> bool:
    """One readiness verdict over the one lane projection.

    Ready means: this provider owns at least one lane that is currently
    delivering or legitimately idle, and no lane it owns is stale.  Both halves
    read :func:`provider_lane_freshness` output only -- there is no second
    counter, and no caller re-derives health from raw subscription state.
    """

    materialized = [dict(row) for row in rows]
    if not materialized:
        return False
    if any(bool(row.get("stale")) for row in materialized):
        return False
    return any(str(row.get("state") or "") in {"HEALTHY", "IDLE"} for row in materialized)


class LaneDeliveryEvidence:
    """What each provider lane has actually delivered -- the single authority.

    Written at the one choke point every market event passes (the provider's
    thin callback adapter).

    ``observe`` runs on the callback hot path: no lock, no ``datetime``, no I/O.
    Dict/list mutation under the GIL is sufficient here because every counter is
    per-lane and monotonic; a lost racing increment cannot invert a
    fresh/stale verdict.  All formatting happens in the reader methods.
    """

    __slots__ = ("_rows", "_last_monotonic", "_last_epoch_ns")

    def __init__(self) -> None:
        # key -> [last_monotonic, last_epoch_ns, count, code, lane, first_epoch_ns]
        self._rows: dict[str, list[Any]] = {}
        self._last_monotonic: float = 0.0
        self._last_epoch_ns: int = 0

    def observe(self, key: str, *, code: str = "", lane: str = "", epoch_ns: int = 0) -> None:
        now = time.monotonic()
        stamp = int(epoch_ns) or time.time_ns()
        row = self._rows.get(key)
        if row is None:
            self._rows[key] = [now, stamp, 1, str(code or ""), str(lane or ""), stamp]
        else:
            row[0] = now
            row[1] = stamp
            row[2] = int(row[2]) + 1
        self._last_monotonic = now
        self._last_epoch_ns = stamp

    @staticmethod
    def _iso(epoch_ns: int) -> str | None:
        if not epoch_ns:
            return None
        try:
            return datetime.fromtimestamp(int(epoch_ns) / 1_000_000_000).astimezone().isoformat(timespec="milliseconds")
        except (OSError, OverflowError, ValueError):  # not an error: an out-of-range epoch has no display time; the raw epoch is still reported
            return None

    def keys(self) -> tuple[str, ...]:
        return tuple(self._rows.keys())

    def first_event_at(self, key: str) -> str | None:
        row = self._rows.get(key)
        return self._iso(int(row[5])) if row else None

    def last_event_at(self, key: str) -> str | None:
        row = self._rows.get(key)
        return self._iso(int(row[1])) if row else None

    def age_seconds(self, key: str) -> float | None:
        row = self._rows.get(key)
        return max(0.0, time.monotonic() - float(row[0])) if row else None

    def count(self, key: str) -> int:
        row = self._rows.get(key)
        return int(row[2]) if row else 0

    def identity(self, key: str) -> tuple[str, str]:
        row = self._rows.get(key)
        return (str(row[3]), str(row[4])) if row else ("", "")

    def last_delivery_at(self) -> str | None:
        return self._iso(self._last_epoch_ns)

    def snapshot(self) -> dict[str, dict[str, Any]]:
        now = time.monotonic()
        return {
            key: {
                "code": str(row[3]),
                "lane": str(row[4]),
                "count": int(row[2]),
                "last_event_at": self._iso(int(row[1])),
                "age_seconds": round(max(0.0, now - float(row[0])), 3),
            }
            for key, row in list(self._rows.items())
        }


def _upper(value: Any) -> str:
    return str(value or "").strip().upper()


def _lane_sets(lanes: Iterable[Any], watchlist_lanes: Iterable[Any]) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """(lanes, watchlist lanes): stripped, deduplicated in order; no watchlist lanes means all lanes. The one place
    a capability rule and the plan built from it read their lanes, so the two can never disagree."""
    def clean(items: Iterable[Any]) -> tuple[str, ...]:
        return tuple(dict.fromkeys(text for item in items if (text := str(item or "").strip())))

    lane_set = clean(lanes)
    watchlist = clean(watchlist_lanes) or lane_set
    if any(lane not in lane_set for lane in watchlist):
        raise ValueError("watchlist lanes must be a subset of the lanes")
    return lane_set, watchlist


@dataclass(frozen=True)
class InstrumentCapabilities:
    """Provider capability truth for one logical instrument family.

    ``logical_code='*'`` is a provider rule wildcard (used for normal stocks).
    Runtime callers receive a concrete :class:`SubscriptionPlan`, so downstream
    code never needs to rediscover which lanes an instrument supports.
    """

    security_type: str
    logical_code: str
    session_market: str
    canonical_market: str
    lanes: tuple[str, ...]
    watchlist_lanes: tuple[str, ...] = ()
    fixed_context: bool = False
    live_trade_detail: bool = False
    live_orderbook: bool = False
    # The code Market Runtime names the instrument by, when it is not the broker's (IX0001 is "TAIEX"). Empty: the same.
    canonical_code: str = ""

    def __post_init__(self) -> None:
        for name in ("security_type", "logical_code", "session_market", "canonical_market"):
            object.__setattr__(self, name, _upper(getattr(self, name)))
        object.__setattr__(self, "canonical_code", _upper(self.canonical_code or self.logical_code))
        lanes, watchlist = _lane_sets(self.lanes, self.watchlist_lanes)
        object.__setattr__(self, "lanes", lanes)
        object.__setattr__(self, "watchlist_lanes", watchlist)
        if not self.security_type or not self.logical_code or not self.session_market or not self.canonical_market:
            raise ValueError("instrument capabilities are incomplete")


@dataclass(frozen=True)
class SubscriptionPlan:
    """Concrete provider subscription contract consumed by control + health paths."""

    provider: str
    security_type: str
    logical_code: str
    session_market: str
    canonical_market: str
    lanes: tuple[str, ...]
    watchlist_lanes: tuple[str, ...] = ()
    fixed_context: bool = False
    live_trade_detail: bool = False
    live_orderbook: bool = False

    def __post_init__(self) -> None:
        object.__setattr__(self, "provider", str(self.provider or "").strip().lower())
        for name in ("security_type", "logical_code", "session_market", "canonical_market"):
            object.__setattr__(self, name, _upper(getattr(self, name)))
        lanes, watchlist = _lane_sets(self.lanes, self.watchlist_lanes)
        object.__setattr__(self, "lanes", lanes)
        object.__setattr__(self, "watchlist_lanes", watchlist)
        if not self.provider or not self.security_type or not self.logical_code:
            raise ValueError("subscription plan is incomplete")

    @property
    def stream_count(self) -> int:
        return len(self.lanes)

    def allows(self, quote_type: str) -> bool:
        return str(quote_type or "").strip() in self.lanes

    def as_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "security_type": self.security_type,
            "logical_code": self.logical_code,
            "session_market": self.session_market,
            "canonical_market": self.canonical_market,
            "lanes": list(self.lanes),
            "watchlist_lanes": list(self.watchlist_lanes),
            "fixed_context": bool(self.fixed_context),
            "live_trade_detail": bool(self.live_trade_detail),
            "live_orderbook": bool(self.live_orderbook),
        }


class ProviderCapabilities:
    """Data-driven capability authority for one provider.

    Exact ``(security_type, logical_code)`` rules win over ``*`` family rules.
    Unsupported instruments deliberately produce an empty plan instead of
    silently inheriting a different market's subscription behavior.
    """

    def __init__(self, provider: str,
                 rules: Iterable[InstrumentCapabilities] | Callable[[], Iterable[InstrumentCapabilities]]) -> None:
        """`rules` may be a callable: rules built from a data file are then read at the first use, where a bad file
        is the caller's error, never an import failure."""
        normalized = str(provider or "").strip().lower()
        if not normalized:
            raise ValueError("provider is required")
        self.provider = normalized
        self._rule_source = rules if callable(rules) else tuple(rules)

    @cached_property
    def _rules(self) -> dict[tuple[str, str], InstrumentCapabilities]:
        source = self._rule_source
        out: dict[tuple[str, str], InstrumentCapabilities] = {}
        for rule in (source() if callable(source) else source):
            key = (rule.security_type, rule.logical_code)
            if key in out:
                raise ValueError(f"duplicate provider capability rule: {key}")
            out[key] = rule
        return out

    def plan_for(self, security_type: str, logical_code: str) -> SubscriptionPlan:
        security = str(security_type or "").strip().upper()
        code = str(logical_code or "").strip().upper()
        rule = self._rules.get((security, code)) or self._rules.get((security, "*"))
        if rule is None:
            return SubscriptionPlan(
                provider=self.provider,
                security_type=security,
                logical_code=code,
                session_market=security,
                canonical_market=security,
                lanes=(),
            )
        return SubscriptionPlan(
            provider=self.provider,
            security_type=security,
            logical_code=code,
            session_market=rule.session_market,
            canonical_market=rule.canonical_market,
            lanes=rule.lanes,
            watchlist_lanes=rule.watchlist_lanes,
            fixed_context=rule.fixed_context,
            live_trade_detail=rule.live_trade_detail,
            live_orderbook=rule.live_orderbook,
        )

    def allows(self, security_type: str, logical_code: str, quote_type: str) -> bool:
        return self.plan_for(security_type, logical_code).allows(quote_type)

    def resolve(self, market: str, code: str) -> SubscriptionPlan | None:
        """The plan for an instrument as Market Runtime names it -- (canonical market, canonical code) -- or None when
        this provider has no capability for it (identity is passed, never guessed from a code)."""
        market_u = str(market or "").strip().upper()
        code_u = str(code or "").strip().upper()
        exact = [r for r in self._rules.values() if r.canonical_market == market_u and r.logical_code != "*" and r.canonical_code == code_u]
        family = [r for r in self._rules.values() if r.canonical_market == market_u and r.logical_code == "*"]
        rule = (exact or family or [None])[0]
        if rule is None or not code_u:
            return None
        plan = self.plan_for(rule.security_type, rule.logical_code if rule.logical_code != "*" else code_u)
        return plan if plan.lanes else None

    def kinds_by_market(self, lane_kinds: Mapping[str, str]) -> dict[str, dict[str, int]]:
        """Per market (as Market Runtime names markets), the streams each kind of an instrument takes -- the most any
        rule of that market subscribes for it -- for a planner that counts the broker's streams. ``lane_kinds`` names
        the kind each lane carries (SHIOAJI_LANE_KINDS)."""
        out: dict[str, dict[str, int]] = {}
        for rule in self._rules.values():
            counts: dict[str, int] = {}
            for lane in rule.lanes:
                counts[lane_kinds[lane]] = counts.get(lane_kinds[lane], 0) + 1
            if not counts:
                continue
            market = out.setdefault(rule.canonical_market, {})
            for kind, n in counts.items():
                market[kind] = max(market.get(kind, 0), n)
        return {market: dict(sorted(kinds.items())) for market, kinds in sorted(out.items())}

    def most_lanes(self) -> int:
        """The most streams any one instrument takes (a stock's Tick + BidAsk), for a planner that counts instruments."""
        return max((len(rule.lanes) for rule in self._rules.values()), default=1)

    def snapshot(self) -> dict[str, Any]:
        rows = []
        for _, rule in sorted(self._rules.items()):
            rows.append({
                "security_type": rule.security_type,
                "logical_code": rule.logical_code,
                "session_market": rule.session_market,
                "canonical_market": rule.canonical_market,
                "lanes": list(rule.lanes),
                "watchlist_lanes": list(rule.watchlist_lanes),
                "fixed_context": bool(rule.fixed_context),
                "live_trade_detail": bool(rule.live_trade_detail),
                "live_orderbook": bool(rule.live_orderbook),
            })
        return {"provider": self.provider, "rules": rows}


def _sector_index_codes() -> tuple[str, ...]:
    """Every sector index of config/tw_industry_indexes.json, through its one validated reader (IX0001 is the market
    context's own rule)."""
    from config import tw_industry_indexes

    return tuple(code for code in tw_industry_indexes.all_index_codes() if code != "IX0001")


def _shioaji_rules() -> tuple[InstrumentCapabilities, ...]:
    return (
        InstrumentCapabilities(
            security_type="STK",
            logical_code="*",
            session_market="STK",
            canonical_market="STK",
            lanes=("Tick", "BidAsk"),
            live_trade_detail=True,
            live_orderbook=True,
        ),
        InstrumentCapabilities(
            security_type="IND",
            logical_code="IX0001",
            session_market="STK",
            canonical_market="IDX",
            canonical_code="TAIEX",
            lanes=("Quote",),
            fixed_context=True,
        ),
        # The 產業指數 of config/tw_industry_indexes.json (background owner sector_index): the same QuoteIdxV1 lane,
        # each named by its own code. Only the listed indexes: an index code is never guessed.
        *(InstrumentCapabilities(security_type="IND", logical_code=code, session_market="STK", canonical_market="IDX",
                                 lanes=("Quote",)) for code in _sector_index_codes()),
        InstrumentCapabilities(
            security_type="FUT",
            logical_code="TXFR1",
            session_market="FUT",
            canonical_market="FUT",
            lanes=("Quote",),
            fixed_context=True,
            live_trade_detail=False,
            live_orderbook=False,
        ),
        # Every dated futures month (台指期 and 個股期貨, named by its symbol: TXF202612, CDF202612): Tick and BidAsk,
        # one stream each (decisions.md 期貨訂閱的月份). Only a month of reference/shioaji/futures_contracts.csv is
        # planned (ShioajiSubscriptionManager.resolve): a symbol is never guessed into a contract.
        InstrumentCapabilities(
            security_type="FUT",
            logical_code="*",
            session_market="FUT",
            canonical_market="FUT",
            lanes=("Tick", "BidAsk"),
            live_trade_detail=True,
            live_orderbook=True,
        ),
    )


# The background list's kind each Shioaji lane carries (config/background_list.py KINDS).
SHIOAJI_LANE_KINDS = {"Quote": "quote", "Tick": "trade", "BidAsk": "orderbook"}


# The rules are built at the first use: the sector indexes come from config/tw_industry_indexes.json, whose
# IndustryIndexTableError then reaches the caller instead of failing every import of this module.
SHIOAJI_CAPABILITIES = ProviderCapabilities("shioaji", _shioaji_rules)



# The background list's kind each OpenD subscription type carries: 報價 and 分時 are both the quote (OpenD counts each
# type of each instrument as one subscription, so a Futu instrument's quote takes two), 逐筆 the trade, 擺盤 the book.
FUTU_LANE_KINDS = {"QUOTE": "quote", "RT_DATA": "quote", "TICKER": "trade", "ORDER_BOOK": "orderbook"}


FUTU_CAPABILITIES = ProviderCapabilities(
    "futu",
    (
        InstrumentCapabilities(
            security_type="US",
            logical_code="*",
            session_market="US",
            canonical_market="US",
            lanes=("QUOTE", "RT_DATA", "TICKER", "ORDER_BOOK"),
            watchlist_lanes=("QUOTE", "RT_DATA", "TICKER"),
            live_trade_detail=True,
            live_orderbook=True,
        ),
        InstrumentCapabilities(
            security_type="CC",
            logical_code="*",
            session_market="CC",
            canonical_market="CC",
            lanes=("QUOTE", "RT_DATA", "TICKER", "ORDER_BOOK"),
            watchlist_lanes=("QUOTE", "RT_DATA", "TICKER"),
            live_trade_detail=True,
            live_orderbook=True,
        ),
    ),
)
