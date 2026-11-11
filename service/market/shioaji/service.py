# service/market/shioaji/service.py

from __future__ import annotations

import logging
import time
from threading import Event, RLock
from service.market.storage.market_storage_layout import process_market_layout
from datetime import time as dt_time, datetime
from typing import Any


from service.market.projection.market_index_service import MarketIndexService
from service.market.reference.watch_page_service import WatchPageService
from service.market.shioaji.session import ShioajiBrokerService
from service.platform.credential_service import CredentialService
from service.market.shared.rust_live import RustDaemonEventSink
from service.market.shioaji.session_evidence_gate import ShioajiSessionEvidenceGate
from service.market.history.rust_historical_store_reader import default_historical_root
from service.market.shioaji.history_repository import ShioajiHistoricalRepository
from service.market.shioaji.maintenance import MarketMaintenanceCoordinator
from service.market.shioaji.history_download import KBarDownloadManager
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)

logger = logging.getLogger(__name__)


class ShioajiMarketService:
    """Shioaji service graph: ingestion, recording and presentation.

    No analysis or model runs here: signals, large orders and model inference are Rust B's, training is a job
    Health starts.

    ShioajiRuntime owns the heartbeat and daemon lifecycle. Build all callback
    targets first; only explicit start opens the producer/consumer lanes.
    """

    source = "shioaji"

    def __init__(
        self,
        watch_page_service: Any | None = None,
        market_index_service: MarketIndexService | None = None,
        credential_service: CredentialService | None = None,
    ):
        # Shioaji stock Tick/BidAsk 的 production data plane 由 Rust
        # runtime 擁有。Python 不建立 per-event MarketDataEvent / queue / worker。
        # Native extension 缺失時 FastAPI/control-plane 仍可啟動，但 live Shioaji
        # subscription 會明確 BLOCKED，不會改走 Python hot path。
        # 即時版本的唯一股票 universe 是商品頁 CSV（watch_pages_file）。
        self.watch_page_service = watch_page_service or WatchPageService(process_market_layout().watch_pages_file)
        # Disk I/O is isolated from ingest/callback workers. Streaming
        # Tick/BidAsk is written in coarse parquet shards by a dedicated queue.
        self.live_event_sink = RustDaemonEventSink()
        self.session_evidence_gate = ShioajiSessionEvidenceGate(
            evidence=self.live_event_sink.evidence,  # Market Runtime's partition records, as the owners read them
        )
        self.market_index_service = market_index_service or MarketIndexService()
        self.scan_count = 0
        self._last_maintenance_minute: str | None = None
        self.market_maintenance_coordinator = MarketMaintenanceCoordinator()

        self._state_lock = RLock()
        self._shutdown_complete = False

        # Shioaji is initialized only after the existing runtime state is
        # ready, and login/subscription runs in its own daemon thread. Electron /
        # FastAPI startup therefore stays progressive even if broker login is slow.
        self.broker_service = ShioajiBrokerService(
            on_connected=self._on_shioaji_connected,
            credential_service=credential_service,
            event_sink=self.live_event_sink,
        )
        self.historical_repository = ShioajiHistoricalRepository(
            self.broker_service.get_api, layout=process_market_layout(), historical_root=default_historical_root())
        # Historical K-bars are a daemon-owned, explicitly submitted workflow.
        # FastAPI receives only this service's read/command proxy and never gets
        # a Shioaji API object.
        self.kbar_download_manager = KBarDownloadManager(
            self.broker_service.get_api,
            self.historical_repository,
        )
        self.market_index_service.set_history_repository(self.historical_repository)
        self._shutdown_lock = RLock()
        self._broker_logout_pending = False
        self._run_stop_event = Event()
        self._started = False

    def start(self) -> dict[str, Any]:
        """Start only broker control and direct Rust callback admission."""
        with self._shutdown_lock:
            if self._shutdown_complete:
                raise RuntimeError("Shioaji service stopped; daemon recovery required")
            if self._started:
                return {"ok": True, "source": self.source, "already_started": True}
            try:
                # start_background() starts the live event sink (the one forwarder to Market Runtime) first.
                self.broker_service.start_background()
                self._started = True
            except Exception:
                self.shutdown_background_processing()
                raise
            return {"ok": True, "source": self.source, "started": True}

    def _on_shioaji_connected(self, api: Any) -> None:
        """Broker-backed metadata current once the contract cache is ready (a reconnect the same day keeps it)."""
        result = self.market_maintenance_coordinator.ensure_current(api)
        logger.info(f"[SHIOAJI CONTRACTS] security master rows={result.get('count', 0)}")

    def _schedule_daily_security_master_refresh(self, now: datetime) -> dict[str, Any]:
        """Refresh Taiwan contracts once per day without blocking the daemon loop."""
        return self.market_maintenance_coordinator.schedule_daily(
            now=now,
            connected=self.broker_service.is_connected(),
            api=self.broker_service.get_api(),
        )

    def run(self) -> None:
        """Run the Shioaji-only streaming runtime until interrupted."""
        self.start()
        logger.info("Shioaji 串流監控已啟動；等待行情 callback。")
        try:
            self._run_stop_event.clear()
            while not self._run_stop_event.wait(1.0):
                self.run_once()
        except KeyboardInterrupt:  # not an error: Ctrl+C is the console stop request
            pass
        finally:
            self.shutdown_background_processing()

    def run_once(self) -> dict[str, Any]:
        """Streaming-only maintenance heartbeat; never fetches realtime quotes."""
        self.scan_count += 1
        try:
            codes = self.watch_page_service.all_codes()
        except Exception as exc:
            record_failure(_failure_log, "reading the watch-page codes for the maintenance scan", exc)
            codes = []
        now = datetime.now()
        minute_key = now.strftime("%Y-%m-%d %H:%M")
        maintenance = None
        if self._last_maintenance_minute != minute_key:
            self._last_maintenance_minute = minute_key
            security_master = self._schedule_daily_security_master_refresh(now)
            maintenance = self._run_shioaji_maintenance(now, codes)
            if maintenance is None:
                maintenance = {"security_master": security_master}
            else:
                maintenance["security_master"] = security_master
            # 歷史資料額度 (連線診斷): a background sample every 10 min while logged in, so readers hit the cache only.
            try:
                self.kbar_download_manager.sample_usage_if_due()
            except Exception as exc:
                record_failure(logger, "sampling the kbar usage", exc)
        return {
            "ok": True, "state": "streaming", "source": "shioaji",
            "watch_count": len(codes),
            "connected": self.broker_service.is_connected(),
            "scan_count": self.scan_count, "maintenance": maintenance,
        }

    def _run_shioaji_maintenance(self, now: datetime, codes: list[str]) -> dict[str, Any] | None:
        """Report deferred heavy maintenance without blocking realtime ingest.

        Feature-dataset construction and retention can take minutes and allocate
        large Pandas/Arrow frames.  They must not run in the persistent
        market-daemon heartbeat, which is also responsible for keeping the broker
        stream alive.  A dedicated maintenance worker/API can consume this
        explicit handoff later; the realtime process stays streaming-only.

        Model training is not here at all: it is a job Health starts after the close.
        """
        if now.weekday() >= 5 or now.time() < dt_time(13, 50):
            return None
        date_text = now.strftime("%Y-%m-%d")
        kbar_maintenance = None
        try:
            kbar_maintenance = {"ok": True, "auto_resumed": len(self.kbar_download_manager.resume_auto_jobs())}
            kbar_maintenance["auto_download"] = self.kbar_download_manager.plan_auto_downloads(today=now.date())
        except Exception as exc:
            record_failure(_failure_log, "running the kbar download maintenance", exc)
            kbar_maintenance = {"ok": False, "error": str(exc)}
        return {
            "date": date_text,
            "source": "shioaji",
            "deferred": True,
            "reason": "heavy_maintenance_requires_dedicated_worker",
            "codes": len(codes),
            "actions": [],
            "kbar_maintenance": kbar_maintenance,
        }

    # A worker's longest wait, and what the steps after the workers keep of the deadline (session 0.25 s, sink 1.5 s).
    _SHUTDOWN_WORKER_SECONDS = 5.0
    _SHUTDOWN_DRAIN_RESERVE_SECONDS = 1.75

    def shutdown_background_processing(self, *, defer_broker_logout: bool = False, deadline: float | None = None) -> dict[str, Any]:
        """Dependency-ordered graceful shutdown for all market-side workers.

        Persistent Market Daemon shutdown may defer the final Shioaji logout until
        canonical/session durability has flushed outside ShioajiMarketService.

        ``deadline`` (time.monotonic()) bounds every step together. Workers wait only for what is left above the drain's
        reserve: a busy worker cannot take the time events already admitted need to reach Market Runtime.
        """
        with self._shutdown_lock:
            if self._shutdown_complete:
                return dict(getattr(self, "_shutdown_result", {"ok": True, "already_shutdown": True}))
            if deadline is None:
                deadline = time.monotonic() + 2 * self._SHUTDOWN_WORKER_SECONDS + self._SHUTDOWN_DRAIN_RESERVE_SECONDS
            with self._state_lock:
                self._shutdown_complete = True
            self._run_stop_event.set()
            logger.info("[Shutdown] stop callback admission and broker session")
            errors: list[str] = []
            # Background workers that call the broker or write files stop before the broker session goes.
            workers: dict[str, Any] = {}
            for name, owner in (("security_master", self.market_maintenance_coordinator),
                                ("kbar_download", self.kbar_download_manager)):
                try:
                    left = deadline - self._SHUTDOWN_DRAIN_RESERVE_SECONDS - time.monotonic()
                    workers[name] = owner.shutdown(timeout=min(self._SHUTDOWN_WORKER_SECONDS, max(0.0, left)))
                except Exception as exc:
                    record_failure(_failure_log, f"stopping the {name} worker at shutdown", exc)
                    workers[name] = {"ok": False, "error": str(exc)}
                if not workers[name].get("ok"):
                    errors.append(f"{name}:{workers[name]}")
            try:
                self.live_event_sink.stop_admission()
                session = self.broker_service.begin_graceful_shutdown(wait=True, timeout=0.25) or {}
                # All callbacks admitted before the gate closed must reach the
                # Rust WAL before Electron asks the canonical engine to stop.
                ingress_receipt = self.live_event_sink.close(timeout=max(0.0, deadline - time.monotonic()))
                if not ingress_receipt.get("ok"):
                    errors.append(f"rust_ingress:{ingress_receipt}")
                # Logout never runs under work still calling the broker: a worker that did not stop in time,
                # or a subscription sync still in progress. The session then ends with this process, and the result
                # says why it was not logged out.
                busy = [name for name, receipt in workers.items() if not receipt.get("ok")]
                if session.get("unsubscribe") == "SKIPPED_SYNC_BUSY":
                    busy.append("subscription_sync")
                if busy:
                    errors.append(f"broker_logout_skipped:busy={','.join(busy)}")
                    logger.warning(f"[Shutdown] broker logout skipped: {', '.join(busy)} still running")
                elif defer_broker_logout:
                    self._broker_logout_pending = True
                else:
                    self.broker_service.logout_after_drain()
            except Exception as exc:
                record_failure(_failure_log, "closing callback admission and the broker session at shutdown", exc)
                errors.append(f"broker:{exc}")
            self._shutdown_result = {
                "ok": not errors, "errors": errors, "background_accepting": False, "workers": workers,
            }
            return dict(self._shutdown_result)

    def finalize_broker_logout(self, *, busy: tuple[str, ...] | list[str] = ()) -> dict[str, Any]:
        """The deferred broker logout, after every durable layer is flushed. Only a shutdown that found no work still
        calling the broker leaves it pending, and `busy` names the daemon's own work that did not stop in time; either
        way the session then ends with the process instead of under that work."""
        with self._shutdown_lock:
            if not self._broker_logout_pending:
                reason = "the shutdown did not leave a logout pending (work still calling the broker, or not stopped)"
                logger.warning(f"[Shutdown] Shioaji logout skipped: {reason}")
                return {"ok": False, "logged_out": False, "skipped": reason}
            if busy:
                reason = f"{', '.join(busy)} still running"
                logger.warning(f"[Shutdown] Shioaji logout skipped: {reason}")
                return {"ok": False, "logged_out": False, "skipped": reason}
            try:
                self.broker_service.logout_after_drain()
                logger.info("[Shutdown] Shioaji logout after all durable drains")
                return {"ok": True, "logged_out": True}
            except Exception as exc:
                record_failure(logger, "logging out of Shioaji at shutdown", exc)
                return {"ok": False, "logged_out": False, "error": str(exc)}
            finally:
                self._broker_logout_pending = False

    def get_market_index_history_session(self, date_text: str) -> dict[str, Any]:
        return self.market_index_service.get_history_session(date_text)
