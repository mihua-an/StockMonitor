"""Every registered remediation mechanism has an emission point and an owner; nothing emits
an unregistered one; the Python emitter speaks the same pipe protocol as Health's ledger (proved against the real
Node writer); and the ingest sink's lost connections map onto registered trigger reasons."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from service.platform import remediation

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = json.loads((ROOT / "config" / "remediation_registry.json").read_text(encoding="utf-8"))
SOURCE_DIRS = ("api", "backend", "config", "health", "native", "scripts", "service", "ui")
SOURCE_SUFFIXES = {".py", ".js", ".mjs", ".cjs", ".rs"}


def _source_files():
    for top in SOURCE_DIRS:
        for path in (ROOT / top).rglob("*"):
            parts = set(path.parts)
            # A crate's tests/ directory holds tests, not emission points; scripts/qa only reads the ledger it checks.
            if path.suffix in SOURCE_SUFFIXES and not parts & {"node_modules", "target", "dist", "__pycache__", "tests", "qa"}:
                yield path


def test_every_mechanism_has_an_owner_and_its_emission_points_name_it():
    for mechanism_id, spec in REGISTRY["mechanisms"].items():
        assert spec["owner"], mechanism_id
        assert spec["trigger_reasons"], mechanism_id
        assert spec["emission"], f"{mechanism_id} has no emission point"
        texts = []
        for rel in spec["emission"]:
            path = ROOT / rel
            assert path.is_file(), f"{mechanism_id}: emission file {rel} does not exist"
            text = path.read_text(encoding="utf-8")
            assert f'"{mechanism_id}"' in text, f"{mechanism_id} is not emitted from {rel}"
            texts.append(text)
        # A trigger may be decided by a part the emission point passes it on from (a facade and its writer).
        for rel in spec.get("trigger_sources", []):
            path = ROOT / rel
            assert path.is_file(), f"{mechanism_id}: trigger source {rel} does not exist"
            texts.append(path.read_text(encoding="utf-8"))
        for reason in spec["trigger_reasons"]:
            assert any(f'"{reason}"' in text for text in texts), f"{mechanism_id}: trigger {reason} is never emitted"


def test_no_source_file_emits_a_mechanism_outside_its_registered_emission_points():
    owners = {mechanism_id: {ROOT / rel for rel in spec["emission"]} for mechanism_id, spec in REGISTRY["mechanisms"].items()}
    # Keyword forms (JS mechanismId:, Python mechanism_id=, Rust mechanism_id:) and Rust's positional begin(component, id, ...).
    pattern = re.compile(r"mechanism(?:_id|Id)\s*[:=]\s*\"([a-z_]+\.[a-z_]+)\"|remediation::begin\(\"[a-z_]+\",\s*\"([a-z_]+\.[a-z_]+)\"")
    for path in _source_files():
        text = path.read_text(encoding="utf-8", errors="replace")
        if path.suffix == ".rs":
            text = text.split("#[cfg(test)]", 1)[0]   # a crate's unit tests are not emission points
        for mechanism_id, files in owners.items():
            if f'"{mechanism_id}"' in text and path not in files and path.name != "remediation_registry.json":
                raise AssertionError(f"{path.relative_to(ROOT)} names {mechanism_id} but is not one of its emission points")
        for match in pattern.finditer(text):
            used = match.group(1) or match.group(2)
            assert used in REGISTRY["mechanisms"], f"{path.relative_to(ROOT)} emits unregistered mechanism {used}"


def test_the_renderer_identity_fields_mirror_the_registry():
    text = (ROOT / "ui" / "renderer" / "js" / "core" / "remediation.js").read_text(encoding="utf-8")
    fields = re.search(r"IDENTITY_FIELDS = Object\.freeze\(\[(.*?)\]\)", text).group(1)
    assert re.findall(r'"([a-z_]+)"', fields) == REGISTRY["identity_fields"]


def test_python_events_carry_the_full_contract_shape():
    emitter = remediation.RemediationEmitter(service_id="provider_futu", pipe_path="")
    operation = emitter.begin(component="rust_event_sink", mechanism_id="provider.ingest_reconnect",
                              trigger_reason="connect_failed", identity={"source": "futu"},
                              detail={"pending": 3, "api_token": "never", "error": "x" * 2000})
    result = operation.finish("succeeded", attempt=2)
    again = operation.finish("failed", attempt=3)
    assert again is result
    started = operation.started_event
    assert list(started["identity"]) == REGISTRY["identity_fields"]
    assert started["identity"]["source"] == "futu" and started["identity"]["code"] is None
    assert "api_token" not in started["detail"]
    assert len(started["detail"]["error"]) <= REGISTRY["limits"]["string_chars"]
    assert started["outcome"] == "started" and started["attempt"] == 0 and started["operation_id"]
    assert result["related_upstream_event_id"] == started["event_id"]
    assert result["operation_id"] == started["operation_id"]
    assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$", started["at"])
    status = emitter.status()
    assert status["configured"] is False and status["unreported_loss"] == 2


def test_ingest_sink_lost_connections_map_onto_registered_triggers():
    from service.market.shared.rust_live import RustDaemonEventSink

    allowed = set(REGISTRY["mechanisms"]["provider.ingest_reconnect"]["trigger_reasons"])
    cases = [
        (OSError("refused"), False, "connect_failed"),
        (RuntimeError("market_runtime refused ingest: bad role"), True, "ingest_refused"),
        (TimeoutError("timed out"), True, "ack_timeout"),
        (ValueError("Expecting value"), True, "protocol_error"),
        (ConnectionResetError("reset"), True, "send_failed"),
    ]
    for exc, opened, expected in cases:
        reason = RustDaemonEventSink._transport_trigger(exc, opened)
        assert reason == expected and reason in allowed


_LEDGER_SCRIPT = r"""
const path = require("path");
const { RemediationLedger } = require(process.argv[2]);
const root = process.argv[3];
const ledger = new RemediationLedger({ logsRoot: path.join(root, "logs"), sessionDir: path.join(root, "logs", "20261009_090000-abcdef"),
  summaryDir: path.join(root, "summaries"), pipePath: process.argv[4], logger: { log() {}, warn() {}, error() {} },
  writer: { service_id: "service_controller", instance_id: "health-test", pid: process.pid } });
ledger.start().then((ok) => {
  process.stdout.write(`READY ${ledger.stats.listening}\n`);
  process.stdin.on("data", async () => {
    await ledger.close("test");
    process.stdout.write(JSON.stringify(ledger.stats) + "\n");
    process.exit(0);
  });
});
"""


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not on PATH")
def test_python_emitter_delivers_to_the_real_health_ledger(tmp_path):
    pipe = (rf"\\.\pipe\stock-monitor-remediation-pytest-{os.getpid()}" if os.name == "nt"
            else str(tmp_path / "ledger.sock"))
    script = tmp_path / "ledger.cjs"
    script.write_text(_LEDGER_SCRIPT, encoding="utf-8")
    node = subprocess.Popen(["node", str(script), str(ROOT / "health" / "remediation" / "ledger.js"), str(tmp_path), pipe],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    try:
        assert node.stdout.readline().strip() == "READY true"
        emitter = remediation.RemediationEmitter(service_id="provider_shioaji", pipe_path=pipe)
        operation = emitter.begin(component="rust_event_sink", mechanism_id="provider.ingest_reconnect",
                                  trigger_reason="ack_timeout", identity={"source": "shioaji"}, detail={"pending": 2})
        operation.finish("succeeded", attempt=1, detail={"pending_resent": 2})
        assert operation.durable(10.0), "start and terminal acknowledged once the ledger fsync'd them (CX-159)"
        emitter.emit(component="rust_event_sink", mechanism_id="not.registered", trigger_reason="x", outcome="failed")
        assert emitter.flush(10.0), emitter.status()
        node.stdin.write("close\n")
        node.stdin.flush()
        stats = json.loads(node.stdout.readline())
        assert stats["accepted"] == 2 and stats["rejected"] == 1
        files = sorted((tmp_path / "logs" / "20261009_090000-abcdef").glob("remediation-*.jsonl"))
        records = [json.loads(line) for f in files for line in f.read_text(encoding="utf-8").splitlines() if line]
        events = [r for r in records if r.get("schema") == REGISTRY["event_schema"]]
        assert [e["outcome"] for e in events] == ["started", "succeeded"]
        assert events[0]["process"]["service_id"] == "provider_shioaji" and events[0]["process"]["runtime"] == "python"
        assert events[1]["related_upstream_event_id"] == events[0]["event_id"]
        assert records[-1]["kind"] == "terminal"
    finally:
        if node.poll() is None:
            node.kill()
        node.wait(timeout=10)


def test_an_operation_without_a_ledger_is_never_durable():
    """Queued in memory is not recorded; with no ledger to acknowledge it, nothing may act as if it were."""
    operation = remediation.RemediationEmitter(service_id="app_api", pipe_path="").begin(
        component="shioaji_session", mechanism_id="provider.broker_session_reconnect", trigger_reason="login_failed")
    assert operation.durable(0.05) is False


def test_every_mechanism_says_what_happened_in_the_users_words():
    # 系統拓樸 補救事件 shows the label, not the mechanism id (user 10-14): every mechanism has one, in Chinese.
    for mechanism_id, spec in REGISTRY["mechanisms"].items():
        label = spec.get("label")
        assert isinstance(label, str) and label.strip(), mechanism_id
        assert any("一" <= ch <= "鿿" for ch in label), f"{mechanism_id}: {label!r}"


def test_every_reason_the_shioaji_session_recovers_for_is_registered_and_no_user_action_is():
    # The writer refuses a trigger the registry does not list: the broker's session-down callback opened
    # provider.broker_session_reconnect with a reason it did not have, and was lost. The user's actions and the
    # scheduled daily re-login are not remediations (docs/decisions.md 什麼算補救) and are not registered.
    import inspect

    from service.market.shioaji.session import ShioajiBrokerService

    source = inspect.getsource(ShioajiBrokerService)
    reasons = set(re.findall(r'_begin_session_recovery\("(\w+)"', source))
    assert reasons == {"login_failed", "subscription_sync_failed"}
    registered = set(REGISTRY["mechanisms"]["provider.broker_session_reconnect"]["trigger_reasons"])
    assert registered == reasons | {"broker_session_down"}
    for mechanism in ("provider.broker_session_reconnect", "client.futu_daemon_attach"):
        assert not {"manual_request", "credentials_changed", "daily_relogin"} & set(
            REGISTRY["mechanisms"][mechanism]["trigger_reasons"]), mechanism
