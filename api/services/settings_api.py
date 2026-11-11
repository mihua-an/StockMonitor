"""settings_api (a part of app_api; no process or factory of its own): shared settings, sources, background list, product catalog, rules -- versioned (00, 06).

The only writer of shared saved configuration. Offline it does not stop anything already configured: every
process starts from the ACTIVE revision on disk, never by asking this service for its own address.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, FastAPI

from api.components import Components, run_read
from api.service_host import ServiceHost
from config.observability_contract import metric
from service.platform.failure_record import record_failure

SERVICE_ID = "settings_api"
_log = logging.getLogger(__name__)
# How long the close waits for the catalog follower (its start check and every master watch) to end.
MASTER_FOLLOW_JOIN_S = 5.0


def _watch_pages_file():
    from service.market.storage.market_storage_layout import process_market_layout

    return process_market_layout().watch_pages_file


class Resources:
    def __init__(self, host: ServiceHost) -> None:
        self.host = host
        self.components = Components.for_host(host)
        self.seeded: dict[str, Any] = {}
        self._tasks: list[asyncio.Task] = []
        self._master_watches: list[Any] = []
        self._stopped_watches: list[Any] = []   # told to stop on drain; joined by close()
        self._follow_future: asyncio.Future | None = None
        self._catalog_follow_stopped = False

    @staticmethod
    def config_root():
        from service.platform.project_root import CONFIG_ROOT

        return CONFIG_ROOT

    def bind(self, app: FastAPI) -> None:
        from api.routes.config_routes import create_config_router, seed_defaults
        from api.routes.product_routes import ProductCatalogRouteDependencies, create_product_catalog_router
        from api.routes.settings_routes import SettingsRouteDependencies, create_settings_router
        from config.source_settings import source_enabled
        from service.market.shared.source_runtime import disabled_source

        from fastapi.responses import JSONResponse

        from config.config_revisions import StoreUnreadable

        self.seeded = seed_defaults(self.config_root())

        # A damaged config store fails closed: every route of that domain says so, nothing reads it as empty.
        async def store_unreadable(_request, exc: StoreUnreadable):
            return JSONResponse({"ok": False, "error": f"CONFIG_STORE_{exc.state}", "domain": exc.domain, "reason": exc.reason},
                                status_code=503)

        app.add_exception_handler(StoreUnreadable, store_unreadable)
        app.include_router(create_config_router(config_root=self.config_root))
        c = self.components
        # Built on first use (api/components.py Deferred): none of them is needed before the process listens.
        app.include_router(create_settings_router(SettingsRouteDependencies(
            credentials=c.lazy("credentials"), shioaji_app=lambda: getattr(c.shioaji_provider(), "app", None))))
        app.include_router(create_product_catalog_router(ProductCatalogRouteDependencies(
            security_master=c.lazy("security_master"), product_catalog=c.lazy("product_catalog"), watch_pages=c.lazy("watch_pages"),
            shioaji_app=lambda: getattr(c.shioaji_provider(), "app", None), futu_proxy=c.futu_proxy(),
            source_enabled=source_enabled, disabled_source=disabled_source, run_blocking_read=run_read)))
        self.host.stream_closers.append(lambda: c.built_component("product_catalog") and c.product_catalog().feed.close())
        # The providers' master streams end with the drain, not with the process: a full shutdown stops the providers
        # right after the APIs drained, and a watch still open then took the provider's planned stop for an outage
        # (a client.security_master_events_reconnect on every full close, 10-20).
        self.host.stream_closers.append(self.stop_master_watches)
        app.include_router(self.background_router())

    def subscription_state(self):
        """The product pages, the 訂閱偏好 and the background list they make (subscription_ops.py), with the two
        holdings read from their ledgers."""
        from service.market.reference.subscription_ops import SubscriptionState

        c = self.components
        futu = c.futu_proxy()
        return SubscriptionState(self.config_root(), _watch_pages_file(), {
            "holdings": lambda: c.lazy("actual_account").get_positions(),
            "paper_holdings": lambda: c.lazy("paper_wallet").get_positions(),
        }, catalog=c.lazy("product_catalog"), futu_quota=lambda: futu("GET", "/v1/futu/subscription-quota", timeout=2.0))

    def background_router(self) -> APIRouter:
        """設定 → 訂閱管理 and the 商品頁設定 windows (service/market/reference/subscription_ops.py): settings_api is the
        one writer of the product pages and the 訂閱偏好, and saves the background list they make -- Rust A plans every
        provider's subscriptions from it; a provider subscribes nothing on its own."""
        router = APIRouter()

        @router.get("/api/subscriptions")
        async def get_subscriptions():
            return await asyncio.to_thread(lambda: self.subscription_state().snapshot())

        @router.post("/api/subscriptions/ops")
        async def apply_subscription_ops(batch: dict[str, Any]):
            from fastapi.responses import JSONResponse

            result = await asyncio.to_thread(self.subscription_state().apply, batch)
            if result.get("ok"):
                return result
            status = {"QUOTA_EXCEEDED": 409}.get(str(result.get("error")), 422)
            return JSONResponse(result, status_code=status)

        # What a window's unsaved changes would make (quota, background list, rows): nothing is written.
        @router.post("/api/subscriptions/preview")
        async def preview_subscription_ops(batch: dict[str, Any]):
            from fastapi.responses import JSONResponse

            result = await asyncio.to_thread(lambda: self.subscription_state().apply(batch, preview=True))
            return result if result.get("ok") else JSONResponse(result, status_code=422)

        return router

    def follow_futures_table(self, state: dict[str, Any]) -> None:
        """The Shioaji security master was rewritten (and the futures contract table before it, maintenance.py): the
        near months move on and expired months leave the preferences. Its failure is recorded; the list in force
        stays until the next write."""
        try:
            result = self.subscription_state().follow_futures_table()
            if not result.get("ok"):
                _log.error("background list not saved after the futures contract table changed: %s", result)
        except Exception as exc:  # noqa: BLE001 -- recorded; the active background revision stays in force
            record_failure(_log, "following the futures contract table", exc)

    async def start(self) -> None:
        # The product pages may have changed while nothing was running: the list A plans from is brought up to date
        # once the process listens (never before: the read touches the CSV and the revision store).
        from service.market.reference import background_demand

        async def refresh() -> None:
            try:
                result = await asyncio.to_thread(background_demand.refresh_fixed_owners, self.config_root(), _watch_pages_file())
                if not result.get("ok"):
                    _log.error("background list refresh at start failed: %s", result)
            except Exception:  # noqa: BLE001 -- recorded; the previous active revision stays in force
                _log.exception("background list refresh at start failed")

        async def follow_holdings(component: str, owner: str, summary: str) -> None:
            # A holdings owner follows its ledger: now, then after every positions change (the same feed the quote
            # screens' live holdings use). Held tasks: an unreferenced task may be collected.
            account = self.components.lazy(component)
            try:
                feed = await asyncio.to_thread(lambda: account.positions_feed)
                queue = feed.subscribe()
            except Exception:  # noqa: BLE001 -- the account store did not open; nothing to follow
                _log.exception("%s owner: the ledger is unavailable", owner)
                return
            try:
                while True:
                    try:
                        positions = await asyncio.to_thread(account.get_positions)
                        result = await asyncio.to_thread(background_demand.replace_owner, self.config_root(), owner,
                                                         background_demand.holdings_items(positions), summary=summary)
                        if not result.get("ok"):
                            _log.error("%s owner not saved: %s", owner, result)
                    except Exception:  # noqa: BLE001 -- the previous holdings stay listed until the next change
                        _log.exception("%s owner update failed", owner)
                    if await queue.get() is None:
                        return
            finally:
                feed.unsubscribe(queue)

        async def follow_paper_orders() -> None:
            # 模擬下單: the working orders' stocks stay subscribed while they can still fill (Rust B matches them).
            try:
                desk = await asyncio.to_thread(self.components.paper_orders)
                queue = desk.feed.subscribe()
            except Exception:  # noqa: BLE001 -- the paper ledger did not open; nothing to follow
                _log.exception("paper_orders owner: the order desk is unavailable")
                return
            held: list[str] | None = None
            try:
                while True:
                    codes = desk.working_codes()
                    if codes != held:
                        try:
                            result = await asyncio.to_thread(background_demand.replace_owner, self.config_root(), "paper_orders",
                                                             background_demand.paper_order_items(codes), summary="paper orders")
                            if result.get("ok"):
                                held = codes
                            else:
                                _log.error("paper_orders owner not saved: %s", result)
                        except Exception:  # noqa: BLE001 -- tried again on the next change
                            _log.exception("paper_orders owner update failed")
                    if await queue.get() is None:
                        return
            finally:
                desk.feed.unsubscribe(queue)

        def follow_security_masters() -> None:
            # The catalog is checked against its masters once at start (a stale one found now is a recorded
            # remediation), then follows each enabled provider's master writes (security_master_watch.py).
            from config.source_settings import ENABLED_SOURCES
            from service.market.reference.security_master_watch import SecurityMasterWatch

            try:
                self.components.product_catalog().ensure_current()
            except Exception:  # noqa: BLE001 -- recorded; the provider streams below still rebuild it
                _log.exception("product catalog check at start failed")
            for source in ("shioaji", "futu"):
                if source not in ENABLED_SOURCES or self._catalog_follow_stopped:
                    continue
                try:
                    catalog = self.components.product_catalog().source_written
                    if source == "shioaji":
                        # The futures contract table is written with the Shioaji master: the background list follows it.
                        def on_written(state: dict[str, Any], catalog=catalog) -> Any:
                            taken = catalog(state)
                            self.follow_futures_table(state)
                            return taken
                    else:
                        on_written = catalog
                    watch = SecurityMasterWatch(f"provider_{source}", on_written)
                    watch.start()
                except Exception:  # noqa: BLE001 -- recorded: this provider's writes reach the catalog at the next start
                    _log.exception("following the %s security master failed to start", source)
                    continue
                self._master_watches.append(watch)
                if self._catalog_follow_stopped:   # closed while this one started: stopped, and joined by close()
                    self.stop_master_watches()

        loop = asyncio.get_running_loop()
        self._follow_future = loop.run_in_executor(None, follow_security_masters)
        self._tasks = [loop.create_task(refresh()), loop.create_task(follow_paper_orders()),
                       loop.create_task(follow_holdings("actual_account", "holdings", "actual holdings")),
                       loop.create_task(follow_holdings("paper_wallet", "paper_holdings", "paper holdings"))]

    def stop_master_watches(self) -> None:
        # Only flags (a drain runs on the event loop): no watch hands the catalog anything new after this. close()
        # waits for the ones already running.
        self._catalog_follow_stopped = True
        watches, self._master_watches = self._master_watches, []
        for watch in watches:
            watch.stop()
        self._stopped_watches.extend(watches)

    async def join_master_follow(self, timeout_s: float = MASTER_FOLLOW_JOIN_S) -> list[str]:
        """Waits, within ``timeout_s`` in all, for the catalog follower's start check and every stopped watch to end;
        what did not end is recorded and returned. Called once the watches are stopped."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_s
        still_running: list[str] = []
        future, self._follow_future = self._follow_future, None
        if future is not None:
            done, _pending = await asyncio.wait({future}, timeout=timeout_s)
            if not done:
                still_running.append("product catalog start check")
            elif not future.cancelled() and future.exception() is not None:
                record_failure(_log, "following the security masters", future.exception())
        watches, self._stopped_watches = self._stopped_watches, []
        for watch in watches:
            ended = await asyncio.to_thread(watch.join, max(0.0, deadline - loop.time()))
            if not ended:
                still_running.append(f"{watch.service_id} security-master watch")
        if still_running:
            record_failure(_log, "closing settings_api", TimeoutError(
                f"still running after {timeout_s} s: {', '.join(still_running)} (stopped: they hand the catalog nothing more)"))
        return still_running

    async def close(self) -> None:
        # The background-list refresh and the two holdings followers end with the service; the catalog follower is
        # waited for, so nothing it started writes the catalog after the service closed.
        self.stop_master_watches()
        await self.join_master_follow()
        tasks, self._tasks = self._tasks, []
        for task in tasks:
            task.cancel()
        for task in tasks:
            try:
                await task
            except asyncio.CancelledError:  # not an error: the task was cancelled just above
                pass
            except Exception as exc:  # noqa: BLE001 -- recorded; the service is closing anyway
                _log.exception("settings_api background task failed while closing: %s", exc)

    def metrics(self) -> list[dict[str, Any]]:
        from config.config_revisions import ConfigRevisionStore

        out = [metric("components.built", SERVICE_ID, value=len(self.components.built()), unit="components"),
                metric("components.failed", SERVICE_ID, value=len(self.components.failed()), unit="components")]
        for domain in ("network", "background", "flow_rules", "event_rules", "breadth"):
            state = ConfigRevisionStore(self.config_root(), domain).state()
            if state["pointer"] is None:
                for name in ("latest", "pending_apply"):
                    out.append(metric(f"config.{domain}.{name}", SERVICE_ID, unit="revision" if name == "latest" else "bool",
                                      availability="TEMPORARILY_UNAVAILABLE", reason=f"store {state['state']}: {state['reason']}"))
                continue
            pointer = state["pointer"]
            latest, active = pointer.get("latest"), pointer.get("active")
            out.append(metric(f"config.{domain}.latest", SERVICE_ID, value=latest, unit="revision") if latest is not None
                       else metric(f"config.{domain}.latest", SERVICE_ID, unit="revision", availability="NO_SAMPLE", reason="no revision saved"))
            out.append(metric(f"config.{domain}.pending_apply", SERVICE_ID, value=int((latest or 0) != (active or 0)), unit="bool"))
        return out

    def prepare_shutdown(self) -> dict[str, Any]:
        return {}
