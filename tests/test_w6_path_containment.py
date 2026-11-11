"""Path containment: a value that becomes a file name stays inside its root.

Both directions: the legitimate value works, every escaping one is refused and touches nothing outside.
"""
from __future__ import annotations

import json
from pathlib import Path


from service.market.projection.analysis_event_archive import AnalysisEventArchive


def _event_line(event_id: str, revision: int = 1) -> str:
    return json.dumps({"event_id": event_id, "revision": revision}) + "\n"


def test_event_archive_reads_a_real_date_and_refuses_anything_else(tmp_path: Path):
    root = tmp_path / "analysis" / "events"
    root.mkdir(parents=True)
    (root / "2026-10-06.jsonl").write_text(_event_line("e1"), encoding="utf-8")
    # Sibling .jsonl files a traversal used to reach.
    (tmp_path / "analysis" / "secret.jsonl").write_text(_event_line("leak"), encoding="utf-8")
    (tmp_path / "secret.jsonl").write_text(_event_line("leak"), encoding="utf-8")
    archive = AnalysisEventArchive(root)

    good = archive.read("2026-10-06")
    assert good["ok"] is True and good["count"] == 1 and good["date"] == "2026-10-06"
    assert archive.read("2026-10-07")["count"] == 0                      # a real date with no file: empty, not an error

    for value in ("../secret", "../../secret", "..\\secret", "../secret.jsonl", "2026-10-06/../../secret",
                  str(tmp_path / "secret"), "2026-13-01", "2026-02-30", "20261006", "2026-10-06x", "", None):
        result = archive.read(value)
        assert result["ok"] is False and result["error"] == "INVALID_DATE", value
        assert result["events"] == [] and "leak" not in json.dumps(result)


def test_event_archive_date_route_cannot_read_outside(tmp_path: Path, monkeypatch):
    """The FastAPI route (/api/monitor/events?date=) passes the value straight to the archive."""
    root = tmp_path / "events"
    root.mkdir()
    (tmp_path / "x.jsonl").write_text(_event_line("leak"), encoding="utf-8")
    archive = AnalysisEventArchive(root)
    # The route slices [:10]: "../x" fits in ten characters.
    assert archive.read("../x"[:10])["ok"] is False


class _NoMetadata:
    pass
