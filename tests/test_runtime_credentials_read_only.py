"""Python market_runtime clients never create a token (04 §5). Under Health they use only the token granted in their
environment and never read a token file; started by hand they read their role's file."""
import pytest

from service.platform import runtime_credentials


@pytest.fixture
def cred_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("STOCK_MONITOR_RUNTIME_CREDENTIAL_DIR", str(tmp_path))
    monkeypatch.delenv("STOCK_MONITOR_MANAGED_BY_HEALTH", raising=False)
    for role in runtime_credentials.ROLES:
        monkeypatch.delenv(runtime_credentials.grant_env(role), raising=False)
    return tmp_path


@pytest.fixture
def managed(cred_dir, monkeypatch):
    """A service Health started: every role's token file exists, and only some roles are granted."""
    monkeypatch.setenv("STOCK_MONITOR_MANAGED_BY_HEALTH", "1")
    for role in runtime_credentials.ROLES:
        runtime_credentials.token_path(role).write_text("f" * 64, encoding="ascii")
    return cred_dir


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


def test_grant_variable_names_match_the_node_rule():
    # service/platform/js/runtime_credentials.js grantEnv (tests/health_role_credentials_contract.cjs checks the same).
    assert runtime_credentials.grant_env("viewer") == "STOCK_MONITOR_RUNTIME_TOKEN_VIEWER"
    assert runtime_credentials.grant_env("provider:shioaji") == "STOCK_MONITOR_RUNTIME_TOKEN_PROVIDER_SHIOAJI"
    with pytest.raises(ValueError):
        runtime_credentials.grant_env("nobody")


def test_managed_service_uses_only_its_grant(managed, monkeypatch):
    monkeypatch.setenv(runtime_credentials.grant_env("viewer"), "g" * 64)
    assert runtime_credentials.require_token("viewer") == "g" * 64


def test_managed_service_never_reads_a_role_file_it_was_not_granted(managed):
    from service.platform.daemon_auth import CredentialNotGranted

    # The file is there (Health wrote it), but this process was not granted the role: refused, not read.
    with pytest.raises(CredentialNotGranted, match="provider:futu"):
        runtime_credentials.require_token("provider:futu")


def test_hand_started_process_still_reads_its_file(cred_dir):
    (cred_dir / "viewer.token").write_text("v" * 64, encoding="ascii")
    assert runtime_credentials.require_token("viewer") == "v" * 64


def test_managed_view_client_without_grant_fails_loudly(managed):
    from service.market.shared.rust_view_client import RustViewClient, RustViewClientError

    with pytest.raises(RustViewClientError, match="not granted"):
        RustViewClient(url="ws://127.0.0.1:1/unused")


def test_managed_live_ingress_uses_its_granted_provider_token(managed, monkeypatch):
    from service.market.shared.rust_live import RustDaemonEventSink

    monkeypatch.setenv(runtime_credentials.grant_env("provider:shioaji"), "p" * 64)
    ingress = RustDaemonEventSink.__new__(RustDaemonEventSink)
    ingress._source, ingress._adapter_source, ingress._explicit_token = "shioaji", None, None
    assert ingress._auth_headers() == {"Authorization": "Bearer " + "p" * 64}
    ingress._source = "futu"
    with pytest.raises(RuntimeError, match="provider:futu"):
        ingress._auth_headers()
