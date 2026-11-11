from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CanonicalSessionIdentity:
    """Storage-layer session identity: source + market/venue + trading session
    (docs/system-architecture/03_protocol_and_storage.md §1)."""

    source: str
    market: str
    logical_code: str
    actual_contract: str
    trading_date: str
    session: str

    @property
    def key(self) -> str:
        return "|".join((self.source, self.market, self.logical_code, self.actual_contract, self.trading_date, self.session))


