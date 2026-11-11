"""A master refresh that changes no product does not rebuild the product catalog (BACKLOG 1k, 10-18: both masters stamp
every row's updated_at on each refresh, so every refresh used to rebuild the catalog and record a remediation)."""
from __future__ import annotations

import os
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

HEADER = "code,name,market,type,source,updated_at\n"


def _rebuilds(monkeypatch):
    from service.platform import remediation

    emitted = []
    monkeypatch.setattr(remediation, "emitter", lambda: SimpleNamespace(emit=lambda **kw: emitted.append(kw)))
    return lambda: [e for e in emitted if e.get("mechanism_id") == "reference.catalog_rebuild"]


def _write(path: Path, rows: str, stamp: str) -> None:
    path.write_text(HEADER + "".join(f"{row},{stamp}\n" for row in rows.splitlines()), encoding="utf-8")
    later = time.time() + 5   # a refresh is later than the catalog that was built
    os.utime(path, (later, later))


def test_a_refresh_with_only_new_time_stamps_rebuilds_nothing(tmp_path: Path, monkeypatch) -> None:
    pytest.importorskip("pyarrow")
    from service.market.projection.product_catalog_service import ProductCatalogService

    rebuilds = _rebuilds(monkeypatch)
    shioaji, futu = tmp_path / "shioaji.csv", tmp_path / "futu.csv"
    _write(shioaji, "2330,台積電,tse,stock,shioaji\n2317,鴻海,tse,stock,shioaji", "2026-10-17 07:24:00")
    _write(futu, "US.AAPL,Apple,us,stock,futu", "2026-10-17 07:24:00")
    catalog = tmp_path / "catalog.parquet"
    service = ProductCatalogService(catalog, shioaji_master_file=shioaji, futu_master_file=futu)
    assert service.ensure_current()["rebuilt"] is True and len(rebuilds()) == 1
    before = catalog.read_bytes()

    # The next start's refresh: the same products, every row stamped anew.
    _write(shioaji, "2330,台積電,tse,stock,shioaji\n2317,鴻海,tse,stock,shioaji", "2026-10-18 07:34:18")
    _write(futu, "US.AAPL,Apple,us,stock,futu", "2026-10-18 08:00:06")
    result = service.ensure_current()
    assert result["ok"] is True and result["rebuilt"] is False
    assert len(rebuilds()) == 1, "no rebuild recorded"
    assert catalog.read_bytes() == before, "the catalog file is not rewritten"
    assert service.ensure_current()["rebuilt"] is False and len(rebuilds()) == 1, "the new source state is remembered"

    # A product really added: rebuilt, and recorded.
    _write(shioaji, "2330,台積電,tse,stock,shioaji\n2317,鴻海,tse,stock,shioaji\n2454,聯發科,tse,stock,shioaji", "2026-10-19 07:30:00")
    result = service.ensure_current()
    assert result["rebuilt"] is True and result["count"] == 4
    assert [e["trigger_reason"] for e in rebuilds()][-1] == "source_changed" and len(rebuilds()) == 2


def test_a_new_process_reads_the_catalog_without_rebuilding(tmp_path: Path, monkeypatch) -> None:
    pytest.importorskip("pyarrow")
    from service.market.projection.product_catalog_service import ProductCatalogService

    shioaji, futu = tmp_path / "shioaji.csv", tmp_path / "futu.csv"
    _write(shioaji, "2330,台積電,tse,stock,shioaji", "2026-10-17 07:24:00")
    _write(futu, "US.AAPL,Apple,us,stock,futu", "2026-10-17 07:24:00")
    catalog = tmp_path / "catalog.parquet"
    ProductCatalogService(catalog, shioaji_master_file=shioaji, futu_master_file=futu).ensure_current()
    rebuilds = _rebuilds(monkeypatch)
    _write(shioaji, "2330,台積電,tse,stock,shioaji", "2026-10-18 07:34:18")   # refreshed while the App was closed
    restarted = ProductCatalogService(catalog, shioaji_master_file=shioaji, futu_master_file=futu)
    assert restarted.ensure_current()["rebuilt"] is False and rebuilds() == []
    assert sorted(row["code"] for row in restarted.rows()) == ["2330", "US.AAPL"]


def test_concurrent_callers_share_one_rebuild(tmp_path: Path, monkeypatch) -> None:
    """R13-22: the start check and both providers' write notices arrive together; one of them rebuilds, the others
    find the catalog current."""
    pytest.importorskip("pyarrow")
    import threading

    from service.market.projection.product_catalog_service import ProductCatalogService

    rebuilds = _rebuilds(monkeypatch)
    shioaji, futu = tmp_path / "shioaji.csv", tmp_path / "futu.csv"
    shioaji.write_text(HEADER + "2330,台積電,tse,stock,shioaji,2026-10-17 07:24:00\n", encoding="utf-8")
    futu.write_text(HEADER + "US.AAPL,Apple,us,stock,futu,2026-10-17 07:24:00\n", encoding="utf-8")
    service = ProductCatalogService(tmp_path / "catalog.parquet", shioaji_master_file=shioaji, futu_master_file=futu)
    real, built = service.rebuild, []

    def slow_rebuild():
        built.append(1)
        time.sleep(0.1)
        return real()

    monkeypatch.setattr(service, "rebuild", slow_rebuild)
    barrier = threading.Barrier(4)
    threads = [threading.Thread(target=lambda: (barrier.wait(), service.ensure_current())) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10)
    assert built == [1] and len(rebuilds()) == 1


def test_after_an_unchanged_refresh_the_masters_are_not_read_again(tmp_path: Path, monkeypatch) -> None:
    """A refresh that only re-stamped the masters left the catalog older than them: every later call (and every
    start) took the catalog for stale and read both masters again."""
    pytest.importorskip("pyarrow")
    from service.market.projection.product_catalog_service import ProductCatalogService

    _rebuilds(monkeypatch)
    shioaji, futu = tmp_path / "shioaji.csv", tmp_path / "futu.csv"
    _write(shioaji, "2330,台積電,tse,stock,shioaji", "2026-10-17 07:24:00")
    _write(futu, "US.AAPL,Apple,us,stock,futu", "2026-10-17 07:24:00")
    catalog = tmp_path / "catalog.parquet"
    service = ProductCatalogService(catalog, shioaji_master_file=shioaji, futu_master_file=futu)
    service.ensure_current()
    os.utime(catalog, (time.time() - 100, time.time() - 100))   # built a while ago
    _write(shioaji, "2330,台積電,tse,stock,shioaji", "2026-10-18 07:34:18")
    refreshed = time.time() - 50                                   # then the master was refreshed
    os.utime(shioaji, (refreshed, refreshed))
    os.utime(futu, (refreshed, refreshed))
    assert service.ensure_current()["rebuilt"] is False
    real, calls = service.rebuild, []
    monkeypatch.setattr(service, "rebuild", lambda: calls.append(1) or real())
    for _ in range(3):
        service.ensure_current()
    assert calls == [], "the unchanged catalog is current: no master is read again"
