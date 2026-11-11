from service.market.history.historical_work_coordinator import HistoricalWorkCoordinator


def test_completed_same_key_read_is_never_reused() -> None:
    work = HistoricalWorkCoordinator(name="fresh-read-test", max_workers=1, queue_size=4)
    values = []
    try:
        for expected in range(50):
            actual = work.run("same-raw-scope", lambda value=expected: value, timeout=1.0)
            values.append(actual)
    finally:
        work.shutdown(timeout=1.0)
    assert values == list(range(50))


def test_a_finished_job_never_removes_a_newer_job_of_the_same_key() -> None:
    """The worker's finally popped the key unconditionally. A same-key request submitted after the old job
    completed (but before its finally ran) lost its in-flight entry, so the next caller started a duplicate."""
    import threading
    from concurrent.futures import Future

    work = HistoricalWorkCoordinator(name="generation-test", max_workers=1, queue_size=4)
    started, release = threading.Event(), threading.Event()

    def slow():
        started.set()
        release.wait(5)
        return "old"

    try:
        old = work.submit("k", slow)
        assert started.wait(5)
        newer: Future = Future()
        with work._lock:
            work._inflight["k"] = newer  # a newer submission for the key while the old job finishes
        release.set()
        assert old.result(timeout=5) == "old"
        work._queue.join()
        with work._lock:
            assert work._inflight.get("k") is newer, "the old job's worker left the newer job in flight"
        assert work.submit("k", lambda: "dup") is newer, "a third caller joins the newer job instead of duplicating it"
    finally:
        newer.set_result(None)
        work.shutdown(timeout=1.0)
