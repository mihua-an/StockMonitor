"""The account settings may only point at an Apps Script deployment and a Google Form, and a changed GAS URL never
keeps the token entered for the previous one: a page that could write the settings could otherwise send the GAS token
(or every new trade) to a host of its choice."""
import pytest

from service.account.account_types import ActualAccountError
from service.account.actual_account_sync import form_prefill_url_problem, gas_url_problem
from tests.support.actual_sync import make_sync

GAS = 'https://script.google.com/macros/s/AKfyFAKE_id-1/exec'
GAS_WORKSPACE = 'https://script.google.com/a/macros/example.com/s/AKfyFAKE/exec'
FORM = 'https://docs.google.com/forms/d/e/1FAIpFAKE/viewform?usp=pp_url&entry.1=TRADE_DATE'


@pytest.mark.parametrize('url', [GAS, GAS_WORKSPACE])
def test_apps_script_deployment_urls_are_accepted(url):
    assert gas_url_problem(url) is None


@pytest.mark.parametrize('url', [
    'https://evil.example/macros/s/X/exec',
    'https://script.google.com.evil.example/macros/s/X/exec',
    'https://script.google.com@evil.example/macros/s/X/exec',
    'http://script.google.com/macros/s/X/exec',
    'https://script.google.com:8443/macros/s/X/exec',
    'https://script.google.com/macros/s/X/dev',
    'https://script.google.com/macros/s/X/exec?token=1',
    'https://script.google.com/macros/s/X/exec#x',
    'https://script.google.com/macros/s/X/exec/../../other',
    'https://script.googleusercontent.com/macros/echo?user_content_key=1',
])
def test_other_gas_urls_are_refused(url):
    assert gas_url_problem(url)


@pytest.mark.parametrize('url', [FORM, 'https://docs.google.com/forms/d/1FAKE/viewform?entry.2=x',
                                 'https://forms.gle/AbCd123'])
def test_google_form_links_are_accepted(url):
    assert form_prefill_url_problem(url) is None


@pytest.mark.parametrize('url', [
    'https://evil.example/forms/d/e/X/viewform',
    'https://docs.google.com@evil.example/forms/d/e/X/viewform',
    'http://docs.google.com/forms/d/e/X/viewform',
    'https://docs.google.com/spreadsheets/d/X/edit',
    'https://docs.google.com/forms/d/e/X/formResponse',
    'https://docs.google.com:444/forms/d/e/X/viewform',
    'https://forms.gle/Ab/../../x',
    'https://forms.gle/Ab?next=https://evil.example',
])
def test_other_form_links_are_refused(url):
    assert form_prefill_url_problem(url)


def test_save_config_refuses_urls_outside_google(tmp_path):
    sync = make_sync(tmp_path)
    with pytest.raises(ActualAccountError) as caught:
        sync.save_config('https://evil.example/exec', 'FAKE-token')
    assert caught.value.status_code == 422
    with pytest.raises(ActualAccountError) as caught:
        sync.save_config(GAS, 'FAKE-token', google_form_prefill_url='https://evil.example/forms/d/e/X/viewform')
    assert caught.value.status_code == 422
    assert not sync.ledger.config_path.exists()
    # Empty values are "not configured", not invalid.
    sync.save_config('', '')
    assert sync.get_config()['gas_url'] == ''


def test_an_unchanged_url_keeps_the_token_and_a_changed_one_needs_it_again(tmp_path):
    sync = make_sync(tmp_path)
    sync.save_config(GAS, 'FAKE-first', google_form_prefill_url=FORM)
    # Saving the other fields leaves the token where it is.
    sync.save_config(GAS, '', auto_sync_on_page_open=True, google_form_prefill_url=FORM)
    assert sync.get_config()['gas_token'] == 'FAKE-first'
    # A new deployment URL without a token is refused and nothing changes.
    with pytest.raises(ActualAccountError) as caught:
        sync.save_config(GAS_WORKSPACE, '')
    assert caught.value.status_code == 422 and 'GAS Token' in str(caught.value)
    assert sync.get_config()['gas_url'] == GAS and sync.get_config()['gas_token'] == 'FAKE-first'
    # With the token entered again it is saved.
    sync.save_config(GAS_WORKSPACE, 'FAKE-second')
    assert sync.get_config()['gas_url'] == GAS_WORKSPACE and sync.get_config()['gas_token'] == 'FAKE-second'
    # Clearing the URL drops the token with it.
    sync.save_config('', '')
    assert sync.get_config()['gas_token'] == ''


def test_the_config_route_leaves_the_token_rule_to_save_config(tmp_path):
    """The route used to reuse the stored token whenever the request left it empty, whatever the new URL."""
    import inspect
    from api.routes import account_routes
    source = inspect.getsource(account_routes)
    start = source.index('def save_actual_account_config')
    body = source[start:source.index('@router', start)]
    assert 'gas_token=req.gas_token' in body and 'previous' not in body
