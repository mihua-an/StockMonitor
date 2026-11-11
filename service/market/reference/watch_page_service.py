from __future__ import annotations

import csv
import io
import math
from copy import deepcopy
import threading
import uuid
from pathlib import Path
from typing import Any

from service.market.shared.provider_contract import normalize_provider_source
from service.platform.atomic_files import write_bytes_atomic

_ALERT_LABELS = {"lower_alert": "低價提醒", "upper_alert": "高價提醒"}


def parse_optional_alert(value: Any, *, code: str, field: str) -> float | None:
    """A price alert of a watch-page item, for both the API save and the CSV read: empty is no alert, anything else
    must be a finite number -- never silently cleared."""
    text = "" if value is None else str(value).strip()
    if not text:
        return None
    try:
        number = float(text)
    except ValueError:  # not an error: not a number -- raised just below as this item's validation error
        number = math.nan
    if not math.isfinite(number):
        raise ValueError(f"{code} 的{_ALERT_LABELS.get(field, field)}不是有效數字：{text}")
    return number


class WatchPageService:
    """Provider-aware watch-page persistence with a Shioaji active-universe view.

    ``data/preferences/watch_pages.csv`` stores both Shioaji and Futu pages.  Runtime methods
    such as :meth:`load` / :meth:`all_codes` deliberately project only Shioaji
    pages so Futu/CC products can never leak into the Shioaji subscription
    universe.  The full page metadata remains available to Electron/Futu.

    The file holds the user's data only: pages, their products' source and code, the order and the alerts. A
    product's name, industry, market and type belong to the product catalog (product_catalog_service.py), joined
    where the pages are shown; the name/type columns a file written before still has (code_name, industry_name,
    market, security_type) are not read, and the next save leaves them out.
    """

    FIELDNAMES = [
        "page_id",
        "page_name",
        "page_source",
        "page_order",
        "code",
        "code_order",
        "source",
        "lower_alert",
        "upper_alert",
    ]

    def __init__(self, path: str | Path) -> None:
        requested = Path(path)
        self.path = requested.with_suffix(".csv") if requested.suffix.lower() != ".csv" else requested
        self._lock = threading.RLock()
        self._pages_cache: list[dict[str, Any]] | None = None
        self._pages_cache_signature: tuple[int, int] | None = None
        # provider -> (file signature, its codes): recomputed only when the CSV changed.
        self._codes_cache: dict[str, tuple[tuple[int, int] | None, frozenset[str]]] = {}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Electron owns production writes. A reader starting before the first
        # save must not replace a concurrently created CSV with an empty file.

    def _file_signature(self) -> tuple[int, int] | None:
        try:
            stat = self.path.stat()
            return int(stat.st_mtime_ns), int(stat.st_size)
        except OSError:  # not an error: no watch page file yet: no signature
            return None

    def _cached_pages(self) -> list[dict[str, Any]]:
        """Read watch pages only when the authoritative CSV has changed."""
        signature = self._file_signature()
        if self._pages_cache is None or signature != self._pages_cache_signature:
            self._pages_cache = self._read_csv()
            # If Electron replaces the file during the read, retain the earlier
            # signature so the next read detects it instead of caching old rows
            # under the newer file's signature.
            self._pages_cache_signature = signature
        return deepcopy(self._pages_cache)

    @staticmethod
    def _normalize_item(raw: Any) -> dict[str, Any] | None:
        # An item is an object; a bare code string was the page's old shape and is refused.
        if not isinstance(raw, dict):
            raise ValueError(f"watch page item must be an object with a code, got {type(raw).__name__}: {raw!r}"[:200])
        code = str(raw.get("code") or "").strip().upper()
        if not code:
            return None
        return {
            "code": code,
            "source": normalize_provider_source(raw.get("source")),
            "lower_alert": parse_optional_alert(raw.get("lower_alert"), code=code, field="lower_alert"),
            "upper_alert": parse_optional_alert(raw.get("upper_alert"), code=code, field="upper_alert"),
        }

    def _normalize_pages(self, pages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        normalized: list[dict[str, Any]] = []
        used_ids: set[str] = set()
        for index, page in enumerate(pages or []):
            if not isinstance(page, dict):
                continue
            page_id = str(page.get("id") or uuid.uuid4().hex[:10]).strip()
            if not page_id or page_id in used_ids:
                page_id = uuid.uuid4().hex[:10]
            used_ids.add(page_id)
            name = str(page.get("name") or f"自選{index + 1}").strip() or f"自選{index + 1}"
            page_source = normalize_provider_source(page.get("source"))
            page_market = "us" if page_source == "futu" else "tw"

            raw_items: list[Any] = list(page.get("items") or [])

            items: list[dict[str, Any]] = []
            seen: set[str] = set()
            for raw in raw_items:
                item = self._normalize_item(raw)
                if not item or item["code"] in seen:
                    continue
                seen.add(item["code"])
                items.append(item)

            normalized.append({
                "id": page_id,
                "name": name,
                "source": page_source,
                "market": page_market,
                "codes": [item["code"] for item in items],
                "items": items,
            })
        return normalized

    def _write_csv(self, pages: list[dict[str, Any]]) -> None:
        # One durable, atomic replace through the shared writer: a unique temporary file removed whatever happens,
        # the data and the rename synced (a user's watch pages must survive a power loss).
        fh = io.StringIO(newline="")
        writer = csv.DictWriter(fh, fieldnames=self.FIELDNAMES)
        writer.writeheader()
        for page_order, page in enumerate(pages):
            items = list(page.get("items") or [])
            if not items:
                writer.writerow({
                    "page_id": page["id"], "page_name": page["name"],
                    "page_source": page.get("source", "shioaji"),
                    "page_order": page_order, "code": "", "code_order": "",
                    "lower_alert": "", "upper_alert": "",
                })
                continue
            for code_order, item in enumerate(items):
                writer.writerow({
                    "page_id": page["id"],
                    "page_name": page["name"],
                    "page_source": page.get("source", "shioaji"),
                    "page_order": page_order,
                    "code": item.get("code", ""),
                    "code_order": code_order,
                    "source": item.get("source", page.get("source", "shioaji")),
                    "lower_alert": "" if item.get("lower_alert") is None else item.get("lower_alert"),
                    "upper_alert": "" if item.get("upper_alert") is None else item.get("upper_alert"),
                })
        write_bytes_atomic(self.path, fh.getvalue().encode("utf-8-sig"), durable=True)

    def _read_csv(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        grouped: dict[str, dict[str, Any]] = {}
        with self.path.open("r", encoding="utf-8-sig", newline="") as fh:
            reader = csv.DictReader(fh)
            missing = [name for name in self.FIELDNAMES if name not in (reader.fieldnames or [])]
            if missing:
                raise ValueError(f"watch_pages.csv 欄位不完整：{', '.join(missing)}")
            for row_number, row in enumerate(reader, start=2):
                if None in row or any(row.get(name) is None for name in self.FIELDNAMES):
                    raise ValueError(f"watch_pages.csv 第 {row_number} 列已截斷或欄位數不符")
                page_id = str(row.get("page_id") or "").strip()
                if not page_id:
                    continue
                try:
                    page_order = int(row.get("page_order") or 0)
                except Exception:  # not an error: a page order that is not a number sorts first
                    page_order = 0
                page = grouped.setdefault(page_id, {
                    "id": page_id,
                    "name": str(row.get("page_name") or "").strip() or "自選",
                    "source": normalize_provider_source(row.get("page_source")),
                    "market": "us" if normalize_provider_source(row.get("page_source")) == "futu" else "tw",
                    "page_order": page_order,
                    "_items": [],
                })
                code = str(row.get("code") or "").strip().upper()
                if not code:
                    continue
                try:
                    code_order = int(row.get("code_order") or len(page["_items"]))
                except Exception:  # not an error: a code order that is not a number keeps the row's position
                    code_order = len(page["_items"])
                item = {
                    "code": code,
                    "source": normalize_provider_source(row.get("source") or page.get("source")),
                    "lower_alert": parse_optional_alert(row.get("lower_alert"), code=code, field="lower_alert"),
                    "upper_alert": parse_optional_alert(row.get("upper_alert"), code=code, field="upper_alert"),
                }
                page["_items"].append((code_order, item))

        pages = sorted(grouped.values(), key=lambda p: p.get("page_order", 0))
        result: list[dict[str, Any]] = []
        for page in pages:
            items: list[dict[str, Any]] = []
            seen: set[str] = set()
            for _, item in sorted(page.pop("_items", []), key=lambda x: x[0]):
                code = item["code"]
                if code in seen:
                    continue
                seen.add(code)
                items.append(item)
            result.append({
                "id": page["id"],
                "name": page["name"],
                "source": page.get("source", "shioaji"),
                "market": page.get("market", "tw"),
                "codes": [item["code"] for item in items],
                "items": items,
            })
        return self._normalize_pages(result)

    def list_pages(self) -> list[dict[str, Any]]:
        with self._lock:
            pages = self._cached_pages()
            return [{**page, "count": len(page["codes"])} for page in pages]

    def save_pages(self, pages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        with self._lock:
            normalized = self._normalize_pages(pages)
            self._write_csv(normalized)
            self._pages_cache = deepcopy(normalized)
            self._pages_cache_signature = self._file_signature()
            return [{**page, "count": len(page["codes"])} for page in normalized]

    def all_codes(self) -> set[str]:
        """The Shioaji stocks of the product pages (maintenance, history replay): an index future a page holds
        (台指期、小台指) is a futures product, not a stock."""
        from service.market.reference.futures_contracts import INDEX_FUTURES

        return set(self._source_codes("shioaji")) - set(INDEX_FUTURES)

    def _source_codes(self, source: str) -> list[str]:
        """The codes of one provider's pages, each once. Futu/CC products never enter the Shioaji universe."""
        with self._lock:
            codes: dict[str, None] = {}
            for page in self._cached_pages():
                if normalize_provider_source(page.get("source")) != source:
                    continue
                for item in page.get("items", []):
                    code = str(item.get("code") or "").strip().upper()
                    if code:
                        codes.setdefault(code)
            return list(codes)

    def provider_codes(self, source: str) -> frozenset[str]:
        """The provider's codes. A caller on a hot path (load-test admission, per batch) holds one service: while the
        CSV is unchanged this is one stat, with no read, normalization or copy of the pages."""
        requested = normalize_provider_source(source)
        with self._lock:
            signature = self._file_signature()
            cached = self._codes_cache.get(requested)
            if cached is not None and signature is not None and cached[0] == signature:
                return cached[1]
            codes = frozenset(self._source_codes(requested))
            self._codes_cache[requested] = (signature, codes)
            return codes
