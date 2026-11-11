from __future__ import annotations

from dataclasses import dataclass
from threading import RLock
from typing import Any


class StaleMarketIdentityError(RuntimeError):
    pass


@dataclass(frozen=True)
class LiveMarketIdentity:
    """Immutable live-session identity handed to downstream runtime components."""

    provider: str
    market: str
    logical_code: str
    actual_contract: str
    trading_date: str
    session: str
    generation: int
    live: bool

    def __post_init__(self) -> None:
        object.__setattr__(self, "provider", str(self.provider or "").strip().lower())
        object.__setattr__(self, "market", str(self.market or "").strip().upper())
        object.__setattr__(self, "logical_code", str(self.logical_code or "").strip().upper())
        object.__setattr__(self, "actual_contract", str(self.actual_contract or "").strip().upper())
        object.__setattr__(self, "trading_date", str(self.trading_date or "")[:10])
        object.__setattr__(self, "session", str(self.session or "").strip().upper())
        object.__setattr__(self, "generation", int(self.generation or 0))
        object.__setattr__(self, "live", bool(self.live))
        if not self.provider or not self.market or not self.trading_date or not self.session:
            raise ValueError("market identity is incomplete")
        if self.generation < 0:
            raise ValueError("market identity generation must be non-negative")

    @property
    def key(self) -> str:
        return "|".join((
            self.provider,
            self.market,
            self.logical_code,
            self.actual_contract,
            self.trading_date,
            self.session,
            str(self.generation),
        ))

    def as_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "market": self.market,
            "logical_code": self.logical_code,
            "actual_contract": self.actual_contract,
            "trading_date": self.trading_date,
            "session": self.session,
            "generation": self.generation,
            "live": self.live,
            "key": self.key,
        }


class MarketIdentityAuthority:
    """Single runtime owner of the currently activated market-session identity.

    Calendar resolution stays in ``SessionOrchestrator``. Once that orchestrator
    activates/closes a generation, downstream broker health and
    subscription logic reads this immutable contract instead of recalculating
    trading_date/session from wall clock independently.
    """

    def __init__(self, provider: str) -> None:
        normalized = str(provider or "").strip().lower()
        if not normalized:
            raise ValueError("provider is required")
        self.provider = normalized
        self._lock = RLock()
        self._current: dict[str, LiveMarketIdentity] = {}

    def transition(
        self,
        *,
        market: str,
        trading_date: str,
        session: str,
        generation: int,
        logical_code: str = "*",
        actual_contract: str = "",
        live: bool = True,
    ) -> LiveMarketIdentity:
        market_u = str(market or "").strip().upper()
        candidate = LiveMarketIdentity(
            provider=self.provider,
            market=market_u,
            logical_code=str(logical_code or "*").strip().upper(),
            actual_contract=str(actual_contract or "").strip().upper(),
            trading_date=str(trading_date or "")[:10],
            session=str(session or "").strip().upper(),
            generation=int(generation or 0),
            live=bool(live),
        )
        with self._lock:
            previous = self._current.get(market_u)
            if previous is not None and candidate.generation < previous.generation:
                raise StaleMarketIdentityError(
                    f"stale {market_u} generation {candidate.generation} < {previous.generation}"
                )
            if (
                previous is not None
                and candidate.generation == previous.generation
                and previous.live is False
                and candidate.live is True
            ):
                raise StaleMarketIdentityError(
                    f"closed {market_u} generation {candidate.generation} cannot be reactivated"
                )
            self._current[market_u] = candidate
            return candidate

    def current(self, market: str) -> LiveMarketIdentity | None:
        with self._lock:
            return self._current.get(str(market or "").strip().upper())

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "provider": self.provider,
                "markets": {market: identity.as_dict() for market, identity in sorted(self._current.items())},
            }
