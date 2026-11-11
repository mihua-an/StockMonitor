"""HTTP request contracts exposed by the Shioaji daemon."""
from __future__ import annotations


from pydantic import BaseModel


class PostSessionMaintenanceRequest(BaseModel):
    market: str = "STK"
    trading_date: str = ""
    session: str = "DAY"
    actual_contract: str = ""
    compact_raw: bool = True
    timeout_seconds: float = 120.0


class KbarDownloadRequest(BaseModel):
    code: str
    start_date: str
    end_date: str
    user_budget_bytes: int | None = None
    safety_reserve_bytes: int = 0
    auto_resume: bool = False


class KbarOlderRequest(BaseModel):
    code: str
    before: str


class KbarActionRequest(BaseModel):
    action: str


