"""A manual ledger rebuild with unmatched trades is recorded failed, with what it produced, and answered as an
incomplete operation -- never "succeeded" with ok:true."""
import json

from api.routes import account_routes


def test_a_rebuild_with_errors_is_a_failure(monkeypatch):
    recorded = []
    monkeypatch.setattr(account_routes, "_record_manual_rebuild", lambda ledger, outcome, detail: recorded.append((ledger, outcome, detail)))
    clean = account_routes._rebuild_answer("actual_account", {"errors": 0, "orders": 3, "realized_matches": 2, "positions": 1})
    assert clean["ok"] is True and recorded[-1][1] == "succeeded"
    assert recorded[-1][2]["derived_version"] and recorded[-1][2]["orders"] == 3
    broken = account_routes._rebuild_answer("paper_wallet", {"errors": 2, "orders": 3, "positions_changed": True}, local_only=True)
    assert broken.status_code == 500
    body = json.loads(broken.body)
    assert body["ok"] is False and body["classification"] == "OPERATION_INCOMPLETE" and body["local_only"] is True
    assert recorded[-1][:2] == ("paper_wallet", "failed") and recorded[-1][2]["errors"] == 2
    assert recorded[-1][2]["positions_changed"] is True, "whether the failed rebuild still moved the holdings is recorded"
