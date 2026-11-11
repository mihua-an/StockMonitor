from service.market.history.history_replay_service import HistoryReplayService


def test_the_product_list_cache_is_bounded_by_dates():
    from service.market.history import history_replay_service as module

    service = HistoryReplayService(lambda: None)
    with service._lock:
        for day in range(module.LIST_CACHE_DATES + 5):
            date_text = f"2026-08-{day + 1:02d}"
            service._stock_lists[date_text] = ("fp", [])
            service._stock_summaries[(date_text, "2330")] = {}
            while len(service._stock_lists) > module.LIST_CACHE_DATES:
                service._forget_date_locked(next(iter(service._stock_lists)))
    assert len(service._stock_lists) == module.LIST_CACHE_DATES
    assert {date for date, _ in service._stock_summaries} == set(service._stock_lists), "summaries leave with their date"
