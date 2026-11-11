"""The once-a-second Shioaji heartbeat reads whether the broker is logged in, never the full status() projection
(which copies every stream's state and walks every subscription)."""
from __future__ import annotations

from types import SimpleNamespace

from service.market.shioaji.service import ShioajiMarketService


def test_the_heartbeat_does_not_build_the_full_status(monkeypatch):
    def full_status():
        raise AssertionError("the heartbeat built the full broker status")

    service = ShioajiMarketService.__new__(ShioajiMarketService)
    service.scan_count = 0
    service._last_maintenance_minute = None
    service.watch_page_service = SimpleNamespace(all_codes=lambda: ["2330"])
    service.broker_service = SimpleNamespace(status=full_status, is_connected=lambda: True, get_api=lambda: None)
    service.market_maintenance_coordinator = SimpleNamespace(schedule_daily=lambda **kw: {"connected": kw["connected"]})
    service.kbar_download_manager = SimpleNamespace(sample_usage_if_due=lambda: None)
    monkeypatch.setattr(service, "_run_shioaji_maintenance", lambda now, codes: None)
    report = service.run_once()
    assert report["connected"] is True and report["maintenance"]["security_master"] == {"connected": True}
