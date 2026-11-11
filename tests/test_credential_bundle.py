"""The Shioaji pair is one versioned bundle switched by a pointer -- the effective pair
is always a whole old or a whole new one, nothing is rolled back -- and a superseded GAS token entry is removed."""
from __future__ import annotations

import json

import pytest

from service.platform.credential_service import CredentialError, CredentialService


class Backend:
    def __init__(self):
        self.entries: dict[tuple[str, str], str] = {}
        self.fail_on: set[str] = set()

    def get_password(self, service, entry):
        return self.entries.get((service, entry))

    def set_password(self, service, entry, value):
        if any(entry.endswith(suffix) for suffix in self.fail_on):
            raise OSError("write refused")
        self.entries[(service, entry)] = value

    def delete_password(self, service, entry):
        self.entries.pop((service, entry), None)

    def status(self):
        return {"available": True, "backend": "memory"}


def test_a_save_switches_whole_versions_and_leaves_no_stale_entries():
    backend = Backend()
    svc = CredentialService(backend)
    first = svc.save_shioaji_credentials("key-1", "secret-1")["version"]
    second = svc.save_shioaji_credentials("key-2", "secret-2")["version"]
    assert svc.load_shioaji_credentials().api_key == "key-2"
    names = {entry for _service, entry in backend.entries}
    assert names == {svc._pointer_entry(), svc._bundle_entry(second)}, "the superseded bundle is gone"
    assert first != second


def test_a_failed_switch_keeps_the_previous_pair_whole():
    backend = Backend()
    svc = CredentialService(backend)
    old = svc.save_shioaji_credentials("key-1", "secret-1")["version"]
    backend.fail_on = {".bundle.active"}
    with pytest.raises(CredentialError) as failed:
        svc.save_shioaji_credentials("key-2", "secret-2")
    assert old in str(failed.value), "the answer names the version still in effect"
    pair = svc.load_shioaji_credentials()
    assert (pair.api_key, pair.secret_key) == ("key-1", "secret-1")
    assert len([e for _s, e in backend.entries if ".bundle." in e and not e.endswith("active")]) == 1


def test_a_superseded_gas_token_entry_is_removed(tmp_path):
    from types import SimpleNamespace

    from service.account.actual_account_sync import ActualAccountSync

    backend = Backend()
    ledger = SimpleNamespace(config_path=tmp_path / "actual_account.json")
    sync = ActualAccountSync(ledger, credential_backend=backend)
    sync._store_config({"gas_url": "u", "gas_token": "t1"})
    first = json.loads(ledger.config_path.read_text(encoding="utf-8"))["gas_token_reference"]
    sync._store_config({"gas_url": "u", "gas_token": "t2"})
    second = json.loads(ledger.config_path.read_text(encoding="utf-8"))["gas_token_reference"]
    assert [entry for _service, entry in backend.entries] == [second] and first != second


def test_a_reader_whose_pointer_moved_under_it_reads_the_new_bundle():
    """A save between the reader's pointer read and its bundle read removed that bundle; the reader follows
    the pointer again instead of reporting no credentials."""
    backend = Backend()
    svc = CredentialService(backend)
    svc.save_shioaji_credentials("key-1", "secret-1")
    real_get = backend.get_password
    swapped = []

    def racing_get(service, entry):
        value = real_get(service, entry)
        if entry == svc._pointer_entry() and not swapped:
            swapped.append(True)
            svc.save_shioaji_credentials("key-2", "secret-2")   # lands right after the reader read the old pointer
        return value

    backend.get_password = racing_get
    assert svc.load_shioaji_credentials().api_key == "key-2"


def test_a_pointer_that_keeps_moving_is_a_failed_read_never_missing_credentials():
    """A save lands after every pointer read: once the rereads are spent the reader reports a read failure -- it never
    reads the last bundle unverified and answers 'no credentials'."""
    backend = Backend()
    svc = CredentialService(backend)
    svc.save_shioaji_credentials("key-1", "secret-1")
    real_get = backend.get_password
    saving = []

    def racing_get(service, entry):
        value = real_get(service, entry)
        if entry == svc._pointer_entry() and not saving:
            saving.append(True)
            svc.save_shioaji_credentials("key-n", "secret-n")
            saving.clear()
        return value

    backend.get_password = racing_get
    with pytest.raises(CredentialError) as raised:
        svc.load_shioaji_credentials()
    assert raised.value.code == "read_failure"


@pytest.mark.parametrize("stored", ["{not json", json.dumps({"api_key": "key-1"}), json.dumps(["key", "secret"]), None])
def test_a_damaged_or_missing_bundle_under_a_pointer_is_a_read_failure_not_unconfigured(stored):
    backend = Backend()
    svc = CredentialService(backend)
    version = svc.save_shioaji_credentials("key-1", "secret-1")["version"]
    if stored is None:
        backend.entries.pop((svc.service_name, svc._bundle_entry(version)))
    else:
        backend.entries[(svc.service_name, svc._bundle_entry(version))] = stored
    with pytest.raises(CredentialError) as raised:
        svc.load_shioaji_credentials()
    assert raised.value.code == "read_failure"
    status = svc.public_status()
    assert status["configured"] is False and status["backend_available"] is False and status["backend_error"]


def test_no_pointer_is_still_unconfigured():
    svc = CredentialService(Backend())
    with pytest.raises(CredentialError) as raised:
        svc.load_shioaji_credentials()
    assert raised.value.code == "missing_credential"
    assert svc.public_status()["backend_available"] is True


def test_saves_and_deletes_on_worker_threads_do_not_interleave():
    """A PUT and a DELETE on two endpoint threads: each runs whole, so the end state is one of them, never a pointer to
    a bundle the other removed, and no bundle is left unreferenced."""
    import threading
    import time

    backend = Backend()
    svc = CredentialService(backend)
    svc.save_shioaji_credentials("key-0", "secret-0")
    real_set = backend.set_password

    def slow_set(service, entry, value):
        time.sleep(0.005)   # widen the window between a save's pointer read and its switch
        real_set(service, entry, value)

    backend.set_password = slow_set
    errors = []

    def run(action):
        try:
            action()
        except CredentialError as exc:
            errors.append(exc)

    threads = [threading.Thread(target=run, args=(lambda i=i: svc.save_shioaji_credentials(f"key-{i}", f"secret-{i}"),))
               for i in range(1, 5)]
    threads.append(threading.Thread(target=run, args=(svc.delete_shioaji_credentials,)))
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    bundles = [e for _s, e in backend.entries if ".bundle." in e and not e.endswith(".active")]
    if svc.has_shioaji_credentials():
        assert bundles == [svc._bundle_entry(svc._active_version())]
    else:
        assert bundles == []


class FlakyDeleteBackend(Backend):
    def __init__(self):
        super().__init__()
        self.refuse_delete = False

    def delete_password(self, service, entry):
        if self.refuse_delete and ".bundle." in entry and not entry.endswith(".active"):
            raise OSError("delete refused")
        super().delete_password(service, entry)


def test_a_bundle_that_could_not_be_removed_is_kept_on_the_cleanup_list_and_removed_later():
    backend = FlakyDeleteBackend()
    svc = CredentialService(backend)
    first = svc.save_shioaji_credentials("key-1", "secret-1")["version"]
    backend.refuse_delete = True
    svc.save_shioaji_credentials("key-2", "secret-2")
    assert svc._pending_cleanup() == [first], "the superseded bundle stays indexed, not lost"
    assert "secret" not in backend.entries[(svc.service_name, svc._cleanup_entry())], "the list holds names only"
    backend.refuse_delete = False
    third = svc.save_shioaji_credentials("key-3", "secret-3")["version"]
    assert svc._pending_cleanup() == []
    assert {e for _s, e in backend.entries} == {svc._pointer_entry(), svc._bundle_entry(third)}


def test_a_delete_that_leaves_a_bundle_behind_is_reported_partial_not_complete():
    backend = FlakyDeleteBackend()
    svc = CredentialService(backend)
    version = svc.save_shioaji_credentials("key-1", "secret-1")["version"]
    backend.refuse_delete = True
    with pytest.raises(CredentialError) as raised:
        svc.delete_shioaji_credentials()
    assert raised.value.code == "delete_incomplete"
    assert svc.has_shioaji_credentials() is False, "the credentials are out of effect"
    assert svc._pending_cleanup() == [version]
    backend.refuse_delete = False
    svc.delete_shioaji_credentials()
    assert backend.entries == {}
