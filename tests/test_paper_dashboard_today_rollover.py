"""The dashboard's 今日 figure follows the calendar day, even when no trade lands after midnight: the figures and the
dashboard cache read one business date (account_analytics_service.business_date)."""
from datetime import date

from service.account import account_analytics_service
from service.account.paper_wallet_service import PaperWalletService


def test_dashboard_today_rolls_over_without_new_trades(tmp_path, monkeypatch):
    class Clock:
        value = date(2026, 9, 8)
    monkeypatch.setattr(account_analytics_service, 'business_date', lambda: Clock.value)
    ledger = PaperWalletService(db_path=tmp_path/'paper.db', config_path=tmp_path/'config.json', security_master_path=tmp_path/'master.csv')
    try:
        base = {'trade_date':'2026-09-08','market':'台股','code':'2330'}
        ledger.local_save_trade({**base,'trade_id':'B1','action':'買進','trade_info':'1000@100','trade_time':'09:00'})
        ledger.local_save_trade({**base,'trade_id':'S1','action':'賣出','trade_info':'1000@110','trade_time':'10:00'})
        before = ledger.get_dashboard()['summary']['today']['tw']
        assert before == 9751
        Clock.value = date(2026,9,9)
        direct = ledger.get_summary()['today']['tw']
        cached = ledger.get_dashboard()['summary']['today']['tw']
        assert direct == 0
        assert cached == direct, {'yesterday':before,'fresh_today':direct,'dashboard_today':cached}
    finally:
        ledger.shutdown()
