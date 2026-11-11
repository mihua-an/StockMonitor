"""Fetch the TWSE market-closure schedule and merge it into config/market_holidays.json.

TWSE publishes one calendar year at a time (OpenAPI ``holidaySchedule``), so run this once a year after the new
schedule is out -- and again if TWSE amends it. Years already stored are kept; the fetched year replaces its own
entry. Ad-hoc closures (typhoon days) are never in the schedule; ``--closed DATE NAME`` records one by hand.

The schedule lists trading days too ("國曆新年開始交易日", "農曆春節前最後交易日"): a row whose name ends in
交易日 is a trading day, every other row (holidays, "市場無交易，僅辦理結算交割作業") is a closed day.

NYSE has no feed to fetch: its days are recorded by hand from NYSE's published calendar
(https://www.nyse.com/markets/hours-calendars, announced about three years ahead), once a year -- every full-day
closure with ``--nyse-closed`` and every early close (13:00 New York) with ``--nyse-half``. Market Runtime and
config/market_holidays.py judge US trading days by them wherever OpenD's own calendar does not reach.

    python scripts/tooling/update_market_holidays.py
    python scripts/tooling/update_market_holidays.py --closed 2026-07-29 颱風停止交易
    python scripts/tooling/update_market_holidays.py --nyse-closed 2029-01-01 "New Year's Day"
    python scripts/tooling/update_market_holidays.py --nyse-half 2029-11-23 "Day after Thanksgiving"
"""
from __future__ import annotations

import argparse
import json
import ssl
import sys
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "config" / "market_holidays.json"
TWSE_URL = "https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule"
NYSE_URL = "https://www.nyse.com/markets/hours-calendars"
SCHEMA = "market-holidays-v1"


def roc_date(text: str) -> date:
    """TWSE dates are ROC calendar ``YYYMMDD`` (1150101 = 2026-01-01)."""
    text = str(text).strip()
    if not text.isdigit() or len(text) != 7:
        raise ValueError(f"not a ROC YYYMMDD date: {text!r}")
    return date(int(text[:3]) + 1911, int(text[3:5]), int(text[5:7]))


def classify(rows: list[dict]) -> dict[str, dict[str, list[dict[str, str]]]]:
    """Rows per Gregorian year: ``closed`` and ``trading`` (the schedule's named trading days)."""
    years: dict[str, dict[str, list[dict[str, str]]]] = {}
    for row in rows:
        day = roc_date(row.get("Date", ""))
        name = str(row.get("Name") or "").strip()
        bucket = "trading" if name.endswith("交易日") else "closed"
        years.setdefault(str(day.year), {"closed": [], "trading": []})[bucket].append({"date": day.isoformat(), "name": name})
    for entry in years.values():
        for rows_ in entry.values():
            rows_.sort(key=lambda item: item["date"])
    return years


def load(path: Path = TARGET) -> dict:
    if not path.exists():
        return {"schema": SCHEMA, "markets": {}}
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("schema") != SCHEMA:
        raise ValueError(f"{path}: unexpected schema {data.get('schema')!r}")
    return data


def save(data: dict, path: Path = TARGET) -> None:
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def merge_fetched(data: dict, years: dict, *, fetched_at: str) -> dict:
    twse = data.setdefault("markets", {}).setdefault("TWSE", {"source": TWSE_URL, "years": {}})
    for year, entry in years.items():
        manual = [row for row in twse["years"].get(year, {}).get("closed", []) if row.get("manual")]
        fetched_dates = {row["date"] for row in entry["closed"]}
        twse["years"][year] = {
            "fetched_at": fetched_at,
            "closed": sorted(entry["closed"] + [row for row in manual if row["date"] not in fetched_dates], key=lambda r: r["date"]),
            "trading": entry["trading"],
        }
    return data


def add_manual_closure(data: dict, day: date, name: str) -> dict:
    twse = data.setdefault("markets", {}).setdefault("TWSE", {"source": TWSE_URL, "years": {}})
    year = twse["years"].get(str(day.year))
    if year is None:
        raise SystemExit(f"{day.year} has no fetched schedule yet; run without --closed first")
    year["closed"] = sorted([row for row in year["closed"] if row["date"] != day.isoformat()]
                            + [{"date": day.isoformat(), "name": name, "manual": True}], key=lambda r: r["date"])
    return data


def add_nyse_day(data: dict, day: date, name: str, kind: str) -> dict:
    """Record one NYSE day: ``closed`` (no trading) or ``half`` (closes at 13:00). A day is in one list only."""
    if day.weekday() >= 5:
        raise SystemExit(f"{day} is a weekend day; NYSE lists only weekdays")
    nyse = data.setdefault("markets", {}).setdefault("NYSE", {"source": NYSE_URL, "years": {}})
    year = nyse["years"].setdefault(str(day.year), {"closed": [], "half": []})
    year["recorded_at"] = date.today().isoformat()
    for bucket in ("closed", "half"):
        year[bucket] = [row for row in year.get(bucket, []) if row["date"] != day.isoformat()]
    year[kind] = sorted(year[kind] + [{"date": day.isoformat(), "name": name}], key=lambda r: r["date"])
    return data


def fetch(url: str = TWSE_URL) -> list[dict]:
    # TWSE's certificate lacks a Subject Key Identifier, which Python 3.13+ rejects under VERIFY_X509_STRICT.
    # Only that strictness flag is relaxed: the chain and the host name are still verified.
    context = ssl.create_default_context()
    context.verify_flags &= ~ssl.VERIFY_X509_STRICT
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=30, context=context) as response:
        rows = json.loads(response.read().decode("utf-8"))
    if not isinstance(rows, list) or not rows:
        raise ValueError("TWSE holiday schedule: empty or not a list")
    return rows


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--closed", nargs=2, metavar=("DATE", "NAME"), help="record an ad-hoc closure (e.g. a typhoon day)")
    parser.add_argument("--nyse-closed", nargs=2, metavar=("DATE", "NAME"), help="record an NYSE full-day closure")
    parser.add_argument("--nyse-half", nargs=2, metavar=("DATE", "NAME"), help="record an NYSE early close (13:00)")
    args = parser.parse_args(argv)
    data = load()
    for kind, given in (("closed", args.nyse_closed), ("half", args.nyse_half)):
        if given:
            save(add_nyse_day(data, date.fromisoformat(given[0]), given[1], kind))
            print(f"recorded NYSE {kind} {given[0]} {given[1]}")
            return 0
    if args.closed:
        save(add_manual_closure(data, date.fromisoformat(args.closed[0]), args.closed[1]))
        print(f"recorded closure {args.closed[0]} {args.closed[1]}")
        return 0
    years = classify(fetch())
    save(merge_fetched(data, years, fetched_at=datetime.now(timezone.utc).isoformat(timespec="seconds")))
    for year, entry in sorted(years.items()):
        print(f"TWSE {year}: {len(entry['closed'])} closed, {len(entry['trading'])} named trading days")
    return 0


if __name__ == "__main__":
    sys.exit(main())
