"""The one reader of config/tw_industry_indexes.json: 台股產業代碼 -> the sector index of each market (tse / otc).

Validated as a whole when first read, and shared by everything that uses the table: the Shioaji capabilities (which
index codes the provider can carry, service/market/shared/provider_contract.py) and the sector indexes a kept stock
brings onto the background list (service/market/reference/sector_indexes.py). A table that does not validate raises
:class:`IndustryIndexTableError`, naming the file and the entry, at the first use -- never at an import, and never
read one way here and another way there.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

PATH = Path(__file__).resolve().with_name("tw_industry_indexes.json")
SCHEMA = "tw-industry-indexes-v1"
SIDES = ("tse", "otc")
CHECKS = frozenset({"data", "name", "proxy"})
_INDUSTRY = re.compile(r"\d{2}")
_INDEX = re.compile(r"IX\d{4}")


class IndustryIndexTableError(ValueError):
    pass


@dataclass(frozen=True)
class SectorIndex:
    code: str
    name: str
    market: str   # the market the index belongs to: a proxy side names the other market's index


@dataclass(frozen=True)
class IndustryIndexTable:
    by_industry: dict[str, dict[str, str]]   # industry code -> {side: index code}, absent sides left out
    indexes: tuple[SectorIndex, ...]         # every index once, 上市 first, then 上櫃, each by code

    def index_for(self, industry_code: str, market: str) -> str | None:
        """The sector index of a stock in `industry_code` listed on `market` ("tse" / "otc"): an OTC stock takes its
        industry's OTC index, or the TSE one where the OTC market has none; None for an industry without one."""
        sides = self.by_industry.get(str(industry_code or "").strip())
        if not sides:
            return None
        if str(market or "").strip().lower() == "otc":
            return sides.get("otc") or sides.get("tse")
        return sides.get("tse")

    def all_index_codes(self) -> tuple[str, ...]:
        return tuple(sorted(item.code for item in self.indexes))


def parse(doc: Any, *, source: str = str(PATH)) -> IndustryIndexTable:
    """The table a document holds; IndustryIndexTableError for anything off the schema."""
    def fail(where: str, why: str) -> IndustryIndexTableError:
        return IndustryIndexTableError(f"{source}: {where}: {why}")

    if not isinstance(doc, dict):
        raise fail("document", f"is a {type(doc).__name__}, not an object")
    if doc.get("schema") != SCHEMA:
        raise fail("schema", f"{doc.get('schema')!r} is not {SCHEMA!r}")
    industries = doc.get("industries")
    if not isinstance(industries, list) or not industries:
        raise fail("industries", "is not a non-empty list")
    by_industry: dict[str, dict[str, str]] = {}
    seen: dict[str, SectorIndex] = {}
    for position, industry in enumerate(industries):
        if not isinstance(industry, dict):
            raise fail(f"industries[{position}]", "is not an object")
        code = industry.get("code")
        if not isinstance(code, str) or not _INDUSTRY.fullmatch(code) or code == "00":
            raise fail(f"industries[{position}].code", f"{code!r} is not a two-digit industry code other than 00")
        if code in by_industry:
            raise fail(f"industry {code}", "is listed twice")
        sides: dict[str, str] = {}
        for side in SIDES:
            entry = industry.get(side)
            if entry is None:
                continue
            where = f"industry {code}.{side}"
            if not isinstance(entry, dict):
                raise fail(where, "is neither null nor an object")
            index = entry.get("index")
            if not isinstance(index, str) or not _INDEX.fullmatch(index):
                raise fail(f"{where}.index", f"{index!r} is not an index code IXnnnn")
            check = entry.get("check")
            how = check.get("how") if isinstance(check, dict) else None
            if how not in CHECKS:
                raise fail(f"{where}.check.how", f"{how!r} is not one of {sorted(CHECKS)}")
            name = entry.get("index_name")
            if name is not None and not isinstance(name, str):
                raise fail(f"{where}.index_name", "is not text")
            sides[side] = index
            own_market = ("otc" if side == "tse" else "tse") if how == "proxy" else side
            seen.setdefault(index, SectorIndex(code=index, name=name or index, market=own_market))
        if sides:
            by_industry[code] = sides
    indexes = tuple(sorted(seen.values(), key=lambda item: (item.market != "tse", item.code)))
    return IndustryIndexTable(by_industry=by_industry, indexes=indexes)


@lru_cache(maxsize=1)
def table() -> IndustryIndexTable:
    """The shipped table, read and validated once per process."""
    try:
        doc = json.loads(PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise IndustryIndexTableError(f"{PATH}: unreadable: {type(exc).__name__}: {exc}") from exc
    return parse(doc)


def index_for(industry_code: str, market: str) -> str | None:
    return table().index_for(industry_code, market)


def all_index_codes() -> tuple[str, ...]:
    return table().all_index_codes()
