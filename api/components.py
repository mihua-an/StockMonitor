"""Lazily built domain components shared by the service app factories.

Every API process builds ONLY what its routes use (00 section 3: no copy of the whole ApiResources per port).
Each component is constructed at most once per process, on first use; SDK owners, the producer and Rust B are
never constructed here.
"""
from __future__ import annotations

import asyncio
import threading
import time
from typing import Any, Callable

from config.source_settings import source_enabled
import logging
from service.platform.failure_record import record_failure
from service.market.storage.market_storage_layout import process_market_layout

_failure_log = logging.getLogger(__name__)


async def run_read(callable_: Callable[[], Any]) -> Any:
    """Blocking reads off the event loop (the old shutdown-aware reader's role; drain waits for in-flight ones)."""
    return await asyncio.to_thread(callable_)


# The components a window's own start reads in its first seconds: the product catalog and the watch pages (the
# product list), the Shioaji security master (the catalog step), both ledgers (the holdings tabs, their position
# streams, the background list's holdings owners) and the paper order desk (its order stream). These are built once
# the process answers, so those first reads do not wait for a build. Every other component (the history replay, the
# data center, the data pages' broker client, credentials, account sync and publishing) is built on first use: built
# at start as well, it ran beside the window's first reads in this one Python process and slowed them (Codex
# 1022-ST-07). quote_api's own start builds its daemon clients.
STARTUP_COMPONENTS = frozenset({"product_catalog", "watch_pages", "security_master", "actual_account", "paper_wallet",
                                "paper_orders"})


class Deferred:
    """A component handed to a router before it exists: built on its first use.

    Building every part's services in ``bind`` made each API process take 2-3 s before it listened (6-8 s with the
    rest of a cold start competing): settings_api's product catalog / security master / watch pages, quote_api's
    daemon clients. Routers only call methods at request time, so they get this stand-in; after the process is ready
    ``Components.warm`` builds the ones a window's start reads (STARTUP_COMPONENTS) on a background thread, so those
    first requests do not pay for it either.
    """

    __slots__ = ("_name", "_factory", "_value", "_lock", "_build", "_state", "_attempts", "_error", "_retry_at", "_recovery")

    # A failed build is not tried again on every request: the next try waits 1, 2, 4 ... up to 60 s; until then each
    # use answers the remembered failure at once.
    RETRY_MAX_S = 60.0

    def __init__(self, name: str, factory: Callable[[], Any]) -> None:
        self._name = name
        self._factory = factory
        self._value: Any = None
        # Two locks: `_build` lets one caller run the factory while the others wait for its outcome; `_lock` only
        # guards the state fields and is never held while the factory runs, so status() never waits on a build.
        self._lock = threading.Lock()
        self._build = threading.Lock()
        self._state = "PENDING"            # PENDING -> BUILDING -> READY | FAILED
        self._attempts = 0
        self._error: BaseException | None = None
        self._retry_at = 0.0
        self._recovery: Any = None

    def resolve(self) -> Any:
        if self._value is not None:
            return self._value
        with self._build:
            if self._value is not None:
                return self._value
            with self._lock:
                if self._state == "FAILED" and time.monotonic() < self._retry_at:
                    raise ComponentUnavailable(self._name, self._error)
                self._state = "BUILDING"
                self._attempts += 1
                attempt = self._attempts
            started = time.perf_counter()
            try:
                value = self._factory()
            except Exception as exc:
                with self._lock:
                    self._state, self._error = "FAILED", exc
                    self._retry_at = time.monotonic() + min(self.RETRY_MAX_S, 2.0 ** min(6, attempt - 1))
                record_failure(_failure_log, f"building the {self._name} component (attempt {attempt})", exc)
                self._recovery_for().failed("component_build_failed", detail={"component": self._name, "error": type(exc).__name__})
                raise
            with self._lock:
                self._value, self._state, self._error = value, "READY", None
            # What each build cost, beside what the process answered meanwhile (a slow first read names its cause).
            _failure_log.info("built the %s component in %.0f ms (attempt %d)", self._name,
                              (time.perf_counter() - started) * 1000, attempt)
            if self._recovery is not None:
                self._recovery.finish("succeeded", detail={"component": self._name, "attempts": attempt})
            return value

    def _recovery_for(self) -> Any:
        if self._recovery is None:
            from service.platform.remediation import Recovery

            self._recovery = Recovery(component="api_components", mechanism_id="api.component_build_retry")
        return self._recovery

    def close(self) -> None:
        """The process is ending: a recovery still open (the build kept failing) ends as abandoned, so the
        ledger never shows an operation no process will finish."""
        with self._lock:
            recovery = self._recovery
            state, attempts = self._state, self._attempts
        if recovery is not None and state != "READY":
            recovery.finish("abandoned", detail={"component": self._name, "attempts": attempts, "reason": "process shutdown"})

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {"state": self._state, "attempts": self._attempts,
                    "error": f"{type(self._error).__name__}: {self._error}"[:300] if self._error else None}

    @property
    def is_built(self) -> bool:
        return self._value is not None

    def built(self) -> Any:
        """The component if it is built, else None -- never builds it and never waits on a build in progress (a
        status read must not stand behind the factory: the heartbeat that did timed out in Electron)."""
        return self._value

    def __getattr__(self, attr: str) -> Any:
        return getattr(self.resolve(), attr)

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        return self.resolve()(*args, **kwargs)

    def __repr__(self) -> str:
        return f"<Deferred {self._name}{' built' if self._value is not None else ''}>"


class ComponentUnavailable(RuntimeError):
    """A component whose last build failed and whose next try is not due yet."""

    def __init__(self, name: str, cause: BaseException | None) -> None:
        super().__init__(f"{name} is unavailable: its build failed ({type(cause).__name__ if cause else 'unknown'}: {cause})")
        self.component = name


class Components:
    def __init__(self, service_id: str) -> None:
        self.service_id = service_id
        self._built: dict[str, Any] = {}
        self._deferred: dict[str, Deferred] = {}
        # `_lock` guards the two dicts only and is never held while a factory runs (built(), failed() and metrics read
        # them during a slow build); `_building` holds one gate per component name so each is built once.
        self._lock = threading.Lock()
        self._building: dict[str, threading.RLock] = {}

    def lazy(self, name: str, factory: Callable[[], Any] | None = None) -> Deferred:
        """``name``'s component, built on first use (``factory`` for one that is not a Components method)."""
        with self._lock:
            if name not in self._deferred:
                self._deferred[name] = Deferred(name, factory or getattr(self, name))
            return self._deferred[name]

    def warm(self, delay_s: float = 0.0) -> threading.Thread:
        """Build the deferred components a window's start reads (STARTUP_COMPONENTS) in the background, once the
        process already answers; the rest wait for their first use."""
        def run() -> None:
            if delay_s > 0:
                threading.Event().wait(delay_s)
            with self._lock:
                wanted = [deferred for name, deferred in self._deferred.items() if name in STARTUP_COMPONENTS]
            for deferred in wanted:
                try:
                    deferred.resolve()
                except Exception:  # not an error: resolve() recorded the failure and keeps it as the component's state
                    continue
        thread = threading.Thread(target=run, daemon=True, name=f"{self.service_id}-warm")
        thread.start()
        return thread

    def shutdown(self) -> None:
        """End every component build recovery still open (the process is stopping)."""
        with self._lock:
            deferred = list(self._deferred.values())
        for item in deferred:
            try:
                item.close()
            except Exception as exc:
                record_failure(_failure_log, f"closing the {item._name} component's recovery at shutdown", exc)

    @classmethod
    def for_host(cls, host: Any) -> "Components":
        """The one Components of this process: parts served together share their providers, readers and caches."""
        if getattr(host, "components", None) is None:
            host.components = cls(host.service_id)
        return host.components

    def _get(self, name: str, factory: Callable[[], Any]) -> Any:
        with self._lock:
            if name in self._built:
                return self._built[name]
            gate = self._building.setdefault(name, threading.RLock())
        with gate:
            with self._lock:
                if name in self._built:
                    return self._built[name]
            value = factory()
            with self._lock:
                self._built[name] = value
            return value

    def built(self) -> list[str]:
        with self._lock:
            return sorted(self._built)

    def states(self) -> dict[str, dict[str, Any]]:
        """Each deferred component's build state (PENDING / BUILDING / READY / FAILED), attempts and last error."""
        with self._lock:
            deferred = dict(self._deferred)
        return {name: item.status() for name, item in sorted(deferred.items())}

    def failed(self) -> list[str]:
        return [name for name, state in self.states().items() if state["state"] == "FAILED"]

    def built_component(self, name: str) -> bool:
        with self._lock:
            return name in self._built

    def peek(self, name: str) -> Any:
        """``name``'s component if it is built, else None: never builds it and never waits on a build."""
        with self._lock:
            return self._built.get(name)

    # ------------------------------------------------------------------ providers
    def shioaji_provider(self) -> Any:
        from service.market.shared.disabled_source import DisabledSourceClient
        from api.provider_http_client import ProviderHttpClient

        return self._get("provider_shioaji", lambda: ProviderHttpClient("provider_shioaji") if source_enabled("shioaji") else DisabledSourceClient("shioaji"))

    def futu_provider(self) -> Any:
        from service.market.shared.disabled_source import DisabledSourceClient
        from api.provider_http_client import ProviderHttpClient

        return self._get("provider_futu", lambda: ProviderHttpClient("provider_futu") if source_enabled("futu") else DisabledSourceClient("futu"))

    def futu_proxy(self) -> Callable[..., Any]:
        """The Futu provider's HTTP surface (GET/POST/PUT by method name), for product/futu routes."""
        def proxy(method: str, path: str, *, params: dict | None = None, body: dict | None = None, timeout: float = 5.0):
            client = self.futu_provider()
            if not hasattr(client, "request"):
                return {"ok": False, "error": "futu source disabled", "classification": "DISABLED_BY_POLICY"}
            try:
                return client.request(method, path, params=params, body=body, timeout=timeout)
            except Exception as exc:  # noqa: BLE001 -- the Futu daemon not answering is a state, not a server error
                # not an error: answered as a state the page already shows (Futu 未連線), like a disabled source; the
                # daemon client's attach recovery records the daemon being away. It was an unhandled
                # MarketDaemonError: every /api/futu/* call while the daemon starts (or hangs) answered 500.
                from service.market.shioaji.daemon_errors import MarketDaemonError

                if not isinstance(exc, MarketDaemonError):
                    raise
                return {"ok": False, "error": "FUTU_PROVIDER_UNAVAILABLE", "classification": "PROVIDER_UNAVAILABLE",
                        "detail": str(exc)[:300]}
        return proxy

    # ------------------------------------------------------------------ reference
    def security_master(self) -> Any:
        from service.market.reference.security_master_service import SecurityMasterService

        return self._get("security_master", lambda: SecurityMasterService(process_market_layout().shioaji_security_master, api_provider=lambda: None))

    def product_catalog(self) -> Any:
        from service.market.projection.product_catalog_service import ProductCatalogService

        from config.source_settings import ENABLED_SOURCES

        layout = process_market_layout()
        return self._get("product_catalog", lambda: ProductCatalogService(
            layout.product_catalog_file, shioaji_master_file=layout.shioaji_security_master,
            futu_master_file=layout.futu_security_master, enabled_sources=ENABLED_SOURCES))

    def watch_pages(self) -> Any:
        from service.market.reference.watch_page_service import WatchPageService

        return self._get("watch_pages", lambda: WatchPageService(process_market_layout().watch_pages_file))

    def credentials(self) -> Any:
        from service.platform.credential_service import CredentialService

        return self._get("credentials", CredentialService)

    # ------------------------------------------------------------------ accounts
    def actual_account(self) -> Any:
        from service.account.actual_account_service import ActualAccountService


        # The composition root owns the paths: the account domain does not reach into market storage.
        return self._get("actual_account", lambda: ActualAccountService(
            db_path=process_market_layout().actual_accounts_root / "actual_account.db",
            config_path=process_market_layout().actual_accounts_root / "actual_account_config.json",
            security_master_path=process_market_layout().shioaji_security_master,
            traded_codes_path=process_market_layout().traded_codes_root / "actual.json"))

    def paper_wallet(self) -> Any:
        from service.account.paper_wallet_service import PaperWalletService

        return self._get("paper_wallet", lambda: PaperWalletService(db_path=process_market_layout().paper_accounts_root / "paper_wallet.db",
                                                                   config_path=process_market_layout().paper_accounts_root / "paper_wallet_config.json",
                                                                   security_master_path=process_market_layout().shioaji_security_master,
                                                                   traded_codes_path=process_market_layout().traded_codes_root / "paper.json"))

    def paper_orders(self) -> Any:
        """模擬下單's 委託台 over the paper ledger; Rust B matches its orders (docs/system-architecture/11)."""
        from service.account.paper_orders import PaperOrderDesk

        return self._get("paper_orders", lambda: PaperOrderDesk(self.paper_wallet(), process_market_layout().paper_matching_root))

    def gas_bridge(self) -> Any:
        from service.account.actual_account_bridge import GasBridgeScheduler

        class _Lazy:
            def __init__(self, outer):
                self._outer = outer

            def get(self):
                return self._outer.actual_account()

            def __getattr__(self, name):
                return getattr(self._outer.actual_account(), name)

        return self._get("gas_bridge", lambda: GasBridgeScheduler(_Lazy(self)))

    # ------------------------------------------------------------------ history
    def history_repository(self) -> Any:
        provider = self.shioaji_provider()
        app = getattr(provider, "app", None)
        if app is not None:
            return app.historical_repository
        from service.market.history.rust_historical_store_reader import default_historical_root
        from service.market.shioaji.history_repository import ShioajiHistoricalRepository
        from service.market.storage.market_storage_layout import process_market_layout

        return self._get("offline_history_repository", lambda: ShioajiHistoricalRepository(
            lambda: None, layout=process_market_layout(), historical_root=default_historical_root()))

    def history_replay(self) -> Any:
        from service.market.history.history_replay_service import HistoryReplayService

        return self._get("history_replay", lambda: HistoryReplayService(
            lambda: self.history_repository(),
            code_provider=lambda: self.watch_pages().all_codes(),
            metadata_provider=lambda code: self.security_master().find_by_code(code),
        ))

    def data_center(self) -> Any:
        from service.market.query.data_center_service import DataCenterService
        from service.market.query.historical_catalog import HistoricalEvidenceCatalog

        def build():
            repo = self.history_repository()
            return DataCenterService(HistoricalEvidenceCatalog(repo.historical))
        return self._get("data_center", build)

    # ------------------------------------------------------------------ models
    def online_registry(self) -> Any:
        """The one model registry. Whether a champion's FeatureSpec is the one Rust B computes is judged against
        B's own status file; unknown while B has not written one."""
        from service.analysis.inference_files import read_status
        from service.analysis.online_training.registry import OnlineModelRegistry

        def worker_digest() -> str | None:
            status = read_status()
            if not status or status.get("stale"):
                return None
            return (status.get("feature_spec") or {}).get("schema_digest")

        return self._get("online_registry", lambda: OnlineModelRegistry(spec_provider=worker_digest))
