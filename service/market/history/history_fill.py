"""The fill of a closed Shioaji session's gaps from the broker's history (decisions.md 盤中重啟的缺口只補空檔時段, 補齊
的資料仍不完整; docs/system-architecture/03_protocol_and_storage.md 盤中重啟的缺口).

1. Rust B reports where each materialized code is missing prints (``analysis_runtime --gap-report``, history_gaps.rs),
   and for an IDX session the whole session of each index it should hold and has no partition of (expected_codes).
2. The provider fetches only those windows from the broker (``fetch``: ShioajiBrokerService.fill_history_windows in the
   provider itself, or its ``/v1/history/fill-gaps`` from scripts/fill_history_gaps.py); nothing is published.
3. Each code's prints become its fill (``<fills_dir>/<CODE>.jsonl``): backfill trades carrying their cumulative volume
   (stocks, TXF), backfill quotes of the index's value (indices; an index missing all day also its 昨收 as a
   Reference). A stock's or TXF window whose prints do not add up to the hole's
   unseen volume, and any window that could not be fetched, leaves its code unresolved.
4. Rust B folds the session again from the historical store with the fills (``--materialize --input store``): the
   session owner submits that as a materialization job (materialization_ledger.py), the script runs it itself.
"""
from __future__ import annotations

import json
import subprocess
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Iterable
from zoneinfo import ZoneInfo

from service.market.shared.market_trade_semantics import shioaji_tick_side
from service.market.shared.native_values import price_to_units

TAIPEI = ZoneInfo("Asia/Taipei")
FUT_DAY_FROM = 6 * 60  # a NIGHT partition's minutes before 06:00 are the next calendar day's (event.rs)
FETCH_CHUNK = 8


def gap_report(binary: Path, historical_root: str | Path, market: str, trading_date: str, session: str,
               expected_codes: Iterable[str] = ()) -> dict[str, Any]:
    command = [str(binary), "--gap-report", "--historical-root", str(historical_root), "--market", market,
               "--trading-date", trading_date, "--session", session]
    expected = sorted({str(c).strip().upper() for c in expected_codes if str(c).strip()})
    if expected:
        command += ["--expected-codes", ",".join(expected)]
    out = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", check=True)
    return json.loads(out.stdout.strip().splitlines()[-1])


def _has_partitions(historical_root: str | Path, market: str, trading_date: str, session: str) -> bool:
    session_dir = (Path(historical_root) / "source=shioaji" / f"market={market}" / f"trading_date={trading_date}"
                   / f"session={session}")
    return session_dir.is_dir() and any(p.is_dir() for p in session_dir.iterdir())


def expected_codes(historical_root: str | Path, market: str, trading_date: str, session: str,
                   config_root: str | Path | None = None) -> list[str]:
    """The codes an IDX session should hold (decisions.md 指數整天沒有分區的日子): the indexes the background list held
    while the session traded -- 加權指數 and the 產業指數 that 設定 → 訂閱管理 put on it -- on a date the STK session
    has partitions (the market traded and the App recorded it). Every other market: none (its codes are what it
    recorded)."""
    from config.config_revisions import config_root as default_config_root
    from service.market.reference.background_demand import items_in_effect
    from service.market.shared.session_identity_contract import partition_end, partition_open

    if market.upper() != "IDX" or not _has_partitions(historical_root, "STK", trading_date, "DAY"):
        return []
    start = partition_open("shioaji", "IDX", trading_date, session)
    end = partition_end("shioaji", "IDX", trading_date, session) + timedelta(minutes=1)
    items = items_in_effect(Path(config_root) if config_root is not None else default_config_root(), start, end)
    return sorted({str(i["code"]).upper() for i in items
                   if str(i.get("source") or "").lower() == "shioaji" and str(i.get("market") or "").upper() == "IDX"})


def background_list_revision(config_root: str | Path | None = None) -> int | None:
    """The background list's newest saved revision: it changes whenever the list does."""
    from config.config_revisions import ConfigRevisionStore, config_root as default_config_root
    from service.market.reference.background_demand import DOMAIN

    return ConfigRevisionStore(Path(config_root) if config_root is not None else default_config_root(), DOMAIN).pointer().get("latest")


def listed_without_partition(historical_root: str | Path, market: str, trading_date: str, session: str,
                             config_root: str | Path | None = None, now: datetime | None = None) -> list[str]:
    """The codes the background list holds now and this session has no partition of: added after it traded (decisions.md
    收盤後看任何商品都要有資料). Asked only once the session is materialized, so the fill never races its materialization."""
    from config.config_revisions import config_root as default_config_root
    from service.market.reference.background_demand import items_in_effect

    moment = now or datetime.now(TAIPEI)
    items = items_in_effect(Path(config_root) if config_root is not None else default_config_root(), moment, moment + timedelta(seconds=1))
    listed = {str(i["code"]).upper() for i in items
              if str(i.get("source") or "").lower() == "shioaji" and str(i.get("market") or "").upper() == market.upper()}
    session_dir = Path(historical_root) / "source=shioaji" / f"market={market.upper()}" / f"trading_date={trading_date}" / f"session={session.upper()}"
    held = {p.name.upper() for p in session_dir.iterdir() if p.is_dir()} if session_dir.is_dir() else set()
    return sorted(listed - held)


def _local_minute(ns: int, session: str) -> int:
    moment = datetime.fromtimestamp(ns / 1e9, TAIPEI)
    minute = moment.hour * 60 + moment.minute
    return minute + 1440 if session == "NIGHT" and minute < FUT_DAY_FROM else minute


def _event(market: str, code: str, date: str, session: str, number: int, ns: int, payload: dict, flags: dict) -> dict:
    return {"schema_version": 2, "event_id": f"history_fill:{market}:{code}:{date}:{session}:{number}", "durable_sequence": 0,
            "symbol": f"shioaji:{market}:{code}", "provider": "shioaji", "market": market, "code": code, "session": session,
            "trading_date": date, "generation": 0, "sequence": number, "exchange_ts_ns": ns, "time_quality": "exchange",
            "flags": flags, "payload": payload}


def _units(price: float) -> int:
    """A broker print price in the native fixed point (exact, as the live ingest stores it)."""
    return price_to_units(price)


def fill_events(result: dict[str, Any]) -> tuple[list[dict], list[str]]:
    """A code's fill events from its fetched windows, and why any of its windows is unresolved."""
    market, code, date, session = result["market"], result["code"], result["trading_date"], result["session"]
    events: list[dict] = []
    problems: list[str] = []
    number = 0
    for window in result["windows"]:
        if "error" in window:
            problems.append(window["error"])
            continue
        prints = window.get("prints") or []
        flags = {"backfill": True, "backfill_cutoff_ns": int(window["end_ns"])}
        if window.get("reference") == "prev_close":
            # An index's 昨收: the previous trading day's closing print (history_gaps.rs session_windows), as the
            # Reference its live stream carries at the open.
            if not prints:
                problems.append(f"no closing print of {window.get('reference_date')} for the 昨收")
                continue
            number += 1
            events.append(_event(market, code, date, session, number, int(window["reference_at_ns"]), {"kind": "reference",
                "limit_up": None, "limit_down": None, "prev_close": _units(prints[-1][1]), "prev_volume": None,
                "reference_price": None, "name": None}, flags))
            continue
        if market == "IDX":
            if not prints:
                problems.append(f"no index prints in {window['after_ns']}..{window['end_ns']}")
                continue
            # Each history print is the index's value at that instant (every 5 s, as its live quotes): a quote, so a
            # fold meets the index as fresh as the live stream kept it. The day's open / high / low are known only
            # over the whole session (0 = not stated); the history has no amount or cumulative volume.
            whole = bool(window.get("whole_session"))
            day = [0, 0, 0]
            for ns, price, _volume, _tick_type in prints:
                units = _units(price)
                if whole:
                    day = [day[0] or units, max(day[1], units), min(day[2], units) if day[2] else units]
                number += 1
                events.append(_event(market, code, date, session, number, int(ns), {"kind": "quote", "current": units,
                    "open": day[0], "high": day[1], "low": day[2], "total_volume": 0.0, "total_amount": 0.0, "status": "live",
                    "minute": _local_minute(int(ns), session), "average": 0, "volume": 0.0, "amount": 0.0}, flags))
            continue
        # A code with no partition: its whole session, counted from 0, with no stored total to check against.
        total = float(window.get("total_before") or 0.0)
        if window.get("next_total_before") is not None:
            unseen = float(window["next_total_before"]) - total
            got = sum(float(p[2]) for p in prints)
            if abs(got - unseen) > 1e-6:
                problems.append(f"window {window['after_ns']}..{window['end_ns']}: {got} fetched of {unseen} unseen")
        for ns, price, volume, tick_type in prints:
            number += 1
            total += float(volume)
            events.append(_event(market, code, date, session, number, int(ns), {"kind": "trade", "price": _units(price),
                "volume": float(volume), "total_volume": total, "side": shioaji_tick_side(tick_type),
                "trade_id": f"hf{number}", "minute": _local_minute(int(ns), session), "open": 0, "high": 0, "low": 0, "average": 0,
                "total_amount": 0.0, "amount": 0.0}, flags))
    return events, problems


def prepare(fetch: Callable[[list[dict]], list[dict]], binary: Path, historical_root: str | Path, market: str,
            trading_date: str, session: str, fills_dir: Path, expected: Iterable[str] = ()) -> dict[str, Any]:
    """Steps 1-3 for one session: its fills written under `fills_dir`. ``refold``: whether folding the session again
    can change anything (a code got a fill, or one is not complete -- a refold proves what it can). `expected`
    (expected_codes): codes the session should hold; one without a partition is fetched for the whole session and
    its fill becomes its partition (``missing_codes``)."""
    market, session = market.upper(), session.upper()
    report = gap_report(binary, historical_root, market, trading_date, session, expected)
    if not report.get("ok"):
        raise RuntimeError(f"gap report of {market} {trading_date} {session}: {report.get('error') or report.get('problems')}")
    wanted = [{"market": market, "code": c["code"], "trading_date": trading_date, "session": session, "windows": c["windows"]}
              for c in report["codes"] if c["windows"]]
    fills_dir.mkdir(parents=True, exist_ok=True)
    unresolved: dict[str, list[str]] = {}
    written = 0
    for start in range(0, len(wanted), FETCH_CHUNK):
        for result in fetch(wanted[start:start + FETCH_CHUNK]):
            events, problems = fill_events(result)
            written += len(events)
            if problems:
                unresolved[str(result["code"]).upper()] = problems
            with open(fills_dir / f"{str(result['code']).upper()}.jsonl", "w", encoding="utf-8", newline="\n") as f:
                for event in events:
                    f.write(json.dumps(event, separators=(",", ":")) + "\n")
    held = [c for c in report["codes"] if c.get("partition")]
    incomplete = [c["code"] for c in held if c.get("completeness") != "complete"]
    return {"market": market, "trading_date": trading_date, "session": session, "codes_with_gaps": len(wanted),
            "fill_events": written, "unresolved": unresolved, "incomplete_codes": len(incomplete),
            "missing_codes": sorted(c["code"] for c in report["codes"] if not c.get("partition")),
            "refold": bool(written or incomplete)}
