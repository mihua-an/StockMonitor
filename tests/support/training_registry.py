"""A stand-in for the online model registry that /api/training/models reads: the given slots, no worker feature spec,
and no run report on disk."""
from __future__ import annotations


class FakeRegistry:
    def __init__(self, slots):
        self.slots = slots

    def status(self):
        return {"slots": self.slots, "worker_feature_spec": None}

    def model_dir(self, model_id):
        raise AssertionError("no run report in this test")

    def read_run(self, model_id):
        """The registry's read: the run report under the model's directory."""
        import json

        return json.loads((self.model_dir(model_id) / "run.json").read_text(encoding="utf-8"))
