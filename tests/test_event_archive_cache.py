"""A past day's event file is parsed once per version, not on every read."""
from __future__ import annotations

import json

from service.market.projection.analysis_event_archive import AnalysisEventArchive


def test_a_day_is_parsed_once_until_its_file_changes(tmp_path, monkeypatch):
    day = tmp_path / "2026-10-08.jsonl"
    day.write_text("\n".join(json.dumps({"event_id": f"e{i}", "revision": 1}) for i in range(3)) + "\n", encoding="utf-8")
    archive = AnalysisEventArchive(tmp_path)
    opened = []
    real_open = type(day).open
    monkeypatch.setattr(type(day), "open", lambda self, *a, **k: opened.append(self.name) or real_open(self, *a, **k))
    assert [e["event_id"] for e in archive.read("2026-10-08")["events"]] == ["e2", "e1", "e0"]
    assert archive.read("2026-10-08", limit=1)["events"][0]["event_id"] == "e2"
    assert opened == ["2026-10-08.jsonl"], "the second read is served from the parsed day"
    with day.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"event_id": "e1", "revision": 2, "state": "REVOKED"}) + "\n")
    events = archive.read("2026-10-08")["events"]
    assert {e["event_id"]: e.get("state") for e in events}["e1"] == "REVOKED", "a changed file is parsed again"


def test_damaged_lines_make_the_day_partial_never_complete(tmp_path):
    """A line that is not JSON or has no event_id is damage: the day is not served as a complete archive (an empty
    one read as "no events that day"). A last line still being written is not damage while the file is fresh."""
    import os
    import time

    day = tmp_path / "2026-10-08.jsonl"
    day.write_text(json.dumps({"event_id": "e0", "revision": 1}) + "\n" + "{torn\n" + json.dumps({"no_id": 1}) + "\n",
                   encoding="utf-8")
    payload = AnalysisEventArchive(tmp_path).read("2026-10-08")
    assert [e["event_id"] for e in payload["events"]] == ["e0"] and payload["damaged_lines"] == 2

    fresh = tmp_path / "2026-10-09.jsonl"
    fresh.write_text(json.dumps({"event_id": "e0"}) + "\n" + '{"event_id": "e1"', encoding="utf-8")
    assert AnalysisEventArchive(tmp_path).read("2026-10-09")["damaged_lines"] == 0, "the line being appended now"
    old = time.time() - 60
    os.utime(fresh, (old, old))
    assert AnalysisEventArchive(tmp_path).read("2026-10-09")["damaged_lines"] == 1, "a last line that never finished"

    assert payload["archived"] is True


def test_a_later_revision_of_an_older_event_is_listed_as_new_as_its_line(tmp_path):
    """R13-29: A1, B1, A2 reads A, B -- A's newest revision is the newest line."""
    day = tmp_path / "2026-10-08.jsonl"
    day.write_text("".join(json.dumps(record) + "\n" for record in (
        {"event_id": "A", "revision": 1}, {"event_id": "B", "revision": 1}, {"event_id": "A", "revision": 2})),
        encoding="utf-8")
    events = AnalysisEventArchive(tmp_path).read("2026-10-08")["events"]
    assert [(e["event_id"], e["revision"]) for e in events] == [("A", 2), ("B", 1)]
