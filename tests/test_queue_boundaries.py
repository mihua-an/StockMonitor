from __future__ import annotations

from service.market.futu.service import FutuMarketService


class _FullSink:
    """Event sink whose bounded queue is saturated: publish must reject, not block."""

    def __init__(self) -> None:
        from service.market.shared.partition_evidence import PartitionEvidence

        self.calls = 0
        self.evidence = PartitionEvidence()   # Market Runtime's partition records, as the sink reads them

    def publish(self, event) -> bool:
        self.calls += 1
        return False

    def stop_admission(self) -> None:
        pass


def test_futu_callback_is_non_blocking_and_records_sink_rejection(tmp_path) -> None:
    sink = _FullSink()
    service = FutuMarketService(tmp_path / "moomoo.db", event_sink=sink)

    result = service.thin_callback._publish(
        "quote", [{"code": "US.AAPL", "last_price": 1.0, "volume": 1, "data_time": "2026-10-01 10:00:00"}])

    assert sink.calls == 1
    # A row the sink refused is not "accepted" just because it was handed to the callback.
    assert result == {"accepted": 0, "rejected": 1, "rejected_by_reason": {"rust_rejected": 1}}
    snapshot = service.thin_callback.snapshot()
    assert snapshot["rejected"] == 1
    assert snapshot["last_rejection"]["message"] == "US.AAPL"
    # Lane evidence is recorded even when the sink rejects; the service holds no market queue.
    assert not hasattr(service, "_push_queue")
