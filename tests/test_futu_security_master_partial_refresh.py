"""A Futu security-master refresh that fetched only some groups is not today's complete refresh: the failed groups
are fetched again the same day, after a back-off (R12-01)."""
from __future__ import annotations

import threading
import time
from pathlib import Path
from types import SimpleNamespace

from service.market.futu import security_master as sm


class _Catalog:
    def __init__(self, tmp_path: Path) -> None:
        self.security_master_path = tmp_path / "security_master.csv"
        self.written: list[dict] = []

    def read_security_master(self):
        return [dict(row) for row in self.written]

    def write_security_master(self, rows):
        self.written = [dict(row) for row in rows]
        self.security_master_path.write_text("written", encoding="utf-8")


_SDK = SimpleNamespace(Market=SimpleNamespace(US="US", CC="CC"),
                       SecurityType=SimpleNamespace(STOCK="STOCK", ETF="ETF", CRYPTO="CRYPTO"))


def _lifecycle(tmp_path: Path, call):
    catalog = _Catalog(tmp_path)
    lifecycle = sm.FutuSecurityMasterLifecycle(
        path=catalog.security_master_path, lock=threading.RLock(), catalog=catalog, sdk_provider=lambda: _SDK,
        call=call, worker_alive=lambda: True, wake=lambda: None)
    return lifecycle, catalog


def test_a_partial_refresh_is_retried_the_same_day(tmp_path, monkeypatch):
    import service.market.reference.security_master_feed as feed

    monkeypatch.setattr(feed, "publish_written", lambda *a, **k: None)
    failing = {"ETF"}

    def call(_context, _name, market, kind):
        if kind in failing:
            raise RuntimeError("OpenD timeout")
        return [{"code": f"{market}.{kind}1", "name": kind}]

    lifecycle, catalog = _lifecycle(tmp_path, call)
    first = lifecycle.refresh_if_needed(None)
    assert first["ok"] and first["coverage"] == "PARTIAL" and first["retry_groups"] == ["us/etf"]
    assert lifecycle.status()["last_error"], "a partial refresh is not reported as clean"
    assert lifecycle.retry_after > time.monotonic(), "retried after a back-off, not in a hot loop"
    assert lifecycle.refresh_if_needed(None)["skipped"] is True, "inside the back-off"

    lifecycle.retry_after = 0.0          # the back-off is over, the same day
    assert lifecycle.refresh_due(), "the failed group is due again today, not tomorrow"
    failing.clear()
    second = lifecycle.refresh_if_needed(None)
    assert second["coverage"] == "COMPLETE" and second["retry_groups"] == []
    assert lifecycle.status()["last_error"] is None and not lifecycle.refresh_due()


def test_the_file_of_a_partial_refresh_reads_back_as_not_complete(tmp_path, monkeypatch):
    """Restart: the kept group's rows carry their older fetch time, so the loaded master is due again."""
    import service.market.reference.security_master_feed as feed

    monkeypatch.setattr(feed, "publish_written", lambda *a, **k: None)
    lifecycle, catalog = _lifecycle(tmp_path, lambda _c, _n, market, kind: [{"code": f"{market}.{kind}1"}])
    lifecycle.refresh_if_needed(None)
    for row in catalog.written:           # that complete refresh happened yesterday
        row["updated_at"] = "2000-01-01T00:00:00.000+00:00"
    lifecycle.load()

    def call(_context, _name, market, kind):
        if kind == "ETF":
            raise RuntimeError("OpenD timeout")
        return [{"code": f"{market}.{kind}1"}]

    lifecycle._call = call
    lifecycle.refresh_requested = True
    lifecycle.refresh_if_needed(None)
    restarted, _ = _lifecycle(tmp_path, call)
    restarted._catalog = catalog
    restarted.load()
    assert restarted.updated_at.startswith("2000-01-01"), "complete as of the last full refresh"
    assert restarted.refresh_due()
