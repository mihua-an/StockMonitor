"""A FUT session's identity includes TXFR1's actual contract, which the broker names only once it is logged in.

A restart binds the session owner before the login: the contract reads "" there. Read as another contract, it sealed
the live night session the restart had just restored and opened an empty-contract one in its place, one generation up;
and the placeholder's intent, never removed when the contract arrived, was restored again at the next start.
"""
from __future__ import annotations

import json
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import Mock
from zoneinfo import ZoneInfo

from service.market.lifecycle.rollover import ActiveMarketSession, SessionOrchestrator

ZONE = ZoneInfo("Asia/Taipei")
NIGHT = datetime(2026, 10, 19, 23, 19, 5, tzinfo=ZONE)   # the 2026-10-20 night session, live
REAL = "shioaji:FUT:TXFR1:2026-10-20:NIGHT:TXFJ6"
PLACEHOLDER = "shioaji:FUT:TXFR1:2026-10-20:NIGHT"


def _app(contract: dict[str, str]) -> SimpleNamespace:
    broker = SimpleNamespace(
        status=lambda: {"txf": {"target_code": contract["code"]}},
        mark_market_session_transition=Mock(), set_market_session_event_listener=Mock())
    return SimpleNamespace(broker_service=broker)


def _orchestrator(tmp_path, app) -> SessionOrchestrator:
    return SessionOrchestrator(app_provider=lambda: app, manifest_dir=tmp_path / "finalization", now_provider=lambda: NIGHT,
                               materialization_jobs_root=tmp_path / "jobs")


def _session(contract: str, generation: int) -> ActiveMarketSession:
    return ActiveMarketSession(market="FUT", trading_date="2026-10-20", session="NIGHT", actual_contract=contract,
                               generation=generation, stream_id=REAL if contract else PLACEHOLDER,
                               activated_at="2026-10-19T15:00:00.000+08:00")


def _intents(orchestrator: SessionOrchestrator) -> dict[str, tuple[str, int]]:
    out = {}
    for path in orchestrator._intent_dir.glob("*.json"):
        row = json.loads(path.read_text(encoding="utf-8"))["active"]
        out[path.name] = (row["actual_contract"], row["generation"])
    return out


def test_a_restart_before_the_login_keeps_the_restored_night_session(tmp_path) -> None:
    contract = {"code": "TXFJ6"}
    app = _app(contract)
    _orchestrator(tmp_path, app)._write_session_intent(_session("TXFJ6", 9))

    contract["code"] = ""   # bound before the broker login
    restarted = _orchestrator(tmp_path, app)
    restarted.bind_service(app)

    active = restarted.lightweight_status()["active"]["FUT"]
    assert (active["actual_contract"], active["generation"]) == ("TXFJ6", 9), active
    assert not restarted._pending_finalizations, "the live night session is not sealed"
    app.broker_service.mark_market_session_transition.assert_not_called()
    assert _intents(restarted) == {"shioaji_FUT_TXFR1_2026-10-20_NIGHT_TXFJ6.json": ("TXFJ6", 9)}

    contract["code"] = "TXFJ6"   # logged in: the same contract, the same session
    restarted.reconcile(NIGHT)
    assert restarted.lightweight_status()["active"]["FUT"]["generation"] == 9
    assert not restarted._pending_finalizations


def test_a_replaced_placeholder_leaves_no_intent_behind(tmp_path) -> None:
    contract = {"code": ""}
    app = _app(contract)
    orchestrator = _orchestrator(tmp_path, app)
    orchestrator.reconcile(NIGHT)
    assert _intents(orchestrator) == {"shioaji_FUT_TXFR1_2026-10-20_NIGHT.json": ("", 1)}

    contract["code"] = "TXFJ6"
    orchestrator.reconcile(NIGHT)
    active = orchestrator.lightweight_status()["active"]["FUT"]
    assert (active["actual_contract"], active["generation"]) == ("TXFJ6", 2)
    assert not orchestrator._pending_finalizations, "a placeholder never owned a subscription: not finalized"
    assert _intents(orchestrator) == {"shioaji_FUT_TXFR1_2026-10-20_NIGHT_TXFJ6.json": ("TXFJ6", 2)}


def test_a_stale_placeholder_intent_next_to_its_real_session_is_dropped_at_start(tmp_path) -> None:
    # What a process that predates this fix leaves: the placeholder (gen 10) beside the session with its contract.
    app = _app({"code": ""})
    writer = _orchestrator(tmp_path, app)
    writer._write_session_intent(_session("TXFJ6", 11))
    writer._write_session_intent(_session("", 10))
    restarted = _orchestrator(tmp_path, app)
    records = []
    restarted._close_record = lambda mechanism, trigger, outcome, **kw: records.append((trigger, kw.get("detail")))

    restarted._recover_session_intents()

    active = restarted.lightweight_status()["active"]["FUT"]
    assert (active["actual_contract"], active["generation"]) == ("TXFJ6", 11)
    assert _intents(restarted) == {"shioaji_FUT_TXFR1_2026-10-20_NIGHT_TXFJ6.json": ("TXFJ6", 11)}
    assert [trigger for trigger, _ in records] == ["placeholder_intent_dropped"], "the placeholder is never restored; the restored session is its normal load, not a remediation"
    assert records[0][1] == {"file": "shioaji_FUT_TXFR1_2026-10-20_NIGHT.json", "generation": 10}
    assert restarted.generation_for("FUT") == 11, "the next activation still starts above every recovered generation"


def test_an_invalid_intent_is_moved_aside_and_never_stops_the_others(tmp_path) -> None:
    """Valid JSON whose `active` is a number or a list, a generation that is not a number, a file that is not JSON:
    each is recorded and moved to unreadable/, and the valid intents beside them are still recovered (with the
    placeholder still read after its real session)."""
    app = _app({"code": ""})
    writer = _orchestrator(tmp_path, app)
    writer._write_session_intent(_session("TXFJ6", 11))
    writer._write_session_intent(_session("", 10))
    intent_dir = writer._intent_dir
    bad = {"a_number.json": '{"active": 1}', "a_list.json": '{"active": [1, 2]}', "a_list_document.json": "[1]",
           "generation.json": '{"active": {"market": "STK", "trading_date": "2026-10-20", "session": "DAY", "generation": "x"}}',
           "not_json.json": "{"}
    for name, text in bad.items():
        (intent_dir / name).write_text(text, encoding="utf-8")
    restarted = _orchestrator(tmp_path, app)
    records = []
    restarted._close_record = lambda mechanism, trigger, outcome, **kw: records.append((trigger, outcome, kw.get("detail")))

    restarted._recover_session_intents()

    active = restarted.lightweight_status()["active"]["FUT"]
    assert (active["actual_contract"], active["generation"]) == ("TXFJ6", 11)
    unreadable = sorted(detail["file"] for trigger, outcome, detail in records if trigger == "intent_unreadable")
    assert unreadable == sorted(bad) and all(outcome == "failed" for trigger, outcome, _ in records if trigger == "intent_unreadable")
    assert sorted(p.name for p in (intent_dir / "unreadable").glob("*.json")) == sorted(bad)
    assert [t for t, _, _ in records if t != "intent_unreadable"] == ["placeholder_intent_dropped"]
    # The next start finds only the recovered session's intent.
    again = _orchestrator(tmp_path, app)
    seen = []
    again._close_record = lambda mechanism, trigger, outcome, **kw: seen.append(trigger)
    again._recover_session_intents()
    assert seen == [], "restoring a live session is a normal load: no remediation event"


def test_an_intent_that_cannot_be_read_now_is_left_for_the_next_start(tmp_path, monkeypatch) -> None:
    from pathlib import Path

    app = _app({"code": ""})
    writer = _orchestrator(tmp_path, app)
    writer._write_session_intent(_session("TXFJ6", 11))
    path = next(writer._intent_dir.glob("*.json"))
    real_read = Path.read_text
    monkeypatch.setattr(Path, "read_text", lambda self, *a, **k: (_ for _ in ()).throw(PermissionError("locked"))
                        if self == path else real_read(self, *a, **k))
    restarted = _orchestrator(tmp_path, app)
    records = []
    restarted._close_record = lambda mechanism, trigger, outcome, **kw: records.append((trigger, kw.get("detail")))
    restarted._recover_session_intents()
    assert [t for t, _ in records] == ["intent_unreadable"] and "moved_to" not in records[0][1]
    assert path.exists()
