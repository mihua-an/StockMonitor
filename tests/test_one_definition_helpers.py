"""Small helpers that had several copies have one each: the Futu provider's UTC timestamp, the account's plain JSON
number, the session file name of the rollover, and the Market Daemon availability check of the K-bar routes."""
from __future__ import annotations

import ast
import re
from decimal import Decimal
from pathlib import Path

from service.account import capital, paper_orders
from service.market.futu.clock import utc_now
from service.market.lifecycle import rollover

ROOT = Path(__file__).resolve().parents[1]


def _functions(path: Path) -> list[str]:
    return [node.name for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))) if isinstance(node, ast.FunctionDef)]


def test_the_futu_provider_has_one_utc_timestamp():
    copies = [path.name for path in (ROOT / "service" / "market" / "futu").glob("*.py") if "_utc_now" in _functions(path)]
    assert copies == []
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00", utc_now())


def test_the_account_has_one_plain_number():
    assert "_number" not in _functions(ROOT / "service" / "account" / "paper_orders.py")
    assert "_number" not in _functions(ROOT / "service" / "account" / "capital.py")
    assert capital.plain_number(Decimal("2000.0")) == 2000 and isinstance(capital.plain_number(Decimal("2000.0")), int)
    assert capital.plain_number(0.1 + 0.2) == 0.30000000000000004
    assert capital.plain_number(Decimal("12.5")) == 12.5
    assert paper_orders.capital is capital


def test_the_rollover_names_session_files_one_way():
    source = (ROOT / "service" / "market" / "lifecycle" / "rollover.py").read_text(encoding="utf-8")
    assert source.count('ch.isalnum() or ch in "-_."') == 1
    assert rollover._file_name("STK:2026-11-16:DAY:2330") == "STK_2026-11-16_DAY_2330"


def test_the_kbar_routes_check_the_market_daemon_in_one_place():
    source = (ROOT / "api" / "routes" / "history_routes.py").read_text(encoding="utf-8")
    assert source.count("Market Daemon client 尚未初始化") == 4, "_daemon_app, taiex-session and the two data-center reads that fall back to the local catalog"
