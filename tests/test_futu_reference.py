"""Futu 昨收 outside the regular session: OpenD pushes no quote rows then, so the reference is asked of the market
snapshot once per code and trading date, re-checked slowly, and sent only when it changed."""
from datetime import datetime, timezone

from service.market.futu.callback import FutuThinCallbackAdapter
from service.market.futu.reference import MIN_CALL_INTERVAL_SECONDS, REFRESH_SECONDS, RETRY_SECONDS, FutuReferencePublisher


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def make(now=datetime(2026, 10, 7, 15, 0, tzinfo=timezone.utc)):   # 11:00 ET: the regular session of 10-07
    sent, clock = [], Clock()
    publisher = FutuReferencePublisher(lambda code, date, data: sent.append((code, date, data)) or True,
                                       now=lambda: now if not callable(now) else now(), monotonic=clock)
    return publisher, sent, clock


def no_kline(code, start, end):
    raise AssertionError(f"no crypto here: 1-minute bars of {code} asked")


def bars(*closes_by_time):
    """1-minute bars of CC.BTCUSD as OpenD labels them (by their end, New York time)."""
    return lambda code, start, end: [{"code": code, "name": "BTC/USD", "time_key": t, "close": c} for t, c in closes_by_time]


def test_each_code_is_asked_once_per_trading_date():
    publisher, sent, clock = make()
    asked = []

    def snapshot(codes):
        asked.append(list(codes))
        return [{"code": "US.TSM", "prev_close_price": 482.3, "name": "台積電"}, {"code": "US.NOK", "prev_close_price": 6.04}]

    assert publisher.run(snapshot, ["US.TSM", "us.nok"], no_kline) == 2
    assert asked == [["US.NOK", "US.TSM"]]
    assert sorted(sent, key=lambda item: item[0]) == [("US.NOK", "2026-10-07", {"prev_close": 60_400}),
                                                     ("US.TSM", "2026-10-07", {"prev_close": 4_823_000, "name": "台積電"})]
    assert publisher.run(snapshot, ["US.TSM", "US.NOK"], no_kline) == 0 and len(asked) == 1, "not asked again within the cadence"


def test_crypto_previous_close_is_its_price_at_the_last_us_close():
    # 2026-11-12 00:15 Taipei = 11-11 11:15 New York: BTC's day is 11-11 (New York), its 昨收 the 16:00 ET price of
    # 11-10, the moment US stocks' 昨收 is from. Real OpenD bars: the bar labelled 16:00:00 ends at 16:00.
    publisher, sent, clock = make(now=datetime(2026, 11, 11, 16, 15, tzinfo=timezone.utc))
    asked = []
    kline = bars(("2026-11-10 15:59:00", 73683.10718), ("2026-11-10 16:00:00", 73701.88841))

    def recording(code, start, end):
        asked.append((code, start, end))
        return kline(code, start, end)

    assert publisher.run(lambda codes: [], ["CC.BTCUSD", "US.TSM"], recording) == 1
    assert asked == [("CC.BTCUSD", "2026-11-10 15:50:00", "2026-11-10 16:00:00")]
    assert sent == [("CC.BTCUSD", "2026-11-11", {"prev_close": 737_018_884, "name": "BTC/USD"})]
    clock.t += REFRESH_SECONDS * 3
    publisher.run(lambda codes: [], ["CC.BTCUSD"], recording)
    assert len(asked) == 1, "a past close never changes: asked once per New York day"


def test_a_weekend_and_monday_compare_with_fridays_close():
    # Saturday 11-07 and Monday 11-09 (New York): both are compared with Friday 11-06's 16:00 price.
    for now, day in ((datetime(2026, 11, 7, 18, 0, tzinfo=timezone.utc), "2026-11-07"),
                     (datetime(2026, 11, 9, 14, 0, tzinfo=timezone.utc), "2026-11-09")):
        publisher, sent, _ = make(now=now)
        asked = []
        publisher.run(lambda codes: [], ["CC.BTCUSD"], lambda code, start, end: asked.append(end) or
                      [{"code": code, "time_key": "2026-11-06 16:00:00", "close": 75500.0}])
        assert asked == ["2026-11-06 16:00:00"] and sent == [("CC.BTCUSD", day, {"prev_close": 755_000_000})]


def test_crypto_without_the_closing_bar_is_unusable_and_asked_again_later():
    publisher, sent, clock = make(now=datetime(2026, 11, 11, 16, 15, tzinfo=timezone.utc))
    calls = []
    kline = lambda code, start, end: calls.append(end) or [{"code": code, "time_key": "2026-11-10 15:59:00", "close": 1.0}]
    publisher.run(lambda codes: [], ["CC.BTCUSD"], kline)
    assert sent == [] and publisher.unusable == 1 and publisher.last_unusable["code"] == "CC.BTCUSD"
    clock.t += MIN_CALL_INTERVAL_SECONDS
    publisher.run(lambda codes: [], ["CC.BTCUSD"], kline)
    assert len(calls) == 1, "not every cycle"
    clock.t += REFRESH_SECONDS
    publisher.run(lambda codes: [], ["CC.BTCUSD"], kline)
    assert len(calls) == 2


def test_a_recheck_sends_only_a_changed_value():
    publisher, sent, clock = make()
    value = {"v": 482.3}
    snapshot = lambda codes: [{"code": "US.TSM", "prev_close_price": value["v"]}]
    publisher.run(snapshot, ["US.TSM"], no_kline)
    clock.t += REFRESH_SECONDS
    assert publisher.run(snapshot, ["US.TSM"], no_kline) == 0, "same value: nothing sent"
    value["v"] = 485.1
    clock.t += REFRESH_SECONDS
    assert publisher.run(snapshot, ["US.TSM"], no_kline) == 1
    assert sent[-1][2] == {"prev_close": 4_851_000}


def test_a_failed_snapshot_waits_before_the_next_try_and_bad_rows_are_skipped():
    publisher, sent, clock = make()

    def broken(codes):
        raise RuntimeError("quota")

    assert publisher.run(broken, ["US.TSM"], no_kline) == 0
    assert publisher.failures == 1 and publisher.due(["US.TSM"]) == []
    clock.t += RETRY_SECONDS
    assert publisher.run(lambda codes: [{"code": "US.TSM", "prev_close_price": None}, {"code": "", "prev_close_price": 1}], ["US.TSM"], no_kline) == 0
    assert sent == []


def test_the_reference_is_dated_by_the_exchange_zone():
    # 2026-10-07 02:00 UTC is 10-06 22:00 in New York: the partition is 10-06.
    publisher, sent, _ = make(now=datetime(2026, 10, 7, 2, 0, tzinfo=timezone.utc))
    publisher.run(lambda codes: [{"code": "US.TSM", "prev_close_price": 480.0}], ["US.TSM"], no_kline)
    assert sent[0][1] == "2026-10-06"


def test_the_adapter_sends_a_reference_event_in_its_own_sequence():
    events = []

    class Sink:
        def publish(self, event):
            events.append(event)
            return True

    adapter = FutuThinCallbackAdapter(Sink(), generation=lambda: 7)
    assert adapter.publish_reference("us.tsm", "2026-10-07", {"prev_close": 4_823_000, "name": "台積電"})
    assert adapter.publish_reference("US.TSM", "2026-10-07", {"prev_close": 4_851_000})
    first, second = events
    assert (first.event_type, first.code, first.market, first.describes_trading_date, first.generation) == ("reference", "US.TSM", "US", "2026-10-07", 7)
    assert (first.sequence, second.sequence) == (1, 2)
    assert first.data == {"prev_close": 4_823_000, "name": "台積電"}


def test_an_unusable_answer_is_not_asked_again_every_cycle_and_calls_are_spaced():
    # Rows the publisher could not use kept their codes due, and the worker asked OpenD every 0.2 s until
    # the account's 60-per-30-s snapshot quota was gone.
    from service.market.futu.reference import MIN_CALL_INTERVAL_SECONDS
    publisher, sent, clock = make()
    calls = []

    def snapshot(codes):
        calls.append(list(codes))
        return [{"code": "US.TSM", "prev_close_price": "N/A"}]

    publisher.run(snapshot, ["US.TSM", "US.NOK"], no_kline)
    for _ in range(50):
        clock.t += 0.2
        publisher.run(snapshot, ["US.TSM", "US.NOK"], no_kline)
    assert len(calls) == 1, "answered codes wait for the cadence, usable or not"
    assert publisher.unusable == 1 and publisher.last_unusable["code"] == "US.TSM"
    assert sent == []
    # A new code is asked, and the next new code waits for the spacing between calls.
    publisher.run(snapshot, ["US.ASX"], no_kline)
    assert calls[-1] == ["US.ASX"]
    publisher.run(snapshot, ["US.ASX", "US.MU"], no_kline)
    assert len(calls) == 2
    clock.t += MIN_CALL_INTERVAL_SECONDS
    publisher.run(snapshot, ["US.ASX", "US.MU"], no_kline)
    assert calls[-1] == ["US.MU"]


def test_before_the_us_regular_open_the_previous_close_is_last_price():
    # 10-16 06:01 ET (pre-market): OpenD's snapshot was still on 10-15 -- prev_close_price 914.13 is 10-14's close,
    # last_price 931.24 is 10-15's, the base of Futu's own pre_change_val (917.00 - 931.24 = -14.24).
    publisher, sent, _ = make(now=datetime(2026, 10, 16, 10, 1, tzinfo=timezone.utc))
    row = {"code": "US.MU", "last_price": 931.24, "prev_close_price": 914.13, "pre_price": 917.0, "pre_change_val": -14.24}
    assert publisher.run(lambda codes: [row], ["US.MU"], no_kline) == 1
    assert sent == [("US.MU", "2026-10-16", {"prev_close": 9_312_400})]


def test_the_overnight_hours_after_midnight_read_last_price_too():
    # 01:00 ET belongs to the 10-07 partition, before 10-07's regular open.
    publisher, sent, _ = make(now=datetime(2026, 10, 7, 5, 0, tzinfo=timezone.utc))
    publisher.run(lambda codes: [{"code": "US.TSM", "last_price": 485.1, "prev_close_price": 482.3}], ["US.TSM"], no_kline)
    assert sent == [("US.TSM", "2026-10-07", {"prev_close": 4_851_000})]


def test_the_pre_open_close_stays_after_the_open():
    # A snapshot that has not moved to the new day just after 09:30 would bring back the day before's close.
    now = {"t": datetime(2026, 10, 16, 13, 20, tzinfo=timezone.utc)}   # 09:20 ET
    publisher, sent, clock = make(now=lambda: now["t"])
    stale = lambda codes: [{"code": "US.MU", "last_price": 931.24, "prev_close_price": 914.13}]
    publisher.run(stale, ["US.MU"], no_kline)
    now["t"] = datetime(2026, 10, 16, 13, 31, tzinfo=timezone.utc)      # 09:31 ET
    clock.t += REFRESH_SECONDS
    assert publisher.run(stale, ["US.MU"], no_kline) == 0
    assert sent == [("US.MU", "2026-10-16", {"prev_close": 9_312_400})]


def test_a_regular_session_start_reads_prev_close_price():
    # Started after the open, the snapshot is already on the day: prev_close_price is its 昨收.
    publisher, sent, _ = make(now=datetime(2026, 10, 16, 15, 0, tzinfo=timezone.utc))   # 11:00 ET
    publisher.run(lambda codes: [{"code": "US.MU", "last_price": 925.0, "prev_close_price": 931.24}], ["US.MU"], no_kline)
    assert sent == [("US.MU", "2026-10-16", {"prev_close": 9_312_400})]


def test_a_weekend_never_gets_a_partition_of_its_own():
    # 10-31 (Saturday) 07:11 ET: a Saturday-dated reference made a 10-31 partition with no prints, and the product
    # list (a view with no date resolves to the newest partition) showed only 昨收. Saturday is still Friday's
    # partition, whose 昨收 after Friday's open is prev_close_price (10-29's close); HK the same.
    publisher, sent, _ = make(now=datetime(2026, 10, 31, 11, 11, tzinfo=timezone.utc))
    rows = lambda codes: [{"code": "US.NOK", "last_price": 8.56, "prev_close_price": 9.31},
                          {"code": "HK.00700", "last_price": 500.0, "prev_close_price": 490.0}]
    publisher.run(rows, ["US.NOK", "HK.00700"], no_kline)
    assert sorted(sent) == [("HK.00700", "2026-10-30", {"prev_close": 4_900_000}), ("US.NOK", "2026-10-30", {"prev_close": 93_100})]


def test_sunday_is_fridays_partition_until_the_overnight_open():
    snapshot = lambda codes: [{"code": "US.NOK", "last_price": 8.56, "prev_close_price": 9.31}]
    publisher, sent, _ = make(now=datetime(2026, 11, 1, 23, 59, tzinfo=timezone.utc))   # Sunday 18:59 ET
    publisher.run(snapshot, ["US.NOK"], no_kline)
    assert sent == [("US.NOK", "2026-10-30", {"prev_close": 93_100})]
    # Sunday 20:00 ET: the overnight session for Monday opens in Sunday's partition, before Monday's regular open,
    # so its 昨收 is Friday's close (last_price).
    publisher, sent, _ = make(now=datetime(2026, 11, 2, 1, 0, tzinfo=timezone.utc))
    publisher.run(snapshot, ["US.NOK"], no_kline)
    assert sent == [("US.NOK", "2026-11-01", {"prev_close": 85_600})]


def test_only_the_current_date_of_codes_still_asked_about_is_kept():
    """R12-13: entries of a code that left the plan, or of a date its exchange moved past, are dropped."""
    when = {"now": datetime(2026, 10, 7, 15, 0, tzinfo=timezone.utc)}
    publisher, sent, clock = make(now=lambda: when["now"])
    snapshot = lambda codes: [{"code": code, "prev_close_price": 10.0} for code in codes]
    publisher.run(snapshot, ["US.TSM", "US.NOK"], no_kline)
    assert {key[0] for key in publisher._sent} == {"US.TSM", "US.NOK"}
    when["now"] = datetime(2026, 10, 8, 15, 0, tzinfo=timezone.utc)    # the next US trading date
    clock.t += REFRESH_SECONDS
    publisher.run(snapshot, ["US.TSM"], no_kline)                                  # US.NOK left the plan
    assert set(publisher._sent) == {("US.TSM", "2026-10-08")} and set(publisher._checked_at) == {("US.TSM", "2026-10-08")}


def _thanksgiving_calendar(tmp_path, monkeypatch):
    """OpenD's US calendar for 11-16..11-30: every weekday but Thanksgiving (11-26); 11-27 is a half day."""
    import json
    from datetime import date, timedelta

    import config.market_holidays as holidays

    days = []
    for offset in range(15):
        day = date(2026, 11, 16) + timedelta(days=offset)
        if day.weekday() < 5 and day != date(2026, 11, 26):
            days.append({"date": day.isoformat(), "kind": "MORNING" if day == date(2026, 11, 27) else "WHOLE"})
    path = tmp_path / "us_trading_calendar.json"
    path.write_text(json.dumps({"schema": holidays.US_CALENDAR_SCHEMA, "source": "futu_opend", "from": "2026-11-16",
                                "to": "2026-11-30", "read_at": "2026-11-16T09:00:00-05:00", "days": days}), encoding="utf-8")
    monkeypatch.setattr(holidays, "us_calendar_path", lambda: path)


def test_a_us_holiday_is_the_previous_trading_days_partition(tmp_path, monkeypatch):
    # Thanksgiving (Thursday 11-26) trades nothing: a 11-26-dated 昨收 would make a partition with no prints, and the
    # product list (the newest partition) would show only 昨收 all day, as on 10-31's Saturday.
    _thanksgiving_calendar(tmp_path, monkeypatch)
    snapshot = lambda codes: [{"code": "US.NOK", "last_price": 8.56, "prev_close_price": 9.31}]
    publisher, sent, _ = make(now=datetime(2026, 11, 26, 16, 0, tzinfo=timezone.utc))   # Thursday 11:00 ET
    publisher.run(snapshot, ["US.NOK"], no_kline)
    assert sent == [("US.NOK", "2026-11-25", {"prev_close": 93_100})]


def test_a_us_holiday_evening_opens_the_next_trading_days_overnight_in_its_own_partition(tmp_path, monkeypatch):
    # Thursday 20:30 ET: Friday's overnight session opens in the 11-26 partition (A dates prints by the New York
    # calendar date), before Friday's regular open, so its 昨收 is Wednesday's close (last_price).
    _thanksgiving_calendar(tmp_path, monkeypatch)
    snapshot = lambda codes: [{"code": "US.NOK", "last_price": 8.56, "prev_close_price": 9.31}]
    publisher, sent, _ = make(now=datetime(2026, 11, 27, 1, 30, tzinfo=timezone.utc))
    publisher.run(snapshot, ["US.NOK"], no_kline)
    assert sent == [("US.NOK", "2026-11-26", {"prev_close": 85_600})]


def test_the_evening_before_a_us_holiday_opens_no_overnight_partition(tmp_path, monkeypatch):
    # Wednesday 11-25 20:30 ET: Thursday trades nothing, so no overnight opens; Wednesday's partition holds.
    _thanksgiving_calendar(tmp_path, monkeypatch)
    snapshot = lambda codes: [{"code": "US.NOK", "last_price": 8.56, "prev_close_price": 9.31}]
    publisher, sent, _ = make(now=datetime(2026, 11, 26, 1, 30, tzinfo=timezone.utc))
    publisher.run(snapshot, ["US.NOK"], no_kline)
    assert [(code, date) for code, date, _data in sent] == [("US.NOK", "2026-11-25")]
