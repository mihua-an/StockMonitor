"""Deterministic corruption matrix for user-owned persistence stores.

The contract is intentionally explicit: structured configuration may recover to
safe defaults, while databases and authoritative CSV data fail visibly instead
of being silently replaced with an empty store.
"""

from __future__ import annotations

import sqlite3
from types import SimpleNamespace

import pytest

from service.account.account_ledger_service import AccountLedgerService
from service.account.actual_account_sync import ActualAccountSync
from service.market.reference.watch_page_service import WatchPageService


class _NoCredentials:
    def get_password(self, *_args):
        return None


@pytest.mark.parametrize("payload", [b"not a sqlite database", b"SQLite format 3\x00truncated"])
def test_account_database_corruption_fails_visibly_without_reinitializing(tmp_path, payload):
    path = tmp_path / "actual_account.db"
    path.write_bytes(payload)
    with pytest.raises(sqlite3.DatabaseError):
        AccountLedgerService(db_path=path, config_path=tmp_path / "account.json")
    assert path.read_bytes() == payload


@pytest.mark.parametrize(
    "contents, message",
    [
        ("page_id,page_name\ntw,台股\n", "欄位不完整"),
        (
            ",".join(WatchPageService.FIELDNAMES) + "\n"
            + "tw,台股,shioaji,0,2330\n",
            "截斷|欄位數不符",
        ),
    ],
)
def test_watch_pages_corruption_fails_visibly(tmp_path, contents, message):
    path = tmp_path / "watch_pages.csv"
    path.write_text(contents, encoding="utf-8-sig")
    service = WatchPageService(path)
    with pytest.raises(ValueError, match=message):
        service.list_pages()


@pytest.mark.parametrize("contents", ["{truncated", "[]", "null"])
def test_account_config_corruption_recovers_to_unconfigured_safe_defaults(tmp_path, contents):
    path = tmp_path / "actual_account_config.json"
    path.write_text(contents, encoding="utf-8")
    sync = ActualAccountSync(SimpleNamespace(config_path=path), credential_backend=_NoCredentials())
    result = sync.get_config()
    assert result["gas_url"] == ""
    assert result["gas_token"] == ""
    assert result["auto_sync_on_page_open"] is False

