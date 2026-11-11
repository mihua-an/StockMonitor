"""Secret scrubbing by key and by value (config/secret_scrub.json): the shared cases Node
(tests/secret_scrub_cases_contract.cjs) and Rust (native/market_runtime/src/remediation.rs) run too, plus the two
Python users -- remediation detail and saved config revisions."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from config import secret_scrub
from config.config_revisions import secret_keys
from service.platform import remediation

CASES = json.loads((Path(__file__).parent / "fixtures" / "secret_scrub_cases.json").read_text(encoding="utf-8"))
PROCESS = {"service_id": "t", "instance_id": "t-1", "pid": 1}


@pytest.mark.parametrize("text, scrubbed", CASES["text"])
def test_text(text: str, scrubbed: str) -> None:
    assert secret_scrub.scrub_text(text) == scrubbed
    assert secret_scrub.secret_spans(scrubbed) == []


@pytest.mark.parametrize("name, secret", CASES["names"])
def test_names(name: str, secret: bool) -> None:
    assert secret_scrub.secret_name(name) is secret


@pytest.mark.parametrize("case", CASES["values"])
def test_values(case: dict) -> None:
    assert secret_scrub.scrub_value(case["in"]) == case["scrubbed"]
    assert secret_scrub.secret_paths(case["in"]) == case["secret_paths"]


@pytest.mark.parametrize("case", CASES["detail"])
def test_remediation_detail(case: dict) -> None:
    assert remediation.sanitize_detail(case["in"]) == case["out"]


def test_remediation_identity_extra_takes_listed_scalars_only() -> None:
    event = remediation.create_event(
        process=PROCESS, component="c", mechanism_id="sink.client_loss", trigger_reason="queue_full", outcome="failed",
        identity={"source": "futu", "host": "127.0.0.1", "port": 11111, "url": "https://h/?token=abc",
                  "client_id": {"token": "x"}, "access_token": "y"})
    assert event["identity"]["source"] == "futu"
    assert json.loads(event["detail"]["identity_extra"]) == {"host": "127.0.0.1", "port": 11111}


def test_config_revision_refuses_a_secret_value_and_allows_credential_references() -> None:
    assert secret_keys({"credential_ref": "win:broker", "credentials_configured": True}) == []
    assert secret_keys({"sync": {"url": "https://script.google.com/exec?token=abc"}, "headers": ["Authorization: Bearer x"]}) == [
        "sync.url", "headers[0]"]
