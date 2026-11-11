"""Python market_runtime clients only read their role's token; a missing one is an error, never a new file (04 §5)."""
import pytest

from service.platform import runtime_credentials


@pytest.fixture
def cred_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("STOCK_MONITOR_RUNTIME_CREDENTIAL_DIR", str(tmp_path))
    return tmp_path


def test_missing_token_is_an_error_and_no_file_is_created(cred_dir):
    with pytest.raises(RuntimeError, match="viewer"):
        runtime_credentials.require_token("viewer")
    assert list(cred_dir.iterdir()) == []


def test_existing_token_is_read(cred_dir):
    (cred_dir / "provider-shioaji.token").write_text("a" * 64, encoding="ascii")
    assert runtime_credentials.require_token("provider:shioaji") == "a" * 64


def test_short_token_counts_as_missing(cred_dir):
    (cred_dir / "viewer.token").write_text("short", encoding="ascii")
    with pytest.raises(RuntimeError):
        runtime_credentials.require_token("viewer")


def test_python_cannot_create_tokens_any_more():
    assert not hasattr(runtime_credentials, "load_or_create_token")
    assert not hasattr(runtime_credentials, "credentials_document")


def test_view_client_without_token_fails_loudly(cred_dir):
    from service.market.shared.rust_view_client import RustViewClient, RustViewClientError

    with pytest.raises(RustViewClientError):
        RustViewClient(url="ws://127.0.0.1:1/unused")
    assert list(cred_dir.iterdir()) == []


def test_live_ingress_without_token_fails_loudly(cred_dir):
    from service.market.shared.rust_live import RustDaemonEventSink

    ingress = RustDaemonEventSink.__new__(RustDaemonEventSink)
    ingress._source, ingress._adapter_source, ingress._explicit_token = "shioaji", None, None
    with pytest.raises(RuntimeError, match="provider:shioaji"):
        ingress._auth_headers()
    assert list(cred_dir.iterdir()) == []
