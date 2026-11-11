"""The fill step of a materialized session (materialization_ledger.py fill_*; decisions.md 盤中重啟的缺口只補空檔時段)."""
from __future__ import annotations

import json

from service.market.shared.materialization_jobs import RESULT_SCHEMA, request_materialization
from service.market.shared.materialization_ledger import SUCCEEDED, MaterializationKey, MaterializationLedger


def ledger_with_materialized(tmp_path):
    ledger = MaterializationLedger("shioaji", jobs_root=tmp_path, clock=lambda: 100.0)
    key = MaterializationKey.for_session("shioaji", "STK", "2026-11-06")
    ledger.submit(key, completeness="gap_detected")
    record = ledger._records[key.key_id]
    record.update({"state": SUCCEEDED, "result": {"codes": [{"code": "2330", "completeness": "gap_detected"}]}})
    ledger._save()
    return ledger, key


def test_a_materialized_session_is_a_fill_candidate_until_its_fill_settles(tmp_path):
    ledger, key = ledger_with_materialized(tmp_path)
    assert [r["key_id"] for r in ledger.fill_candidates()] == [key.key_id]
    ledger.fill_update(key.key_id, state="preparing")
    assert ledger.fill_candidates() == []
    assert ledger.drop_records({key.key_id}) == 0, "a record being filled is not dropped"
    ledger.fill_update(key.key_id, state="not_needed")
    assert ledger.drop_records({key.key_id}) == 1


def test_the_fill_job_reads_the_store_with_its_fills_and_settles_from_its_result(tmp_path):
    ledger, key = ledger_with_materialized(tmp_path)
    job_id = ledger.fill_submit(key.key_id, fills_dir=tmp_path / "fills" / key.key_id, unresolved_codes=["1802"], summary={"fill_events": 3})
    request = json.loads((tmp_path / "pending" / f"{job_id}.json").read_text(encoding="utf-8"))
    assert request["fill"] == {"fills_dir": str(tmp_path / "fills" / key.key_id), "unresolved_codes": ["1802"]}
    assert (request["market"], request["code"], request["session"]) == ("STK", "*", "DAY")
    assert ledger.status(key)["state"] == SUCCEEDED, "the session stays materialized while it is filled"
    # Health ran it: the request is gone from pending, its result is in done.
    (tmp_path / "pending" / f"{job_id}.json").unlink()
    (tmp_path / "done").mkdir()
    (tmp_path / "done" / f"{job_id}.json").write_text(json.dumps({"schema": RESULT_SCHEMA, "job_id": job_id, "ok": True,
        "status": "materialized", "request": request, "codes": [{"code": "2330", "completeness": "repaired"},
                                                                {"code": "1802", "completeness": "gap_detected"}]}), encoding="utf-8")
    ledger.tick()
    fill = ledger._records[key.key_id]["fill"]
    assert (fill["state"], fill["completeness"]) == ("done", {"complete": 0, "repaired": 1, "gap_detected": 1})
    assert not (tmp_path / "done" / f"{job_id}.json").exists(), "its result was consumed"


def test_a_lost_fill_job_is_a_failed_fill_and_a_session_materialized_again_is_filled_again(tmp_path):
    ledger, key = ledger_with_materialized(tmp_path)
    job_id = ledger.fill_submit(key.key_id, fills_dir=tmp_path / "f", unresolved_codes=[], summary={})
    (tmp_path / "pending" / f"{job_id}.json").unlink()
    ledger.tick()
    assert ledger._records[key.key_id]["fill"]["state"] == "failed"
    ledger._launch(key, ledger._records[key.key_id], "gap_detected")
    assert "fill" not in ledger._records[key.key_id]


def test_request_materialization_names_no_fill_by_default(tmp_path):
    job_id = request_materialization(source="shioaji", market="STK", code="*", trading_date="2026-11-06", session="DAY",
                                     completeness="complete", jobs_root=tmp_path)
    assert "fill" not in json.loads((tmp_path / "pending" / f"{job_id}.json").read_text(encoding="utf-8"))


def test_an_idx_session_that_found_no_input_is_a_fill_candidate(tmp_path):
    """decisions.md 指數整天沒有分區的日子: the WAL never got the day's indexes, so the fill fetches them whole."""
    from service.market.shared.materialization_ledger import NO_INPUT

    ledger = MaterializationLedger("shioaji", jobs_root=tmp_path, clock=lambda: 100.0)
    key = MaterializationKey.for_session("shioaji", "IDX", "2026-10-20")
    ledger.submit(key, completeness="complete")
    ledger._records[key.key_id].update({"state": NO_INPUT, "result": {"status": "no_matching_input"}})
    ledger._save()
    assert [r["key_id"] for r in ledger.fill_candidates()] == [key.key_id]


def _background_revisions(monkeypatch, config_root, revisions):
    """Background revisions saved at the given UTC instants (each save activates its revision)."""
    from config import config_revisions

    store = config_revisions.ConfigRevisionStore(config_root, "background")
    for created_at, codes in revisions:
        monkeypatch.setattr(config_revisions, "_now", lambda at=created_at: at)
        latest = store.latest() if store.state()["state"] == "OK" else None
        store.save({"items": [{"source": "shioaji", "market": market, "code": code, "kinds": ["quote"]} for market, code in codes]},
                   expected_revision=(latest or {}).get("revision"), source="test", activate=True)


def _stk_partition(root, date):
    (root / "source=shioaji" / "market=STK" / f"trading_date={date}" / "session=DAY" / "2330").mkdir(parents=True)


def test_an_idx_session_expects_the_indexes_the_background_list_held_while_it_traded(tmp_path, monkeypatch):
    from service.market.history import history_fill

    config_root, store_root = tmp_path / "config", tmp_path / "store"
    _background_revisions(monkeypatch, config_root, [
        ("2026-10-19T06:40:00+00:00", [("IDX", "TAIEX"), ("IDX", "IX0010"), ("STK", "2330")]),  # held through 10-20 09:31
        ("2026-10-20T01:31:00+00:00", [("IDX", "TAIEX"), ("IDX", "IX0028")]),                   # 09:31 Taipei, mid-session
        ("2026-10-20T06:00:00+00:00", [("IDX", "IX0099")]),                                     # 14:00 Taipei, after the close
    ])
    assert history_fill.expected_codes(store_root, "IDX", "2026-10-20", "DAY", config_root) == [], "no STK partition: no expectation"
    _stk_partition(store_root, "2026-10-20")
    assert history_fill.expected_codes(store_root, "IDX", "2026-10-20", "DAY", config_root) == ["IX0010", "IX0028", "TAIEX"]
    assert history_fill.expected_codes(store_root, "STK", "2026-10-20", "DAY", config_root) == [], "only an IDX session expects codes"


def test_an_expected_index_without_a_partition_is_fetched_whole_and_written_as_its_fill(tmp_path, monkeypatch):
    from service.market.history import history_fill

    whole = {"after_ns": 0, "volume_at_after": 0, "total_before": None, "end_ns": 1_760_938_440_000_000_000,
             "next_total_before": None, "end_is_live": False, "whole_session": True}
    reference = {"after_ns": 1_760_851_800_000_000_000, "volume_at_after": 0, "total_before": None, "end_ns": 1_760_852_040_000_000_000,
                 "next_total_before": None, "end_is_live": False, "reference": "prev_close", "reference_date": "2026-10-17",
                 "reference_at_ns": 1_760_922_000_000_000_000}
    seen = {}

    def report(binary, root, market, date, session, expected=()):
        seen["expected"] = list(expected)
        return {"ok": True, "codes": [{"code": "TAIEX", "completeness": None, "partition": False, "windows": [reference, whole]},
                                      {"code": "IX0028", "completeness": None, "partition": False, "windows": [reference, whole]}]}

    def fetch(items):
        seen["windows"] = {i["code"]: i["windows"] for i in items}
        prints = {("TAIEX", True): [[1_760_851_980_000_000_000, 22950.25, 9.0, 0]],
                  ("TAIEX", False): [[1_760_922_000_000_000_000, 23000.5, 1.0, 0], [1_760_922_005_000_000_000, 23001.0, 1.0, 0]]}
        return [{**i, "windows": [{**w, "prints": prints.get((i["code"], "reference" in w), [])} for w in i["windows"]]} for i in items]

    monkeypatch.setattr(history_fill, "gap_report", report)
    summary = history_fill.prepare(fetch, None, tmp_path, "IDX", "2026-10-20", "DAY", tmp_path / "fills", ["TAIEX", "IX0028"])
    assert seen["expected"] == ["TAIEX", "IX0028"]
    assert seen["windows"]["TAIEX"] == [reference, whole], "the whole session and the previous close are asked for"
    assert summary["missing_codes"] == ["IX0028", "TAIEX"]
    assert list(summary["unresolved"]) == ["IX0028"], "an index the history gave nothing for stays unresolved"
    assert summary["refold"] and summary["incomplete_codes"] == 0
    events = [json.loads(line) for line in (tmp_path / "fills" / "TAIEX.jsonl").read_text(encoding="utf-8").splitlines()]
    assert [e["payload"]["kind"] for e in events] == ["reference", "quote", "quote"], "each 5-second print is a quote, as live"
    assert (events[0]["payload"]["prev_close"], events[0]["exchange_ts_ns"]) == (229_502_500, reference["reference_at_ns"]), \
        "昨收 is the previous day's closing print, stamped at the open"
    last = events[-1]["payload"]
    assert (last["current"], last["open"], last["high"], last["low"]) == (230_010_000, 230_005_000, 230_010_000, 230_005_000), \
        "over the whole session the day's open / high / low are the prints'"
    assert (last["total_amount"], last["status"]) == (0.0, "live") and all(e["flags"]["backfill"] is True for e in events)


def test_an_index_gap_inside_a_session_states_no_day_open_high_low():
    from service.market.history import history_fill

    window = {"after_ns": 1, "volume_at_after": 0, "total_before": None, "end_ns": 1_760_922_100_000_000_000,
              "next_total_before": None, "end_is_live": True, "prints": [[1_760_922_000_000_000_000, 23000.5, 1.0, 0]]}
    events, problems = history_fill.fill_events({"market": "IDX", "code": "TAIEX", "trading_date": "2026-10-20", "session": "DAY",
                                                 "windows": [window]})
    payload = events[0]["payload"]
    assert problems == [] and (payload["kind"], payload["current"], payload["open"], payload["high"], payload["low"]) == \
        ("quote", 230_005_000, 0, 0, 0), "a gap's prints are not the day's extremes"


def test_a_code_listed_after_the_session_is_found_only_when_it_has_no_partition(tmp_path, monkeypatch):
    """收盤後看任何商品都要有資料: asked once the session is materialized, so it never races the materialization."""
    from datetime import datetime, timezone

    from service.market.history import history_fill

    config_root, store_root = tmp_path / "config", tmp_path / "store"
    _background_revisions(monkeypatch, config_root, [("2026-11-08T16:00:00+00:00", [("FUT", "TXF202611"), ("FUT", "MXF202611"), ("STK", "2330")])])
    (store_root / "source=shioaji" / "market=FUT" / "trading_date=2026-11-06" / "session=DAY" / "MXF202611").mkdir(parents=True)
    now = datetime(2026, 11, 8, 17, 0, tzinfo=timezone.utc)
    assert history_fill.listed_without_partition(store_root, "FUT", "2026-11-06", "DAY", config_root, now) == ["TXF202611"]


def test_a_settled_session_is_reopened_for_new_codes_under_its_own_job(tmp_path):
    ledger, key = ledger_with_materialized(tmp_path)
    assert ledger.fill_settled_newest() == [], "not while its first fill is open"
    ledger.fill_update(key.key_id, state="not_needed")
    assert [r["key_id"] for r in ledger.fill_settled_newest()] == [key.key_id]
    ledger.fill_reopen(key.key_id, ["TXF202611"])
    assert [r["fill_listed"] for r in ledger.fill_candidates()] == [["TXF202611"]]
    job_id = ledger.fill_submit(key.key_id, fills_dir=tmp_path / "f", unresolved_codes=[], summary={})
    assert job_id.endswith("-fill-1"), job_id


def test_a_stock_with_no_partition_is_filled_whole_from_zero():
    from service.market.history import history_fill

    events, problems = history_fill.fill_events({"market": "FUT", "code": "TXF202611", "trading_date": "2026-11-06", "session": "DAY", "windows": [
        {"after_ns": 0, "total_before": None, "end_ns": 9, "next_total_before": None, "end_is_live": False, "whole_session": True,
         "prints": [[1, 100.0, 2.0, 1], [2, 101.0, 3.0, 2]]}]})
    assert problems == []
    assert [e["payload"]["total_volume"] for e in events] == [2.0, 5.0]


def test_a_stock_filled_whole_keeps_its_prev_close_as_a_reference():
    from service.market.history import history_fill

    events, problems = history_fill.fill_events({"market": "STK", "code": "2912", "trading_date": "2026-11-06", "session": "DAY", "windows": [
        {"reference": "prev_close", "prints": [[0, 208.0, 0, 0]], "end_ns": 9, "reference_at_ns": 5},
        {"after_ns": 0, "total_before": None, "end_ns": 9, "next_total_before": None, "whole_session": True, "prints": [[6, 210.0, 2.0, 1]]}]})
    assert problems == []
    assert (events[0]["payload"]["kind"], events[0]["payload"]["prev_close"], events[0]["exchange_ts_ns"]) == ("reference", 2_080_000, 5)

