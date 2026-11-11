"""The one network resolver and the versioned config store (docs/system-architecture/06, CFG-01/03/10/11/19)."""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path

import pytest

from config import network_config as nc
from config.config_revisions import ConfigRevisionStore, RevisionConflict, RevisionRejected

CASES = json.loads((Path(__file__).parent / "fixtures" / "network_config" / "cases.json").read_text(encoding="utf-8"))
MANIFEST = nc.load_manifest()


def summarize(effective):
    return {
        "listener_count": len(nc.listeners(effective)),
        "problem_codes": nc.iter_problem_codes(effective["problems"]),
        "ports": {sid: e["port"] for sid, e in effective["services"].items()},
        "hosts": {sid: e["host"] for sid, e in effective["services"].items()},
        "sources": {sid: e["source"] for sid, e in effective["services"].items()},
        "override_ids": sorted(o["service_id"] for o in effective["overrides"]),
        "revision": effective["revision"],
    }


@pytest.mark.parametrize("case", CASES["resolve"], ids=lambda c: c["name"])
def test_shared_resolve_cases(case):
    got = summarize(nc.resolve(MANIFEST, saved=case["saved"], env=case["env"]))
    for key, expected in case["expect"].items():
        if isinstance(expected, dict):
            for sub, value in expected.items():
                assert got[key][sub] == value, f"{key}.{sub}"
        else:
            assert got[key] == expected, key


@pytest.mark.parametrize("case", CASES["validate"], ids=lambda c: c["name"])
def test_shared_validate_cases(case):
    codes = nc.iter_problem_codes(nc.validate_values(MANIFEST, case["values"]))
    assert codes == case["expect_codes"]


def edited_manifest(edits):
    """The shipped manifest with a shared case's edits: [service_id or "$", field, value or {"$delete": true}]."""
    manifest = json.loads(json.dumps(MANIFEST))
    for target, field, value in edits:
        node = manifest if target == "$" else next(s for s in manifest["services"] if s["service_id"] == target)
        if isinstance(value, dict) and value.get("$delete"):
            node.pop(field, None)
        else:
            node[field] = value
    return manifest


@pytest.mark.parametrize("case", CASES["manifest"], ids=lambda c: c["name"])
def test_shared_manifest_cases(case):
    assert nc.manifest_problems(edited_manifest(case["edits"])) == case["expect"]


def test_manifest_is_the_spec_table():
    table = nc.services(MANIFEST)
    assert MANIFEST["port_policy"]["reserved_ports"] == [8002, 8003, 8004, 8005, 8006, 8007, 8008, 8009]
    for sid in ("analysis_runtime", "managed_workers"):
        assert table[sid]["listener"] is False and table[sid]["default_port"] is None
    assert table["external_futu_opend"]["managed"] is False
    # Two business API processes; every former service is a part of exactly one of them.
    apis = {sid: spec for sid, spec in table.items() if spec["kind"] == "api"}
    assert {sid: spec["default_port"] for sid, spec in apis.items()} == {"realtime_api": 8000, "app_api": 8001}
    parts = [part for spec in apis.values() for part in spec["parts"]]
    assert sorted(parts) == sorted(["quote_api", "model_api", "settings_api", "history_api", "data_center_api",
                                    "actual_account_api", "paper_account_api"])


def test_renderer_projection_has_no_controller_or_provider_and_no_secrets():
    effective = nc.resolve(MANIFEST, env={})
    projection = nc.renderer_projection(effective)
    assert set(projection["services"]) == set(nc.renderer_services(nc.load_manifest())) == {"realtime_api", "app_api", "market_runtime"}
    text = json.dumps(projection)
    assert "8011" not in text and "8100" not in text and "token" not in text.lower()
    assert nc.connect_sources(effective)[-1] == "ws://127.0.0.1:8010"


def test_store_revisions_conflict_and_pointer(tmp_path):
    store = ConfigRevisionStore(tmp_path, "network")
    assert store.latest() is None and store.active() is None
    first = store.save({"services": {"realtime_api": {"port": 18000}}}, expected_revision=None, source="test")
    assert first["revision"] == 1 and first["previous_revision"] is None
    assert store.active() is None, "saving alone never activates"
    with pytest.raises(RevisionConflict) as conflict:
        store.save({"services": {"realtime_api": {"port": 18001}}}, expected_revision=None, source="window-2")
    assert conflict.value.current["revision"] == 1
    assert conflict.value.diff == [{"path": "services.realtime_api.port", "change": "changed", "before": 18000, "after": 18001}]
    second = store.save({"services": {"realtime_api": {"port": 18001}}}, expected_revision=1, source="window-1")
    assert second["revision"] == 2
    store.set_active(2, verified=False)
    pointer = store.pointer()
    assert (pointer["latest"], pointer["active"], pointer["last_good"]) == (2, 2, None)
    store.set_active(1, verified=True)
    assert store.last_good()["revision"] == 1
    with pytest.raises(RevisionConflict):
        store.set_active(2, verified=True, expected_active=2)
    assert [h["revision"] for h in store.history()] == [2, 1]
    assert store.get(1)["values"] == {"services": {"realtime_api": {"port": 18000}}}, "revisions are immutable"


def test_set_active_expecting_no_active_revision_is_a_real_check(tmp_path):
    # An apply that started on the defaults (active None) must not overwrite a revision another apply activated.
    store = ConfigRevisionStore(tmp_path, "network")
    store.save({"services": {}}, expected_revision=None, source="t")
    store.save({"services": {}}, expected_revision=1, source="t")
    store.set_active(1, verified=True)
    with pytest.raises(RevisionConflict):
        store.set_active(2, verified=True, expected_active=None)
    assert store.pointer()["active"] == 1
    fresh = ConfigRevisionStore(tmp_path / "fresh", "network")
    fresh.save({"services": {}}, expected_revision=None, source="t")
    assert fresh.set_active(1, verified=True, expected_active=None)["active"] == 1


def test_store_refuses_secrets_and_invalid_candidates(tmp_path):
    store = ConfigRevisionStore(tmp_path, "sources")
    with pytest.raises(RevisionRejected) as rejected:
        store.save({"shioaji": {"api_key": "x", "credential_ref": "win:shioaji"}}, expected_revision=None, source="t")
    assert rejected.value.problems[0]["paths"] == ["shioaji.api_key"]
    network = ConfigRevisionStore(tmp_path, "network")
    with pytest.raises(RevisionRejected):
        network.save({"services": {"realtime_api": {"port": 8007}}}, expected_revision=None, source="t",
                     validator=lambda v: nc.validate_values(MANIFEST, v["services"]))
    assert network.latest() is None


def test_concurrent_saves_serialize_to_one_winner(tmp_path):
    store = ConfigRevisionStore(tmp_path, "background")
    results = []

    def attempt(n):
        try:
            results.append(store.save({"n": n}, expected_revision=None, source=f"w{n}")["revision"])
        except RevisionConflict:
            results.append("conflict")

    threads = [threading.Thread(target=attempt, args=(n,)) for n in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert results.count(1) == 1 and results.count("conflict") == 7


def test_effective_from_disk_uses_active_not_latest(tmp_path):
    store = ConfigRevisionStore(tmp_path, "network")
    store.save({"services": {"realtime_api": {"port": 18000}}}, expected_revision=None, source="t")
    assert nc.effective_from_disk(env={}, config_root=tmp_path)["services"]["realtime_api"]["port"] == 8000
    store.set_active(1, verified=True)
    effective = nc.effective_from_disk(env={}, config_root=tmp_path)
    assert effective["services"]["realtime_api"]["port"] == 18000 and effective["revision"] == 1


def test_store_state_tells_a_damaged_store_from_an_absent_one(tmp_path):
    # A damaged store fails closed; it is never read (or re-seeded) as an empty one.
    from config.config_revisions import StoreUnreadable

    store = ConfigRevisionStore(tmp_path, "network")
    assert store.state()["state"] == "ABSENT" and store.latest() is None
    store.save({"services": {}}, expected_revision=None, source="t", activate=True)
    assert store.state()["state"] == "OK"
    good = store.pointer_path.read_text(encoding="utf-8")

    store.pointer_path.write_text("{not json", encoding="utf-8")
    assert store.state()["state"] == "CORRUPT"
    for read in (store.pointer, store.latest, store.active, store.history):
        with pytest.raises(StoreUnreadable):
            read()
    with pytest.raises(StoreUnreadable):
        store.save({"services": {}}, expected_revision=None, source="t")
    assert store.get(1)["revision"] == 1, "revision 1 was not overwritten"

    store.pointer_path.unlink()
    assert store.state()["state"] == "CORRUPT", "a missing pointer over existing history is damage, not absence"
    store.pointer_path.write_text(good.replace('"latest": 1', '"latest": 3'), encoding="utf-8")
    assert store.state()["state"] == "INCONSISTENT"
    store.pointer_path.write_text(good, encoding="utf-8")
    assert store.state()["state"] == "OK" and store.active()["revision"] == 1
    # A pointer that only names its schema, or no latest, over a store with revisions is damage -- the next save
    # allocated revision 1 over the one on disk.
    store.pointer_path.write_text(json.dumps({"schema": json.loads(good)["schema"]}), encoding="utf-8")
    assert store.state()["state"] == "CORRUPT"
    store.pointer_path.write_text(good.replace('"latest": 1', '"latest": null').replace('"active": 1', '"active": null')
                                  .replace('"last_good": 1', '"last_good": null'), encoding="utf-8")
    assert store.state()["state"] == "CORRUPT"
    with pytest.raises(StoreUnreadable):
        store.save({"services": {}}, expected_revision=None, source="t")
    store.pointer_path.write_text(good, encoding="utf-8")
    # A revision file past `latest` (a save that crashed before its pointer moved) is not history.
    (store.revisions / "r000002.json").write_text(json.dumps({**store.get(1), "revision": 2}), encoding="utf-8")
    assert [h["revision"] for h in store.history()] == [1]


def test_store_lock_is_owned_by_its_token_and_taken_over_only_from_a_dead_owner(tmp_path, monkeypatch):
    # No age guess; a live owner's lock is waited on, a dead owner's is taken over (recorded).
    import config.config_revisions as cr

    store = ConfigRevisionStore(tmp_path, "network")
    store.LOCK_TIMEOUT_S = 1.5
    store.directory.mkdir(parents=True)
    lock = store.directory / ".lock"
    lock.write_text(json.dumps({"token": "other", "pid": os.getpid(), "created_ms": cr._own_created_ms(), "at_ms": 0}), encoding="utf-8")
    os.utime(lock, (0, 0))   # ancient mtime: it no longer matters
    with pytest.raises(TimeoutError):
        store.save({"services": {}}, expected_revision=None, source="t")
    assert json.loads(lock.read_text(encoding="utf-8"))["token"] == "other", "a live owner's lock is never removed"

    recorded = []
    monkeypatch.setattr(cr, "_record_takeover", lambda *args: recorded.append(args))
    monkeypatch.setattr(cr, "_owner_state", lambda owner: "gone")
    assert store.save({"services": {}}, expected_revision=None, source="t")["revision"] == 1
    assert [(r[3], r[4]) for r in recorded] == [("owner_process_gone", "succeeded")]
    assert not lock.exists() and not list(store.directory.glob(".lock.*")), "released by its own token, nothing left aside"


def test_a_dead_lock_is_taken_over_by_one_contender_only(tmp_path):
    """Two contenders could both judge a lock dead; one moved aside a live lock the other had made meanwhile and
    deleted it when it could not go back. The takeover of a dead lock is claimed by its token first."""
    store = ConfigRevisionStore(tmp_path, "network")
    store.directory.mkdir(parents=True)
    lock = store.directory / ".lock"
    lock.write_text(json.dumps({"token": "dead-owner", "pid": 999999, "created_ms": 1, "at_ms": 0}), encoding="utf-8")
    claim = store.directory / ".lock.takeover.dead-owner"
    claim.write_text("", encoding="utf-8")             # another contender is taking this very lock over
    assert store._take_over(lock) is False and lock.exists(), "the claimed lock is left to its claimant"
    claim.unlink()
    assert store._take_over(lock) is True and not lock.exists()
    assert not claim.exists(), "the claim goes with the takeover"


def test_a_claim_left_by_a_claimant_that_died_is_taken_over_too(tmp_path, monkeypatch):
    """A contender that died between making its takeover claim and removing the dead lock left the claim behind, and
    every writer then read it as someone taking over -- the domain could never be written again. The claim carries its
    claimant's owner record, and a dead claimant's claim is removed the same way."""
    import config.config_revisions as cr

    store = ConfigRevisionStore(tmp_path, "network")
    store.directory.mkdir(parents=True)
    lock = store.directory / ".lock"
    lock.write_text(json.dumps({"token": "dead-owner", "pid": 999999, "created_ms": 1, "at_ms": 0}), encoding="utf-8")
    claim = store.directory / ".lock.takeover.dead-owner"
    claim.write_text(json.dumps({"token": "dead-claimant", "pid": 999998, "created_ms": 1, "at_ms": 0}), encoding="utf-8")
    recorded = []
    monkeypatch.setattr(cr, "_record_takeover", lambda *args: recorded.append(args))
    assert store._take_over(lock) is False and not claim.exists(), "the dead claimant's claim is removed first"
    assert store._take_over(lock) is True and not lock.exists(), "then the dead lock"
    assert [r[5] for r in recorded] == ["takeover claim removed", "lock removed"]
    assert store.save({"services": {}}, expected_revision=None, source="t")["revision"] == 1


def test_a_claim_that_cannot_be_written_is_the_error_it_is(tmp_path, monkeypatch):
    # Only an existing claim is contention: no space / no access is raised, never retried into "domain is locked".
    store = ConfigRevisionStore(tmp_path, "network")
    store.directory.mkdir(parents=True)
    lock = store.directory / ".lock"
    lock.write_text(json.dumps({"token": "dead-owner", "pid": 999999, "created_ms": 1, "at_ms": 0}), encoding="utf-8")
    real_link = os.link

    def refuse(src, dst, *a, **k):
        if ".takeover." in str(dst):
            raise PermissionError(13, "access denied")
        return real_link(src, dst, *a, **k)

    monkeypatch.setattr(os, "link", refuse)
    with pytest.raises(PermissionError):
        store._take_over(lock)
    assert lock.exists() and not list(store.directory.glob("*.aside"))
