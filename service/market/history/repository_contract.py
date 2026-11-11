from __future__ import annotations

from datetime import date, datetime
from typing import Any, Protocol


from service.market.history.historical_store import HistoricalStore

DateLike = str | date | datetime


class HistoricalDataReader(Protocol):
    """Reads of the materialized history a replay is built from."""

    historical: HistoricalStore

    def date_fingerprint(self, date_value: DateLike) -> str: ...

    def list_materialized_codes(self, date_value: str) -> list[str]: ...


class ProjectionStores(Protocol):
    """The finalized read models replay responses are built from."""

    minute_trend_store: Any
    session_summary_store: Any


class MarketHistoryRepository(HistoricalDataReader, ProjectionStores, Protocol):
    """Everything history and replay services use of a market history repository. It exposes no Shioaji SDK or
    contract-resolution operation."""

    def shutdown_historical_work(self, timeout: float = 8.0) -> dict[str, Any]: ...
