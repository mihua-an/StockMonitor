from __future__ import annotations

from pydantic import BaseModel, SecretStr



class ShioajiCredentialsRequest(BaseModel):
    api_key: SecretStr
    secret_key: SecretStr


class ActualAccountConfigRequest(BaseModel):
    gas_url: str = ""
    gas_token: str = ""
    auto_sync_on_page_open: bool = False
    google_form_prefill_url: str = ""
    google_form_param_trade_date: str = ""
    google_form_param_market: str = ""
    google_form_param_action: str = ""
    google_form_param_code: str = ""
    google_form_param_trade_info: str = ""
    google_form_param_trade_time: str = ""


class ActualTradeSaveRequest(BaseModel):
    trade_id: str | None = None
    trade_date: str
    market: str
    action: str
    code: str
    trade_info: str
    trade_time: str = ""


class ActualTradeDeleteRequest(BaseModel):
    trade_id: str


class AccountCapitalRequest(BaseModel):
    """資金 settings per market, within the ledger's scope (service/account/capital.py): actual {"台股": {"daily_limit":
    ...}, "美股": {...}}; paper {"台股": {"initial_principal": ..., "daily_limit": ...}}."""
    markets: dict[str, dict[str, float | int | str]]
