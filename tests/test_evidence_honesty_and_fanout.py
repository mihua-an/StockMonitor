"""Behaviour tests for five defects where the system reported something it had not measured.

Common theme: a component that could not answer a question answered it anyway -- with a zero, an
empty list, or a second component's data merged in silently. Each test below fails if its fix is
reverted; none of them assert on source text.
"""
from __future__ import annotations

import threading
from pathlib import Path

import pytest


# --------------------------------------------------------------------------------------------
# Item 22 -- a missing security master is not an empty security master.
# --------------------------------------------------------------------------------------------
def _security_master(tmp_path: Path, *, rows: list[dict] | None = None):
    from service.market.futu.security_master import FutuSecurityMasterLifecycle

    source = tmp_path / "security_master-A.csv"

    class Catalog:
        security_master_path = source

        def read_security_master(self):
            return list(rows or [])

    return FutuSecurityMasterLifecycle(
        path=tmp_path / "state.json",
        lock=threading.RLock(),
        catalog=Catalog(),
        sdk_provider=lambda: None,
        call=lambda *a, **k: None,
        worker_alive=lambda: False,
        wake=lambda: None,
    ), source


def test_missing_security_master_is_reported_not_silently_empty(tmp_path: Path) -> None:
    lifecycle, source = _security_master(tmp_path)
    assert not source.exists()

    lifecycle.load()

    status = lifecycle.status()
    assert status["last_error"] == "SECURITY_MASTER_NOT_FOUND", (
        "a source file that is not there must be distinguishable from a master that legitimately "
        "holds zero securities"
    )


def test_missing_security_master_keeps_the_last_known_good_rows(tmp_path: Path) -> None:
    good = [{"code": "US.AAPL", "market": "us"}]
    lifecycle, source = _security_master(tmp_path, rows=good)
    source.write_text("code,market\nUS.AAPL,us\n", encoding="utf-8")
    lifecycle.load()
    assert lifecycle.status()["count"] == 1

    source.unlink()
    lifecycle.load()

    assert lifecycle.status()["count"] == 1, "a vanished source must not wipe what is loaded"
    assert lifecycle.status()["last_error"] == "SECURITY_MASTER_NOT_FOUND"


# --------------------------------------------------------------------------------------------
# Item 17 -- a rebuild with no sources must not overwrite a good catalog and call it success.
# --------------------------------------------------------------------------------------------
def test_rebuild_refuses_to_replace_a_good_catalog_with_nothing(tmp_path: Path) -> None:
    pytest.importorskip("pyarrow")
    from service.market.projection.product_catalog_service import ProductCatalogService

    shioaji_master = tmp_path / "shioaji.csv"
    shioaji_master.write_text(
        "code,name,market,type\n2330,台積電,tse,stock\n", encoding="utf-8",
    )
    service = ProductCatalogService(
        tmp_path / "catalog.parquet",
        shioaji_master_file=shioaji_master,
        futu_master_file=tmp_path / "absent.csv",
    )
    first = service.rebuild()
    assert first["ok"] is True and first["count"] == 1
    # One source present, one absent: still a usable catalog, but honestly degraded.
    assert first["state"] == "DEGRADED"
    assert first["missing_sources"] == ["futu"]

    shioaji_master.unlink()
    second = service.rebuild()

    assert second["ok"] is False, "a rebuild that can read no source is not a successful rebuild"
    assert second["rebuilt"] is False
    assert second["state"] == "DEGRADED"
    assert sorted(second["missing_sources"]) == ["futu", "shioaji"]
    assert second["retained_count"] == 1
    assert service.status()["count"] == 1, "the loaded catalog must survive a sourceless rebuild"
    assert [row["code"] for row in service.rows()] == ["2330"]


def test_catalog_status_always_names_missing_sources(tmp_path: Path) -> None:
    from service.market.projection.product_catalog_service import ProductCatalogService

    service = ProductCatalogService(
        tmp_path / "catalog.parquet",
        shioaji_master_file=tmp_path / "absent-a.csv",
        futu_master_file=tmp_path / "absent-b.csv",
    )
    status = service.status()
    assert status["state"] == "DEGRADED"
    assert sorted(status["missing_sources"]) == ["futu", "shioaji"]




def test_q27_one_providers_absent_master_never_erases_it_from_the_catalog(tmp_path: Path) -> None:
    # Futu's master briefly absent (OpenD down at refresh) rewrote the catalog without any Futu product.
    from service.market.projection.product_catalog_service import ProductCatalogService
    from service.market.storage.storage_codec import read_frame

    shioaji_master, futu_master = tmp_path / "shioaji.csv", tmp_path / "futu.csv"
    shioaji_master.write_text("code,name,market,type\n2330,台積電,tse,stock\n", encoding="utf-8")
    futu_master.write_text("code,name,market,type\nUS.AAPL,Apple,us,stock\n", encoding="utf-8")
    catalog = tmp_path / "catalog.parquet"
    service = ProductCatalogService(catalog, shioaji_master_file=shioaji_master, futu_master_file=futu_master)
    assert service.rebuild()["state"] == "OK"
    before = catalog.read_bytes()

    futu_master.unlink()
    shioaji_master.write_text("code,name,market,type\n2330,台積電,tse,stock\n2317,鴻海,tse,stock\n", encoding="utf-8")
    result = service.rebuild()
    assert result["ok"] is False and result["state"] == "DEGRADED" and result["retained_sources"] == ["futu"]
    assert catalog.read_bytes() == before, "the file on disk is left as it was"
    assert sorted(read_frame(catalog)["code"]) == ["2330", "US.AAPL"]
    assert [row["code"] for row in service.search("futu", "AAPL")] == ["US.AAPL"]

    futu_master.write_text("", encoding="utf-8")  # present but empty: just as absent
    assert service.rebuild()["retained_sources"] == ["futu"]
    futu_master.write_text("code,name,market,type\nUS.AAPL,Apple,us,stock\n", encoding="utf-8")
    assert service.rebuild()["state"] == "OK" and service.status()["count"] == 3


def test_a_rebuild_that_raises_is_reported_recorded_and_retried(tmp_path: Path, monkeypatch) -> None:
    # The source state was marked attempted before the rebuild ran, so a rebuild that raised was
    # never tried again for that state, status stayed OK and no failed rebuild was recorded.
    pytest.importorskip("pyarrow")
    from service.market.projection import product_catalog_service as module
    from service.platform import remediation

    shioaji_master, futu_master = tmp_path / "shioaji.csv", tmp_path / "futu.csv"
    shioaji_master.write_text("code,name,market,type\n2330,台積電,tse,stock\n", encoding="utf-8")
    futu_master.write_text("code,name,market,type\nUS.AAPL,Apple,us,stock\n", encoding="utf-8")
    service = module.ProductCatalogService(tmp_path / "catalog.parquet", shioaji_master_file=shioaji_master,
                                           futu_master_file=futu_master)
    events = []
    monkeypatch.setattr(remediation, "emitter", lambda: type("E", (), {"emit": lambda self, **kw: events.append(kw)})())
    real_write = module.write_frame
    monkeypatch.setattr(module, "write_frame", lambda *a, **k: (_ for _ in ()).throw(OSError("disk full")))

    first = service.ensure_current()
    assert first["ok"] is False and first["state"] == "DEGRADED" and "disk full" in first["error"]
    assert service.status()["state"] == "DEGRADED", "the status names the failure"
    assert events[-1]["outcome"] == "failed" and "disk full" in events[-1]["detail"]["error"]
    assert service.ensure_current()["ok"] is False and len(events) == 1, "inside the backoff: not rebuilt again"

    monkeypatch.setattr(module, "write_frame", real_write)
    service._retry_at = 0.0  # the backoff has passed
    again = service.ensure_current()
    assert again["ok"] is True and again["rebuilt"] is True and service.status()["state"] == "OK"
    assert events[-1]["outcome"] == "succeeded"


def test_a_disabled_sources_missing_master_neither_fails_nor_degrades_the_catalog(tmp_path: Path) -> None:
    """Only the selected sources' masters are required (config/source_settings.py): with Futu disabled its absent master
    is not a missing source, and a catalog row of it left on disk is not offered."""
    from service.market.projection.product_catalog_service import ProductCatalogService

    shioaji_master, futu_master = tmp_path / "shioaji.csv", tmp_path / "futu.csv"
    shioaji_master.write_text("code,name,market,type\n2330,台積電,tse,stock\n", encoding="utf-8")
    futu_master.write_text("code,name,market,type\nUS.AAPL,Apple,us,stock\n", encoding="utf-8")
    catalog = tmp_path / "catalog.parquet"
    assert ProductCatalogService(catalog, shioaji_master_file=shioaji_master, futu_master_file=futu_master).rebuild()["count"] == 2
    futu_master.unlink()
    service = ProductCatalogService(catalog, shioaji_master_file=shioaji_master, futu_master_file=futu_master,
                                    enabled_sources={"shioaji"})
    assert service.status()["by_source"] == {"shioaji": 1}, "the disabled source's rows are not offered"
    result = service.rebuild()
    assert result["ok"] is True and result["state"] == "OK" and result["missing_sources"] == []
    assert service.status()["state"] == "OK"
