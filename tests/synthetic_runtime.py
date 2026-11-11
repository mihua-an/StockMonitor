"""Synthetic (no broker) harness around the REAL Market Runtime and Materializer binaries.

- ``RuntimeProcess``: starts market_runtime_daemon (``RUNTIME_EXE``) on a free
  loopback port with a temp WAL directory. Events are sent through the production
  ``RustDaemonEventSink`` so the WAL contains exactly what Runtime writes for production events.
- ``run_materializer_job``: performs what Health's job runner does for one pending request
  (spawns the real materialization job -- analysis_runtime --materialize -- with the request's arguments and writes
  done/<job_id>.json in the runner's result shape).
"""
from __future__ import annotations

import json
import socket
import subprocess
import threading
import time
from pathlib import Path
from types import SimpleNamespace

from service.market.shared.partition_evidence import default_evidence_root

from service.platform.native_binaries import (
    ANALYSIS_RUNTIME_RELEASE_ENV,
    MARKET_RUNTIME_RELEASE_ENV,
    analysis_runtime_binary,
    market_runtime_binary,
)

# The Rust binaries come from the services' own resolver (STOCK_MONITOR_A_RELEASE / STOCK_MONITOR_B_RELEASE name
# a build elsewhere), so a test runs the executable the service under test would run.
# tests/support/native_binaries.cjs is the Node side, same rule.
RUNTIME_EXE = market_runtime_binary()
# The materialization job is Rust B in its --materialize mode.
MATERIALIZER_EXE = analysis_runtime_binary()
TOKEN = "synthetic-token-0123456789"  # provider:shioaji
# One credential per role (docs/system-architecture/01: the role comes from the credential, never from the client).
ROLE_TOKENS = {
    "provider:shioaji": TOKEN,
    "provider:futu": "synthetic-futu-token-0123456789",
    "viewer": "synthetic-viewer-token-0123456789",
    "analysis_runtime": "synthetic-analysis-token-0123456789",
    "signal_producer": "synthetic-signal-token-0123456789",
    "controller": "synthetic-controller-token-0123456789",
}
FUTU_TOKEN = ROLE_TOKENS["provider:futu"]
VIEWER_TOKEN = ROLE_TOKENS["viewer"]
ANALYSIS_TOKEN = ROLE_TOKENS["analysis_runtime"]
SIGNAL_TOKEN = ROLE_TOKENS["signal_producer"]
CONTROLLER_TOKEN = ROLE_TOKENS["controller"]


def write_credentials(path: Path) -> Path:
    import hashlib

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"schema": "market-runtime-credentials-v1",
                                "roles": {role: hashlib.sha256(token.encode()).hexdigest() for role, token in ROLE_TOKENS.items()}}),
                    encoding="utf-8")
    return path


def require_binaries(*binaries: Path) -> None:
    """Fail (never skip) when a binary is missing: a test that could not run is not a pass."""
    for binary in binaries or (RUNTIME_EXE, MATERIALIZER_EXE):
        if not binary.exists():
            crate = "market_runtime" if binary == RUNTIME_EXE else "analysis_runtime"
            env = MARKET_RUNTIME_RELEASE_ENV if binary == RUNTIME_EXE else ANALYSIS_RUNTIME_RELEASE_ENV
            raise FileNotFoundError(f"{binary} not found: build it with `cargo build --release` in native/{crate}, "
                                    f"or set {env} to <CARGO_TARGET_DIR>\\release")


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class RuntimeProcess:
    """Market Runtime on a free loopback port, entered once it says ``ready``.

    A listens before it recovers its WAL and, while recovering, answers ``health`` only and closes every other
    connection once recovery ends; ``ready`` (stdout) is printed after recovery, so a reachable port is not a
    serving runtime.
    """

    def __init__(self, data_dir: Path, *extra_args: str) -> None:
        self.data_dir = Path(data_dir)
        self.port = free_port()
        self.extra_args = list(extra_args)
        self.proc: subprocess.Popen | None = None
        self.stdout_lines: list[dict] = []
        self._ready = threading.Event()

    @property
    def url(self) -> str:
        return f"ws://127.0.0.1:{self.port}/live"

    ready_timeout = 10.0

    def command(self) -> list[str]:
        return [str(RUNTIME_EXE), "--port", str(self.port), "--data-dir", str(self.data_dir),
                "--credentials", str(write_credentials(self.data_dir.parent / f"{self.data_dir.name}-credentials.json")),
                # Fixtures replay fixed historical dates: the wall-clock session rollover would drop them as rolled over.
                "--rollover", "off",
                # Where A writes the session evidence the owners read (the test's own root, tests/conftest.py).
                "--evidence-root", str(default_evidence_root()), *self.extra_args]

    def __enter__(self) -> "RuntimeProcess":
        # __exit__ never runs when __enter__ raises, so every failure after Popen stops the daemon here; a daemon
        # left running would hold the port and lock the Rust exe.
        self.stderr_path = self.data_dir.parent / f"{self.data_dir.name}-stderr.log"
        self.stderr_path.parent.mkdir(parents=True, exist_ok=True)
        self._stderr = self.stderr_path.open("wb")
        try:
            self.proc = subprocess.Popen(self.command(), stdout=subprocess.PIPE, stderr=self._stderr)
            # Drained for the whole run so A never blocks on a full stdout pipe.
            threading.Thread(target=self._read_stdout, name="market-runtime-stdout", daemon=True).start()
            self._wait_ready(self.ready_timeout)
        except BaseException:
            self.stop()
            raise
        return self

    def _read_stdout(self) -> None:
        # A's stdout is JSON lines only (listening, ready, stopped).
        for raw in self.proc.stdout:
            line = json.loads(raw)
            self.stdout_lines.append(line)
            if line.get("type") == "ready":
                self._ready.set()

    def _wait_ready(self, timeout: float) -> None:
        deadline = time.time() + timeout
        while not self._ready.wait(0.05):
            code = self.proc.poll()
            if code is not None:
                raise RuntimeError(f"market_runtime_daemon exited with {code} before ready: {self.stderr_tail()}")
            if time.time() >= deadline:
                raise RuntimeError(f"market_runtime_daemon did not listen and say ready on {self.port} within {timeout}s "
                                   f"(stdout {self.stdout_lines}): {self.stderr_tail()}")

    def stderr_tail(self, limit: int = 4000) -> str:
        self._stderr.flush()
        data = self.stderr_path.read_bytes()
        return data[-limit:].decode("utf-8", errors="replace")

    def stop(self) -> None:
        """Terminate, wait bounded, kill if needed, and wait again so the exe is unlocked when this returns."""
        if self.proc is not None and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)
        self._stderr.close()

    def __exit__(self, *exc) -> None:
        self.stop()


def wait_acked(sink, expected: int, timeout: float = 10.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        stats = sink.stats()
        if stats["acked"] + stats["rejected"] >= expected and stats["queue_depth"] == 0:
            return stats
        time.sleep(0.02)
    raise AssertionError(f"sink did not drain: {sink.stats()}")


def run_materializer_job(pending_file: Path, wal_dir: Path, out_dir: Path, jobs_root: Path) -> dict:
    """Health's job-runner behaviour for one request file."""
    request = json.loads(pending_file.read_text(encoding="utf-8"))
    proc = subprocess.run(
        [str(MATERIALIZER_EXE), "--materialize", "--data-dir", str(wal_dir), "--out-dir", str(out_dir),
         "--source", request["source"], "--market", request["market"], "--code", request["code"],
         "--logical-code", request.get("logical_code") or request["code"],
         "--trading-date", request["trading_date"], "--session", request["session"],
         "--completeness", request["completeness"]],
        capture_output=True, text=True, timeout=60,
    )
    result = json.loads(proc.stdout.strip().splitlines()[-1])
    (jobs_root / "done").mkdir(parents=True, exist_ok=True)
    (jobs_root / "done" / f"{request['job_id']}.json").write_text(json.dumps({"schema": "materialization-job-result-v1", "job_id": request["job_id"], "request": request, **result}))
    pending_file.unlink()
    return result


def run_all_pending(jobs_root: Path, wal_dir: Path, out_dir: Path) -> list[dict]:
    return [run_materializer_job(path, wal_dir, out_dir, jobs_root)
            for path in sorted((jobs_root / "pending").glob("*.json"))]


def shioaji_owner(sink):
    """Owner stub exposing what ShioajiThinCallbackAdapter reads, using the real static helpers and the real
    delivery record (every delivered event is observed there before the owner is told of it)."""
    from service.market.shared.provider_contract import LaneDeliveryEvidence
    from service.market.shioaji.session import ShioajiBrokerService as Real

    owner = SimpleNamespace(
        event_sink=sink, price_scale=10_000, _session_generation=1, TXF_CODE="TXFR1", TAIEX_CODE="TAIEX",
        _price_scale_errors=0, _callback_errors=0, _last_callback_error="",
        _value=Real._value, _number=Real._number, _int_value=Real._int_value,
        delivery_evidence=LaneDeliveryEvidence(), note_market_event=lambda security_type: None,
        _lock=threading.Lock(), _reference_stream_seq={},
        # The refused-reference recovery is the broker's; this stub only reports whether the sink admitted it.
        _reference_admitted=lambda admitted, identity, detail: admitted is True,
    )
    return owner
