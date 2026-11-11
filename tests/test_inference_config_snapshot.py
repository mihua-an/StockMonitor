"""model_options: only a missing enabled_minutes means the default; a saved empty list is refused like any invalid
value, and the horizons and revision in one inference config come from one read of the store."""
from __future__ import annotations

import pytest

from service.analysis.inference.contract import ContractError
from service.analysis.producer.inference_config import InferenceConfigAuthority


class Store:
    def __init__(self, *docs):
        self.docs = list(docs)
        self.reads = 0

    def active(self):
        doc = self.docs[min(self.reads, len(self.docs) - 1)]
        self.reads += 1
        return doc


def test_missing_means_default_and_saved_empty_is_refused():
    authority = InferenceConfigAuthority(store=Store(None), test_only=False)
    assert authority.snapshot() == (authority._authority.default_enabled_minutes, None)
    assert InferenceConfigAuthority(store=Store({"revision": 2, "values": {}}), test_only=False).snapshot()[1] == 2
    with pytest.raises(ContractError):
        InferenceConfigAuthority(store=Store({"revision": 3, "values": {"enabled_minutes": []}}), test_only=False).snapshot()


def test_current_reads_the_store_once():
    store = Store({"revision": 4, "values": {"enabled_minutes": [3]}}, {"revision": 5, "values": {"enabled_minutes": [5]}})
    config = InferenceConfigAuthority(store=store, test_only=False).current()
    assert store.reads == 1
    assert config["model_options_revision"] == 4
    assert {slot["horizon_minutes"] for slot in config["slots"]} == {3}
