"""Rust B tells Health `ready` once Market Runtime confirmed its durable subscription (Codex 1022-ST-03).

Health took B's `hello` -- said before B had any connection to A -- as READY, so a B that never reached Market
Runtime was a READY service that received nothing. Its host now waits for `ready` (health/services/
analysis_runtime_host.js); this runs the real A and the real B and checks B says it, after hello.
"""
from __future__ import annotations

import json
import subprocess
import threading
import time

from tests import synthetic_runtime as rt


def test_b_says_ready_after_hello_once_market_runtime_confirmed_its_subscription(tmp_path):
    rt.require_binaries(rt.RUNTIME_EXE, rt.MATERIALIZER_EXE)
    token = tmp_path / "analysis.token"
    token.write_text(rt.ANALYSIS_TOKEN, encoding="utf-8")
    with rt.RuntimeProcess(tmp_path / "a") as market_runtime:
        b = subprocess.Popen([str(rt.MATERIALIZER_EXE), "--runtime-url", market_runtime.url, "--token-file", str(token),
                              "--data-dir", str(tmp_path / "b"), "--events-dir", str(tmp_path / "events")],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        lines: list[dict] = []

        def read() -> None:
            for raw in b.stdout:
                try:
                    lines.append(json.loads(raw))
                except ValueError:
                    continue

        reader = threading.Thread(target=read, daemon=True)
        reader.start()
        try:
            deadline = time.time() + 30
            while time.time() < deadline and not any(line.get("type") == "ready" for line in lines):
                time.sleep(0.05)
            kinds = [line.get("type") for line in lines if line.get("type") in ("hello", "ready")]
            assert kinds[:2] == ["hello", "ready"], kinds
            ready = next(line for line in lines if line.get("type") == "ready")
            hello = next(line for line in lines if line.get("type") == "hello")
            assert ready["instance_id"] == hello["instance_id"] and ready["durable_stream_id"]
            assert kinds.count("ready") == 1
        finally:
            b.stdin.write(b'{"type":"shutdown"}\n')
            b.stdin.flush()
            try:
                b.wait(timeout=15)
            except subprocess.TimeoutExpired:
                b.kill()
                b.wait(timeout=5)
