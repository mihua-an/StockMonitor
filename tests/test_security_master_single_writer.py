"""10-22 16:47: the Shioaji provider wrote its security master at login, and 0.5 s later the desktop's start asked it
to write it again while app_api was still reading the first one -- `os.replace` refused (WinError 5). The master has
one writer that writes it once a day (service/market/shioaji/maintenance.py), and it is replaced so that readers
opening it with delete sharing do not block it (service/platform/atomic_files.py)."""
from __future__ import annotations

import threading

from service.market.reference.security_master_service import SecurityInfo, SecurityMasterService
from service.market.shioaji import maintenance


class _Master:
    writes: list[str] = []
    release = threading.Event()

    def __init__(self, master_file, api_provider=None):
        self.master_file = master_file

    def update_master(self, api=None):
        self.writes.append("write")
        self.release.wait(5)
        return {"ok": True, "count": 3163}

    def load_master(self):
        return {"2330": object()}


def test_the_desktops_start_waits_for_the_logins_write_instead_of_writing_again(monkeypatch, tmp_path):
    monkeypatch.setattr(maintenance, "SecurityMasterService", _Master)
    monkeypatch.setattr(maintenance, "process_market_layout",
                        lambda: type("Layout", (), {"shioaji_security_master": tmp_path / "security_master.csv"})())
    _Master.writes, _Master.release = [], threading.Event()
    coordinator = maintenance.MarketMaintenanceCoordinator()
    answers = {}
    login = threading.Thread(target=lambda: answers.setdefault("login", coordinator.ensure_current(object(), day="2026-10-22")))
    login.start()
    while not _Master.writes:
        threading.Event().wait(0.01)
    start = threading.Thread(target=lambda: answers.setdefault("start", coordinator.ensure_current(object(), day="2026-10-22")))
    start.start()
    start.join(0.2)
    assert start.is_alive(), "the second caller waits for the write in flight"
    _Master.release.set()
    login.join(5)
    start.join(5)
    assert _Master.writes == ["write"]
    assert answers["login"]["ok"] and answers["start"] == {"ok": True, "current": True, "day": "2026-10-22", "count": 1,
                                                          "file": str(tmp_path / "security_master.csv")}
    coordinator.refresh_connected(object(), day="2026-10-22")
    assert _Master.writes == ["write", "write"], "an explicit refresh writes even when today's is there"
    coordinator.ensure_current(object(), day="2026-10-23")
    assert len(_Master.writes) == 3, "a new day is written again"


def test_the_master_is_replaced_while_a_reader_holds_it(tmp_path):
    from service.platform import atomic_files

    service = SecurityMasterService(tmp_path / "security_master.csv")
    row = SecurityInfo(code="2330", name="台積電", market="TSE", type="stock", industry_code="24", industry_name="",
                       source="shioaji_contracts", updated_at="2026-10-22")
    service.write_master([row])
    handle = None
    if atomic_files.os.name == "nt":
        kernel32, handle = atomic_files._open_handle(service.master_file, 0x80000000)   # a reader, as read_bytes_shared opens
    try:
        service.write_master([row, SecurityInfo(**{**row.__dict__, "code": "2317", "name": "鴻海"})])
    finally:
        if handle is not None:
            kernel32.CloseHandle(handle)
    assert sorted(SecurityMasterService(service.master_file).load_master()) == ["2317", "2330"]
