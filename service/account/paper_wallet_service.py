from __future__ import annotations
from service.account import capital
from service.account.account_ledger_service import AccountLedgerService


class PaperWalletService(AccountLedgerService):
    """Local-input ledger sharing accounting rules without GAS publication; it enforces the Taiwan lot rules and its
    daily limit (service/account/capital.py). 台股 only (user 2026-10-16: no paper 美股)."""
    enforces_trading_rules = True
    capital_scope = capital.PAPER_SCOPE

    def __init__(self, *args, **kwargs) -> None:
        kwargs["enable_remote_integrations"] = False
        super().__init__(*args, **kwargs)
        self._apply_fee_rate()
