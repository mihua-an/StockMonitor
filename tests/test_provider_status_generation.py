"""A provider adapter applies Market Runtime's plan and REPORTS what its broker confirmed; it does
not write subscription coverage into the WAL as wall-clock ``source_status`` market events (they created weekend
sessions). Market Runtime turns the report into coverage records dated by its own calendar."""
import json
from types import SimpleNamespace

import pytest

from service.market.shared.rust_live import RustDaemonEventSink


def test_applying_a_plan_reports_to_market_runtime_and_publishes_no_market_event():
    sink = RustDaemonEventSink(source="futu", token="test")
    sink.register_adapter(source="futu", max_subscriptions=100,
                          replace_subscriptions=lambda items, revision: {
                              "subscribed": [{"market": "US", "code": "US.UMC"}],
                              "failed": [{"market": "US", "code": "US.BAD", "reason": "NO_QUOTE_RIGHT"}]},
                          report_subscriptions=lambda: {})
    sent = []
    socket = SimpleNamespace(send=lambda raw: sent.append(json.loads(raw)))
    sink._control.apply_plan(socket, {"generation": 7, "items": [{"market": "US", "code": "US.UMC"}, {"market": "US", "code": "US.BAD"}]})
    assert sink._queue.qsize() == 0, "no coverage event enters the ingest queue"
    assert sent == [{"type": "adapter.subscription.status", "payload": {
        "source": "futu", "generation": 7, "subscribed": [{"market": "US", "code": "US.UMC"}],
        "failed": [{"market": "US", "code": "US.BAD", "reason": "NO_QUOTE_RIGHT"}], "draining": []}}]


def test_source_status_is_not_a_provider_event_type():
    from service.market.shared.rust_live import LIVE_EVENT_TYPES
    from config.system_contract import contract

    assert "source_status" not in LIVE_EVENT_TYPES
    assert "source_status" not in contract()["role_ingest_kinds"]["provider"]


@pytest.mark.parametrize("source", ["futu", "shioaji"])
def test_generation_reserved_across_restarts_without_login(tmp_path, monkeypatch, source):
    """The market-data generation seed still advances on disk, so a restart never reuses a generation."""
    if source == "futu":
        from service.market.futu import service as module
    else:
        from service.market.shioaji import session as module
    monkeypatch.setattr(module, "process_market_layout", lambda: SimpleNamespace(**{f"{source}_root": tmp_path}))
    monkeypatch.setattr(module.time, "time", lambda: 1000)
    first = module._load_and_advance_persisted_generation_seed()
    # No login, and the clock even moves backwards. Disk reservation is authoritative.
    monkeypatch.setattr(module.time, "time", lambda: 999)
    second = module._load_and_advance_persisted_generation_seed()
    assert second > first
    assert module._load_and_advance_persisted_generation_seed() > second


def test_an_event_dated_to_a_day_without_a_session_is_refused_before_admission():
    # A weekend reconnect snapshot is no session's event -- no evidence row, no WAL event.
    from service.market.shared.session_identity_contract import is_business_session

    assert is_business_session("shioaji", "STK", "DAY", "2026-10-05") is True
    assert is_business_session("shioaji", "STK", "DAY", "2026-10-03") is False, "Saturday"
    assert is_business_session("shioaji", "FUT", "NIGHT", "2026-10-03") is True, "a night session is dated by its open"
    assert is_business_session("futu", "US", "FULL", "2026-10-03") is True, "no venue calendar: not judged"


def test_a_generation_that_cannot_be_recorded_is_never_returned(tmp_path, monkeypatch):
    # A failed seed write used to be logged and the value used anyway.
    from service.market.shared import generation_seed

    seed = tmp_path / "seed.txt"
    first = generation_seed.reserve_generation(seed)

    def refuse(*_args, **_kwargs):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(generation_seed, "write_bytes_atomic", refuse)
    with pytest.raises(generation_seed.GenerationPersistError):
        generation_seed.advance_generation(seed, first + 1)
    assert int(seed.read_text()) == first
    assert not list(tmp_path.glob("*.tmp")), "the temp file of a failed write is removed"


def test_a_rename_whose_directory_entry_cannot_be_synced_is_never_returned(tmp_path, monkeypatch):
    """POSIX: a rename is durable only once its directory is synced; a reservation without that is not one."""
    from service.market.shared import generation_seed
    from service.platform import atomic_files

    seed = tmp_path / "seed.txt"
    first = generation_seed.reserve_generation(seed)
    synced: list = []
    monkeypatch.setattr(atomic_files, "fsync_directory", lambda folder: synced.append(folder))
    second = generation_seed.advance_generation(seed, first + 1)
    assert synced == [tmp_path], "the seed's directory is synced after the rename"

    def refuse(_folder):
        raise OSError(5, "Input/output error")

    monkeypatch.setattr(atomic_files, "fsync_directory", refuse)
    with pytest.raises(generation_seed.GenerationPersistError):
        generation_seed.advance_generation(seed, second + 1)


def test_a_corrupt_seed_fails_closed(tmp_path):
    from service.market.shared import generation_seed

    seed = tmp_path / "seed.txt"
    seed.write_text("not-a-number")
    with pytest.raises(generation_seed.GenerationPersistError):
        generation_seed.reserve_generation(seed)


def test_advance_skips_values_an_earlier_failed_attempt_used(tmp_path):
    from service.market.shared import generation_seed

    seed = tmp_path / "seed.txt"
    current = generation_seed.reserve_generation(seed)
    burnt = generation_seed.advance_generation(seed, current + 1)   # the attempt that reserved it then failed
    assert generation_seed.advance_generation(seed, current + 1) == burnt + 1


def test_concurrent_reservations_never_share_a_generation(tmp_path):
    import threading
    from service.market.shared import generation_seed

    seed = tmp_path / "seed.txt"
    results, barrier = [], threading.Barrier(8)

    def reserve():
        barrier.wait()
        results.append(generation_seed.advance_generation(seed, 1))

    threads = [threading.Thread(target=reserve) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len(set(results)) == 8
    assert int(seed.read_text()) == max(results)
