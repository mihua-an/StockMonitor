"""Both provider daemons publish their own Market Runtime acknowledgements.

系統連線診斷 animates Shioaji -> Rust A and Futu -> Rust A only when THAT provider's ``live_ingress.acked`` advanced; it
never borrows Rust A's intake total, which every source feeds. The renderer test feeds the field directly, so this pins
the producers: removing ``acked`` from either daemon's health payload must fail here.
"""
from __future__ import annotations

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _live_ingress_keys(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict):
            for key, value in zip(node.keys, node.values):
                if isinstance(key, ast.Constant) and key.value == "live_ingress" and isinstance(value, ast.Dict):
                    found |= {k.value for k in value.keys if isinstance(k, ast.Constant)}
    return found


def test_shioaji_daemon_health_carries_its_own_acks():
    keys = _live_ingress_keys(ROOT / "backend" / "shioaji" / "daemon_health.py")
    assert {"running", "ready", "acked"} <= keys


def test_futu_daemon_health_carries_its_own_acks():
    keys = _live_ingress_keys(ROOT / "backend" / "futu" / "server.py")
    assert {"running", "ready", "acked"} <= keys


def test_the_shioaji_value_comes_from_the_sinks_own_counter():
    source = (ROOT / "backend" / "shioaji" / "daemon_health.py").read_text(encoding="utf-8")
    assert '"acked": ingress_health.get("acked")' in source
    sink = (ROOT / "service" / "market" / "shared" / "rust_live.py").read_text(encoding="utf-8")
    assert '"acked": self._acked' in sink, "RustDaemonEventSink.stats() (merged into health()) is the counter"
