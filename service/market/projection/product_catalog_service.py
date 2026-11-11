from __future__ import annotations

import csv
import io
import os
import threading
import time
from pathlib import Path
from typing import Any, Iterable

import pandas as pd

from service.market.shared.provider_contract import normalize_provider_source
from service.market.storage.storage_codec import parquet_available, read_frame, write_frame
import logging
from service.platform.atomic_files import read_text_shared
from service.platform.change_feed import ChangeFeed
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)


CATALOG_COLUMNS = [
    "source", "provider", "provider_label", "code", "display_code", "name",
    "market", "type", "industry_code", "industry_name", "exchange_type",
    "lot_size", "listing_date", "stock_id",
]

# What a product page shows of a product besides its code: read from the catalog where the pages are shown, never
# kept with the pages (watch_page_service.py stores the user's data only).
METADATA_FIELDS = ("name", "industry_name", "market", "type")


def _text(value: Any) -> str:
    if value is None:
        return ""
    try:
        if pd.isna(value):
            return ""
    except Exception:  # not an error: pd.isna is undefined for array-like values; they are stringified below
        pass
    return str(value).strip()


class ProductCatalogService:
    """Unified local product catalog backed by one canonical Parquet file.

    Provider-specific raw masters remain owned by their data-plane services. This
    service materializes them into one read-optimized local catalog so UI search
    never has to query Shioaji/OpenD per keystroke.

    When it is rebuilt: once at the start of the owning process (``ensure_current``: a catalog found older than its
    masters then is a recorded remediation), whenever a provider writes its master (``source_written``, told by the
    provider's security-master stream: the normal daily update, not a remediation), and on a manual refresh. Reads
    never re-derive staleness. Every catalog file written is published on ``feed`` (Electron main reloads its copy).
    """

    def __init__(
        self,
        catalog_file: str | Path,
        *,
        shioaji_master_file: str | Path,
        futu_master_file: str | Path,
        enabled_sources: Iterable[str] = ("shioaji", "futu"),
    ) -> None:
        self.catalog_file = Path(catalog_file)
        self.shioaji_master_file = Path(shioaji_master_file)
        self.futu_master_file = Path(futu_master_file)
        # The catalog is built from the selected sources only (config/source_settings.py, fixed for the process): a
        # disabled source's master is neither required nor read, so its absence never fails a rebuild.
        enabled = set(enabled_sources)
        self._sources = [(name, path) for name, path in (("shioaji", self.shioaji_master_file),
                                                         ("futu", self.futu_master_file)) if name in enabled]
        self._lock = threading.RLock()
        self._rows: list[dict[str, Any]] = []
        self._index: dict[tuple[str, str], dict[str, Any]] = {}
        self._signature = ""
        # The source signature the last rebuild was attempted with: a rebuild that could not produce a catalog (its
        # sources are missing) is not attempted again -- and recorded again -- on every read until a source changes.
        self._attempted_signature: str | None = None
        # A rebuild that raised (I/O, a master that does not decode) is retried for the same source state, never more
        # often than this backoff: 30 s doubling to 30 min.
        self._failed_attempts = 0
        self._retry_at = 0.0
        self._last_error = ""
        # One rebuild at a time: the start check and the two providers' write notifications arrive on their own threads.
        self._rebuild_lock = threading.Lock()
        self.feed = ChangeFeed()
        self._load_existing()

    @staticmethod
    def _file_signature(path: Path) -> str:
        try:
            stat = path.stat()
            return f"{path}:{stat.st_size}:{stat.st_mtime_ns}"
        except OSError:  # not an error: a missing file is part of the fingerprint ("missing") by design
            return f"{path}:missing"

    def source_signature(self) -> str:
        return "|".join(self._file_signature(path) for _name, path in self._sources)

    def _catalog_stale_by_mtime(self) -> bool:
        try:
            catalog_mtime = self.catalog_file.stat().st_mtime_ns
        except OSError:  # not an error: no catalog yet: it is stale and gets built
            return True
        for _name, source in self._sources:
            try:
                if source.stat().st_mtime_ns > catalog_mtime:
                    return True
            except OSError:  # not an error: a missing master source cannot be newer than the catalog
                continue
        return False

    def _load_existing(self) -> None:
        if not self.catalog_file.exists() or not parquet_available():
            return
        try:
            frame = read_frame(self.catalog_file)
            # Products of a source this process does not run are not offered (they would have no quotes).
            enabled = {name for name, _path in self._sources}
            rows = [row for row in self._normalize_frame(frame) if row["source"] in enabled]
            with self._lock:
                self._set_rows(rows)
                self._signature = self.source_signature()
                self._last_error = ""
        except Exception as exc:
            record_failure(_failure_log, f"loading the product catalog {self.catalog_file} (it is rebuilt)", exc)
            with self._lock:
                self._last_error = str(exc)

    @staticmethod
    def _read_csv(path: Path) -> list[dict[str, str]]:
        if not path.exists():
            return []
        # Opened with delete sharing: a provider replaces its master while this reads it.
        return [dict(row) for row in csv.DictReader(io.StringIO(read_text_shared(path, "utf-8-sig"), newline=""))]

    @staticmethod
    def _provider_row(raw: dict[str, Any], source: str) -> dict[str, Any] | None:
        code = _text(raw.get("code")).upper()
        if not code:
            return None
        if source == "futu":
            market = _text(raw.get("market")).lower()
            if not market and "." in code:
                market = code.split(".", 1)[0].lower()
            display_code = code.split(".", 1)[1] if "." in code else code
            provider_label = "富途 Futu"
            provider = "futu"
        else:
            market = _text(raw.get("market")).lower()
            display_code = code
            provider_label = "永豐 Shioaji"
            provider = "shioaji"
        return {
            "source": source,
            "provider": provider,
            "provider_label": provider_label,
            "code": code,
            "display_code": display_code,
            "name": _text(raw.get("name")) or code,
            "market": market,
            "type": _text(raw.get("type") or raw.get("security_type")).lower(),
            "industry_code": _text(raw.get("industry_code")),
            "industry_name": _text(raw.get("industry_name") or raw.get("industry")),
            "exchange_type": _text(raw.get("exchange_type")),
            "lot_size": _text(raw.get("lot_size")),
            "listing_date": _text(raw.get("listing_date")),
            "stock_id": _text(raw.get("stock_id")),
        }

    @classmethod
    def _normalize_frame(cls, frame: pd.DataFrame) -> list[dict[str, Any]]:
        if frame is None or frame.empty:
            return []
        result: list[dict[str, Any]] = []
        for raw in frame.to_dict("records"):
            source = normalize_provider_source(_text(raw.get("source") or raw.get("provider")))
            row = cls._provider_row(raw, source)
            if row:
                result.append(row)
        return result

    def rebuild(self) -> dict[str, Any]:
        if not parquet_available():
            message = "PARQUET_ENGINE_REQUIRED: product catalog requires pyarrow"
            record_failure(_failure_log, f"rebuilding the product catalog ({message})")
            with self._lock:
                self._last_error = message
            return {"ok": False, "error": message, "count": len(self._rows), "file": str(self.catalog_file)}

        # _read_csv() returns [] for a file that is not there, so a rebuild with no sources on
        # disk would build zero rows, WRITE those zero rows over a perfectly good catalog,
        # clear last_error and return ok=True: a fresh install or a failed master refresh could
        # destroy the catalog and report success. Missing sources are therefore named, and a
        # rebuild that would replace real rows with nothing is refused.
        missing_sources = [name for name, path in self._sources if not Path(path).exists()]

        rows: list[dict[str, Any]] = []
        read_counts: dict[str, int] = {}
        for name, path in self._sources:
            before = len(rows)
            for raw in self._read_csv(path):
                row = self._provider_row(raw, name)
                if row:
                    rows.append(row)
            read_counts[name] = len(rows) - before
        # A master present but empty is as absent as a missing one (a refresh that failed half way).
        absent = sorted(set(missing_sources) | {name for name, count in read_counts.items() if count == 0})

        # One provider's master temporarily absent must not erase that provider from the catalog. While
        # the catalog on disk still holds its products, the file is left as it is (DEGRADED, retained).
        with self._lock:
            held = {name for name in absent if any(row.get("source") == name for row in self._rows)}
        if held:
            message = f"PRODUCT_CATALOG_SOURCES_MISSING: {', '.join(absent)}; catalog kept unchanged"
            record_failure(_failure_log, f"rebuilding the product catalog ({message})")
            with self._lock:
                self._last_error = message
                retained = len(self._rows)
                # This source state was judged: searches do not re-read the masters until a master file changes.
                self._signature = self.source_signature()
            return {
                **self.status(), "ok": False, "rebuilt": False, "state": "DEGRADED",
                "error": message, "missing_sources": absent, "retained_count": retained,
                "retained_sources": sorted(held),
            }

        if missing_sources and not rows:
            message = f"PRODUCT_CATALOG_SOURCES_MISSING: {', '.join(missing_sources)}"
            record_failure(_failure_log, f"rebuilding the product catalog ({message})")
            with self._lock:
                self._last_error = message
                retained = len(self._rows)
            # Keep whatever is already loaded and whatever is already on disk. DEGRADED, not a
            # successful rebuild of an empty catalog.
            return {
                **self.status(), "ok": False, "rebuilt": False, "state": "DEGRADED",
                "error": message, "missing_sources": missing_sources, "retained_count": retained,
            }

        # Provider + canonical code is the stable identity. Keep the last row if
        # a source emits a duplicate during contract refresh.
        unique: dict[tuple[str, str], dict[str, Any]] = {}
        for row in rows:
            unique[(row["source"], row["code"])] = row
        order = lambda row: (row["source"], row["market"], row["type"], row["code"])  # noqa: E731
        rows = sorted(unique.values(), key=order)
        # A master refresh rewrites its file (new time stamps) however few products changed: when the products are
        # exactly the catalog's, nothing is rebuilt -- the new source state is only remembered.
        with self._lock:
            unchanged = self.catalog_file.exists() and rows == sorted(self._rows, key=order)
        if unchanged:
            # The catalog file is current for these sources: its time says so, or the start check (a source newer
            # than the catalog) would take it for stale and read both masters again on every call, for good.
            try:
                os.utime(self.catalog_file)
            except OSError as exc:
                record_failure(_failure_log, "marking the unchanged product catalog current", exc)
            signature = self.source_signature()
            with self._lock:
                self._signature = signature
                self._last_error = ""
            return {**self.status(), "ok": True, "rebuilt": False, "unchanged": True,
                    "state": "DEGRADED" if missing_sources else "OK", "missing_sources": missing_sources}
        frame = pd.DataFrame(rows, columns=CATALOG_COLUMNS).fillna("")
        write_frame(frame, self.catalog_file, validate_readback=True)
        signature = self.source_signature()
        with self._lock:
            self._set_rows(rows)
            self._signature = signature
            self._last_error = ""
        self.feed.publish({"revision": self.revision()})
        return {
            **self.status(), "ok": True, "rebuilt": True,
            "state": "DEGRADED" if missing_sources else "OK",
            "missing_sources": missing_sources,
        }

    def revision(self) -> str:
        """The catalog file's identity: it changes exactly when a rebuild writes the catalog."""
        return self._file_signature(self.catalog_file)

    def source_written(self, change: dict[str, Any]) -> dict[str, Any]:
        """A provider wrote its security master (security_master_watch.py; the stream also opens with the master's
        current state). Rebuilt when the masters differ from the state the catalog was built from -- the normal update,
        so no remediation is recorded; a rebuild that fails is recorded as a failure and stated by the status."""
        source = str(change.get("source") or "")
        with self._rebuild_lock:
            current = self.source_signature()
            with self._lock:
                applied = current == self._signature
            if applied:
                return {**self.status(), "ok": True, "rebuilt": False}
            try:
                result = self.rebuild()
            except Exception as exc:
                record_failure(_failure_log, f"rebuilding the product catalog after the {source} security master was written", exc)
                with self._lock:
                    self._last_error = f"PRODUCT_CATALOG_REBUILD_FAILED: {type(exc).__name__}: {exc}"
                return {**self.status(), "ok": False, "rebuilt": False, "state": "DEGRADED", "error": self._last_error}
            with self._lock:
                self._attempted_signature = current
                self._failed_attempts = 0
                self._retry_at = 0.0
            _failure_log.info("[PRODUCT CATALOG] %s security master written (revision %s): rebuilt=%s unchanged=%s state=%s count=%s",
                              source, change.get("revision"), bool(result.get("rebuilt")), bool(result.get("unchanged")),
                              result.get("state"), result.get("count"))
            return result

    def ensure_current(self, *, force: bool = False) -> dict[str, Any]:
        with self._rebuild_lock:
            return self._ensure_current(force=force)

    def _ensure_current(self, *, force: bool) -> dict[str, Any]:
        current = self.source_signature()
        with self._lock:
            loaded = bool(self._rows)
            signature = self._signature
            attempted = self._attempted_signature
        if not force and not loaded and attempted == current:
            state = self.status()
            return {**state, "ok": state.get("state") != "DEGRADED", "rebuilt": False}
        trigger = ("manual" if force else "not_loaded" if not loaded else "source_changed" if signature != current
                   else "catalog_stale" if self._catalog_stale_by_mtime() else None)
        if trigger:
            with self._lock:
                waiting = self._retry_at > time.monotonic()
            if waiting and not force:
                state = self.status()
                return {**state, "ok": False, "rebuilt": False}
            try:
                result = self.rebuild()
            except Exception as exc:
                # Not a judgement of the source state: the same state is tried again after the backoff, and the
                # failure is both the status's last error and a recorded failed rebuild.
                record_failure(_failure_log, "rebuilding the product catalog", exc)
                with self._lock:
                    self._last_error = f"PRODUCT_CATALOG_REBUILD_FAILED: {type(exc).__name__}: {exc}"
                    self._failed_attempts += 1
                    self._retry_at = time.monotonic() + min(1800.0, 30.0 * 2 ** (self._failed_attempts - 1))
                    attempt = self._failed_attempts
                result = {**self.status(), "ok": False, "rebuilt": False, "state": "DEGRADED", "error": self._last_error,
                          "attempt": attempt}
            else:
                # Only a classified result settles this source state: searches do not rebuild it again.
                with self._lock:
                    self._attempted_signature = current
                    self._failed_attempts = 0
                    self._retry_at = 0.0
            # Every rebuild of this derived artifact is recorded with why and how it ended; a source state whose
            # products are the catalog's already rebuilt nothing and records nothing.
            if result.get("unchanged"):
                return result
            try:
                from service.platform.remediation import emitter

                emitter().emit(component="product_catalog", mechanism_id="reference.catalog_rebuild", trigger_reason=trigger,
                               outcome="succeeded" if result.get("ok") else "failed",
                               detail={"state": result.get("state"), "rebuilt": result.get("rebuilt"), "error": result.get("error"),
                                       "attempt": result.get("attempt"),
                                       "missing_sources": result.get("missing_sources"), "count": result.get("count")})
            except Exception as exc:
                record_failure(_failure_log, "recording the product catalog rebuild event", exc)
            return result
        state = self.status()
        return {**state, "ok": state.get("state") != "DEGRADED", "rebuilt": False}

    def _set_rows(self, rows: list[dict[str, Any]]) -> None:
        """Called with the lock held: the rows and their (source, code) index change together."""
        self._rows = rows
        self._index = {(row["source"], row["code"]): row for row in rows}

    def metadata(self, source: str, code: str) -> dict[str, str]:
        """A product's name, industry, market and type as the catalog lists them; empty for one it does not list."""
        key = (normalize_provider_source(_text(source)), _text(code).upper())
        with self._lock:
            row = self._index.get(key) or {}
        return {name: _text(row.get(name)) for name in METADATA_FIELDS}

    def with_metadata(self, pages: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
        """Product pages (WatchPageService.list_pages) with each item's metadata read from the catalog now."""
        return [{**page, "items": [{**item, **self.metadata(item.get("source") or page.get("source"), item.get("code"))}
                                   for item in page.get("items") or ()]} for page in pages]

    def rows(self) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(row) for row in self._rows]

    def search(self, source: str, query: str, *, market: str = "", limit: int = 50) -> list[dict[str, Any]]:
        provider = normalize_provider_source(_text(source))   # an unknown source raises SOURCE_UNKNOWN
        keyword = _text(query).lower()
        market_filter = _text(market).lower()
        maximum = max(1, min(200, int(limit or 50)))
        rows = self.rows()
        ranked: list[tuple[int, int, int, str, dict[str, Any]]] = []
        for row in rows:
            if row.get("source") != provider:
                continue
            if market_filter and market_filter not in {"all", "*"} and _text(row.get("market")).lower() != market_filter:
                continue
            code = _text(row.get("code")).lower()
            display = _text(row.get("display_code")).lower()
            name = _text(row.get("name")).lower()
            if not keyword:
                score, pos = 8, 0
            elif keyword in {code, display}:
                score, pos = 0, 0
            elif display.startswith(keyword) or code.startswith(keyword):
                score, pos = 1, 0
            elif keyword in display:
                score, pos = 2, display.index(keyword)
            elif keyword in code:
                score, pos = 2, code.index(keyword)
            elif name == keyword:
                score, pos = 3, 0
            elif name.startswith(keyword):
                score, pos = 4, 0
            elif keyword in name:
                score, pos = 5, name.index(keyword)
            else:
                continue
            type_rank = 0 if _text(row.get("type")).lower() in {"stock", "etf", "etn", "reit", "crypto"} else 1
            ranked.append((score, pos, type_rank, code, row))
        ranked.sort(key=lambda item: item[:4])
        return [dict(item[4]) for item in ranked[:maximum]]

    def status(self) -> dict[str, Any]:
        with self._lock:
            rows = [dict(row) for row in self._rows]
            last_error = self._last_error
        by_source: dict[str, int] = {}
        by_market: dict[str, int] = {}
        for row in rows:
            src = _text(row.get("source")) or "unknown"
            market = _text(row.get("market")).lower() or "unknown"
            by_source[src] = by_source.get(src, 0) + 1
            by_market[f"{src}:{market}"] = by_market.get(f"{src}:{market}", 0) + 1
        # Every surface that reports the catalog gets the same two fields, so "0 items" can
        # never again be read as a healthy empty catalog: `missing_sources` names what is not on
        # disk, and `state` is DEGRADED whenever a required source is absent or the last rebuild
        # failed. One stat() per selected source per status read.
        missing_sources = [name for name, path in self._sources if not Path(path).exists()]
        return {
            "file": str(self.catalog_file),
            "format": "parquet",
            "count": len(rows),
            "by_source": by_source,
            "by_market": by_market,
            "source_signature": self.source_signature(),
            "revision": self.revision(),
            "last_error": last_error or None,
            "missing_sources": missing_sources,
            "state": "DEGRADED" if (missing_sources or last_error) else "OK",
        }
