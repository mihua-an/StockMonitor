from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _contract() -> dict:
    return json.loads((ROOT / "config" / "runtime_contract.json").read_text(encoding="utf-8"))


def test_market_runtime_speaks_the_contract_renderer_protocol() -> None:
    # The renderer's live socket talks to Market Runtime, whose health carries its PROTOCOL_VERSION; the renderer checks
    # it against the contract's backend.renderer_protocol_version, so the two must be the same number. The constants live
    # in one of the crate's server submodules, so every source file of the crate is read.
    sources = sorted((ROOT / "native" / "market_runtime" / "src").rglob("*.rs"))
    server = "\n".join(path.read_text(encoding="utf-8") for path in sources)
    match = re.search(r"pub const PROTOCOL_VERSION: u32 = (\d+);", server)
    assert match is not None
    assert int(match.group(1)) == _contract()["backend"]["renderer_protocol_version"]
    assert 'pub const SERVICE_ID: &str = "market_runtime";' in server


def test_the_renderer_reads_the_expected_protocol_from_main_not_a_copy() -> None:
    # Electron main hands the page the contract's value (desktop_application.js liveEngineConnection); realtime.js keeps
    # no literal copy of any contract version.
    main = (ROOT / "ui" / "main" / "desktop_application.js").read_text(encoding="utf-8")
    assert 'expected: { service_id: "market_runtime", protocol: runtime.backend.rendererProtocolVersion }' in main
    realtime = (ROOT / "ui" / "renderer" / "js" / "market_data" / "realtime.js").read_text(encoding="utf-8")
    assert "liveEngineConnection?.expected" in realtime
    for copy in ("REALTIME_PROTOCOL_VERSION", "RENDERER_PROTOCOL_VERSION", "EXPECTED_BACKEND_RUNTIME_VERSION"):
        assert copy not in realtime
