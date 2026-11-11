"""The Python price policy and ledger on tests/fixtures/tw_stock_rules_cases.json: 升降單位 per instrument kind from
config/twse_price_policy.json, and a sale's proceeds under the ledger's closing terms of the code's kind. The renderer
checks the same cases (tests/renderer_tw_stock_rules_parity_contract.mjs) on the tables the paper funds serve it."""

import json
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

from service.account.accounting_core import AccountingCore
from service.market.semantics import twse_price_policy
from service.market.semantics.twse_price_policy import price_policy_projection, twse_tick_size

CASES = json.loads((Path(__file__).parent / "fixtures" / "tw_stock_rules_cases.json").read_text(encoding="utf-8"))


def test_tick_sizes():
    for price, kind, tick in CASES["ticks"]:
        assert float(twse_tick_size(Decimal(str(price)), kind)) == tick, (price, kind)


def test_no_standard_limit_formula_is_left():
    assert not hasattr(twse_price_policy, "twse_standard_price_limits"), "limits are only the provider's official values"
    assert set(price_policy_projection()["tick_table_of_kind"]) == {"stock", "etf", "etn", "reit"}


def test_sell_proceeds():
    """The cases' closing terms are the ledger's own (AccountingCore.closing_terms at the list rate), and each sale's
    proceeds are what the ledger charges; ETN and REIT are taxed as ETFs."""
    core = AccountingCore(tw_fee_rate=Decimal(CASES["closing_terms"]["stock"]["fee_rate"]))
    for code, kind, price, qty, proceeds in CASES["sells"]:
        assert core.instrument_kind(code) == kind, code
        assert core.closing_terms("台股", code) == CASES["closing_terms"][kind] == core.tw_closing_terms_of_kind(kind), code
        gross = core.parse_trade_info(f"{qty}@{price}", "台股")[0].amount
        fee = core.fee_for_order("台股", gross)
        tax = core.tax_for_leg(SimpleNamespace(action="賣出", market="台股", trade_type="一般", code=code, gross_amount=gross))
        assert float(gross - fee - tax) == proceeds, (code, price, qty)
