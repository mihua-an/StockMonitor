"""歷史回放 minute series and re-sent prints.

- The materialized minute store started at 09:28 for 00403A while its ticks started at 09:02:55: at a
  09:22 cursor the chart had no line. The replay builds its minutes from the ticks it replays.
- The broker's re-sent 14:30 print (same cumulative total) was stored twice before ingest dropped it.
"""
from __future__ import annotations




def tick(time, price, volume, total, seq, simtrade=False):
    return {"time": time, "datetime": f"2026-09-30T{time}", "price": price, "volume": volume,
            "total_volume": total, "ingest_sequence": seq, "simtrade": simtrade}


def test_the_replay_session_is_the_materialized_artifact_and_starts_no_b():
    # Flow, large orders and 逐價內外盤 come from Market Runtime's replay (A feeds B); the REST session
    # serves the materialized artifact only and never launches analysis_runtime.
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    service = (root / "service" / "market" / "history" / "history_replay_service.py").read_text(encoding="utf-8")
    assert "analysis_replay" not in service and "subprocess" not in service
    assert not (root / "service" / "market" / "history" / "analysis_replay.py").exists()
    assert "/v1/history/price-volume" not in (root / "backend" / "shioaji" / "routes" / "history_routes.py").read_text(encoding="utf-8")

