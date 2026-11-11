"""A scheduled phone publish is for the complete ledger it was scheduled with; a ledger rebuilt since is not
published under it (cancelled, recorded). The package and the signature it is checked against are read together, so
a sync landing while the package is computed can never be sent under the signature of the ledger before it."""
import threading
from datetime import datetime, timedelta

from service.account import account_report_publisher as arp


class ContendedLock:
    """The ledger's RLock, telling the test when another thread finds it held and has to wait."""

    def __init__(self):
        self._lock = threading.RLock()
        self.waiter_blocked = threading.Event()

    def __enter__(self):
        if not self._lock.acquire(blocking=False):
            self.waiter_blocked.set()
            self._lock.acquire()
        return self

    def __exit__(self, *exc):
        self._lock.release()


class FakeLedger:
    def __init__(self):
        self.meta = {}
        self._lock = ContendedLock()

    def _get_meta(self, key):
        return self.meta.get(key, "")

    def _set_meta_many(self, values, caller=""):
        self.meta.update(values)

    def _count_runtime_operation(self, name):
        pass


def _due(ledger):
    ledger.meta["mobile_publish_due_at"] = (datetime.now() - timedelta(seconds=1)).isoformat(timespec="seconds")


def test_a_changed_ledger_is_not_published_under_an_old_schedule(monkeypatch):
    ledger = FakeLedger()
    publisher = arp.AccountReportPublisher(ledger, request=lambda *a, **k: {"ok": True})
    monkeypatch.setattr(publisher, "build_mobile_entries", lambda today=None: {"cards": 1})
    published = []
    monkeypatch.setattr(publisher, "publish_mobile_data", lambda snapshot=None: published.append(snapshot) or {"ok": True})
    ledger.meta["ledger_publishable_signature"] = "sig-1"
    publisher.schedule_mobile_publish("sync_rebuild", delay_minutes=1, ledger_signature="sig-1")
    _due(ledger)
    ledger.meta["ledger_publishable_signature"] = ""            # a later rebuild was incomplete
    result = publisher.run_due_mobile_publish()
    assert result["published"] is False and result["reason"] == "LEDGER_CHANGED"
    assert published == []
    assert ledger.meta["mobile_publish_due_at"] == ""

    ledger.meta["ledger_publishable_signature"] = "sig-2"
    publisher.schedule_mobile_publish("sync_rebuild", delay_minutes=1, ledger_signature="sig-2")
    _due(ledger)
    assert publisher.run_due_mobile_publish()["published"] is True
    assert published == [({"cards": 1}, "sig-2")], "the package goes out with the signature it was computed under"


def test_a_failed_publish_is_sent_once_and_not_scheduled_again(monkeypatch, caplog):
    ledger = FakeLedger()
    calls = []

    def gas(name, payload, write):
        calls.append(name)
        raise RuntimeError("GAS 503")

    publisher = arp.AccountReportPublisher(ledger, request=gas)
    monkeypatch.setattr(publisher, "build_mobile_entries", lambda today=None: {"cards": 1})
    ledger.meta["ledger_publishable_signature"] = "sig-1"
    publisher.schedule_mobile_publish("sync_rebuild", delay_minutes=1, ledger_signature="sig-1")
    _due(ledger)
    result = publisher.run_due_mobile_publish()
    assert result == {"ok": False, "due": True, "published": False, "error": "GAS 503"}
    assert calls == ["mobilePublish"]
    assert ledger.meta["mobile_publish_due_at"] == "", "a failed publish is not rescheduled"
    assert ledger.meta["mobile_publish_last_error"] == "GAS 503" and ledger.meta["mobile_publish_failures"] == "1"
    assert "publishing the phone's data to GAS failed" in caplog.text
    assert publisher.run_due_mobile_publish()["due"] is False and calls == ["mobilePublish"]


def test_a_sync_during_the_package_build_waits_and_the_publish_sends_one_ledger(monkeypatch):
    ledger = FakeLedger()
    sent = []
    publisher = arp.AccountReportPublisher(ledger, request=lambda name, payload, write: sent.append(payload) or {"ok": True})
    ledger.meta["trades"] = "v1"
    ledger.meta["ledger_publishable_signature"] = "sig-1"
    building = threading.Event()

    def build(today=None):
        building.set()
        # a sync lands in the middle of the build: it must find the ledger held and wait for the snapshot
        assert ledger._lock.waiter_blocked.wait(5), "the sync was not held off while the package was built"
        return {"trades": ledger.meta["trades"]}

    monkeypatch.setattr(publisher, "build_mobile_entries", build)

    def sync():
        building.wait()
        # actual_account_sync replaces the trades and sets their signature under the ledger's lock.
        with ledger._lock:
            ledger.meta["trades"] = "v2"
            ledger.meta["ledger_publishable_signature"] = "sig-2"

    worker = threading.Thread(target=sync)
    worker.start()
    publisher.schedule_mobile_publish("sync_rebuild", delay_minutes=1, ledger_signature="sig-1")
    _due(ledger)
    result = publisher.run_due_mobile_publish()
    worker.join()
    assert result["published"] is True
    assert sent[0]["entries"] == {"trades": "v1"}, "the trades of the ledger sig-1 named, not the sync's"
    assert ledger.meta["mobile_publish_last_signature"] == "sig-1"
    assert ledger.meta["ledger_publishable_signature"] == "sig-2", "the sync went through after the snapshot"
