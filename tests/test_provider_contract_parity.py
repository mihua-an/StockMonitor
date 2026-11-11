"""config/provider_contract.json is validated with the same rules and error codes in Python and Node:
a broken contract fails to load in both, neither guesses a default."""
from __future__ import annotations

import copy
import json
import subprocess
from pathlib import Path

from service.market.shared.provider_contract import ProviderContractError, normalize_provider_source, validate_provider_contract

ROOT = Path(__file__).resolve().parents[1]
VALID = json.loads((ROOT / "config" / "provider_contract.json").read_text(encoding="utf-8"))


def _case(mutate):
    value = copy.deepcopy(VALID)
    mutate(value)
    return value


CASES = {
    "valid": (VALID, None),
    "no_default": (_case(lambda c: c.pop("default_source")), "DEFAULT_SOURCE_INVALID"),
    "unknown_default": (_case(lambda c: c.update(default_source="ib")), "DEFAULT_SOURCE_INVALID"),
    "version_string": (_case(lambda c: c.update(contract_version="1")), "CONTRACT_VERSION_UNSUPPORTED"),
    "version_2": (_case(lambda c: c.update(contract_version=2)), "CONTRACT_VERSION_UNSUPPORTED"),
    "no_canonical": (_case(lambda c: c.update(canonical_sources=[])), "CANONICAL_SOURCES_INVALID"),
    "upper_canonical": (_case(lambda c: c.update(canonical_sources=["Shioaji", "futu"])), "CANONICAL_SOURCES_INVALID"),
    "not_object": ([], "CONTRACT_NOT_OBJECT"),
}


def _python(value):
    try:
        validate_provider_contract(value)
        return None
    except ProviderContractError as exc:
        return exc.code


NODE = """
const { validateProviderContract } = require('./config/js/provider_contract.js');
const cases = JSON.parse(process.argv[1]);
const out = {};
for (const [name, value] of Object.entries(cases)) {
  try { validateProviderContract(value); out[name] = null; } catch (error) { out[name] = error.code || String(error); }
}
process.stdout.write(JSON.stringify(out));
"""


def test_python_and_node_classify_every_case_alike():
    payload = json.dumps({name: value for name, (value, _) in CASES.items()})
    result = subprocess.run(["node", "-e", NODE, payload], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=30)
    assert result.returncode == 0, result.stderr
    expected = {name: code for name, (_, code) in CASES.items()}
    assert {name: _python(value) for name, (value, _) in CASES.items()} == expected
    assert json.loads(result.stdout) == expected


SOURCES = {"shioaji": "shioaji", "FUTU": "futu", " futu ": "futu", "": "shioaji",
           "moomoo": "SOURCE_UNKNOWN", "us": "SOURCE_UNKNOWN", "sinopac": "SOURCE_UNKNOWN", "tw": "SOURCE_UNKNOWN"}

NORMALIZE = """
const { normalizeProviderSource } = require('./config/js/provider_contract.js');
const out = {};
for (const raw of JSON.parse(process.argv[1])) {
  try { out[raw] = normalizeProviderSource(raw); } catch (error) { out[raw] = error.code || String(error); }
}
process.stdout.write(JSON.stringify(out));
"""


def test_only_canonical_source_names_are_read_in_python_and_node():
    """No aliases (moomoo / us / sinopac / tw): a source is a canonical name, or the default when empty."""
    def python(raw):
        try:
            return normalize_provider_source(raw)
        except ProviderContractError as exc:
            return exc.code

    assert {raw: python(raw) for raw in SOURCES} == SOURCES
    result = subprocess.run(["node", "-e", NORMALIZE, json.dumps(list(SOURCES))], cwd=ROOT, capture_output=True,
                            text=True, encoding="utf-8", timeout=30)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == SOURCES
