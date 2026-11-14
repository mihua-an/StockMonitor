"""Unix servers keep broker credentials in one owner-only file (0600 in a 0700 folder); a file or folder others can
reach is refused, never read, and no error message carries a credential value."""
from __future__ import annotations

import json
import os
import stat

import pytest

from service.platform import credential_service as cs
from service.platform.credential_service import CredentialError, CredentialService, FileCredentialBackend

pytestmark = pytest.mark.skipif(os.name == "nt", reason="the owner-only file backend is the Unix backend")


def mode(path):
    return stat.S_IMODE(path.stat().st_mode)


def test_values_round_trip_in_an_owner_only_file(tmp_path):
    target = tmp_path / "creds" / "credentials.json"
    backend = FileCredentialBackend(target)
    assert backend.get_password("svc", "user") is None
    backend.set_password("svc", "user", "s3cret")
    backend.set_password("svc", "other", "v2")
    assert backend.get_password("svc", "user") == "s3cret"
    assert mode(target) == 0o600 and mode(target.parent) == 0o700
    document = json.loads(target.read_text(encoding="utf-8"))
    assert document["schema"] == cs.CREDENTIAL_FILE_SCHEMA
    backend.delete_password("svc", "user")
    backend.delete_password("svc", "user")   # idempotent
    assert backend.get_password("svc", "user") is None
    assert backend.get_password("svc", "other") == "v2"
    assert not [p for p in target.parent.iterdir() if p.name.endswith(".tmp")], "no staged file is left behind"


def test_a_file_others_can_read_is_refused_not_read(tmp_path):
    target = tmp_path / "creds" / "credentials.json"
    backend = FileCredentialBackend(target)
    backend.set_password("svc", "user", "s3cret")
    target.chmod(0o644)
    with pytest.raises(CredentialError) as raised:
        backend.get_password("svc", "user")
    assert raised.value.code == "insecure_permissions"
    assert "s3cret" not in str(raised.value)
    assert backend.status()["available"] is False


def test_a_folder_others_can_enter_is_refused(tmp_path):
    folder = tmp_path / "creds"
    folder.mkdir(mode=0o755)
    folder.chmod(0o755)
    with pytest.raises(CredentialError) as raised:
        FileCredentialBackend(folder / "credentials.json").set_password("svc", "user", "x")
    assert raised.value.code == "insecure_permissions"
    assert not (folder / "credentials.json").exists()


def test_a_symlinked_file_is_refused(tmp_path):
    folder = tmp_path / "creds"
    folder.mkdir(mode=0o700)
    real = tmp_path / "elsewhere.json"
    real.write_text(json.dumps({"schema": cs.CREDENTIAL_FILE_SCHEMA, "entries": {}}))
    real.chmod(0o600)
    (folder / "credentials.json").symlink_to(real)
    with pytest.raises(CredentialError) as raised:
        FileCredentialBackend(folder / "credentials.json").get_password("svc", "user")
    assert raised.value.code == "insecure_permissions"


def test_a_damaged_file_is_a_read_failure_without_its_content(tmp_path):
    target = tmp_path / "creds" / "credentials.json"
    backend = FileCredentialBackend(target)
    backend.set_password("svc", "user", "s3cret")
    target.write_text('{"schema": "other", "entries": {"svc": {"user": "s3cret"}}}')
    with pytest.raises(CredentialError) as raised:
        backend.get_password("svc", "user")
    assert raised.value.code == "read_failure" and "s3cret" not in str(raised.value)


def test_the_default_backend_off_windows_is_the_file_named_by_the_environment(tmp_path, monkeypatch):
    target = tmp_path / "named" / "credentials.json"
    monkeypatch.setenv(cs.CREDENTIAL_FILE_ENV, str(target))
    backend = cs.default_credential_backend()
    assert isinstance(backend, FileCredentialBackend)
    assert backend.path() == target


def test_the_shioaji_bundle_works_on_the_file_backend(tmp_path):
    svc = CredentialService(FileCredentialBackend(tmp_path / "creds" / "credentials.json"))
    svc.save_shioaji_credentials("key-1", "secret-1")
    svc.save_shioaji_credentials("key-2", "secret-2")
    loaded = svc.load_shioaji_credentials()
    assert (loaded.api_key, loaded.secret_key) == ("key-2", "secret-2")
