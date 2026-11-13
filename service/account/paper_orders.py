"""模擬下單的委託台 (docs/system-architecture/11_paper_order_matching.md): paper_account_api's half of the matching.

paper_account_api accepts an order, checks it, reserves its money and appends it to ``orders.jsonl``; Rust B
(native/analysis_runtime/src/paper.rs) matches it on the durable stream and appends what happened to
``results.jsonl``; this desk reads that back, writes every fill into the paper ledger and tells the screens. The two
files have one writer each. ``local.jsonl`` holds what only this side knows (an order deleted with its fills).
``checkpoint.json`` is the desk's state at an offset of each journal, so a start reads only what came after; the
finished orders of earlier days leave memory for ``history/<trading_date>.json`` and are read from there.

Checks when an order is placed (O6, O7): 台股 only, a trading day, 整股 08:30-13:30 / 零股 09:00-13:30, IOC / FOK only
from 09:00 (call auctions take ROD), the price on the 升降單位, 整股 in whole lots and 零股 1-999 shares; then the
paper ledger's own rules -- 零股 is not day-traded, a sell first is whole lots, the 每日交易額度 -- with every working
order counted as if it had filled (委託預扣). The principal is not a limit: 台股 settles T+2, so within the 額度 a
buy (and a day trade with no principal) is accepted. Limit-up / limit-down is checked by the matching, which has the day's reference.

"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo

from service.account import capital
from service.account.accounting_core import AccountingCore
from service.account.account_types import ActualAccountError, invalid_account_input
from service.market.shared.native_values import DEFAULT_PRICE_SCALE, derived_price_to_units
from service.market.semantics.twse_price_policy import PRICE_POLICY, price_policy_projection, twse_tick_size
from service.platform.change_feed import ChangeFeed
from service.platform.failure_record import record_failure

_log = logging.getLogger(__name__)

TAIPEI = ZoneInfo("Asia/Taipei")
LOT = 1000
ORDERS_FILE = "orders.jsonl"
RESULTS_FILE = "results.jsonl"
LOCAL_FILE = "local.jsonl"
POLL_INTERVAL_S = 0.2
# Matched fills the ledger refused are written again after this wait, doubling per failure up to the cap.
IMPORT_RETRY_FIRST_S = 1.0
IMPORT_RETRY_MAX_S = 60.0
# How long close() waits for the polling thread (within app_api's shutdown budget).
CLOSE_WAIT_S = 5.0
RESULTS_QUARANTINE_FILE = "results.quarantine.jsonl"
# The desk's state up to an offset of each journal (written atomically after every change): a start reads only the
# journal lines after it. Finished orders of earlier days leave memory for one file per day under ARCHIVE_DIR.
CHECKPOINT_FILE = "checkpoint.json"
CHECKPOINT_SCHEMA = "paper-desk-checkpoint-v1"
ARCHIVE_DIR = "history"
ARCHIVE_SCHEMA = "paper-desk-day-v1"
# An order B has not read this long after it was written: the matching is not running (shown, never assumed).
MATCHER_SILENT_S = 5.0
# 整股 / 零股 order windows (minutes of the Taipei day) and when IOC / FOK may be sent (continuous trading).
WHOLE_WINDOW = (8 * 60 + 30, 13 * 60 + 30)
ODD_WINDOW = (9 * 60, 13 * 60 + 30)
CONTINUOUS_FROM = 9 * 60
SIDES = {"buy": "買進", "sell": "賣出", "買進": "買進", "賣出": "賣出", "買": "買進", "賣": "賣出"}
TIFS = ("ROD", "IOC", "FOK")
FINAL_STATES = {"filled", "cancelled", "expired", "rejected"}
STATE_LABELS = {"submitted": "等待撮合", "pending": "送出中", "working": "委託中", "filled": "全部成交", "cancelled": "已取消",
                "expired": "已失效", "rejected": "拒絕"}
# 委託紀錄 reads at most this many days at once (one request; the screen pages by date range).
HISTORY_MAX_DAYS = 366
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _amount(qty: int, lot: str) -> str:
    return f"{qty / LOT:g} 張" if lot == "whole" else f"{qty} 股"


def _price_text(scaled: Any) -> str:
    return "市價" if scaled is None else f"{_price(scaled):g}"


def trade_kind(trade: dict[str, Any]) -> str:
    """委託紀錄's 類型 of one ledger trade (使用者 10-17): 999 股以內 is 零股; a trade the ledger paired with a same-day
    opposite trade (`is_daytrade`, from its 當沖 legs) is 當沖; anything else is 現股."""
    if float(trade.get("qty") or 0) < LOT:
        return "零股"
    return "當沖" if trade.get("is_daytrade") else "現股"


def tick_size(price: Decimal, instrument_kind: str) -> Decimal:
    """台股 升降單位 of an instrument kind (the price policy's one table, config/twse_price_policy.json)."""
    tick = twse_tick_size(price, instrument_kind)
    if tick is None:
        raise invalid_account_input(f"價格 {price} 沒有升降單位")
    return tick


def _decimal(value: Any, label: str) -> Decimal:
    try:
        number = Decimal(str(value).replace(",", "").strip())
    except (InvalidOperation, ValueError):
        raise invalid_account_input(f"{label}必須是數字") from None
    if not number.is_finite():
        raise invalid_account_input(f"{label}必須是數字")
    return number


def _scaled(price: Decimal) -> int:
    return derived_price_to_units(price)


def _price_decimal(scaled: int) -> Decimal:
    """A 1/10_000 price as the exact Decimal (money is computed with this, never with the display float)."""
    return Decimal(int(scaled)) / DEFAULT_PRICE_SCALE


def _price(scaled: Any) -> float:
    """A 1/10_000 price as the number an API answer shows."""
    return float(_price_decimal(scaled))


def _fill_price(fill: dict[str, Any]) -> int | float:
    """A matched fill's price as the ledger records it."""
    return _number(_price_decimal(fill["price_scaled"]))


def _fill_time(fill: dict[str, Any]) -> str:
    """A matched fill's exchange time (Taipei, HH:MM:SS); "" when the matcher gave none."""
    ts = fill["exchange_ts_ns"]
    return datetime.fromtimestamp(ts / 1e9, TAIPEI).strftime("%H:%M:%S") if ts else ""


def _number(value: Decimal | float) -> int | float:
    value = Decimal(str(value))
    return int(value) if value == value.to_integral_value() else float(value)


def _shares(value: Any) -> int:
    """A share count as the desk keeps it: an integer (B writes JSON numbers; 2000.0 is 2000, 2000.5 is refused)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != int(value) or value < 0:
        raise ValueError(f"a share count is a non-negative whole number, got {value!r}")
    return int(value)


def _int(value: Any, what: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{what} is an integer, got {value!r}")
    return value


def _text(value: Any, what: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{what} is a non-empty string, got {value!r}")
    return value


# Every result record B writes (native/analysis_runtime/src/paper.rs emit): its required fields and how each is read.
# A record is checked whole before it changes anything; an unknown type or a missing / mistyped field is refused (and
# quarantined by _read_results), never half-applied or silently ignored.
RESULT_FIELDS: dict[str, dict[str, str]] = {
    "read": {"cmd_id": "text", "order_id": "text"},
    "entered": {"cmd_id": "text", "order_id": "text"},
    "fill": {"id": "text", "order_id": "text", "qty": "shares", "price": "int"},
    "done": {"order_id": "text", "state": "state"},
    "notice": {"order_id": "text"},
    "reduced": {"cmd_id": "text", "order_id": "text", "qty": "shares"},
    "replaced": {"cmd_id": "text", "order_id": "text", "qty": "shares", "price": "int"},
    "refused": {},
}


def _result(record: dict[str, Any]) -> dict[str, Any]:
    """`record` checked against RESULT_FIELDS and typed: shares as int, prices as scaled int, times as int ns."""
    kind = record.get("type")
    fields = RESULT_FIELDS.get(kind) if isinstance(kind, str) else None
    if fields is None:
        raise ValueError(f"unknown result type {kind!r}")
    out = dict(record)
    for name, how in fields.items():
        if name not in record:
            raise ValueError(f"a {kind} result has no {name}")
        value = record[name]
        if how == "text":
            out[name] = _text(value, name)
        elif how == "int":
            out[name] = _int(value, name)
        elif how == "shares":
            out[name] = _shares(value)
        elif how == "state" and value not in FINAL_STATES:
            raise ValueError(f"a done result's state is one of {sorted(FINAL_STATES)}, got {value!r}")
    out["exchange_ts_ns"] = _int(record.get("exchange_ts_ns") or 0, "exchange_ts_ns")
    for name in ("id", "cmd_id", "order_id", "reason"):
        if record.get(name) is not None and not isinstance(record[name], str):
            raise ValueError(f"{name} is a string, got {record[name]!r}")
    out["reason"] = record.get("reason") or ""
    return out


# The PaperOrderDesk method that applies each result type.
RESULT_HANDLERS = {"read": "_on_read", "entered": "_on_entered", "fill": "_on_fill", "done": "_on_done", "notice": "_on_notice",
                   "reduced": "_on_reduced", "replaced": "_on_replaced", "refused": "_on_refused"}
if set(RESULT_HANDLERS) != set(RESULT_FIELDS):
    raise RuntimeError("every result type in RESULT_FIELDS needs its handler in RESULT_HANDLERS")


class PaperOrderDesk:
    def __init__(self, ledger, root: Path, *, now: Callable[[], datetime] | None = None,
                 clock_ns: Callable[[], int] = time.time_ns) -> None:
        self.ledger = ledger
        self.root = Path(root)
        self._now = now or (lambda: datetime.now(TAIPEI))
        self._clock_ns = clock_ns
        self.feed = ChangeFeed()
        self._lock = threading.RLock()
        self._orders: dict[str, dict[str, Any]] = {}
        self._commands: dict[str, dict[str, Any]] = {}
        self._deleted: set[str] = set()
        # The ledger trades of each deleted order (its tombstone): finishing a deletion never needs the order itself.
        self._deleted_trades: dict[str, list[str]] = {}
        self._results_offset = 0
        self._orders_offset = 0
        self._compacted_on = ""
        self.revision = 0
        self.import_failures = 0
        self._last_import_error = ""
        # Fills the ledger refused: written again no sooner than this (time.monotonic()), one recorded recovery.
        self._import_retry_at = 0.0
        self._import_retry_wait = 0.0
        from service.platform.remediation import Recovery

        self._import_recovery = Recovery(component="paper_orders", mechanism_id="account.paper_fill_import_retry")
        # Result ids already applied: a record written twice (a retried write) is one result.
        self._seen_results: set[str] = set()
        # While a start reads the journals: the commands of orders.jsonl not taken yet, in file order (_take_loaded).
        self._loading: list[dict[str, Any]] = []
        # Importing fills and deleting an order with its fills never run at the same time.
        self._import_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.root.mkdir(parents=True, exist_ok=True)
        self._load()
        # The paper ledger's own writes check against the working orders too (委託預扣): a manual trade or
        # deletion that a working order relies on is refused.
        ledger.working_reservations = self._reservation_trades
        self._finish_deletions()

    # ------------------------------------------------------------------ files
    def _lines(self, name: str) -> list[dict[str, Any]]:
        path = self.root / name
        if not path.exists():
            return []
        out = []
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                out.append(json.loads(line))
            except ValueError as exc:
                record_failure(_log, f"reading a line of {path}", exc)
        return out

    def _append(self, name: str, records: list[dict[str, Any]]) -> None:
        """Append whole lines and sync them."""
        path = self.root / name
        text = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())

    def _load(self) -> None:
        """The checkpoint (when there is a usable one), then only the journal lines written after it."""
        with self._lock:
            for record in self._lines(LOCAL_FILE):
                if record.get("type") == "deleted":
                    self._deleted.add(str(record.get("order_id")))
                    self._deleted_trades[str(record.get("order_id"))] = [str(t) for t in record["trades"]]
            self._restore_checkpoint()
            path = self.root / ORDERS_FILE
            offset = self._orders_offset
            if path.exists():
                with open(path, "rb") as fh:
                    fh.seek(offset)
                    data = fh.read()
                for raw in data.splitlines(keepends=True):
                    if raw.strip():
                        try:
                            self._loading.append(json.loads(raw))
                        except ValueError as exc:
                            record_failure(_log, f"reading a line of {path}", exc)
                    offset += len(raw)
            self._orders_offset = offset
            # Each command is taken where the matching read it (its read result), so its 經過 line comes after the
            # results written before that and before those after; the commands not read yet are taken last.
            self._read_results()
            self._take_loaded(len(self._loading))
            self._compact()
            self._save_checkpoint()

    def _restore_checkpoint(self) -> None:
        path = self.root / CHECKPOINT_FILE
        if not path.exists():
            return
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(doc, dict) or doc.get("schema") != CHECKPOINT_SCHEMA:
                raise ValueError(f"not a {CHECKPOINT_SCHEMA} document")
            orders, commands = dict(doc["orders"]), dict(doc["commands"])
            seen, orders_offset, results_offset = set(doc["seen_results"]), _int(doc["orders_offset"], "orders_offset"), \
                _int(doc["results_offset"], "results_offset")
        except (OSError, ValueError, KeyError, TypeError) as exc:
            # Read from the journals' start instead: slower, never wrong (they are the record).
            record_failure(_log, f"reading {path} (the journals are read from their start)", exc)
            return
        self._orders, self._commands, self._seen_results = orders, commands, seen
        self._orders_offset, self._results_offset = orders_offset, results_offset

    def _save_checkpoint(self) -> None:
        from service.platform.atomic_files import write_json_atomic

        with self._lock:
            doc = {"schema": CHECKPOINT_SCHEMA, "orders_offset": self._orders_offset, "results_offset": self._results_offset,
                   "orders": self._orders, "commands": self._commands, "seen_results": sorted(self._seen_results)}
            try:
                write_json_atomic(self.root / CHECKPOINT_FILE, doc, durable=True, compact=True)
            except OSError as exc:  # the journals still hold everything; the next start reads more of them
                record_failure(_log, f"writing {CHECKPOINT_FILE}", exc)

    # ------------------------------------------------------------------ day archive
    def _archive_path(self, trading_date: str) -> Path:
        return self.root / ARCHIVE_DIR / f"{trading_date}.json"

    def _archived(self, trading_date: str) -> dict[str, dict[str, Any]]:
        """The finished orders of one earlier day (order_id -> order); empty when none were archived."""
        path = self._archive_path(trading_date)
        if not path.exists():
            return {}
        doc = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(doc, dict) or doc.get("schema") != ARCHIVE_SCHEMA or not isinstance(doc.get("orders"), dict):
            raise ValueError(f"{path} is not a {ARCHIVE_SCHEMA} document")
        return doc["orders"]

    def _compact(self) -> None:
        """Move the finished orders of earlier days (every fill in the ledger) to their day's archive, with their
        commands and result ids; the day's file is written before memory drops them. Once per day."""
        today = self._today()[0]
        if self._compacted_on == today:
            return
        from service.platform.atomic_files import write_json_atomic

        with self._lock:
            by_day: dict[str, dict[str, dict[str, Any]]] = {}
            for order_id, order in self._orders.items():
                day = order["command"]["trading_date"]
                if (day < today and order["state"] in FINAL_STATES
                        and (order_id in self._deleted or all(f.get("imported") for f in order["fills"]))):
                    by_day.setdefault(day, {})[order_id] = order
            for day, orders in sorted(by_day.items()):
                try:
                    merged = {**self._archived(day), **orders}
                    write_json_atomic(self._archive_path(day), {"schema": ARCHIVE_SCHEMA, "trading_date": day, "orders": merged},
                                      durable=True, compact=True)
                except (OSError, ValueError) as exc:  # those orders stay in memory and are archived on a later day
                    record_failure(_log, f"archiving the paper orders of {day}", exc)
                    continue
                for order_id in orders:
                    del self._orders[order_id]
                    for cmd_id in [c for c, cmd in self._commands.items() if cmd.get("order_id") == order_id]:
                        del self._commands[cmd_id]
                    self._seen_results = {r for r in self._seen_results if not r.startswith((f"{order_id}-", f"{order_id}:"))}
            self._compacted_on = today

    def _find_order(self, order_id: str) -> dict[str, Any] | None:
        """An order in memory, or a finished one of an earlier day from its archive (PO-YYYYMMDD-NNNN names its day)."""
        order = self._orders.get(order_id)
        if order is not None:
            return order
        found = re.fullmatch(r"PO-(\d{4})(\d{2})(\d{2})-\d+", order_id)
        return self._archived(f"{found[1]}-{found[2]}-{found[3]}").get(order_id) if found else None

    def _orders_between(self, start: str, end: str) -> list[dict[str, Any]]:
        """Every order of the trading days start..end not deleted: the archived days' and those in memory."""
        out = {oid: o for oid, o in self._orders.items() if start <= o["command"]["trading_date"] <= end}
        for path in sorted((self.root / ARCHIVE_DIR).glob("*.json")) if (self.root / ARCHIVE_DIR).exists() else []:
            if start <= path.stem <= end:
                for oid, order in self._archived(path.stem).items():
                    out.setdefault(oid, order)
        return [o for oid, o in out.items() if oid not in self._deleted]

    def _submit(self, command: dict[str, Any]) -> None:
        """Append a command to orders.jsonl and take it; the checkpoint's journal offset moves past it.

        The results the matching wrote before it are applied first: an order's 經過 is in the order things happened
        (a fill the poll has not read yet came before this cancel). Its fills reach the ledger at the next poll."""
        self._read_results()
        self._append(ORDERS_FILE, [command])
        self._take_command(command)
        # The file's size, not the line's length: the text-mode append writes the platform's line ending. Only this
        # desk writes orders.jsonl, and under its lock.
        self._orders_offset = (self.root / ORDERS_FILE).stat().st_size

    def _take_loaded(self, count: int) -> None:
        for command in self._loading[:count]:
            self._take_command(command)
        del self._loading[:count]

    def _take_command(self, command: dict[str, Any]) -> None:
        self._commands[command["cmd_id"]] = command
        at = int(command.get("accepted_ns") or 0)
        if command["type"] == "new":
            order = self._orders[command["order_id"]] = self._order_from(command)
            self._step(order, at, f"委託 {_amount(order['qty'], command['lot'])} @{_price_text(command.get('price'))} {command['tif']}")
        else:
            order = self._orders.get(command["order_id"])
            if order is not None:
                order["pending_commands"].append(command["cmd_id"])
                lot = order["command"]["lot"]
                sent = {"cancel": "送出刪單", "replace": f"送出改價 @{_price_text(command.get('price'))}"}
                self._step(order, at, sent.get(command["type"]) or f"送出減量 {_amount(_shares(command.get('qty') or 0), lot)}")

    @staticmethod
    def _step(order: dict[str, Any], at_ns: int, text: str) -> None:
        """One line of the order's 經過 (委託紀錄): when (exchange or accepted time, ns) and what."""
        order["steps"].append((int(at_ns or 0), text))

    @staticmethod
    def _order_from(command: dict[str, Any]) -> dict[str, Any]:
        # Shares as int and prices as 1/10_000 integers throughout; display numbers only in view().
        # `price_changes`: each 改價 the matching made, in order ({at_ns, from, to}, scaled prices); the command keeps
        # the price the order now has (what its reservation and every screen read).
        return {"command": command, "order_id": command["order_id"], "state": "submitted", "qty": _shares(command["qty"]),
                "filled": 0, "removed": 0, "fills": [], "reason": "", "messages": [], "pending_commands": [],
                "price_changes": [], "steps": []}

    def _read_results(self) -> int:
        """New records of results.jsonl applied (whole lines only: B may be writing the last); returns how many.

        The read position moves past a line only once it is handled: applied, or -- a line that does not decode or
        cannot be applied -- copied to results.quarantine.jsonl with an error record. A line whose quarantine write
        fails stops the read there, to be tried again on the next poll; nothing is skipped unrecorded."""
        path = self.root / RESULTS_FILE
        if not path.exists():
            return 0
        with open(path, "rb") as fh:
            fh.seek(self._results_offset)
            data = fh.read()
        complete = data.rfind(b"\n") + 1
        if complete <= 0:
            return 0
        count = 0
        for raw in data[:complete].splitlines(keepends=True):
            if raw.strip():
                try:
                    record = json.loads(raw.decode("utf-8"))
                    if not isinstance(record, dict):
                        raise ValueError("a result record is a JSON object")
                    self._apply_result(_result(record))
                    count += 1
                except (ValueError, KeyError, TypeError) as exc:
                    kept = self._quarantine_result(raw, self._results_offset, exc)   # records the line and why
                    if not kept:
                        break
            self._results_offset += len(raw)
        return count

    def _quarantine_result(self, raw: bytes, offset: int, error: Exception) -> bool:
        """Keep a result line that could not be used, with where it was and why; False when that write failed."""
        record_failure(_log, f"applying the matching result at byte {offset} of {RESULTS_FILE} (kept in {RESULTS_QUARANTINE_FILE})", error)
        try:
            self._append(RESULTS_QUARANTINE_FILE, [{"offset": offset, "error": f"{type(error).__name__}: {error}"[:500],
                                                    "line": raw.decode("utf-8", errors="replace").rstrip("\n")}])
        except OSError as exc:
            record_failure(_log, f"writing {RESULTS_QUARANTINE_FILE}", exc)
            return False
        return True

    def _apply_result(self, record: dict[str, Any]) -> None:
        """One result checked by _result(): the state change of its type (RESULT_HANDLERS), applied once per id."""
        result_id = record.get("id") or ""
        if result_id:
            if result_id in self._seen_results:
                return
            self._seen_results.add(result_id)
        if record["type"] == "read":
            taken = next((i for i, c in enumerate(self._loading) if c.get("cmd_id") == record["cmd_id"]), None)
            if taken is not None:
                self._take_loaded(taken + 1)
        order = self._orders.get(record.get("order_id") or "")
        if order is None:
            if record["type"] == "refused" and not record.get("order_id"):
                _log.error("paper matching refused a command: %s", record)
            return
        getattr(self, RESULT_HANDLERS[record["type"]])(order, record, record["exchange_ts_ns"])

    def _on_read(self, order: dict[str, Any], record: dict[str, Any], at: int) -> None:
        if record["cmd_id"] == order["order_id"] and order["state"] == "submitted":
            order["state"] = "pending"

    def _on_entered(self, order: dict[str, Any], record: dict[str, Any], at: int) -> None:
        cmd_id = record["cmd_id"]
        if cmd_id == order["order_id"]:
            self._step(order, at, "進入撮合")
            if order["state"] in ("submitted", "pending"):
                order["state"] = "working"
        if cmd_id in order["pending_commands"]:
            order["pending_commands"].remove(cmd_id)

    def _on_fill(self, order: dict[str, Any], record: dict[str, Any], at: int) -> None:
        fill = {"fill_id": record["id"], "order_id": order["order_id"], "qty": record["qty"], "price_scaled": record["price"],
                "exchange_ts_ns": at, "reason": record["reason"],
                "trading_date": record.get("trading_date") or order["command"]["trading_date"]}
        order["filled"] += fill["qty"]
        if order["state"] not in FINAL_STATES:
            order["state"] = "working"
        order["fills"].append(fill)
        self._step(order, at, f"成交 {_amount(fill['qty'], order['command']['lot'])} @{_price_text(fill['price_scaled'])}"
                              f"{'（' + fill['reason'] + '）' if fill['reason'] else ''}")

    def _on_done(self, order: dict[str, Any], record: dict[str, Any], at: int) -> None:
        order["state"], order["reason"] = record["state"], record["reason"]
        label = STATE_LABELS[order["state"]]
        self._step(order, at, f"{label}：{order['reason']}" if order["reason"] else label)
        if order["state"] != "filled":
            order["removed"] = max(0, order["qty"] - order["filled"])
        order["pending_commands"] = []

    def _on_notice(self, order: dict[str, Any], record: dict[str, Any], at: int) -> None:
        # The matching could not see this stock for a while (R1): kept with the order, the newest last.
        order["messages"] = (order["messages"] + [record["reason"]])[-5:]
        self._step(order, at, record["reason"])

    def _on_reduced(self, order: dict[str, Any], record: dict[str, Any], at: int) -> None:
        order["removed"] += record["qty"]
        self._step(order, at, f"減量 {_amount(record['qty'], order['command']['lot'])} 完成")

    def _on_replaced(self, order: dict[str, Any], record: dict[str, Any], at: int) -> None:
        # The same order at its new price (C3): the command takes it, the change is kept with when and from what.
        command = order["command"]
        order["price_changes"].append({"at_ns": at, "from": command.get("price"), "to": record["price"]})
        order["command"] = {**command, "price_type": "limit", "price": record["price"]}
        if record["cmd_id"] in order["pending_commands"]:
            order["pending_commands"].remove(record["cmd_id"])
        self._step(order, at, f"改價完成 @{_price_text(record['price'])}（剩 {_amount(record['qty'], command['lot'])}）")

    def _on_refused(self, order: dict[str, Any], record: dict[str, Any], at: int) -> None:
        cmd_id, reason = record.get("cmd_id") or "", record["reason"]
        order["messages"].append(reason)
        self._step(order, at, f"被拒：{reason}")
        if cmd_id in order["pending_commands"]:
            order["pending_commands"].remove(cmd_id)
        command = self._commands.get(cmd_id) or {}
        # A refused 刪單／減量／改價 leaves the order as it was; only a refused new order is rejected.
        if command.get("type") == "new" or cmd_id == order["order_id"]:
            order["state"], order["reason"] = "rejected", reason

    # ------------------------------------------------------------------ polling
    def poll(self) -> bool:
        """Read what the matching wrote since the last poll, put new fills in the ledger, tell the screens."""
        if self._compacted_on != self._today()[0]:
            self._compact()
            self._save_checkpoint()
        with self._import_lock:
            with self._lock:
                changed = self._read_results() > 0
                due = time.monotonic() >= self._import_retry_at
                pending_import = self._unimported_fills() if due else []
            if pending_import:
                self._import(pending_import)
        if changed or pending_import:
            self._publish()
        return changed

    def _unimported_fills(self) -> list[dict[str, Any]]:
        out = []
        for order in self._orders.values():
            if order["order_id"] in self._deleted:
                continue
            for fill in order["fills"]:
                if not fill.get("imported"):
                    out.append(fill)
        return out

    def _import(self, fills: list[dict[str, Any]]) -> None:
        """The orders these new fills belong to, each written as one ledger trade with all of its fills so far."""
        with self._lock:
            rows = [self._ledger_trade(self._orders[order_id]) for order_id in dict.fromkeys(f["order_id"] for f in fills)]
        try:
            self.ledger.local_input.import_matched_orders(rows)
        except Exception as exc:  # kept unimported: written again after a doubling wait, recorded, and shown
            with self._lock:
                self.import_failures += 1
                self._last_import_error = f"{type(exc).__name__}: {exc}"
                self._import_retry_wait = min(IMPORT_RETRY_MAX_S, max(IMPORT_RETRY_FIRST_S, self._import_retry_wait * 2))
                self._import_retry_at = time.monotonic() + self._import_retry_wait
                wait = self._import_retry_wait
            record_failure(_log, "writing matched paper fills into the paper ledger", exc)
            self._import_recovery.failed("ledger_write_failed", detail={"fills": [f["fill_id"] for f in fills][:50],
                                                                         "error": self._last_import_error[:300], "next_wait_s": wait})
            return
        with self._lock:
            for fill in fills:
                fill["imported"] = True
            self._last_import_error = ""
            self._import_retry_wait = 0.0
            self._import_retry_at = 0.0
        self._import_recovery.finish("succeeded", detail={"fills": len(fills)})
        self._check_after_fills(fills)

    @staticmethod
    def _ledger_trade(order: dict[str, Any]) -> dict[str, Any]:
        """One order as one ledger trade (使用者 11-04: one order number, one trade -- its fills differ only in time):
        its fills as qty@price parts, at its first fill's time and trading day."""
        first = order["fills"][0]
        return {"order_id": order["order_id"], "trade_date": first["trading_date"], "code": order["command"]["code"],
                "action": SIDES[order["command"]["side"]], "fills": [{"qty": f["qty"], "price": _fill_price(f)} for f in order["fills"]],
                "trade_time": _fill_time(first), "reasons": list(dict.fromkeys(f["reason"] for f in order["fills"] if f["reason"]))}

    def _check_after_fills(self, fills: list[dict[str, Any]]) -> None:
        """A fill is the exchange's: never refused. The ledger after it must still satisfy the paper rules (the
        reservation and the guarded manual writes keep it so); a breach is recorded and shown on the order."""
        try:
            outcomes = capital.simulate(self.ledger.capital_trades())
        except Exception as exc:  # recorded; the fills are in the ledger either way
            record_failure(_log, "checking the paper ledger after matched fills", exc)
            return
        for order_id in dict.fromkeys(f["order_id"] for f in fills):
            violation = getattr(outcomes.get(order_id), "violation", "")
            if violation:
                _log.error("paper order %s breaks the paper ledger's rules after its fills: %s", order_id, violation)
                with self._lock:
                    order = self._orders.get(order_id)
                    if order is not None:
                        order["messages"] = (order["messages"] + [f"成交後帳本規則不符：{violation}"])[-5:]

    def _publish(self) -> None:
        with self._lock:
            self.revision += 1
            revision = self.revision
        self._save_checkpoint()
        self.feed.publish({"revision": revision})

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop.clear()

        def run() -> None:
            while not self._stop.wait(POLL_INTERVAL_S):
                try:
                    self.poll()
                except Exception as exc:  # recorded; the next poll tries again
                    record_failure(_log, "polling the paper matching results", exc)

        self._thread = threading.Thread(target=run, name="paper-orders", daemon=True)
        self._thread.start()

    def close(self, timeout: float = CLOSE_WAIT_S) -> bool:
        """Stop polling. True once the polling thread has exited; False (recorded) when it is still inside a poll after
        `timeout` -- it keeps its handle, so the desk is not reported closed while it may still write the ledger."""
        self._stop.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=timeout)
            if thread.is_alive():
                record_failure(_log, "stopping the paper order desk",
                               TimeoutError(f"the polling thread of {self.root} is still running after {timeout} s"))
                return False
            self._thread = None
        self._save_checkpoint()
        self.feed.close()
        return True

    # ------------------------------------------------------------------ placing
    def _today(self) -> tuple[str, int]:
        now = self._now().astimezone(TAIPEI)
        return now.date().isoformat(), now.hour * 60 + now.minute

    def _next_order_id(self, trading_date: str) -> str:
        prefix = f"PO-{trading_date.replace('-', '')}-"
        taken = [int(oid[len(prefix):]) for oid in self._orders if oid.startswith(prefix) and oid[len(prefix):].isdigit()]
        return f"{prefix}{max(taken, default=0) + 1:04d}"

    def _working(self, trading_date: str | None = None) -> list[dict[str, Any]]:
        return [o for o in self._orders.values() if o["state"] not in FINAL_STATES and o["order_id"] not in self._deleted
                and (trading_date is None or o["command"]["trading_date"] == trading_date)]

    def _reserved_orders(self, exclude: str = "") -> list[dict[str, Any]]:
        """The working orders, each holding a reservation at the price it has now (a 改價 changes it once the
        matching made the change)."""
        return [order for order in self._working() if order["order_id"] != exclude]

    def _reserved_cash(self, order: dict[str, Any]) -> Decimal:
        """A working buy's cash: what is left of it at its price (a market buy at 漲停) and its fee."""
        gross = self._remaining(order) * self._reserve_price(order["command"])
        return gross + self.ledger.accounting_core.fee_for_order("台股", gross) if gross > 0 else Decimal(0)

    def _reservation_trades(self) -> list[capital.CapitalTrade]:
        """The working orders as the capital rules read them (as if filled), for the ledger's own write checks."""
        with self._lock:
            return [self._hypothetical(o["command"], self._remaining(o), n) for n, o in enumerate(self._reserved_orders())]

    @staticmethod
    def _remaining(order: dict[str, Any]) -> int:
        return max(0, order["qty"] - order["filled"] - order["removed"])

    @staticmethod
    def _reserve_price(command: dict[str, Any]) -> Decimal:
        scaled = command.get("price") if command.get("price_type") == "limit" else command.get("reserve_price")
        return Decimal(int(scaled or 0)) / DEFAULT_PRICE_SCALE

    def _hypothetical(self, command: dict[str, Any], qty: int, n: int) -> capital.CapitalTrade:
        """A working order as the capital rules read it: as if what is left of it had filled now (委託預扣)."""
        q = Decimal(_shares(qty))
        return capital.CapitalTrade(f"~{command['order_id']}", command["trading_date"], "99:99:9" + str(min(n, 9)), 10**9 + n, "台股",
                                    SIDES[command["side"]], command["code"], q, q * self._reserve_price(command))

    def _check_funds(self, command: dict[str, Any], replacing: dict[str, Any] | None = None) -> None:
        """The lot rules and the daily limit with every working order reserved. The cash is not checked: 台股 settles
        T+2, so a buy needs only 額度 when it is placed (a day trade settles net, with no principal) (user 11-06)."""
        trading_date = command["trading_date"]
        settings = capital.read_settings(self.ledger._get_meta, self.ledger.capital_scope)
        trades = list(self.ledger.capital_trades())
        working = self._reserved_orders(exclude=replacing["order_id"] if replacing else "")
        for n, order in enumerate(working):
            trades.append(self._hypothetical(order["command"], self._remaining(order), n))
        new = self._hypothetical(command, command["qty"], len(working))
        trades.append(new)
        outcomes = capital.simulate(trades)
        if outcomes[new.trade_id].violation:
            raise invalid_account_input(outcomes[new.trade_id].violation)
        limit = Decimal(settings["台股"].get("daily_limit") or "0")
        if limit > 0:
            used = capital.used_limit(trades, "台股", trading_date, outcomes)
            if used > limit:
                raise invalid_account_input(f"每日交易額度 {_number(limit):,} 不足：含委託中的單已用 {_number(used):,}")

    def place(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Check and write one order (O1-O7). The matching takes it from orders.jsonl."""
        code = str(payload.get("code") or "").strip().upper()
        side = SIDES.get(str(payload.get("side") or "").strip())
        price_type = str(payload.get("price_type") or "limit").strip().lower()
        tif = str(payload.get("tif") or "ROD").strip().upper()
        qty = _decimal(payload.get("qty"), "數量")
        if not code:
            raise invalid_account_input("缺少股號")
        if side is None:
            raise invalid_account_input("買賣別必須是買進或賣出")
        if price_type not in ("limit", "market"):
            raise invalid_account_input("價格類別必須是限價或市價")
        if tif not in TIFS:
            raise invalid_account_input("委託條件必須是 ROD、IOC 或 FOK")
        if qty <= 0 or qty != qty.to_integral_value():
            raise invalid_account_input("數量必須是正整數股")
        lot = "whole" if qty >= LOT else "odd"
        if lot == "whole" and qty % LOT:
            raise invalid_account_input("一筆委託是整股（1,000 股的倍數）或零股（1～999 股），要分成兩筆")
        trading_date, minute = self._today()
        if not capital.is_trading_day("台股", datetime.fromisoformat(trading_date).date()):
            raise invalid_account_input("今天不是交易日")
        window = WHOLE_WINDOW if lot == "whole" else ODD_WINDOW
        if not window[0] <= minute < window[1]:
            raise invalid_account_input(f"{'整股' if lot == 'whole' else '盤中零股'}委託時間是 {window[0] // 60:02d}:{window[0] % 60:02d}～13:30")
        if tif != "ROD" and minute < CONTINUOUS_FROM:
            raise invalid_account_input("開盤前的集合競價只接受 ROD")
        price = None
        if price_type == "limit":
            price_value = _decimal(payload.get("price"), "價格")
            if price_value <= 0:
                raise invalid_account_input("價格必須大於 0")
            tick = tick_size(price_value, self.ledger.accounting_core.instrument_kind(code))
            if price_value % tick:
                raise invalid_account_input(f"價格 {price_value} 不在升降單位 {tick} 上")
            price = _scaled(price_value)
        reserve = payload.get("reserve_price")
        reserve_scaled = _scaled(_decimal(reserve, "預扣價格")) if reserve not in (None, "") else None
        if price_type == "market" and not reserve_scaled:
            raise invalid_account_input("市價單要帶漲停（買）或跌停（賣）價格作為預扣")
        # The ledger's write lock across the money check and the append: no ledger write (sync, manual trade, an
        # imported fill) lands between them. Ledger before desk, the order the ledger's own checks take them in.
        with self.ledger.write_lock, self._lock:
            order_id = self._next_order_id(trading_date)
            command = {"type": "new", "cmd_id": order_id, "order_id": order_id, "accepted_ns": self._clock_ns(), "trading_date": trading_date,
                       "code": code, "side": "buy" if side == "買進" else "sell", "lot": lot, "price_type": price_type, "price": price,
                       "qty": int(qty), "tif": tif}
            if lot == "odd":
                # 零股交易 as set when the order is placed: the order is matched so to the end, a rebuild too.
                settings = capital.read_settings(self.ledger._get_meta, self.ledger.capital_scope)
                command["odd_matching"] = settings["台股"]["odd_lot_matching"]
            self._check_funds({**command, "reserve_price": reserve_scaled})
            line = dict(command)
            if reserve_scaled:
                line["reserve_price"] = reserve_scaled
            self._submit(line)
        self._publish()
        return {"ok": True, "order": self.view(order_id)}

    def _command_for(self, order_id: str, kind: str) -> tuple[dict[str, Any], str]:
        order = self._orders.get(order_id)
        if order is None or order_id in self._deleted:
            raise ActualAccountError("找不到這筆委託", classification="NOT_FOUND", status_code=404)
        if order["state"] in FINAL_STATES:
            raise invalid_account_input(f"委託已{STATE_LABELS[order['state']]}")
        n = 1 + sum(1 for c in self._commands.values() if c.get("order_id") == order_id and c["type"] != "new")
        return order, f"{order_id}:{kind}{n}"

    def cancel(self, order_id: str) -> dict[str, Any]:
        with self._lock:
            _order, cmd_id = self._command_for(order_id, "c")
            command = {"type": "cancel", "cmd_id": cmd_id, "order_id": order_id, "accepted_ns": self._clock_ns()}
            self._submit(command)
        self._publish()
        return {"ok": True, "order": self.view(order_id)}

    def reduce(self, order_id: str, qty: Any) -> dict[str, Any]:
        by = _decimal(qty, "減量")
        with self._lock:
            order, cmd_id = self._command_for(order_id, "r")
            if by <= 0 or by != by.to_integral_value():
                raise invalid_account_input("減量必須是正整數股")
            if order["command"]["lot"] == "whole" and by % LOT:
                raise invalid_account_input("整股委託以張（1,000 股）為單位減量")
            if by >= self._remaining(order):
                raise invalid_account_input("減量不能大於等於剩餘數量；要全部取消請刪單")
            command = {"type": "reduce", "cmd_id": cmd_id, "order_id": order_id, "accepted_ns": self._clock_ns(), "qty": int(by)}
            self._submit(command)
        self._publish()
        return {"ok": True, "order": self.view(order_id)}

    def replace(self, order_id: str, price: Any) -> dict[str, Any]:
        """改價 (C3): one command on the same order (its number kept); the matching moves what it has left to the new
        price, at the back of that price's queue."""
        value = _decimal(price, "價格")
        with self.ledger.write_lock, self._lock:
            order, cmd_id = self._command_for(order_id, "p")
            if order["command"]["price_type"] != "limit":
                raise invalid_account_input("市價單不能改價")
            if any((self._commands.get(c) or {}).get("type") == "replace" for c in order["pending_commands"]):
                raise invalid_account_input("這筆委託已在改價中")
            tick = tick_size(value, self.ledger.accounting_core.instrument_kind(order["command"]["code"]))
            if value <= 0 or value % tick:
                raise invalid_account_input(f"價格 {value} 不在升降單位 {tick} 上")
            # The order as it would stand at the new price, checked with the other working orders.
            probe = {**order["command"], "price_type": "limit", "price": _scaled(value), "qty": self._remaining(order),
                     "trading_date": self._today()[0]}
            self._check_funds(probe, replacing=order)
            command = {"type": "replace", "cmd_id": cmd_id, "order_id": order_id, "accepted_ns": self._clock_ns(), "price": _scaled(value)}
            self._submit(command)
        self._publish()
        return {"ok": True, "order": self.view(order_id)}

    def cancel_all(self) -> dict[str, Any]:
        trading_date = self._today()[0]
        with self._lock:
            ids = [o["order_id"] for o in self._working(trading_date)]
        results = []
        for order_id in ids:
            try:
                results.append(self.cancel(order_id)["order"])
            except ActualAccountError as exc:  # not an error: the order finished or was deleted in between; answered per order
                results.append({"order_id": order_id, "error": str(exc)})
        return {"ok": True, "cancelled": len(results), "orders": results}

    def delete(self, order_id: str) -> dict[str, Any]:
        """A finished order with its fills out of the ledger (A4); the order leaves every list."""
        with self._import_lock:
            with self._lock:
                order = self._find_order(order_id)
                if order is None or order_id in self._deleted:
                    raise ActualAccountError("找不到這筆委託", classification="NOT_FOUND", status_code=404)
                if order["state"] not in FINAL_STATES:
                    raise invalid_account_input("委託還有效：先刪單，結束後才能刪除整筆委託")
                trade_ids = [order_id] if order["fills"] else []
            # The ledger's own check first (a later sell may have sold what this order bought): a refused deletion
            # leaves both the ledger and the order as they were.
            self.ledger.local_input.check_matched_orders_deletable(trade_ids)
            # The tombstone before the ledger: a crash in between is finished at the next start (_finish_deletions),
            # never an order whose fills come back.
            with self._lock:
                self._append(LOCAL_FILE, [{"type": "deleted", "order_id": order_id, "at_ns": self._clock_ns(), "trades": trade_ids}])
                self._deleted.add(order_id)
                self._deleted_trades[order_id] = trade_ids
            self.ledger.local_input.delete_matched_orders(trade_ids)
        self._publish()
        return {"ok": True, "order_id": order_id, "trades_deleted": len(trade_ids)}

    def _finish_deletions(self) -> None:
        """Deleted orders whose trades are still in the ledger (a crash between the tombstone and the ledger write)."""
        gone = [trade_id for trades in self._deleted_trades.values() for trade_id in trades]
        if not gone:
            return
        present = {t["trade_id"] for t in self.ledger.get_raw_trades(None, trade_ids=gone)}
        left = [tid for tid in gone if tid in present]
        if left:
            _log.warning("paper orders: finishing the deletion of %d matched orders' trades", len(left))
            self.ledger.local_input.delete_matched_orders(left)

    # ------------------------------------------------------------------ views
    def view(self, order_id: str, names: dict[str, str] | None = None) -> dict[str, Any]:
        """One order as the screens show it; `names` (code -> 股名, the security master) is read once by a caller
        listing many orders, else here."""
        if names is None:
            names = self.ledger._stock_names()
        with self._lock:
            order = self._find_order(order_id)
            if order is None:
                raise KeyError(order_id)
            return self._view(order, names)

    def _view(self, order: dict[str, Any], names: dict[str, str]) -> dict[str, Any]:
        order_id = order["order_id"]
        with self._lock:
            command = order["command"]
            filled = order["filled"]
            amount = sum((f["qty"] * _price_decimal(f["price_scaled"]) for f in order["fills"]), Decimal(0))
            silent = (order["state"] == "submitted" and (self._clock_ns() - int(command["accepted_ns"])) / 1e9 > MATCHER_SILENT_S)
            state = order["state"]
            label = STATE_LABELS.get(state, state)
            if state == "working" and filled > 0:
                label = "部分成交"
            if order["pending_commands"] and state not in FINAL_STATES:
                label = "刪改中"
            return {
                "order_id": order_id, "trading_date": command["trading_date"],
                "created_at": datetime.fromtimestamp(int(command["accepted_ns"]) / 1e9, TAIPEI).strftime("%H:%M:%S"),
                "code": command["code"], "name": names.get(str(command["code"]).upper(), ""),
                "side": SIDES[command["side"]], "lot": command["lot"], "price_type": command["price_type"],
                "price": _price(command["price"]) if command.get("price") is not None else None,
                "tif": command["tif"], "qty": _number(order["qty"]), "filled": _number(filled), "unfilled": _number(self._remaining(order)),
                "avg_price": float(round(amount / filled, 4)) if filled else None, "state": state, "state_label": label,
                "reason": order["reason"], "messages": list(order["messages"]),
                # Each 改價: when, from what price to what (the order's lines show them under its 委託).
                "price_changes": [{"time": self._clock_text(c["at_ns"])[:8],
                                   "from": _price(c["from"]) if c["from"] is not None else None, "to": _price(c["to"])}
                                  for c in order["price_changes"]],
                "matcher_silent": silent, "final": state in FINAL_STATES,
                "steps": [{"time": self._clock_text(at), "text": text} for at, text in order["steps"]],
                "fills": [{"fill_id": f["fill_id"], "qty": f["qty"], "price": _price(f["price_scaled"]), "reason": f["reason"],
                           "time": datetime.fromtimestamp(f["exchange_ts_ns"] / 1e9, TAIPEI).strftime("%H:%M:%S") if f["exchange_ts_ns"] else ""}
                          for f in order["fills"]],
            }

    def orders(self, trading_date: str | None = None) -> dict[str, Any]:
        """The day's orders."""
        trading_date = trading_date or self._today()[0]
        names = self.ledger._stock_names()
        with self._lock:
            views = [self._view(o, names) for o in self._orders_between(trading_date, trading_date)]
            silent = any(v["matcher_silent"] for v in views)
        views.sort(key=lambda v: v["order_id"], reverse=True)
        return {"ok": True, "trading_date": trading_date, "orders": views, "revision": self.revision,
                "matcher": {"silent": silent, "import_failures": self.import_failures, "last_import_error": self._last_import_error}}

    @staticmethod
    def _clock_text(at_ns: int) -> str:
        if not at_ns:
            return ""
        moment = datetime.fromtimestamp(at_ns / 1e9, TAIPEI)
        return moment.strftime("%H:%M:%S.") + f"{moment.microsecond // 1000:03d}"

    def history(self, start: str, end: str) -> dict[str, Any]:
        """委託紀錄 (帳務 → 模擬帳務): the trading days start..end (inclusive), newest first --
        `orders`: every 模擬下單 order with its fills, its 經過 and its 類型 (零股 by its lot, else 當沖 when its trade
        is, else 現股); orders deleted with their trades are not listed.
        `fills`: every trade of the paper ledger on those days (matched or typed in), with its 類型 (trade_kind)."""
        for value in (start, end):
            if not DATE.fullmatch(str(value or "")):
                raise invalid_account_input("日期格式要是 YYYY-MM-DD")
        if start > end:
            start, end = end, start
        if (datetime.fromisoformat(end) - datetime.fromisoformat(start)).days >= HISTORY_MAX_DAYS:
            raise invalid_account_input(f"一次最多查 {HISTORY_MAX_DAYS} 天")
        names = self.ledger._stock_names()
        trades = self.ledger.get_raw_trades(None, start=start, end=end)
        kinds = {t["trade_id"]: trade_kind(t) for t in trades}
        with self._lock:
            views = [self._view(o, names) for o in self._orders_between(start, end)]
        for v in views:
            v["kind"] = "零股" if v["lot"] == "odd" else ("當沖" if kinds.get(v["order_id"]) == "當沖" else "現股")
        views.sort(key=lambda v: (v["trading_date"], v["order_id"]), reverse=True)
        fills = []
        for t in trades:
            cash = AccountingCore.trade_cash(t["action"], Decimal(str(t["gross_amount"] or 0)), Decimal(str(t["fee"] or 0)), Decimal(str(t["tax"] or 0)))
            fills.append({"trade_id": t["trade_id"], "date": t["date"], "time": t["time"], "code": t["code"], "name": t["name"],
                          "action": t["action"], "qty": t["qty"], "avg_price": t["avg_price"], "gross_amount": t["gross_amount"],
                          "fee": t["fee"], "tax": t["tax"], "cash": _number(cash), "kind": kinds[t["trade_id"]],
                          "origin": "撮合" if t.get("source") == "paper_match" else "手動", "order_id": t.get("order_id") or "",
                          "fill_reason": t.get("fill_reason") or ""})
        fills.sort(key=lambda f: (str(f["date"]), str(f["time"] or "")), reverse=True)
        return {"ok": True, "start": start, "end": end, "orders": views, "fills": fills, "revision": self.revision}

    def fills(self, trading_date: str | None = None) -> dict[str, Any]:
        """成交 of a day in the paper ledger: the matched fills (with their order and why they filled) and the trades
        typed in by hand, with fee, tax and 應收付 (the ledger's own amounts)."""
        trading_date = trading_date or self._today()[0]
        rows = self.ledger.get_raw_trades(None, start=trading_date, end=trading_date)
        out = []
        for t in rows:
            gross = Decimal(str(t["gross_amount"] or 0))
            fee = Decimal(str(t["fee"] or 0))
            tax = Decimal(str(t["tax"] or 0))
            out.append({**t, "cash": _number(AccountingCore.trade_cash(t["action"], gross, fee, tax)),
                        "origin": "撮合" if t.get("source") == "paper_match" else "手動"})
        return {"ok": True, "trading_date": trading_date, "fills": out}

    def working_instruments(self) -> list[tuple[str, bool]]:
        """(code, odd lots) of every order not finished: the stock's quotes, and for an odd-lot order queued at the odd-lot
        matches (零股交易 根據實際排隊) its 盤中零股 too (background owner paper_orders)."""
        with self._lock:
            out = {(o["command"]["code"], False) for o in self._working()}
            out |= {(o["command"]["code"], True) for o in self._working() if o["command"].get("odd_matching") == "queue"}
        return sorted(out)

    def funds(self) -> dict[str, Any]:
        """額度 / 交割款 with the working orders' reservation (A3): the ledger's capital block (交割款 by date with the
        trades each is made of: capital.capital_view's `pending`) plus what is reserved."""
        trading_date, _ = self._today()
        settings = capital.read_settings(self.ledger._get_meta, self.ledger.capital_scope)
        view = dict(self.ledger.get_capital(self._now())["台股"])
        with self._lock:
            working = self._reserved_orders()
            trades = list(self.ledger.capital_trades())
            for n, order in enumerate(working):
                trades.append(self._hypothetical(order["command"], self._remaining(order), n))
            reserved_buys = sum((self._reserved_cash(o) for o in working if SIDES[o["command"]["side"]] == "買進"), Decimal(0))
        used_with_orders = capital.used_limit(trades, "台股", trading_date)
        limit = Decimal(settings["台股"].get("daily_limit") or "0")
        used = Decimal(str(view["used_today"]))
        view.update({
            "reserved_limit": _number(used_with_orders - used),
            "used_with_orders": _number(used_with_orders),
            "remaining_with_orders": _number(limit - used_with_orders) if limit > 0 else None,
            "reserved_cash": _number(reserved_buys),
            "available_cash": _number(Decimal(str(view["principal_after_settlement"])) - reserved_buys) if "principal_after_settlement" in view else None,
            # What an ordinary trade of each instrument kind is charged (the order ticket's 預估金額): the ledger's own
            # terms, 手續費折扣 applied (AccountingCore.closing_terms, core/trade_costs.js), and the 升降單位 tables
            # its price steppers use (config/twse_price_policy.json).
            "trade_terms": {kind: self.ledger.accounting_core.tw_closing_terms_of_kind(kind) for kind in PRICE_POLICY["tick_table_of_kind"]},
            "price_policy": price_policy_projection(),
        })
        return {"ok": True, "trading_date": trading_date, "capital": view}
