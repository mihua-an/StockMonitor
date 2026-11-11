import json
import traceback
from types import SimpleNamespace

import pytest

from service.account.account_types import ActualAccountError
from tests.support.actual_sync import make_sync


def test_secure_save_and_a_plaintext_token_is_refused_on_read(tmp_path):
    sync = make_sync(tmp_path)
    sync.save_config('https://example.invalid/exec', 'FAKE-audit-token')
    assert 'FAKE-audit-token' not in sync.ledger.config_path.read_text()
    assert sync.get_config()['gas_token'] == 'FAKE-audit-token'
    # The retired plaintext format: reading neither migrates it (no credential write, no file rewrite) nor uses it.
    sync.ledger.config_path.write_text(json.dumps({'gas_url': 'https://example.invalid/exec', 'gas_token': 'FAKE-legacy'}))
    stored = dict(sync._credentials.values)
    config = sync.get_config()
    assert config['gas_token'] == '' and 'GAS token' in config['config_error'] and config['gas_url']
    assert 'FAKE-legacy' in sync.ledger.config_path.read_text(), 'a read does not rewrite the file'
    assert dict(sync._credentials.values) == stored, 'a read does not write the credential store'
    sync.save_config('https://example.invalid/exec', 'FAKE-new')
    assert 'FAKE-legacy' not in sync.ledger.config_path.read_text() and sync.get_config()['gas_token'] == 'FAKE-new'


def test_failed_credential_save_preserves_config(tmp_path):
    sync = make_sync(tmp_path)
    sync.save_config('https://example.invalid/exec', 'FAKE-first')
    original = sync.ledger.config_path.read_bytes()
    def fail(*args):
        raise RuntimeError('FAKE-sensitive')
    sync._credentials.set_password = fail
    with pytest.raises(ActualAccountError) as caught:
        sync.save_config('https://example.invalid/exec', 'FAKE-next')
    assert 'FAKE-sensitive' not in ''.join(traceback.format_exception(caught.value))
    assert sync.ledger.config_path.read_bytes() == original


@pytest.mark.parametrize('mode', ['transport', 'html', 'business', 'redirect_404'])
def test_gas_failures_do_not_expose_tokens(tmp_path, monkeypatch, mode):
    import requests
    sync = make_sync(tmp_path)
    token = 'FAKE-audit-secret'
    sync.save_config('https://example.invalid/exec', token)
    sync.ledger._shutdown_event = SimpleNamespace(is_set=lambda: False, wait=lambda delay: False)
    class Session:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def request(self, *args, **kwargs):
            if mode == 'transport':
                raise requests.ConnectionError('https://example.invalid/?token=' + token)
            if mode == 'redirect_404':
                # Defense in depth: no request carries the token in a
                # URL, but a redirect chain (response.history) that somehow did
                # must still only surface host+status, never the query string.
                history_hop = SimpleNamespace(
                    status_code=302, url='https://example.invalid/exec?action=fake&token=' + token,
                    request=SimpleNamespace(method='POST', url='https://example.invalid/exec'),
                )
                return SimpleNamespace(
                    status_code=404, history=[history_hop],
                    request=SimpleNamespace(method='GET', url='https://example.invalid/landing'),
                    url='https://example.invalid/exec?action=fake&token=' + token,
                    raise_for_status=lambda: None, text='',
                )
            return SimpleNamespace(status_code=200, history=[], request=SimpleNamespace(method='POST', url='https://example.invalid/exec'), url='https://example.invalid',
                                   raise_for_status=lambda: None,
                                   text=token if mode == 'html' else json.dumps({'ok': False, 'error': token}))
    monkeypatch.setattr(requests, 'Session', Session)
    with pytest.raises(ActualAccountError) as caught:
        sync._gas_request('fake')
    assert token not in ''.join(traceback.format_exception(caught.value))
    assert token not in str(caught.value)


def test_every_gas_action_carries_the_token_in_the_post_body_never_the_url(tmp_path, monkeypatch):
    """Read actions used to be GETs with ?token=... in the URL, where proxies, access logs and
    exception messages keep it. Every action -- read or write -- is now a POST with the token in the JSON body."""
    import requests
    from service.account import actual_account_sync as module
    sync = make_sync(tmp_path)
    token = 'FAKE-audit-secret'
    sync.save_config('https://example.invalid/exec', token)
    sync.ledger._shutdown_event = SimpleNamespace(is_set=lambda: False, wait=lambda delay: False)
    sent = []

    class Session:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def get(self, *args, **kwargs):
            raise AssertionError('no GAS action may be a GET any more')
        def request(self, method, url, *, json=None, headers=None, params=None, timeout=None, **kwargs):
            sent.append({'method': method, 'url': url, 'json': json, 'headers': dict(headers or {}), 'params': params,
                         'timeout': timeout})
            return SimpleNamespace(status_code=200, history=[], request=SimpleNamespace(method='POST', url='https://example.invalid/exec'), url=url, raise_for_status=lambda: None,
                                   text=__import__('json').dumps({'ok': True, 'raw_revision': 1, 'items': []}))
    monkeypatch.setattr(requests, 'Session', Session)
    sync._gas_request('actualBridgeStatus', {'client': 'desktop', 'token': 'caller-cannot-override'})
    sync._gas_request('actualRawTrades')
    sync._gas_request('actualTradeDelete', {'trade_id': 't1'}, write=True)
    assert [item['method'] for item in sent] == ['POST', 'POST', 'POST']
    for item in sent:
        assert item['json']['token'] == token
        assert token not in item['url'] and 'token' not in item['url']
        assert not item['params']
        assert token not in __import__('json').dumps(item['headers'])
    assert sent[0]['json'] == {'client': 'desktop', 'token': token, 'action': 'actualBridgeStatus'}
    assert sent[1]['json'] == {'action': 'actualRawTrades', 'token': token}
    assert sent[0]['timeout'] == (5, module.GET_READ_TIMEOUT_S) and sent[2]['timeout'] == (5, module.POST_READ_TIMEOUT_S)


def test_a_gas_url_carrying_a_credential_is_refused_before_any_request(tmp_path, monkeypatch):
    import requests
    sync = make_sync(tmp_path)
    sync.ledger._shutdown_event = SimpleNamespace(is_set=lambda: False, wait=lambda delay: False)
    monkeypatch.setattr(requests, 'Session', lambda: (_ for _ in ()).throw(AssertionError('no request may be sent')))
    for url in ('https://script.google.com/macros/s/X/exec?token=FAKE-in-url',
                'https://script.google.com/macros/s/X/exec?a=1&Token=FAKE-in-url',
                'https://user:FAKE-in-url@script.google.com/macros/s/X/exec'):
        sync.save_config(url, 'FAKE-field')
        with pytest.raises(ActualAccountError) as caught:
            sync._gas_request('actualBridgeStatus')
        assert 'FAKE-in-url' not in str(caught.value) and 'FAKE-field' not in str(caught.value)
    # A plain URL with an ordinary query is still accepted.
    sync.save_config('https://script.google.com/macros/s/X/exec?lang=zh', 'FAKE-field')
    with pytest.raises(AssertionError, match='no request may be sent'):
        sync._gas_request('actualBridgeStatus')


def test_gas_requests_are_https_only(tmp_path, monkeypatch):
    # The request carries the GAS token, and an http:// URL was accepted.
    import requests
    sync = make_sync(tmp_path)
    sync.save_config('http://example.invalid/exec', 'FAKE-plain')
    sync.ledger._shutdown_event = SimpleNamespace(is_set=lambda: False, wait=lambda delay: False)
    sent = []
    monkeypatch.setattr(requests, 'Session', lambda: (_ for _ in ()).throw(AssertionError('no request may be sent')))
    with pytest.raises(ActualAccountError) as caught:
        sync._gas_request('fake')
    assert 'https' in str(caught.value) and 'FAKE-plain' not in str(caught.value)
    assert sent == []


def test_a_publish_waits_long_enough_and_failures_say_why(tmp_path, monkeypatch):
    """Every derived-sheet publish (~200 KB) failed as a bare "GAS 連線失敗": Apps Script needs more than the old
    10 s read timeout, and neither the timeout nor GAS's own ok:false reason reached the message."""
    import requests
    from service.account import actual_account_sync as module
    sync = make_sync(tmp_path)
    token = 'FAKE-audit-secret'
    sync.save_config('https://example.invalid/exec', token)
    sync.ledger._shutdown_event = SimpleNamespace(is_set=lambda: False, wait=lambda delay: False)
    seen = {}
    behaviour = {'mode': 'timeout'}

    class Session:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def request(self, method, url, **kwargs):
            seen['timeout'] = kwargs.get('timeout')
            if behaviour['mode'] == 'timeout':
                raise requests.ReadTimeout('read timed out')
            return SimpleNamespace(status_code=200, history=[], request=SimpleNamespace(method='POST', url='https://example.invalid/exec'), url='https://example.invalid', raise_for_status=lambda: None,
                                   text=json.dumps({'ok': False, 'error': 'sheet 交易明細 missing; token=' + token}))
    monkeypatch.setattr(requests, 'Session', Session)
    with pytest.raises(ActualAccountError) as caught:
        sync._gas_request('mobilePublish', {'entries': {}}, write=True)
    assert seen["timeout"] == (5, module.POST_READ_TIMEOUT_S) and module.POST_READ_TIMEOUT_S >= 60 and module.GET_READ_TIMEOUT_S >= 30
    assert '逾時' in str(caught.value)
    behaviour['mode'] = 'business'
    with pytest.raises(ActualAccountError) as caught:
        sync._gas_request('mobilePublish', {'entries': {}}, write=True)
    assert 'sheet 交易明細 missing' in str(caught.value) and token not in str(caught.value)


def test_a_config_that_cannot_be_written_leaves_no_new_credential_entry(tmp_path, monkeypatch):
    """The config still names the previous entry; the one just created for it is removed."""
    from service.platform import atomic_files

    sync = make_sync(tmp_path)
    creds = sync._credentials
    creds.delete_password = lambda service, entry: creds.values.pop((service, entry), None)
    sync.save_config('https://example.invalid/exec', 'FAKE-first')
    before = dict(creds.values)
    monkeypatch.setattr(atomic_files, 'replace_file', lambda *a: (_ for _ in ()).throw(OSError('disk full')))
    with pytest.raises(ActualAccountError):
        sync.save_config('https://example.invalid/exec', 'FAKE-second')
    assert creds.values == before, "only the entry the config names remains"
