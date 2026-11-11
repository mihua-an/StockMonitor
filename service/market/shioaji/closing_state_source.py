"""The closing state of one listed stock from the address the user set (config/closing_data_settings.py); none set,
nothing connects and the broker's history is all a closed session shows.

The broker's history has one level of the book and no limits. The source answers the stock's latest state: five levels,
the reference price and the limits. It is read at most once per product and session viewed
(ShioajiBrokerService._closed_view_requested keeps that), and an answer of any other date is not used.
"""
from __future__ import annotations

import json
import logging
import ssl
import urllib.parse
import urllib.request
from typing import Any

from config import closing_data_settings
from service.market.history.query_cache import ClosingState

_log = logging.getLogger(__name__)
_TIMEOUT_S = 5.0


def _price(text: Any) -> float | None:
    try:
        value = float(text)
    except (TypeError, ValueError):  # not an error: the endpoint writes "-" for a value it does not have
        return None
    return value if value > 0 else None


def _levels(prices: Any, volumes: Any) -> list[tuple[float, float]]:
    out = []
    for price_text, volume_text in zip(str(prices or "").split("_"), str(volumes or "").split("_")):
        price, volume = _price(price_text), _price(volume_text)
        if price is not None and volume is not None:
            out.append((price, volume))
    return out[:5]


def parse(answer: dict[str, Any], code: str, trading_date: str) -> ClosingState | None:
    """The stock's row of `answer`, when it is of `trading_date`; None otherwise."""
    wanted = trading_date.replace("-", "")
    for row in answer.get("msgArray") or []:
        if str(row.get("c") or "").upper() == code.upper() and str(row.get("d") or "") == wanted:
            return ClosingState(prev_close=_price(row.get("y")), limit_up=_price(row.get("u")), limit_down=_price(row.get("w")),
                                bids=_levels(row.get("b"), row.get("g")), asks=_levels(row.get("a"), row.get("f")))
    return None


def fetch(code: str, trading_date: str) -> ClosingState | None:
    """One request to the set address, None without asking when none is set. Raises what the request raises."""
    template = closing_data_settings.url()
    if not template:
        return None
    context = ssl.create_default_context()
    # The chain and the host are still verified: some providers' certificates lack one extension the strict profile requires.
    context.verify_flags &= ~ssl.VERIFY_X509_STRICT
    address = template.replace("{code}", urllib.parse.quote(code))
    origin = urllib.parse.urlsplit(address)
    request = urllib.request.Request(address, headers={"User-Agent": "Mozilla/5.0", "Referer": f"{origin.scheme}://{origin.netloc}/"})
    with urllib.request.urlopen(request, timeout=_TIMEOUT_S, context=context) as response:
        answer = json.loads(response.read().decode("utf-8"))
    state = parse(answer, code, trading_date)
    _log.info("[closing data] state of %s %s: %s", code, trading_date, "read" if state else "no row of that date")
    return state
