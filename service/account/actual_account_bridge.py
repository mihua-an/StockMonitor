from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta, timezone
from typing import Any

logger = logging.getLogger(__name__)


# 固定使用台灣時間，避免 Windows 缺少 tzdata 時 zoneinfo 失敗。
TAIPEI_TZ = timezone(timedelta(hours=8), name="Asia/Taipei")


def is_gas_bridge_check_time(moment: datetime) -> bool:
    """判斷目前時間是否為 GAS revision 檢查時間。

    規則（Asia/Taipei）：
    - 02:00-08:29：不檢查
    - 08:30：1 次
    - 09:00：1 次
    - 09:30-15:00：每 10 分鐘
    - 15:01-21:29：不檢查
    - 21:30：1 次
    - 22:00：1 次
    - 22:30-01:50：每 10 分鐘
    - 02:00 起：停止
    """
    if moment.tzinfo is None:
        local = moment.replace(tzinfo=TAIPEI_TZ)
    else:
        local = moment.astimezone(TAIPEI_TZ)

    hour = local.hour
    minute = local.minute
    total_minutes = hour * 60 + minute

    if (hour, minute) in {(8, 30), (9, 0), (21, 30), (22, 0)}:
        return True

    # 09:30 ~ 15:00，每 10 分鐘。
    if 570 <= total_minutes <= 900 and (total_minutes - 570) % 10 == 0:
        return True

    # 22:30 ~ 23:50，每 10 分鐘。
    if 1350 <= total_minutes <= 1430 and (total_minutes - 1350) % 10 == 0:
        return True

    # 00:00 ~ 01:50，每 10 分鐘。
    if 0 <= total_minutes <= 110 and total_minutes % 10 == 0:
        return True

    return False


def next_gas_bridge_check_time(moment: datetime | None = None) -> datetime:
    """回傳下一個 GAS revision 檢查時間。"""
    now = moment or datetime.now(TAIPEI_TZ)
    if now.tzinfo is None:
        now = now.replace(tzinfo=TAIPEI_TZ)
    else:
        now = now.astimezone(TAIPEI_TZ)

    candidate = now.replace(second=0, microsecond=0) + timedelta(minutes=1)

    # 最多掃兩天，足以跨過任何靜默時段。
    for _ in range(2 * 24 * 60 + 1):
        if is_gas_bridge_check_time(candidate):
            return candidate
        candidate += timedelta(minutes=1)

    return candidate


class GasBridgeScheduler:
    """Windows 端 GAS revision 輕量輪詢器。

    每個排程時間只呼叫 actualBridgeStatus。
    只有遠端 revision 與本機已同步 revision 不同時，才觸發既有完整同步、
    SQLite 重建與衍生資料發布。
    """

    def __init__(self, service: Any, wake_seconds: float = 5.0) -> None:
        self.service = service
        self.wake_seconds = max(1.0, float(wake_seconds))
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_check_key = ""
        self._wake_count = 0
        self._mobile_due_check_count = 0
        self._bridge_check_count = 0

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return

        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._run,
            daemon=True,
            name="actual-account-gas-bridge",
        )
        self._thread.start()

    def stop(self, timeout: float = 15.0) -> dict[str, Any]:
        self._stop_event.set()
        from service.platform.lazy_component import LazyComponent
        service = self.service.peek(timeout=timeout) if isinstance(self.service, LazyComponent) else self.service
        begin_shutdown = getattr(service, "begin_shutdown", None)
        if callable(begin_shutdown):
            begin_shutdown()
        thread = self._thread
        if thread is not None and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=max(0.0, float(timeout)))
            if thread.is_alive():
                logger.warning("[Shutdown][TIMEOUT] actual-account-gas-bridge")
            else:
                logger.info("[Shutdown] GAS/account bridge scheduler stopped")

        alive = bool(thread is not None and thread.is_alive())
        return {"ok": not alive, "thread_alive": alive}

    def status(self) -> dict[str, Any]:
        now = datetime.now(TAIPEI_TZ)
        next_check = next_gas_bridge_check_time(now)
        return {
            "running": bool(self._thread and self._thread.is_alive()),
            "timezone": "Asia/Taipei",
            "now": now.isoformat(timespec="seconds"),
            "next_check_at": next_check.isoformat(timespec="minutes"),
            "last_check_key": self._last_check_key,
            "wake_count": self._wake_count,
            "mobile_due_check_count": self._mobile_due_check_count,
            "bridge_check_count": self._bridge_check_count,
        }

    def _run(self) -> None:
        while not self._stop_event.is_set():
            self._wake_count += 1
            # Mobile due_at is memory-backed. The scheduler
            # may wake every few seconds, but an idle wake must not open SQLite.
            # 這讓 30 分鐘 debounce 不受 Bridge revision 檢查時段限制。
            try:
                self._mobile_due_check_count += 1
                mobile_result = self.service.report_publisher.run_due_mobile_publish()
                if mobile_result.get("published"):
                    logger.info(
                        "[MOBILE PUBLISH] published: "
                        f"at={mobile_result.get('published_at')} "
                        f"entries={mobile_result.get('entry_count')}"
                    )
            except Exception as exc:
                stopping = " (while stopping)" if self._stop_event.is_set() else ""
                logger.error(f"[MOBILE PUBLISH] scheduler failed{stopping}: {exc}")

            now = datetime.now(TAIPEI_TZ)
            check_key = now.strftime("%Y-%m-%d %H:%M")

            if is_gas_bridge_check_time(now) and check_key != self._last_check_key:
                # 先記錄，避免該分鐘內失敗後每幾秒重複呼叫 GAS。
                self._last_check_key = check_key

                try:
                    self._bridge_check_count += 1
                    result = self.service.sync_service.poll_gas_bridge_once(
                        source=f"schedule:{check_key}"
                    )

                    if result.get("configured"):
                        if result.get("changed"):
                            logger.info(
                                "[GAS BRIDGE] change detected and synchronized: "
                                f"time={check_key} "
                                f"revision={result.get('remote_revision')}"
                            )
                        else:
                            logger.debug(
                                "[GAS BRIDGE] up to date: "
                                f"time={check_key} "
                                f"revision={result.get('remote_revision')}"
                            )
                except Exception as exc:
                    # Not retried: the next scheduled slot is the next check (poll_gas_bridge_once stored the error).
                    stopping = " (while stopping)" if self._stop_event.is_set() else ""
                    next_check = next_gas_bridge_check_time(datetime.now(TAIPEI_TZ)).isoformat(timespec="minutes")
                    logger.error(f"[GAS BRIDGE] check failed at {check_key}{stopping}: {exc}; next check {next_check}")

            self._stop_event.wait(self.wake_seconds)
