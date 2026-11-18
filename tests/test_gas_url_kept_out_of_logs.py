"""The Apps Script deployment URL (and Google's redirect user_content_key) must not reach a log file: urllib3's DEBUG
request lines wrote it into app_api.log, and a GAS transport failure logged the exception text, which carries it."""
import logging
from types import SimpleNamespace

import pytest

from service.account.account_types import ActualAccountError
from service.platform import logging_setup
from tests.support.actual_sync import make_sync

GAS = 'https://script.google.com/macros/s/AKfyDEPLOYMENTID/exec'


def test_http_client_loggers_are_pinned_to_warning(monkeypatch):
    names = ('urllib3', 'urllib3.connectionpool', 'requests')
    saved = {name: logging.getLogger(name).level for name in (*names, *logging_setup.NOISY_WIRE_LOGGERS)}
    monkeypatch.setattr(logging_setup, '_CONFIGURED', False)
    # The services' root logger is DEBUG (configure_logging's default); basicConfig is skipped so the test's own
    # handlers stay, and the root is set the way it would set it.
    root_level = logging.getLogger().level
    monkeypatch.setattr(logging, 'basicConfig', lambda **_: logging.getLogger().setLevel(logging.DEBUG))
    try:
        logging_setup.configure_logging(logging.DEBUG)
        for name in names:
            assert logging.getLogger(name).getEffectiveLevel() >= logging.WARNING, name
            assert not logging.getLogger(name).isEnabledFor(logging.DEBUG), name
    finally:
        logging.getLogger().setLevel(root_level)
        for name, level in saved.items():
            logging.getLogger(name).setLevel(level)


def test_a_gas_transport_failure_logs_the_type_and_host_only(tmp_path, monkeypatch, caplog):
    import requests
    sync = make_sync(tmp_path)
    sync.save_config(GAS, 'FAKE-log-token')
    sync.ledger._shutdown_event = SimpleNamespace(is_set=lambda: False, wait=lambda delay: False)
    failure = requests.ConnectionError(
        f"HTTPSConnectionPool(host='script.googleusercontent.com'): Max retries exceeded with url: "
        f"/macros/echo?user_content_key=FAKEKEY&lib=x (redirected from {GAS})")
    monkeypatch.setattr(sync, '_gas_send', lambda *args: ('', failure, None))
    with caplog.at_level(logging.DEBUG):
        with pytest.raises(ActualAccountError):
            sync._gas_request('actualBridgeStatus')
    logged = '\n'.join(record.getMessage() for record in caplog.records)
    assert 'ConnectionError' in logged and 'script.google.com' in logged
    for secret in ('AKfyDEPLOYMENTID', 'user_content_key', 'FAKEKEY', '/macros/', 'FAKE-log-token'):
        assert secret not in logged, secret
