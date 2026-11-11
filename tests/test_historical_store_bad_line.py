"""One undecodable line in events.jsonl ended the read of the whole partition."""
from __future__ import annotations

import json

from service.market.history.historical_store import HistoricalStore
from service.market.history.rust_historical_store_reader import partition_dir
from tests.historical_fixtures import encode, event, needs_verifier, write_partition


def test_a_bad_line_is_skipped_alone_and_counted(tmp_path):
    path = partition_dir(source="shioaji", market="STK", logical_code="2330", trading_date="2026-09-23", session="DAY",
                         historical_root=tmp_path)
    path.mkdir(parents=True)
    lines = [json.dumps({"durable_sequence": 1}), "{broken", json.dumps({"durable_sequence": 3})]
    (path / "events.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (path / "manifest.json").write_text(json.dumps({"event_count": 3}), encoding="utf-8")
    store = HistoricalStore(tmp_path)
    events = list(store.iter_events("STK", "2330", "2026-09-23", "DAY"))
    assert [e["durable_sequence"] for e in events] == [1, 3], "the events after the bad line are still read"
    assert store.unreadable_lines == {str(path / "events.jsonl"): 1}
    list(store.iter_events("STK", "2330", "2026-09-23", "DAY"))
    assert store.unreadable_lines == {str(path / "events.jsonl"): 1}, "a re-read does not add the same line again (CX-30)"


@needs_verifier
def test_a_damaged_events_file_is_a_gap_whatever_its_manifest_says(tmp_path):
    """Coverage trusted the manifest alone, so a partition with a damaged line still read as complete."""
    path = partition_dir(source="shioaji", market="STK", logical_code="2330", trading_date="2026-09-23", session="DAY",
                         historical_root=tmp_path)
    good = [event(n) for n in (1, 2, 3)]
    write_partition(path, good, completeness="complete", loss_evidence=[])
    store = HistoricalStore(tmp_path)
    assert store.completeness("2330", "2026-09-23", market="STK")["completeness"] == "complete"
    (path / "events.jsonl").write_bytes(encode([good[0], "{broken", good[2]]))
    result = store.completeness("2330", "2026-09-23", market="STK")
    assert result["completeness"] == "gap_detected"
    assert any("undecodable" in item for item in result["loss_evidence"]), result
    (path / "events.jsonl").write_bytes(encode(good[:2]))
    result = store.completeness("2330", "2026-09-23", market="STK")
    assert result["completeness"] == "gap_detected" and any("manifest says 3" in item for item in result["loss_evidence"]), result


@needs_verifier
def test_a_valid_event_changed_into_another_is_a_gap(tmp_path):
    """Only the line count and JSON decoding were checked, so an event rewritten into another
    valid one (same count) still read as complete. The bytes must hash to the manifest's content hash, and every line
    must be a market event."""
    path = partition_dir(source="shioaji", market="STK", logical_code="2330", trading_date="2026-09-23", session="DAY",
                         historical_root=tmp_path)
    good = [event(n) for n in (1, 2, 3)]
    write_partition(path, good, completeness="complete", loss_evidence=[])
    store = HistoricalStore(tmp_path)
    before = store.completeness("2330", "2026-09-23", market="STK")
    assert before["completeness"] == "complete", before
    (path / "events.jsonl").write_bytes(encode([good[0], event(2, exchange_ts_ns=99), good[2]]))
    after = store.completeness("2330", "2026-09-23", market="STK")
    assert after["completeness"] == "gap_detected" and any("hashes to" in item for item in after["loss_evidence"]), after
    # No manifest changed, yet the fingerprint did, so a replay cache built before the damage is stale.
    assert after["fingerprint"] != before["fingerprint"]
    write_partition(path, [good[0], {"durable_sequence": 2}, good[2]], completeness="complete", loss_evidence=[])
    foreign = store.completeness("2330", "2026-09-23", market="STK")
    assert foreign["completeness"] == "gap_detected" and any("undecodable" in item for item in foreign["loss_evidence"]), \
        "JSON that is not a market event is damage even under a matching hash"


@needs_verifier
def test_the_check_cache_keeps_one_entry_per_file(tmp_path):
    """Every rewrite of a partition left its old (path, size, mtime) entry behind forever."""
    path = partition_dir(source="shioaji", market="STK", logical_code="2330", trading_date="2026-09-23", session="DAY",
                         historical_root=tmp_path)
    store = HistoricalStore(tmp_path)
    for count in (1, 2, 3):
        write_partition(path, [event(n) for n in range(1, count + 1)], completeness="complete", loss_evidence=[])
        assert store.completeness("2330", "2026-09-23", market="STK")["completeness"] == "complete"
    assert list(store._artifact_checks) == [str(path / "events.jsonl")]
    (path / "events.jsonl").unlink()
    assert store.completeness("2330", "2026-09-23", market="STK")["completeness"] == "gap_detected"
    assert store._artifact_checks == {}, "a file that is gone leaves no entry"


def test_a_partition_that_cannot_be_verified_is_never_complete(tmp_path):
    """The verifier missing is reported (recorded), never read as an intact partition."""
    path = partition_dir(source="shioaji", market="STK", logical_code="2330", trading_date="2026-09-23", session="DAY",
                         historical_root=tmp_path)
    write_partition(path, [event(1)], completeness="complete", loss_evidence=[])
    store = HistoricalStore(tmp_path, verifier=tmp_path / "missing.exe")
    result = store.completeness("2330", "2026-09-23", market="STK")
    assert result["completeness"] == "gap_detected" and any("could not be verified" in item for item in result["loss_evidence"]), result
