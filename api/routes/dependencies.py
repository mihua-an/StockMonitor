"""The smallest surface each route family needs from its dependencies, as Protocols.

Route dependency dataclasses name these instead of ``Any``: the methods a router calls are readable here, and a type
checker (or tests/test_route_dependency_protocols.py) sees a missing one before a request reaches it. Each Protocol
lists only what the routes call; the real classes have more.
"""
from __future__ import annotations

from typing import Any, Callable, Protocol, runtime_checkable

# A JSON document a provider or service answers with; routes pass it on or merge it.
Document = dict[str, Any]


@runtime_checkable
class ProviderApp(Protocol):
    """What history and data-center routes read of the Shioaji provider (api/provider_http_client.py or a disabled
    source): its local application object when this process hosts one, else None (routes then answer from the
    replay service or the local catalog)."""

    app: Any


@runtime_checkable
class ProviderRuntime(ProviderApp, Protocol):
    """quote_api's Shioaji daemon client (service/market/shioaji/daemon_client.py MarketDaemonClient)."""

    def cached_health(self) -> Document: ...

    def stream_stats(self) -> Document: ...


@runtime_checkable
class FutuDaemonClient(Protocol):
    """quote_api's Futu daemon client (service/market/futu/daemon_client.py MoomooDaemonClient)."""

    def health(self, *, refresh: bool = False) -> Document: ...

    def stats(self) -> Document: ...

    def manual_reattach(self) -> Document: ...


@runtime_checkable
class EventArchive(Protocol):
    """Past trading days' analysis events (service/market/projection/analysis_event_archive.py)."""

    def read(self, *, date_text: str, limit: int) -> Document: ...


@runtime_checkable
class ReplayService(Protocol):
    """history_api's replay reads (service/market/history)."""

    def status(self) -> Document: ...

    def list_dates(self, *args: Any, **kwargs: Any) -> Any: ...

    def list_stocks(self, *args: Any, **kwargs: Any) -> Any: ...

    def get_kline(self, *args: Any, **kwargs: Any) -> Any: ...

    def get_reference_tick_session(self, *args: Any, **kwargs: Any) -> Any: ...


@runtime_checkable
class DayTradeLedger(Protocol):
    """The actual-account ledger's day-trade reads that the replay page lists (交易明細)."""

    def get_daytrade_history_page(self, *args: Any, **kwargs: Any) -> Any: ...

    def get_daytrade_symbol_date_rows(self, *args: Any, **kwargs: Any) -> Any: ...


@runtime_checkable
class DataCatalog(Protocol):
    """The local data catalog data_center_api answers from when no provider app is in this process."""

    def dates(self, *args: Any, **kwargs: Any) -> Any: ...

    def date_categories(self, *args: Any, **kwargs: Any) -> Any: ...


# Callbacks with their full signatures.
BrokerStatusReader = Callable[[], Document]
MarketSessionsReader = Callable[[Document | None], Document]
SourceStatusSnapshot = Callable[[], dict[str, Document]]
AttachedCallback = Callable[[], None]
