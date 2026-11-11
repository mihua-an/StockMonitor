"""A GAS request is sent once and never retried (decisions.md「GAS 請求失敗不自動重試」): a scheduled bridge check that
fails stores the failure and waits for the next slot; a sync or trade write the user pressed raises a message that says
what happened -- and, for a write, whether the sheet may already hold it."""
from types import SimpleNamespace

import pytest
import requests

from service.account.account_types import ActualAccountError
from tests.support.actual_sync import make_sync


def _ok_reply(body='{"ok": true, "raw_revision": 7}', status=200):
    request = SimpleNamespace(method='POST', url='https://example.invalid/exec')
    return SimpleNamespace(status_code=status, history=[], request=request, url='https://example.invalid/exec',
                           raise_for_status=lambda: None, text=body)


def _gas(tmp_path, monkeypatch, replies):
    """A configured sync whose GAS answers ``replies`` in order (an exception is raised); returns (sync, sent)."""
    sync = make_sync(tmp_path)
    sync.save_config('https://example.invalid/exec', 'FAKE-no-retry')
    meta: dict[str, str] = {}
    sync.ledger._set_meta_many = lambda values, caller=None: meta.update(values)
    sync.ledger._get_meta = lambda key: meta.get(key, '')
    sync.ledger._count_runtime_operation = lambda name: None
    sync.ledger._get_bridge_instance_id = lambda: 'desktop-test'
    sync.ledger._parse_bridge_revision = lambda value: None if value in (None, '') else int(value)
    sync.meta = meta
    sent: list[str] = []
    answers = iter(replies)

    class Session:
        def __enter__(self): return self
        def __exit__(self, *args): pass

        def request(self, method, url, **kwargs):
            sent.append(kwargs['json']['action'])
            answer = next(answers)
            if isinstance(answer, BaseException):
                raise answer
            return answer

    monkeypatch.setattr(requests, 'Session', Session)
    emitted = []
    monkeypatch.setattr('service.platform.remediation.emitter', lambda: SimpleNamespace(emit=lambda **kw: emitted.append(kw)))
    return sync, sent, emitted


def test_a_failed_read_is_sent_once_and_records_no_remediation(tmp_path, monkeypatch):
    sync, sent, emitted = _gas(tmp_path, monkeypatch, [_ok_reply(status=503), _ok_reply()])
    with pytest.raises(ActualAccountError) as caught:
        sync._gas_request('actualBridgeStatus')
    assert sent == ['actualBridgeStatus'], 'one request: the answer that would have come next is never asked for'
    assert 'HTTP 503' in str(caught.value) and '請稍後再試' in str(caught.value) and '重試' not in str(caught.value)
    assert emitted == []


def test_a_scheduled_check_that_fails_sends_once_and_stores_the_failure(tmp_path, monkeypatch):
    sync, sent, _ = _gas(tmp_path, monkeypatch, [requests.ReadTimeout('read timed out'), _ok_reply()])
    with pytest.raises(ActualAccountError):
        sync.poll_gas_bridge_once(source='schedule:2026-10-29 09:30')
    assert sent == ['actualBridgeStatus']
    assert sync.meta['bridge_last_check_status'] == 'error'
    assert sync.meta['bridge_last_check_source'] == 'schedule:2026-10-29 09:30'
    assert '逾時' in sync.meta['bridge_last_check_message']
    assert '逾時' in sync.meta['bridge_last_auto_sync_error']


def test_a_user_sync_that_fails_is_reported_at_once(tmp_path, monkeypatch):
    sync, sent, _ = _gas(tmp_path, monkeypatch, [requests.ConnectionError('refused'), requests.ConnectionError('refused')])
    with pytest.raises(ActualAccountError) as caught:
        sync.sync_from_gas()
    # The bridge status read before the sync failed (recorded, the sync goes on), then the raw trades failed: one
    # request each, nothing asked again.
    assert sent == ['actualBridgeStatus', 'actualRawTrades']
    assert '無法連線' in str(caught.value)
    assert sync.meta['last_sync_attempt_status'] == 'failed' and '無法連線' in sync.meta['last_sync_attempt_error']


def test_a_write_whose_answer_never_came_says_it_may_be_in_the_sheet(tmp_path, monkeypatch):
    sync, sent, _ = _gas(tmp_path, monkeypatch, [requests.ReadTimeout('read timed out'), _ok_reply()])
    with pytest.raises(ActualAccountError) as caught:
        sync.remote_save_trade({'code': '2330', 'trade_info': '1000@100'})
    assert sent == ['actualTradeCreate'], 'never sent twice: a second create would add the trade twice'
    assert '可能已經完成' in str(caught.value) and '同步' in str(caught.value)


def test_a_write_that_never_reached_google_says_nothing_was_written(tmp_path, monkeypatch):
    sync, sent, _ = _gas(tmp_path, monkeypatch, [requests.ConnectTimeout('connect timed out'), _ok_reply()])
    with pytest.raises(ActualAccountError) as caught:
        sync.remote_delete_trade('T1')
    assert sent == ['actualTradeDelete']
    assert '沒有送到 Google' in str(caught.value) and '連線 Google 逾時' in str(caught.value)
