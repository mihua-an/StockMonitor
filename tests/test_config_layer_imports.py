"""Importing the config/ readers starts no runtime machinery (AGENTS.md section 2): no service/ module (whose failure
recorder registers atexit hooks and starts a sweep thread) and no extra thread. A config lock takeover reaches the
remediation ledger only through the emitter a composition root installs."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_config_readers_import_no_service_module_and_start_no_thread():
    code = ("import sys, threading, json\n"
            "import config.config_revisions, config.market_holidays, config.observability_contract\n"
            "import config.source_settings, config.network_config, config.api_routes\n"
            "config.market_holidays._twse()\n"
            "print(json.dumps({'service': sorted(m for m in sys.modules if m.split('.')[0] == 'service'),"
            " 'threads': threading.active_count()}))")
    out = subprocess.run([sys.executable, "-c", code], cwd=ROOT, capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    assert json.loads(out.stdout) == {"service": [], "threads": 1}


def test_a_takeover_goes_to_the_installed_emitter_or_the_log(monkeypatch, caplog):
    import config.config_revisions as cr

    events = []

    class Emitter:
        def emit(self, **event):
            events.append(event)

    monkeypatch.setattr(cr, "_remediation_emitter", None)
    cr._record_takeover("network", Path("x/.lock"), {"pid": 1, "at_ms": 0}, "dead_owner", "succeeded", "lock removed")
    assert "no remediation emitter installed" in caplog.text
    cr.set_remediation_emitter(lambda: Emitter())
    cr._record_takeover("network", Path("x/.lock"), {"pid": 1, "at_ms": 0}, "dead_owner", "succeeded", "lock removed")
    assert events[0]["mechanism_id"] == "config.lock_takeover" and events[0]["detail"]["result"] == "lock removed"
