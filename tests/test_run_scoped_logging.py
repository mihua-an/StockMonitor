"""Per-run log session, broker API-call log and dataflow interval log.

The rules these encode:
  * every App run gets its own ``var/logs/<startup_timestamp>/`` and never overwrites an earlier
    one (the error log used to be a single file every run appended to);
  * an operation is one API-log line, not one per symbol -- a full subscription sync moves ~80
    lanes and used to produce no record at all;
  * broker *pushes* are never API-log entries;
  * credentials can never reach a log file;
  * an idle interval writes no dataflow line at all (per-event logging previously grew a daemon
    log to 201 MB).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from service.platform import log_session
from service.platform.api_call_log import (
    SYMBOL_SAMPLE_LIMIT, SensitiveApiLogField, api_call, record_api_call,
)
from service.platform.dataflow_log import DataFlowIntervalLogger, dataflow_log_path
from service.platform.log_session import (
    LOG_SESSION_ENV, SESSION_PATTERN, log_session_dir, log_session_id, log_session_path,
    new_log_session_id,
)

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def run_session(monkeypatch, tmp_path):
    """A fresh run id per test so nothing lands in the developer's real var/logs."""
    monkeypatch.setattr(log_session, "log_root", lambda: tmp_path / "logs")
    monkeypatch.setenv(LOG_SESSION_ENV, new_log_session_id())
    return tmp_path / "logs"


# --- run session -------------------------------------------------------------------------------
def test_run_id_is_stamped_unique_and_inherited(run_session, monkeypatch):
    first = log_session_id()
    assert SESSION_PATTERN.match(first)
    assert log_session_id() == first, "the id must be stable for the life of a process"

    monkeypatch.delenv(LOG_SESSION_ENV, raising=False)
    minted = log_session_id()
    assert minted != first
    assert os.environ[LOG_SESSION_ENV] == minted, "must be exported so child processes inherit it"


def test_a_malformed_run_id_is_refused_not_replaced(run_session, monkeypatch):
    # A child that minted its own id would put this run's logs in a second directory; Node refuses the same value.
    monkeypatch.setenv(LOG_SESSION_ENV, "2026-10-21 run")
    with pytest.raises(ValueError, match=LOG_SESSION_ENV):
        log_session_id()
    script = ("const {logSessionId}=require('./service/platform/js/log_session.js');"
              "try{logSessionId({STOCK_MONITOR_LOG_SESSION:'2026-10-21 run'});process.stdout.write('minted')}"
              "catch(e){process.stdout.write(e.message)}")
    out = subprocess.run(["node", "-e", script], cwd=Path(__file__).resolve().parents[1], capture_output=True,
                         text=True, encoding="utf-8", timeout=30)
    assert LOG_SESSION_ENV in out.stdout and "not a run id" in out.stdout


def test_two_runs_never_share_a_directory(run_session, monkeypatch):
    log_session_path("error.log").write_text("first run\n", encoding="utf-8")
    first = log_session_dir()
    monkeypatch.setenv(LOG_SESSION_ENV, new_log_session_id())
    second = log_session_dir()
    assert second != first
    assert first.joinpath("error.log").read_text(encoding="utf-8") == "first run\n"


@pytest.mark.parametrize("name", ["", ".hidden", "a/b", "a\\b"])
def test_a_log_file_can_never_escape_its_run_directory(run_session, name):
    with pytest.raises(ValueError):
        log_session_path(name)


# --- API call log ------------------------------------------------------------------------------
def _rows(source: str) -> list[dict]:
    path = log_session_path(f"api-{source}.log")
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def test_a_batch_subscribe_is_one_record_with_a_bounded_symbol_sample(run_session):
    codes = [f"LOADTW{index:03d}" for index in range(1, 81)]
    record_api_call("shioaji", "subscribe", reason="full_subscription_sync", market="STK",
                    symbols=codes, duration_ms=12.5, ok=True)

    rows = _rows("shioaji")
    assert len(rows) == 1, "80 symbols must not become 80 lines"
    row = rows[0]
    assert row["operation"] == "subscribe" and row["reason"] == "full_subscription_sync"
    assert row["symbol_count"] == 80
    assert len(row["symbols"]) == SYMBOL_SAMPLE_LIMIT
    assert row["symbols_truncated"] == 80 - SYMBOL_SAMPLE_LIMIT
    for field in ("at", "source", "market", "duration_ms", "ok", "pid"):
        assert field in row


def test_a_failed_call_records_its_error_type_and_reraises(run_session):
    class Boom(RuntimeError):
        code = "E_QUOTA"

    with pytest.raises(Boom):
        with api_call("futu", "subscribe", reason="subscription_sync", symbols=["US.AAPL"]):
            raise Boom("quota exceeded")

    row = _rows("futu")[-1]
    assert row["ok"] is False and row["error_type"] == "Boom" and row["error_code"] == "E_QUOTA"
    assert row["duration_ms"] is not None


def test_credentials_can_never_reach_an_api_log(run_session):
    for field in ("token", "api_key", "secret_key", "ca_passwd", "account_id"):
        with pytest.raises(SensitiveApiLogField):
            record_api_call("shioaji", "login", reason="broker_session_start", detail={field: "x"})
    assert _rows("shioaji") == [], "a refused record must not be written at all"


def test_nested_credentials_are_refused_or_redacted(run_session):
    """The guard looked at top-level keys only."""
    for detail in ({"meta": {"token": "x"}}, {"rows": [{"api_key": "x"}]}, {"a": {"b": {"c": {"secret": "x"}}}}):
        with pytest.raises(SensitiveApiLogField):
            record_api_call("shioaji", "login", reason="broker_session_start", detail=detail)
    assert _rows("shioaji") == [], "a refused record must not be written at all"
    # A credential inside a VALUE (runtime data: an SDK error, a URL) is redacted and the record still written.
    record_api_call("futu", "subscribe", reason="subscription_sync", detail={
        "url": "https://example.invalid/exec?action=x&token=LEAKME", "last_error": "Authorization: Bearer LEAKME",
        "nested": [{"note": "password=LEAKME"}], "failed_count": 2, "plain": "quota exceeded"})
    row = _rows("futu")[-1]
    assert "LEAKME" not in json.dumps(row)
    assert row["failed_count"] == 2 and row["plain"] == "quota exceeded"
    assert row["url"].startswith("[REDACTED") and row["nested"][0]["note"].startswith("[REDACTED")


def test_only_known_sources_have_an_api_log(run_session):
    record_api_call("nasdaq", "subscribe", reason="typo")          # swallowed, never crashes a call
    assert not list(run_session.rglob("api-nasdaq.log"))


def test_broker_pushes_are_not_api_calls():
    """The callback adapters must not reach for the API log: a quote push is not a request."""
    for module in ("service/market/shioaji/callback.py", "service/market/futu/callback.py"):
        source = (ROOT / module).read_text(encoding="utf-8")
        assert "api_call_log" not in source, f"{module} must never write per-push API log records"


# --- dataflow interval log ---------------------------------------------------------------------
def test_an_idle_interval_writes_nothing(run_session):
    logger = DataFlowIntervalLogger("market_daemon", lambda: {"stages": {"callback_received|stk.tick": {"observed": 7}}})
    assert logger.sample_once() is not None, "the first interval establishes the baseline"
    assert logger.sample_once() is None, "nothing moved: an idle market must not write a line"
    assert not dataflow_log_path("market_daemon").exists()


def test_a_moving_interval_records_counts_and_rates(run_session):
    counts = {"observed": 0}

    def snapshot():
        counts["observed"] += 500
        return {"stages": {
            "callback_received|stk.tick": {"observed": counts["observed"]},
            "market_runtime_acked|trade": {"observed": counts["observed"] - 5},
        }}

    logger = DataFlowIntervalLogger("market_daemon", snapshot, extra_provider=lambda: {"dropped": 2})
    logger.sample_once()
    row = logger.sample_once()
    assert row["events"]["callback_received"] == 500
    assert row["events"]["market_runtime_acked"] == 500
    assert row["rates_per_s"]["callback_received"] > 0
    assert row["dropped"] == 2 and row["component"] == "market_daemon"


def test_an_anomaly_is_logged_even_when_nothing_moved(run_session):
    logger = DataFlowIntervalLogger("futu_daemon", lambda: {"stages": {}}, extra_provider=lambda: {"sequence_gaps": 1})
    logger.sample_once()
    assert logger.sample_once() is not None, "a gap with no traffic is exactly what must be visible"


# --- cross-language agreement -------------------------------------------------------------------
def test_node_and_python_resolve_the_same_run_directory(tmp_path):
    """service/platform/js/log_session.js and service/platform/log_session.py must agree, or a run's
    Electron/Health logs and its Python daemon logs end up in two different places."""
    env = {**os.environ, "STOCK_MONITOR_VAR_ROOT": str(tmp_path / "var"),
           "STOCK_MONITOR_LOG_SESSION": new_log_session_id(),
           "STOCK_MONITOR_AUTH_ROOT": str(tmp_path / "auth")}
    node = subprocess.run(
        ["node", "-e", "const s=require('./service/platform/js/log_session.js');process.stdout.write(s.logSessionDir())"],
        cwd=ROOT, env=env, capture_output=True, text=True,
    )
    assert node.returncode == 0, node.stderr
    python = subprocess.run(
        [sys.executable, "-c",
         "from service.platform.log_session import log_session_dir; print(log_session_dir(), end='')"],
        cwd=ROOT, env=env, capture_output=True, text=True,
    )
    assert python.returncode == 0, python.stderr
    assert Path(node.stdout) == Path(python.stdout)
