"""A claim next to its result is a finished job -- DONE, never RUNNING/CLAIMED."""
from service.market.shared.materialization_jobs import job_stage


def test_claim_next_to_result_is_done(tmp_path):
    for folder in ("pending", "claimed", "done"):
        (tmp_path / folder).mkdir()
    assert job_stage("j", jobs_root=tmp_path) == "LOST"
    (tmp_path / "claimed" / "j.json").write_text("{}")
    assert job_stage("j", jobs_root=tmp_path) == "CLAIMED"
    (tmp_path / "done" / "j.json").write_text("{}")
    assert job_stage("j", jobs_root=tmp_path) == "DONE"
    (tmp_path / "claimed" / "j.json").unlink()
    assert job_stage("j", jobs_root=tmp_path) == "DONE"
