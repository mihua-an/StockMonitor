"""Aggregate renderer selection traces without converting missing stages to zero."""
from __future__ import annotations
import argparse, json, math
from collections import defaultdict
from pathlib import Path
from typing import Any

KPI_MARKS = {
    "selection_to_first_meaningful_market_data_ms":"first_meaningful_market_data",
    "selection_to_summary_visible_ms":"summary_painted",
    "selection_to_orderbook_visible_ms":"orderbook_painted",
    "selection_to_trend_visible_ms":"trend_painted",
    "selection_to_trades_visible_ms":"trades_painted",
    "selection_to_tradeflow_visible_ms":"tradeflow_painted",
    "selection_to_price_volume_visible_ms":"price_volume_painted",
    "selection_to_bootstrap_complete_ms":"full_view_ready",
}
BACKEND_SUFFIXES = ("snapshot_coordinator_queue_wait_ms","view_interests_ms","daemon_http_ms",
                    "hydration_ms","checkpoint_ms","ram_snapshot_ms","snapshot_build_ms",
                    "canonical_payload_encode_ms","renderer_parse_ms","state_apply_ms")

def percentile(values:list[float], q:float):
    values=sorted(values)
    return values[max(0,math.ceil(len(values)*q)-1)] if values else None

def summary(values:list[float])->dict[str,Any]:
    return {"samples":len(values),"p50":percentile(values,.5),"p90":percentile(values,.9),
            "p95":percentile(values,.95),"p99":percentile(values,.99),"max":max(values) if values else None}

def leaves(value:Any,prefix=""):
    if isinstance(value,dict):
        for key,item in value.items(): yield from leaves(item,f"{prefix}.{key}" if prefix else key)
    elif isinstance(value,(int,float)) and not isinstance(value,bool): yield prefix,float(value)

def hydration_decision(row:dict[str,Any])->str:
    for value in (row.get("stages") or {}).values():
        if isinstance(value,dict) and value.get("hydration_decision"): return str(value["hydration_decision"])
    return ""

def cache_class(row:dict[str,Any])->str:
    if str(row.get("renderer_cache_class") or "").upper()=="HOT": return "HOT"
    decision=hydration_decision(row).upper()
    if decision in {"START_NEW","JOIN_EXISTING"}: return "COLD"
    if decision in {"SKIP_READY","SKIP_LIVE"}: return "WARM"
    return str(row.get("renderer_cache_class") or "UNCLASSIFIED").upper()

def load_rows(path:Path)->list[dict[str,Any]]:
    raw=json.loads(path.read_text(encoding="utf-8")); values=raw if isinstance(raw,list) else raw.get("rows") or []
    return [dict(row) for row in values if isinstance(row,dict)]

def aggregate(inputs:list[tuple[str,Path]])->dict[str,Any]:
    groups=defaultdict(list)
    for label,path in inputs:
        for row in load_rows(path): groups[(label,cache_class(row),str(row.get("load_profile") or "UNSPECIFIED"),str(row.get("to_code") or ""))].append(row)
    output=[]
    for (label,cache,profile,symbol),rows in sorted(groups.items()):
        metrics={name:summary([float(row.get("marks",{}).get(mark)) for row in rows if isinstance(row.get("marks",{}).get(mark),(int,float))])
                 for name,mark in KPI_MARKS.items()}
        for suffix in BACKEND_SUFFIXES:
            values=[value for row in rows for key,value in leaves(row.get("stages") or {}) if key.endswith(suffix)]
            metrics[suffix]=summary(values)
        output.append({"label":label,"cache_class":cache,"load_profile":profile,"symbol":symbol,
                       "selections":len(rows),"metrics":metrics,
                       "missing":{name:len(rows)-metric["samples"] for name,metric in metrics.items()}})
    def metric_deltas(before:dict[str,Any],after:dict[str,Any])->dict[str,Any]:
        deltas={}
        for metric,before_summary in before["metrics"].items():
            after_summary=after["metrics"].get(metric) or {}
            quantiles={}
            for quantile in ("p50","p95","p99","max"):
                old,new=before_summary.get(quantile),after_summary.get(quantile)
                quantiles[quantile]={"before":old,"after":new,
                                     "delta_ms":None if old is None or new is None else new-old,
                                     "delta_percent":None if old in (None,0) or new is None else (new-old)/old*100.0}
            deltas[metric]=quantiles
        return deltas

    comparisons=[]
    by_key:dict[tuple[str,str,str],dict[str,dict[str,Any]]]=defaultdict(dict)
    for group in output:
        by_key[(group["cache_class"],group["load_profile"],group["symbol"])][group["label"]]=group
    labels=[]
    for label,_ in inputs:
        if label not in labels: labels.append(label)
    if len(labels)>=2:
        baseline_label=labels[0]
        for after_label in labels[1:]:
            for (cache,profile,symbol),label_groups in sorted(by_key.items()):
                before,after=label_groups.get(baseline_label),label_groups.get(after_label)
                if not before or not after: continue
                comparisons.append({"before_label":baseline_label,"after_label":after_label,
                                    "cache_class":cache,"load_profile":profile,"symbol":symbol,
                                    "metrics":metric_deltas(before,after)})
    load_comparisons=[]
    by_load:dict[tuple[str,str,str],dict[str,dict[str,Any]]]=defaultdict(dict)
    for group in output:
        by_load[(group["label"],group["cache_class"],group["symbol"])][group["load_profile"]]=group
    for (label,cache,symbol),profiles in sorted(by_load.items()):
        baseline=profiles.get("LOW")
        if not baseline: continue
        for profile,group in sorted(profiles.items()):
            if profile=="LOW": continue
            load_comparisons.append({"label":label,"cache_class":cache,"symbol":symbol,
                                     "before_profile":"LOW","after_profile":profile,
                                     "metrics":metric_deltas(baseline,group)})
    return {"contract":"missing stage remains missing; no zero fill",
            "comparison_contract":"first input label is baseline; only matching cache/load/symbol groups are compared",
            "groups":output,"comparisons":comparisons,"load_comparisons":load_comparisons}

def main():
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument("inputs",nargs="+",help="LABEL=trace.json")
    parser.add_argument("--output",type=Path,required=True); args=parser.parse_args()
    inputs=[]
    for item in args.inputs:
        label,sep,path=item.partition("=");
        if not sep: raise SystemExit("each input must be LABEL=path.json")
        inputs.append((label,Path(path)))
    report=aggregate(inputs); args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8"); print(json.dumps(report,ensure_ascii=False,indent=2))
if __name__=="__main__": main()
