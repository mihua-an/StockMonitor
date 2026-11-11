"""「自動同步失敗」: the page gave /api/actual-account/sync the 20 s every request gets, while one sync's
GAS requests (the bridge status twice, the raw-trade pages within their budget plus one page and the confirming read,
and a publish, each sent once) can take minutes; the server publishes that bound."""
from service.account import actual_account_sync as sync


def test_the_sync_deadline_covers_every_gas_request():
    per_read = sync.GAS_CONNECT_TIMEOUT_S + sync.GET_READ_TIMEOUT_S
    per_write = sync.GAS_CONNECT_TIMEOUT_S + sync.POST_READ_TIMEOUT_S
    assert sync.SYNC_DEADLINE_S >= 4 * per_read + sync.RAW_TRADES_READ_BUDGET_S + per_write - 1
    assert sync.SYNC_DEADLINE_S > 20, "longer than the default request deadline that cut syncs short"


def test_the_config_route_publishes_it():
    from pathlib import Path

    source = Path(__file__).resolve().parents[1].joinpath("api", "routes", "account_routes.py").read_text(encoding="utf-8")
    assert '"sync_deadline_s": SYNC_DEADLINE_S' in source
