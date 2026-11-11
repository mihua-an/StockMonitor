"""Trade-tick detail paging: Market Runtime answers it (`trades.page`, native/market_runtime/src/trade_pages.rs).

A reads a session not materialized yet from its own WAL (an index of the tape its start's scan builds and each append
extends) and a materialized one from the historical store; the tape rule (試撮 prints are not trades, a FUT quote
that raises the cumulative volume is) is A's alone. This process only forwards the request: it reads no WAL and
parses no partition, so nothing here holds the GIL of the API answering the screens.
"""
from __future__ import annotations

from typing import Any

from service.market.shared.rust_view_client import RustViewClient


def trade_page(
    *, market: str, code: str, trading_date: str = "", session: str = "",
    page: int = 1, page_size: int = 100, snapshot_watermark: int = 0,
    before_sequence: int = 0, metadata_only: bool = False,
) -> dict[str, Any]:
    """One page of trades, newest first (Market Runtime's answer as it is)."""
    return RustViewClient().trade_page({
        "market": str(market or "STK").upper(), "code": str(code or "").upper(),
        "trading_date": str(trading_date or "")[:10], "session": str(session or "").upper(),
        "page": max(1, int(page)), "page_size": max(1, min(100, int(page_size))),
        "snapshot_watermark": max(0, int(snapshot_watermark or 0)), "before_sequence": max(0, int(before_sequence or 0)),
        "metadata_only": bool(metadata_only),
    })
