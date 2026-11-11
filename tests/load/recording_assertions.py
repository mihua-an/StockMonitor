"""Read-only semantic validation of this load run's independent temporary storage."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3


def validate_recorded_trades(directory, source, accepted_sequences):
    directory = Path(directory).resolve()
    allowed = Path(os.environ["STOCK_MONITOR_CHECK_RUN"]).resolve()
    assert directory.is_relative_to(allowed), "Only isolated load output may be read"
    expected = set(accepted_sequences)
    assert len(expected) == len(accepted_sequences), "Duplicate admission sequence"
    trades = {}
    if source == "futu":
        with sqlite3.connect(f"file:{(directory / 'market.db').as_posix()}?mode=ro", uri=True) as db:
            payloads = [json.loads(row[0]) for row in db.execute("SELECT payload_json FROM trade_tick")]
            daily = db.execute("SELECT code,sample_count,outside_volume FROM trade_side_daily").fetchall()
        for code, count, volume in daily:
            selected = [row for row in payloads if row["code"] == code]
            assert count == len(selected) and volume == sum(row["volume"] for row in selected)
        assert {row[0] for row in daily} == {row["code"] for row in payloads}
    else:
        checkpoint = directory / "journal" / "canonical_checkpoints.sqlite3"
        with sqlite3.connect(f"file:{checkpoint.as_posix()}?mode=ro", uri=True) as db:
            events = [json.loads(row[0]) for row in db.execute(
                "SELECT payload_json FROM canonical_checkpoint WHERE channel='trades'"
            )]
        payloads = [event["payload"]["trade"] for event in events if event.get("delta_type") == "trade.frame"]
        # Canonical checkpoint intentionally stores only the latest state per
        # stream/channel; Raw storage, not this warm-start checkpoint, owns history.
        latest_by_code = {}
        for sequence in accepted_sequences:
            latest_by_code[str(2330 + sequence % 12)] = sequence
        expected = set(latest_by_code.values())
    for trade in payloads:
        sequence = trade["sequence"]
        assert sequence not in trades, "Duplicate durable trade"
        stamp = f"2026-09-04 09:30:{sequence % 60:02d}.{sequence:03d}"
        row = dict(code="US.TEST" + str(sequence % 12) if source == "futu" else str(2330 + sequence % 12),
                   time=stamp, datetime=stamp, price=100 + sequence / 1000, volume=sequence % 3,
                   sequence=sequence, ticker_sequence=sequence, ticker_direction="BUY")
        if source == "shioaji":
            # This fixture has no quote-side classifier; the canonical row
            # normalizes subsecond time and keeps the original exchange time.
            row.update(datetime=stamp + "000", timestamp=stamp + "000", exchange_time=stamp,
                       current=row["price"], trade_side="UNKNOWN")
        assert trade == row, f"Durable payload differs from offered fixture: {source}:{sequence}"
        trades[sequence] = trade
    assert set(trades) == expected, "Expected durable sequence set differs"
    return {"admitted_sequence_set_equal": True, "full_payloads_checked": len(trades),
            "admitted_sequences": sorted(expected),
            "payload_sha256": hashlib.sha256(json.dumps(trades, sort_keys=True).encode()).hexdigest()}
