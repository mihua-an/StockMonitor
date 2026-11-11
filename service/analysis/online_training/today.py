"""模型中心「今天的狀態」: where today stands for the automatic training, and how much data the next run will use.

Read only from what is on disk (the committed STK partitions' date totals, the session owner's settled notice, the
training state and schedule ledgers) and the clock -- the same facts the job itself decides on (job.py). Nothing here
starts, waits on or predicts a run: Health starts it when the session owner publishes the day materialized
(health/training_job_runner.js), so the only start time known in advance is a failed attempt's retry
(schedule.json `next_due_at`).
"""
from __future__ import annotations

from datetime import date, datetime, time
from pathlib import Path
from typing import Any, Callable
import logging
from service.platform import historical_totals
from service.platform.failure_record import record_failure


_failure_log = logging.getLogger(__name__)

SOURCE = "shioaji"
SESSION_OPEN = time(9, 0)
SESSION_CLOSE = time(13, 30)


def date_data(historical_root: Path, day: str) -> dict[str, Any]:
    """Instruments, events and bytes on disk of one trading date's committed STK partitions: the date's index
    (service/platform/historical_totals.py), which the store's one manager keeps in line with the partitions
    (native/market_runtime/src/historical_totals.rs, run by Rust B). No file: no committed partition."""
    date_dir = Path(historical_root) / f"source={SOURCE}" / "market=STK" / f"trading_date={day}"
    out = {"date": day, "instruments": 0, "events": 0, "bytes": 0}
    try:
        partitions = historical_totals.date_partitions(date_dir)
    except (OSError, historical_totals.TotalsUnreadable) as exc:
        record_failure(_failure_log, f"reading the date index {date_dir / historical_totals.FILE_NAME}", exc)
        return {**out, "error": "TOTALS_UNREADABLE"}
    partitions = partitions or []
    return {**out, "instruments": len({str(p.get("code") or "").upper() for p in partitions}),
            "events": sum(int(p.get("events") or 0) for p in partitions),
            "bytes": sum(int(p.get("bytes") or 0) for p in partitions)}


def training_today(now: datetime, *, schedule: dict[str, Any], window_days: int, state: dict[str, Any], job: dict[str, Any] | None,
                   running: bool, available: list[str], window: tuple[list[str], list[str]], materialized: tuple[bool, str],
                   is_trading: Callable[[date], bool], data_of: Callable[[str], dict[str, Any]]) -> dict[str, Any]:
    """`now` is Taipei time. See the module doc for where each input comes from."""
    today = now.date()
    today_text = today.isoformat()
    trading = bool(is_trading(today))
    trained_today = state.get("last_trained_trading_date") == today_text
    ready, ready_reason = materialized if trading else (False, "")
    # A failed attempt for today is retried at the time the job recorded; nothing else is scheduled ahead.
    retry_at = None
    if schedule.get("trading_date") == today_text and schedule.get("state") == "WAITING" and schedule.get("next_due_at"):
        try:
            retry_at = datetime.fromisoformat(str(schedule["next_due_at"])).astimezone(now.tzinfo)
        except ValueError as exc:
            record_failure(_failure_log, "parsing the training retry time", exc)

    if running:
        phase = "TRAINING"
    elif not trading:
        phase = "HOLIDAY"
    elif trained_today:
        phase = "TRAINED"
    elif now.time() < SESSION_OPEN:
        phase = "BEFORE_OPEN"
    elif now.time() < SESSION_CLOSE:
        phase = "IN_SESSION"
    elif retry_at is not None and ready:
        # Health retries only a day the session owner published materialized (training_job_runner.js), so a due
        # time alone is not a retry.
        phase = "RETRY_WAIT"
    elif not ready:
        phase = "WAITING_SEAL"
    else:
        phase = "WAITING_TRAINING"
    next_run = retry_at if phase == "RETRY_WAIT" else None

    # The next run's dates (job.training_window): the 完整 ones it trains on and the incomplete ones it only tests on.
    trained, test_only = window
    window = sorted([*trained, *test_only])
    per_date = [data_of(day) for day in window]
    return {
        "ok": True,
        "now": now.isoformat(timespec="seconds"),
        "trading_date": today_text,
        "is_trading_day": trading,
        "phase": phase,
        "materialized": bool(ready),
        "materialized_reason": ready_reason,
        "trained_today": trained_today,
        "last_finished_at": (job or {}).get("finished_at") if (job or {}).get("state") == "SUCCEEDED" else (state.get("last_success") or {}).get("finished_at"),
        "next_run_at": next_run.isoformat(timespec="seconds") if next_run else None,
        "seconds_until_next_run": max(0, int((next_run - now).total_seconds())) if next_run else None,
        "window": {
            "trading_days": window_days,
            "dates": window,
            "trained_dates": list(trained),
            "test_only_dates": list(test_only),
            "includes_today": today_text in window,
            "instruments": max((d["instruments"] for d in per_date), default=0),
            "events": sum(d["events"] for d in per_date),
            "bytes": sum(d["bytes"] for d in per_date),
        },
        "today_data": data_of(today_text) if today_text in available else None,
    }
