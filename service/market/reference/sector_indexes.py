"""The 產業指數 of the stocks the user keeps (user 10-19): every stock on a product page, in the actual holdings or in
the paper holdings brings the sector index of its industry onto the background list, so it is subscribed and stored
for model training. A searched stock or a workspace one brings none (it is not on the list at all).

The stock -> industry link is the security master's ``industry_code`` and market (tse / otc); the industry -> index
link is ``config/tw_industry_indexes.json`` (verified 10-17): an OTC stock takes its industry's OTC index, or the TSE
one where the OTC market has none. ETFs and industries without an index bring nothing.
"""
from __future__ import annotations

import logging
from typing import Any, Iterable, Mapping

from config import tw_industry_indexes
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)

# The owners whose stocks bring their sector index (user 10-19).
FOLLOWED_OWNERS = frozenset({"watchlist", "holdings", "paper_holdings"})


def index_for(industry_code: str, market: str) -> str | None:
    """The sector index of a stock in `industry_code` listed on `market` ("tse" / "otc"), or None
    (config/tw_industry_indexes.py, the table's one validated reader)."""
    return tw_industry_indexes.index_for(industry_code, market)


def _indexes() -> tuple[dict[str, str], ...]:
    return tuple({"code": i.code, "name": i.name, "market": i.market} for i in tw_industry_indexes.table().indexes)


def industry_indexes() -> list[dict[str, str]]:
    """The 產業指數 the user can pick (即時報價 「Shioaji產業指數」): 上市 first, then 上櫃, each by code."""
    return [dict(item) for item in _indexes()]


def stock_industry_index(code: str, info: Any | None) -> dict[str, Any]:
    """The 產業指數 of one stock (即時報價: a Shioaji product row picked) from its security-master row `info`;
    `index` is None for an unknown stock, 00 (no industry) and an industry without an index."""
    names = {item["code"]: item for item in _indexes()}
    industry_code = str(getattr(info, "industry_code", "") or "").strip()
    market = str(getattr(info, "market", "") or "").strip().lower()
    index = index_for(industry_code, market) if info is not None else None
    return {
        "code": str(code or "").strip().upper(),
        "found": info is not None,
        "industry_code": industry_code,
        "industry_name": str(getattr(info, "industry_name", "") or ""),
        "market": market,
        "index": dict(names[index]) if index in names else None,
    }


def _master() -> dict[str, tuple[str, str]]:
    """code -> (industry_code, market) from the security master; {} when it cannot be read (recorded)."""
    from service.market.reference.security_master_service import SecurityMasterService
    from service.market.storage.market_storage_layout import process_market_layout

    try:
        master = SecurityMasterService(process_market_layout().shioaji_security_master).load_master()
    except Exception as exc:
        record_failure(_failure_log, "reading the security master for the sector indexes", exc)
        return {}
    return {code: (info.industry_code, info.market) for code, info in master.items()}


def sector_index_items(items: Iterable[Mapping[str, Any]],
                       master: Mapping[str, tuple[str, str]] | None = None) -> list[dict[str, Any]]:
    """The sector indexes of the Shioaji stocks in `items` (background list rows) held by a followed owner."""
    rows = list(items)
    stocks = sorted({str(i.get("code") or "").strip().upper() for i in rows
                     if str(i.get("source") or "").lower() == "shioaji" and str(i.get("market") or "").upper() == "STK"
                     and FOLLOWED_OWNERS & set(i.get("owners") or [])})
    if not stocks:
        return []
    master = _master() if master is None else master
    codes = {index for code in stocks if (info := master.get(code)) and (index := index_for(*info))}
    return [{"source": "shioaji", "market": "IDX", "code": code, "kinds": ["quote"]} for code in sorted(codes)]
