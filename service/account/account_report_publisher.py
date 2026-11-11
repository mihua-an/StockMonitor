from __future__ import annotations
import threading
from datetime import date, datetime, timedelta
from typing import Any
from service.account import mobile_api
import logging
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)


class AccountReportPublisher:
    """Debounced publication of the phone's data (service/account/mobile_api.py) to the GAS Web App.

    The desktop computes every answer the phone can ask for and publishes them as one package; GAS only stores and
    serves it (docs/system-architecture/gas_mobile_design.md). The old mirror sheets (交易明細／配對明細 and the six
    「手機_」sheets) are gone with the GAS-side computation that read them."""
    def __init__(self, ledger, *, request) -> None:
        self.ledger = ledger
        self._gas_request = request
        self._mobile_publish_lock = threading.RLock()

    def status(self): return self.get_mobile_publish_status()
    def schedule(self, reason, *, delay_minutes, ledger_signature=None):
        return self.schedule_mobile_publish(reason, delay_minutes=delay_minutes, ledger_signature=ledger_signature)
    def publish_now(self): return self.publish_mobile_data()

    def get_mobile_publish_status(self) -> dict[str, Any]:
        self.ledger._count_runtime_operation("mobile_publish_status")
        due_text = self.ledger._get_meta("mobile_publish_due_at")
        return {
            "scheduled": bool(due_text),
            "due_at": due_text,
            "scheduled_at": self.ledger._get_meta("mobile_publish_scheduled_at"),
            "reason": self.ledger._get_meta("mobile_publish_reason"),
            **self.last_publish(),
            "failures": int(self.ledger._get_meta("mobile_publish_failures") or 0),
        }

    def last_publish(self) -> dict[str, Any]:
        """The last mobile upload; the publisher is the only writer of these meta keys."""
        return {
            "last_publish_at": self.ledger._get_meta("mobile_publish_last_at"),
            "last_publish_error": self.ledger._get_meta("mobile_publish_last_error"),
        }


    def schedule_mobile_publish(self, reason: str, delay_minutes: int = 30, ledger_signature: str | None = None) -> dict[str, Any]:
        """30 分鐘 debounce：每次新事件都把 due_at 往後重設 30 分鐘。

        與真正 publish 共用同一把 RLock，避免剛好發布時又新增交易，
        新事件排好的下一輪 due_at 被舊發布流程 cancel 掉。
        """
        with self._mobile_publish_lock:
            now = datetime.now()
            due = now + timedelta(minutes=max(1, int(delay_minutes)))
            self.ledger._set_meta_many(
                {
                    "mobile_publish_scheduled_at": now.isoformat(timespec="seconds"),
                    "mobile_publish_due_at": due.isoformat(timespec="seconds"),
                    "mobile_publish_reason": str(reason or "mobile_refresh"),
                    # The complete ledger this publish is for; empty: whatever is publishable when it is due.
                    "mobile_publish_ledger_signature": str(ledger_signature or ""),
                },
                caller="mobile_publish.schedule",
            )
            return {"ok": True, **self.get_mobile_publish_status()}


    def cancel_mobile_publish(self) -> None:
        self.ledger._set_meta_many(
            {
                "mobile_publish_due_at": "",
                "mobile_publish_scheduled_at": "",
                "mobile_publish_reason": "",
            },
            caller="mobile_publish.cancel",
        )


    def build_mobile_entries(self, today: date | None = None) -> dict[str, Any]:
        """The package the phone reads, computed from the ledger now (the same answer a publish would send)."""
        data = mobile_api.MobileData.from_ledger(self.ledger, self.ledger.security_master_path)
        return mobile_api.build_bundle(data, today or date.today())

    def _snapshot(self) -> tuple[dict[str, Any], str]:
        """The package and the publishable signature of the ledger it was computed from, read together under the
        ledger's lock: a sync replaces the trades and sets their signature under the same lock, so the two always
        describe one ledger (never new trades under the previous signature). The send happens after, unlocked."""
        with self.ledger._lock:
            return self.build_mobile_entries(), self.ledger._get_meta("ledger_publishable_signature").strip()

    def preview_mobile_data(self) -> dict[str, Any]:
        """The phone's cards for the desktop's 手機卡片 view: computed locally, nothing is sent to GAS."""
        return {**mobile_api.preview(self.ledger), "last_publish_at": self.ledger._get_meta("mobile_publish_last_at")}

    def publish_mobile_data(self, *, snapshot: tuple[dict[str, Any], str] | None = None) -> dict[str, Any]:
        with self._mobile_publish_lock:
            entries, signature = snapshot or self._snapshot()
            # With its UTC offset: the phone shows it as the data's time and parses it as an absolute instant.
            now = datetime.now().astimezone().isoformat(timespec="seconds")
            result = self._gas_request("mobilePublish", {"published_at": now, "entries": entries}, write=True)
            self.ledger._set_meta_many(
                {
                    "mobile_publish_last_at": now,
                    "mobile_publish_last_error": "",
                    "mobile_publish_due_at": "",
                    "mobile_publish_scheduled_at": "",
                    "mobile_publish_reason": "",
                    "mobile_publish_failures": "0",
                    # The ledger the phone now shows ("" when it was published by hand while incomplete).
                    "mobile_publish_last_signature": signature,
                },
                caller="mobile_publish.success",
            )
            return {"ok": True, "published_at": now, "entry_count": len(entries), "remote": result}


    def run_due_mobile_publish(self) -> dict[str, Any]:
        """Scheduler due check is memory-only until a publish is actually due."""
        self.ledger._count_runtime_operation("mobile_publish_due_check")
        with self._mobile_publish_lock:
            due_text = self.ledger._get_meta("mobile_publish_due_at").strip()
            if not due_text:
                return {"ok": True, "due": False, "published": False}
            try:
                due = datetime.fromisoformat(due_text)
            except Exception as exc:
                # A due time that cannot be read is not a cancelled publish: it is due now, and recorded.
                due = datetime.now()
                record_failure(_failure_log, f"reading the mobile publish due time {due_text[:40]!r}", exc)

            now = datetime.now()
            if now < due:
                return {
                    "ok": True,
                    "due": False,
                    "published": False,
                    "due_at": due_text,
                }

            # Published only while the ledger is still the complete one it was scheduled for: a rebuild since
            # (incomplete, or another revision whose own schedule follows) is not published under this schedule. The
            # signature compared is the one the package was computed from, not one read before it.
            wanted = self.ledger._get_meta("mobile_publish_ledger_signature").strip()
            snapshot = self._snapshot()
            current = snapshot[1]
            if wanted and wanted != current:
                self.cancel_mobile_publish()
                # not an error: the rebuild that replaced this ledger schedules its own publish when it is complete
                _failure_log.info("[MOBILE PUBLISH] schedule for ledger %s dropped, the ledger is now %s",
                                  wanted, current or "incomplete")
                return {"ok": True, "due": True, "published": False, "reason": "LEDGER_CHANGED"}

            try:
                result = self.publish_mobile_data(snapshot=snapshot)
                return {"ok": True, "due": True, "published": True, **result}
            except Exception as exc:
                # Sent once, never retried (decisions.md「GAS 請求失敗不自動重試」): the failure is recorded and shown in
                # the status; the next account change or the user's publish sends the package again.
                message = str(exc)
                failures = int(self.ledger._get_meta("mobile_publish_failures") or 0) + 1
                self.ledger._set_meta_many(
                    {
                        "mobile_publish_last_error": message,
                        "mobile_publish_failures": str(failures),
                        "mobile_publish_due_at": "",
                        "mobile_publish_scheduled_at": "",
                        "mobile_publish_reason": "",
                    },
                    caller="mobile_publish.failed",
                )
                record_failure(_failure_log, "publishing the phone's data to GAS", exc)
                return {"ok": False, "due": True, "published": False, "error": message}

