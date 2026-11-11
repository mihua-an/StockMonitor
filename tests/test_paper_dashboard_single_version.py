"""One dashboard response is one ledger version, even when a trade lands between its reads."""
import threading

from service.account.paper_wallet_service import PaperWalletService


def _ledger(tmp_path):
    return PaperWalletService(db_path=tmp_path / 'race.db', config_path=tmp_path / 'config.json',
                              security_master_path=tmp_path / 'master.csv')


def _buy(ledger, trade_id='B1'):
    ledger.local_save_trade({'trade_id': trade_id, 'trade_date': '2026-09-08', 'market': '台股', 'code': '2330',
                             'action': '買進', 'trade_info': '1000@100', 'trade_time': '09:00'})


def test_first_response_after_concurrent_trade_is_not_mixed(tmp_path, monkeypatch):
    ledger = _ledger(tmp_path)
    waiting, release = threading.Event(), threading.Event()
    calls = {'n': 0}
    # The race point is a read the dashboard makes after positions (the dashboard carries no trade list, R14-23).
    original_read = ledger.get_errors

    def blocked_once(*args, **kwargs):
        calls['n'] += 1
        if calls['n'] == 1:  # only the first read races; positions were already read empty
            waiting.set()
            assert release.wait(5), 'test writer never completed'
        return original_read(*args, **kwargs)

    monkeypatch.setattr(ledger, 'get_errors', blocked_once)
    rereads = []
    monkeypatch.setattr(type(ledger), '_record_dashboard_reread',
                        lambda self, attempt, before, after: rereads.append((attempt, before, after)))
    result = {}
    reader = threading.Thread(target=lambda: result.setdefault('dashboard', ledger.get_dashboard()))
    try:
        reader.start()
        assert waiting.wait(5)
        _buy(ledger)
        release.set()
        reader.join(5)
        assert not reader.is_alive()
        first = result['dashboard']
        assert len(first['positions']) == 1, {'positions': first['positions']}
        assert float(first['positions'][0]['qty']) == 1000
        assert calls['n'] == 2  # thrown away once, read again
        assert ledger.get_dashboard() is first  # the re-read result is the one cached
        assert first['positions'] == ledger.get_positions()
        # The re-read names what moved under the first read -- its write generation, before and after.
        [(attempt, before, after)] = rereads
        assert attempt == 1 and after[0] > before[0]
    finally:
        release.set()
        reader.join(6)
        ledger.shutdown()


def test_retry_is_bounded_and_last_attempt_holds_the_ledger_lock(tmp_path, monkeypatch):
    ledger = _ledger(tmp_path)
    original_read = ledger.get_errors
    state = {'n': 0, 'writer_blocked_on_last': None}
    writers = []

    def write_during_each_read(*args, **kwargs):
        state['n'] += 1
        writer = threading.Thread(target=_buy, args=(ledger, f"B{state['n']}"))
        writers.append(writer)
        writer.start()
        writer.join(0.5)
        if state['n'] == 3:
            state['writer_blocked_on_last'] = writer.is_alive()
        return original_read(*args, **kwargs)

    monkeypatch.setattr(ledger, 'get_errors', write_during_each_read)
    try:
        value = ledger.get_dashboard()
        assert state['n'] == 3
        # the third read held the lock: the writer waited and this response is the two-trade version, consistent
        assert state['writer_blocked_on_last'] is True
        assert float(value['positions'][0]['qty']) == 2000
    finally:
        for writer in writers:
            writer.join(5)
        ledger.shutdown()


def test_the_reread_event_names_its_ledger_and_what_moved(tmp_path, monkeypatch):
    """The recorded event carries the ledger and the generations/signatures before and after."""
    from types import SimpleNamespace

    from service.platform import remediation

    events = []
    monkeypatch.setattr(remediation, 'emitter', lambda: SimpleNamespace(emit=lambda **e: events.append(e)))
    ledger = _ledger(tmp_path)
    try:
        ledger._record_dashboard_reread(2, (4, (10, 20)), (5, (11, 21)))
    finally:
        ledger.shutdown()
    [event] = events
    assert event['detail'] == {'ledger': 'race.db', 'generation_before': 4, 'generation_after': 5,
                               'signature_before': ['10', '20'], 'signature_after': ['11', '21']}
