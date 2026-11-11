from scripts.benchmark.selection_latency_report import aggregate, cache_class
import json

def test_report_groups_cache_load_symbol_and_preserves_missing(tmp_path):
    path=tmp_path/"trace.json"
    path.write_text(json.dumps({"rows":[
      {"to_code":"2330","renderer_cache_class":"COLD","load_profile":"HIGH","marks":{"first_meaningful_market_data":20},"stages":{"all:backend":{"snapshot_coordinator_queue_wait_ms":3}}},
      {"to_code":"2330","renderer_cache_class":"COLD","load_profile":"HIGH","marks":{},"stages":{}},
    ]}),encoding="utf-8")
    group=aggregate([("before",path)])["groups"][0]
    assert group["metrics"]["selection_to_first_meaningful_market_data_ms"]["p95"]==20
    assert group["missing"]["selection_to_first_meaningful_market_data_ms"]==1
    assert group["metrics"]["snapshot_coordinator_queue_wait_ms"]["samples"]==1


def test_matching_before_after_groups_report_deltas(tmp_path):
    before=tmp_path/"before.json"; after=tmp_path/"after.json"
    before.write_text(json.dumps({"rows":[{"to_code":"2330","renderer_cache_class":"HOT","load_profile":"LOW",
                                          "marks":{"first_meaningful_market_data":20}}]}),encoding="utf-8")
    after.write_text(json.dumps({"rows":[{"to_code":"2330","renderer_cache_class":"HOT","load_profile":"LOW",
                                         "marks":{"first_meaningful_market_data":15}}]}),encoding="utf-8")
    report=aggregate([("before",before),("after",after)])
    delta=report["comparisons"][0]["metrics"]["selection_to_first_meaningful_market_data_ms"]["p95"]
    assert delta=={"before":20.0,"after":15.0,"delta_ms":-5.0,"delta_percent":-25.0}


def test_skip_live_is_warm_unless_renderer_is_hot():
    assert cache_class({"renderer_cache_class":"COLD","stages":{"all:backend":{"hydration_decision":"SKIP_LIVE"}}})=="WARM"
    assert cache_class({"renderer_cache_class":"HOT","stages":{"all:backend":{"hydration_decision":"SKIP_LIVE"}}})=="HOT"


def test_low_high_comparison_is_reported(tmp_path):
    path=tmp_path/"loads.json"
    path.write_text(json.dumps({"rows":[
      {"to_code":"2330","renderer_cache_class":"HOT","load_profile":"LOW","marks":{"first_meaningful_market_data":10}},
      {"to_code":"2330","renderer_cache_class":"HOT","load_profile":"HIGH","marks":{"first_meaningful_market_data":25}},
    ]}),encoding="utf-8")
    report=aggregate([("after",path)])
    assert report["load_comparisons"][0]["metrics"]["selection_to_first_meaningful_market_data_ms"]["p99"]["delta_ms"]==15
