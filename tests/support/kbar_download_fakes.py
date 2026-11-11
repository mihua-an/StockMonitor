"""A Shioaji API whose usage() answers from a list, and a repository that returns minute bars for any range."""
from __future__ import annotations

import json

import pandas as pd



class FakeAPI:
    def __init__(self, usages):
        self.usages = list(usages)
        self.usage_calls = 0

    def usage(self):
        self.usage_calls += 1
        value = self.usages[min(self.usage_calls - 1, len(self.usages) - 1)]
        if isinstance(value, Exception):
            raise value
        return value


class FakeRepository:
    def __init__(self, tmp_path, api, rows=2):
        self.api = api
        self.rows = rows
        self.calls = []

    def fetch_broker_kbars_for_download(self, code, start, end):
        self.calls.append((code, start, end))
        stamp = pd.date_range(f"{start} 09:00", periods=self.rows, freq="min")
        return pd.DataFrame({
            "datetime": stamp,
            "open": [10.0 + i for i in range(self.rows)],
            "high": [11.0 + i for i in range(self.rows)],
            "low": [9.0 + i for i in range(self.rows)],
            "close": [10.5 + i for i in range(self.rows)],
            "volume": [100] * self.rows,
            "amount": [1000] * self.rows,
        })


def store_import(root, payload):
    """Rust B's --import-kbars, standing in where a test is about the job: each date at 1 minute in the store's file.
    The daily bar is Rust B's to fold from the minutes (kbar_store.rs `daily_of`), so the stand-in writes none."""
    path = root / "source=shioaji" / "market=STK" / f"{payload['code']}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    held = json.loads(path.read_bytes())["sessions"]["DAY"] if path.exists() else {"daily": {}, "intraday": {}}
    for day in payload["days"]:
        assert set(day) == {"date", "minutes"}, day
        held["intraday"][day["date"]] = {"timeframe": 1, "bars": day["minutes"]}
    path.write_text(json.dumps({"schema": "kbar-code-v1", "sessions": {"DAY": held}}), encoding="utf-8")
    return {"ok": True, "imported": len(payload["days"]), "held": 0}
