"""A paper order desk over a fresh ledger with a settable Taipei clock, and matcher results written as the matcher
writes them."""
from __future__ import annotations

import json
from datetime import datetime
from zoneinfo import ZoneInfo

from service.account.paper_orders import PaperOrderDesk
from service.account.paper_wallet_service import PaperWalletService

TPE = ZoneInfo("Asia/Taipei")


class Clock:
    def __init__(self, hhmm: str = "10:00", day: str = "2026-10-16") -> None:
        self.set(hhmm, day)

    def set(self, hhmm: str, day: str = "2026-10-16") -> None:
        self.value = datetime.fromisoformat(f"{day}T{hhmm}:00").replace(tzinfo=TPE)

    def now(self) -> datetime:
        return self.value

    def ns(self) -> int:
        return int(self.value.timestamp() * 1e9)


def make_desk(tmp_path, clock=None):
    clock = clock or Clock()
    ledger = PaperWalletService(db_path=tmp_path / "paper.db", config_path=tmp_path / "config.json", security_master_path=tmp_path / "m.csv")
    return PaperOrderDesk(ledger, tmp_path / "matching", now=clock.now, clock_ns=clock.ns), ledger, clock


def read_commands(desk) -> list[dict]:
    return [json.loads(line) for line in (desk.root / "orders.jsonl").read_text(encoding="utf-8").splitlines()]


def append_results(desk, *records) -> None:
    with open(desk.root / "results.jsonl", "a", encoding="utf-8") as fh:
        for r in records:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
