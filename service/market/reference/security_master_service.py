from __future__ import annotations

import csv
import io
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable
from service.platform.atomic_files import read_text_shared, write_bytes_atomic
import logging
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)


@dataclass
class SecurityInfo:
    code: str
    name: str
    market: str
    type: str
    industry_code: str = ""
    industry_name: str = ""
    source: str = "shioaji_contracts"
    updated_at: str = ""


class SecurityMasterService:
    """Security master backed only by Shioaji contracts plus the local cache."""

    def __init__(
        self,
        master_file: str | Path,
        api_provider: Callable[[], Any | None] | None = None,
    ) -> None:
        self.master_file = Path(master_file)
        self.api_provider = api_provider
        self._master_cache: dict[str, SecurityInfo] = {}
        self._master_cache_mtime_ns: int | None = None
        self._master_cache_lock = threading.RLock()

    @staticmethod
    def _enum_text(value: Any) -> str:
        return str(getattr(value, "value", value) or "")

    @classmethod
    def _market(cls, contract: Any) -> str:
        text = cls._enum_text(getattr(contract, "exchange", "")).upper()
        if "OTC" in text or "OES" in text:
            return "otc"
        if "TSE" in text:
            return "tse"
        if "TAIFEX" in text or "TFE" in text:
            return "taifex"
        return text.lower()

    @staticmethod
    def instrument_kind(code: str) -> str:
        """The 台股 instrument kind of a listed code, written as the master's `type`: etf / etn / reit / stock.

        Shioaji's contracts carry no kind (their `category` 00 covers ETFs, ETNs, REITs, preferred shares and
        TDRs alike), so the exchange's code ranges decide it, here only: 00xxxx ETF, 02xxxx ETN, 01xxxT REIT
        (受益證券). Everything else in the listing is a stock. The price policy, the paper desk, the ledger's tax and
        the screens read this kind (the master's `type`, or this function for a code), never a code rule of their own."""
        code = str(code or "").strip().upper()
        if code.startswith("00"):
            return "etf"
        if code.startswith("02") and len(code) == 6:
            return "etn"
        if code.startswith("01") and code.endswith("T"):
            return "reit"
        return "stock"

    @staticmethod
    def _stock_security_type(api: Any) -> Any:
        security_type = getattr(api, "SecurityType", None)
        if security_type is not None and hasattr(security_type, "Stock"):
            return security_type.Stock
        # An api object comes only from the Shioaji provider, which has already loaded the SDK (and set its log path)
        # before logging in: take the enum from the loaded SDK, never import a provider from this reference module
        # (dependency direction).
        import sys

        sdk = sys.modules.get("shioaji")
        enum = getattr(sdk, "SecurityType", None)
        if enum is not None and hasattr(enum, "Stock"):
            return enum.Stock
        # Test doubles accept the string directly.
        return "Stock"

    def _stock_contracts(self, api: Any, contracts: Any) -> list[Any]:
        # Shioaji 1.7.2's ContractsApi.list(kind) is the one listing (checked live 2026-10-17).
        try:
            return list(contracts.list(self._stock_security_type(api)) or [])
        except Exception as exc:
            record_failure(_failure_log, "listing Shioaji stock contracts by security type", exc)
            return []

    def _contract_info(self, contracts: Any, contract: Any) -> Any:
        info_fn = getattr(contracts, "info", None)
        if not callable(info_fn):
            return contract
        try:
            return info_fn(contract) or contract
        except Exception as exc:
            record_failure(_failure_log, "reading Shioaji contract info", exc)
            return contract

    def update_master(self, api: Any | None = None) -> dict[str, Any]:
        api = api or (self.api_provider() if self.api_provider else None)
        if api is None:
            return {
                "ok": False,
                "count": len(self.load_master()),
                "updated_at": "",
                "errors": ["Shioaji 尚未登入，保留既有本機商品檔"],
                "file": str(self.master_file),
                "preserved_existing": self.master_file.exists(),
            }
        contracts = getattr(api, "contracts", None)
        if contracts is None:
            raise RuntimeError("Shioaji contracts 尚未就緒")

        updated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        rows: dict[str, SecurityInfo] = {}
        base_contracts = self._stock_contracts(api, contracts)
        info_fn = getattr(contracts, "info", None)
        for contract in base_contracts:
            detail = self._contract_info(contracts, contract) if callable(info_fn) else contract
            code = str(getattr(detail, "code", "") or getattr(contract, "code", "") or "").strip().upper()
            name = str(getattr(detail, "name", "") or getattr(contract, "name", "") or "").strip()
            if not code or not name:
                continue
            category = str(getattr(detail, "category", "") or getattr(contract, "category", "") or "").strip()
            rows[code] = SecurityInfo(
                code=code,
                name=name,
                market=self._market(detail) or self._market(contract),
                type=self.instrument_kind(code),
                industry_code=category,
                # Shioaji StockInfo exposes category code but not a canonical
                # localized industry-name mapping. Keep the display name empty
                # rather than introducing a non-Shioaji metadata source.
                industry_name="",
                source="shioaji_contracts",
                updated_at=updated_at,
            )

        if rows:
            # The index futures a product page can hold (台指期、小台指): a product named by its category, listed while
            # the broker lists its months (maintenance.py writes the contract table first).
            from service.market.reference import futures_contracts

            table = futures_contracts.current_table()
            for category, name in futures_contracts.INDEX_FUTURES.items():
                if table.months(category):
                    rows[category] = SecurityInfo(code=category, name=name, market="FUT", type="future",
                                                  source="shioaji_contracts", updated_at=updated_at)

        notice: dict[str, Any] = {}
        if rows:
            self.write_master(sorted(rows.values(), key=lambda item: (item.market, item.type, item.code)))
            # The product catalog's owner (app_api) rebuilds from it now, not at the next start. Committed above:
            # the notice's result is reported, never turned into a failed write.
            from service.market.reference import security_master_feed

            notice = security_master_feed.publish_written("shioaji", self.master_file)
        return {
            "ok": bool(rows),
            "count": len(rows),
            "updated_at": updated_at,
            "errors": [] if rows else ["Shioaji Contracts 未回傳股票商品"],
            "file": str(self.master_file),
            "preserved_existing": bool(not rows and self.master_file.exists()),
            "source": "shioaji_contracts",
            "metadata_gap": ["industry_name"],
            "notice": notice,
        }

    def write_master(self, rows: list[SecurityInfo]) -> None:
        text = io.StringIO(newline="")
        writer = csv.DictWriter(text, fieldnames=[
            "code", "name", "market", "type", "industry_code",
            "industry_name", "source", "updated_at",
        ])
        writer.writeheader()
        for item in rows:
            writer.writerow(item.__dict__)
        write_bytes_atomic(self.master_file, text.getvalue().encode("utf-8-sig"), durable=True)

    def load_master(self) -> dict[str, SecurityInfo]:
        if not self.master_file.exists():
            return {}
        try:
            mtime_ns = int(self.master_file.stat().st_mtime_ns)
        except OSError:  # not an error: the file went away between exists() and stat(): it is read again below
            mtime_ns = None
        with self._master_cache_lock:
            if mtime_ns is not None and self._master_cache_mtime_ns == mtime_ns:
                return dict(self._master_cache)

        result: dict[str, SecurityInfo] = {}
        try:
            # Opened with delete sharing: the provider replaces this file while readers have it open.
            for row in csv.DictReader(io.StringIO(read_text_shared(self.master_file, "utf-8-sig"), newline="")):
                code = str(row.get("code") or "").strip().upper()
                if not code:
                    continue
                result[code] = SecurityInfo(
                    code=code,
                    name=str(row.get("name") or "").strip(),
                    market=str(row.get("market") or "").strip(),
                    type=str(row.get("type") or "stock").strip(),
                    industry_code=str(row.get("industry_code") or "").strip(),
                    industry_name=str(row.get("industry_name") or "").strip(),
                    source=str(row.get("source") or "shioaji_contracts").strip(),
                    updated_at=str(row.get("updated_at") or "").strip(),
                )
        except Exception as exc:
            record_failure(_failure_log, "loading the security master", exc)
            return {}
        with self._master_cache_lock:
            self._master_cache = result
            self._master_cache_mtime_ns = mtime_ns
            return dict(self._master_cache)

    def find_by_code(self, code: str) -> SecurityInfo | None:
        return self.load_master().get(str(code or "").strip().upper())

    #: How often name_for() re-stats the master file. It sits on the analysis producer's emit
    #: path, so it must not stat (let alone copy the whole master) per symbol per pass.
    NAME_RECHECK_SECONDS = 2.0

    def name_for(self, code: str) -> str:
        """The security's name from the local master, or "" when it is not known.

        Never the code: a code standing in for a name is how 台積電 became "2330" on screen. Reads
        the already-loaded master without copying it, and re-checks the file at most every
        NAME_RECHECK_SECONDS -- so a master refreshed after startup is picked up without a
        restart, and no broker/SDK call is ever made from here.
        """
        now = time.monotonic()
        with self._master_cache_lock:
            due = now >= getattr(self, "_name_recheck_at", 0.0)
            if due:
                self._name_recheck_at = now + self.NAME_RECHECK_SECONDS
        if due:
            self.load_master()   # reloads only when the file's mtime changed
        with self._master_cache_lock:
            info = self._master_cache.get(str(code or "").strip().upper())
        return info.name if info is not None and info.name else ""

    def search(self, keyword: str, limit: int = 50) -> list[dict[str, str]]:
        needle = str(keyword or "").strip().lower()
        rows = []
        for item in self.load_master().values():
            if not needle or needle in item.code.lower() or needle in item.name.lower():
                rows.append(item.__dict__.copy())
        rows.sort(key=lambda item: (0 if str(item["code"]).lower().startswith(needle) else 1, item["code"]))
        return rows[: max(1, int(limit))]
