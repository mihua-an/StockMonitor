"""Fill the gaps of closed Shioaji sessions from the broker's history by hand (service/market/history/history_fill.py;
the session owner does the same automatically after each materialization, materialization_ledger.py).

Run with the App up (the provider holds the broker login): the windows are fetched through the provider's
``/v1/history/fill-gaps``, the session is folded again with ``analysis_runtime --materialize --input store``.
``--dry-run`` writes the fills and stops. An IDX date whose indexes have no partition (history_fill.expected_codes) is
fetched whole and its partitions built from the fills.
Usage: python scripts/fill_history_gaps.py --market STK --session DAY --date 2026-11-06 [--date ...] [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from config.network_settings import base_url  # noqa: E402
from service.market.history import history_fill  # noqa: E402
from service.platform.daemon_auth import authorization_headers  # noqa: E402
from service.platform.native_binaries import analysis_runtime_job_binary  # noqa: E402


def fetch(items: list[dict]) -> list[dict]:
    request = urllib.request.Request(f"{base_url('provider_shioaji')}/v1/history/fill-gaps", method="POST",
                                     data=json.dumps({"items": items}).encode("utf-8"),
                                     headers={**authorization_headers(), "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=1800) as response:
        return list(json.load(response).get("results") or [])


def run(args: argparse.Namespace, date: str) -> dict:
    market, session = args.market.upper(), args.session.upper()
    binary = analysis_runtime_job_binary()
    work = Path(args.work_dir) / f"{date}_{market}_{session}"
    expected = history_fill.expected_codes(args.historical_root, market, date, session)
    summary = history_fill.prepare(fetch, binary, args.historical_root, market, date, session, work, expected)
    (work / "fetch_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    if args.dry_run:
        return summary
    data = REPO / "var" / "data"
    command = [str(binary), "--materialize", "--input", "store", "--out-dir", args.historical_root, "--source", "shioaji",
               "--market", market, "--code", "*", "--trading-date", date, "--session", session, "--fills-dir", str(work),
               "--rollover-cutoffs", str(data / "live-engine" / "rollover_cutoffs.json"), "--traded-codes-dir", str(data / "accounts" / "traded_codes"),
               "--retention-config-root", str(REPO / "var" / "config"), "--daily-summary-dir", args.daily_summary_dir,
               "--volume-baseline-root", str(data / "market"), "--voided-events", str(data / "live-engine" / "voided_events.json")]
    if summary["unresolved"]:
        command += ["--unresolved-codes", ",".join(sorted(summary["unresolved"]))]
    out = subprocess.run(command, capture_output=True, text=True, encoding="utf-8")
    result = json.loads(out.stdout.strip().splitlines()[-1]) if out.stdout.strip() else {"ok": False, "error": out.stderr[-500:]}
    codes = result.get("codes") or []
    summary["materialized"] = {"ok": result.get("ok"), "error": result.get("error"),
                               "by_completeness": {k: sorted(c["code"] for c in codes if c["completeness"] == k)
                                                   for k in ("repaired", "complete", "gap_detected")}}
    (work / "result.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--market", required=True)
    parser.add_argument("--session", required=True)
    parser.add_argument("--date", action="append", required=True)
    parser.add_argument("--historical-root", required=True)
    parser.add_argument("--daily-summary-dir", required=True)
    parser.add_argument("--work-dir", default=str(REPO / "var" / "history_fill"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    for date in args.date:
        summary = run(args, date)
        brief = {k: v for k, v in summary.items() if k != "unresolved"}
        brief["unresolved_codes"] = sorted(summary.get("unresolved") or {})
        print(json.dumps(brief, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
