"""A training directory that could not be removed is recorded and not listed as removed (R14-15)."""
from __future__ import annotations

import logging
import shutil

from service.analysis.online_training import cleanup
from service.analysis.online_training.cleanup import remove_tree
from service.analysis.online_training.dataset import OnlineDatasetBuilder


def test_remove_tree_answers_whether_it_is_gone(tmp_path, monkeypatch, caplog):
    target = tmp_path / "x"
    (target / "sub").mkdir(parents=True)
    assert remove_tree(target, "a test directory") and not target.exists()
    assert remove_tree(tmp_path / "absent", "a test directory"), "absent is gone"
    target.mkdir()

    def refuse(path):
        raise PermissionError(13, "in use", str(path))
    monkeypatch.setattr(cleanup.shutil, "rmtree", refuse)
    with caplog.at_level(logging.WARNING):
        assert remove_tree(target, "a test directory") is False
    assert target.exists()
    assert any("removing a test directory" in r.getMessage() for r in caplog.records)


def test_prune_lists_only_what_is_gone(tmp_path, monkeypatch):
    builder = OnlineDatasetBuilder(tmp_path / "hist", tmp_path / "out", exporter=object())
    for day in ("2026-10-01", "2026-10-02", "2026-10-03"):
        (tmp_path / "out" / "shards" / day).mkdir(parents=True)
    real = shutil.rmtree

    def rmtree(path):
        if path.name == "2026-10-01":
            raise PermissionError(13, "in use", str(path))
        real(path)
    monkeypatch.setattr(cleanup.shutil, "rmtree", rmtree)
    used = {"feature_spec": {"schema_digest": "d"}, "horizons_minutes": [3], "shards": []}
    removed = builder.prune(used=used, retention_days=1, keep_datasets=3)
    assert removed["dates"] == ["2026-10-02"]
    assert removed["failed"] == ["2026-10-01"]
    assert (tmp_path / "out" / "shards" / "2026-10-01").exists()
