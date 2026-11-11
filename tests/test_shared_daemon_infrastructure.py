from __future__ import annotations

from types import SimpleNamespace

import pytest
import requests

from service.market.shared.daemon_process_identity import matches_process_patterns
from service.market.shared.daemon_singleton import DaemonSingletonLock, read_owner_metadata
from service.market.shared.daemon_transport import DaemonHttpTransport, DaemonTransportError


class Session:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error

    def request(self, *args, **kwargs):
        if self.error:
            raise self.error
        return self.response


def response(status=200, payload=None, json_error=None):
    def decode():
        if json_error:
            raise json_error
        return payload
    return SimpleNamespace(status_code=status, json=decode)


def test_transport_accepts_only_json_objects():
    transport = DaemonHttpTransport("127.0.0.1", 1, session=Session(response(payload={"ok": True})))
    assert transport.get("/health") == {"ok": True}
    with pytest.raises(DaemonTransportError, match="not an object"):
        DaemonHttpTransport("127.0.0.1", 1, session=Session(response(payload=[]))).get("/health")


def test_transport_classifies_http_invalid_json_and_timeout():
    cases = [
        (Session(response(503, {"error": "busy"})), "HTTP_ERROR"),
        (Session(response(200, json_error=ValueError("bad"))), "INVALID_RESPONSE"),
        (Session(error=requests.Timeout("late")), "TIMEOUT"),
    ]
    for session, expected in cases:
        with pytest.raises(DaemonTransportError) as caught:
            DaemonHttpTransport("127.0.0.1", 1, session=session).get("/health")
        assert caught.value.classification == expected


def test_provider_process_patterns_do_not_cross_match():
    shioaji = {"commandLine": "python run_shioaji_daemon.py"}
    futu = {"commandLine": "python run_futu_daemon.py"}
    shioaji_patterns = ("run_shioaji_daemon.py", "stock-monitor-market-daemon")
    futu_patterns = ("run_futu_daemon.py", "stock-monitor-moomoo-daemon")
    assert matches_process_patterns(shioaji, shioaji_patterns)
    assert not matches_process_patterns(shioaji, futu_patterns)
    assert matches_process_patterns(futu, futu_patterns)
    assert not matches_process_patterns(futu, shioaji_patterns)


def test_shared_singleton_keeps_os_lock_authoritative_and_metadata_diagnostic(tmp_path):
    class Held(RuntimeError):
        def __init__(self, message, *, classification, owner):
            super().__init__(message)
            self.classification = classification
            self.owner = owner

    lock_path = tmp_path / "daemon.lock"
    metadata_path = tmp_path / "owner.json"

    def make_lock():
        return DaemonSingletonLock(
            path=lock_path,
            metadata_path=metadata_path,
            metadata={"daemon_instance_id": "instance-a", "port": 8010},
            classify_owner=lambda owner: "KNOWN_DAEMON_OWNER",
            error_type=Held,
            daemon_label="test daemon",
            heartbeat_thread_name="TestDaemonHeartbeat",
        )

    first = make_lock()
    first.acquire()
    try:
        assert read_owner_metadata(metadata_path)["daemon_instance_id"] == "instance-a"
        with pytest.raises(Held) as caught:
            make_lock().acquire()
        assert caught.value.classification == "KNOWN_DAEMON_OWNER"
    finally:
        first.release()
    assert not metadata_path.exists()


def test_the_owner_record_carries_generation_lifecycle_and_a_bound_stop_receipt(tmp_path):
    # The owner says who it is (pid + creation time), which generation, and where it is in its
    # life; its stop receipt is bound to its instance and generation.
    import json

    from service.market.shared import daemon_singleton

    lock_path = tmp_path / "daemon.lock"
    metadata_path = tmp_path / "owner.json"

    def make_lock(instance):
        return DaemonSingletonLock(path=lock_path, metadata_path=metadata_path, metadata={"daemon_instance_id": instance},
                                   classify_owner=lambda owner: "KNOWN_DAEMON_OWNER", error_type=RuntimeError,
                                   daemon_label="test daemon", heartbeat_thread_name="TestDaemonHeartbeat")

    first = make_lock("instance-a")
    first.acquire()
    record = read_owner_metadata(metadata_path)
    assert (record["generation"], record["lifecycle"], record["schema"]) == (1, "STARTING", daemon_singleton.OWNER_SCHEMA)
    daemon_singleton.publish_lifecycle("READY")
    assert read_owner_metadata(metadata_path)["lifecycle"] == "READY"
    daemon_singleton.publish_lifecycle("STOPPING")
    first.release(receipt={"clean": True, "reason": "test", "exit_code": 0})
    assert not metadata_path.exists(), "no owner record without an owner"
    receipt = json.loads(daemon_singleton.receipt_path_for(metadata_path).read_text(encoding="utf-8"))
    assert (receipt["daemon_instance_id"], receipt["generation"], receipt["clean"]) == ("instance-a", 1, True)
    daemon_singleton.publish_lifecycle("READY")      # nobody holds the lock: nothing is written
    assert not metadata_path.exists()

    second = make_lock("instance-b")
    second.acquire()
    try:
        assert read_owner_metadata(metadata_path)["generation"] == 2, "a new owner is a new generation"
    finally:
        second.release()
    receipt = json.loads(daemon_singleton.receipt_path_for(metadata_path).read_text(encoding="utf-8"))
    assert (receipt["daemon_instance_id"], receipt["clean"]) == ("instance-b", False), "no account given: not clean"
