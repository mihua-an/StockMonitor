"""R14-25: every actual-account sync failed from 10-21. GAS read the whole raw sheet in one request (~30 s for 1,153
rows); Google then sent the answer back to /exec, the redirect became a GET and doGet answered 「請改用 POST」. The raw
trades are now read in pages at one raw revision, and a redirect back to /exec is named for what it is."""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from service.account import actual_account_sync as module
from service.account.account_types import ActualAccountError
from tests.support.actual_sync import make_sync

ROWS = [{"trade_id": f"T{n}", "source_order": n + 2} for n in range(7)]


def paged_gas(sync, revisions=None):
    """A fake GAS answering actualRawTrades pages of ROWS; ``revisions`` gives each answer's raw_revision in turn
    (the one-row read that confirms the revision after the last page included), then 5."""
    calls = []
    order = iter(revisions or [])

    def request(action, payload=None, **_):
        calls.append((action, dict(payload or {})))
        offset, limit = payload["offset"], payload["limit"]
        end = min(offset + limit, len(ROWS))
        return {"ok": True, "items": ROWS[offset:end], "next_offset": end if end < len(ROWS) else None,
                "raw_revision": next(order, 5)}

    sync._gas_request = request
    return calls


def test_pages_are_read_until_the_last_and_joined_in_order(tmp_path, monkeypatch):
    sync = make_sync(tmp_path)
    monkeypatch.setattr(module, "RAW_TRADES_PAGE_SIZE", 3)
    calls = paged_gas(sync)
    assert sync._gas_raw_trades() == ROWS
    assert [payload for _, payload in calls] == [{"offset": 0, "limit": 3}, {"offset": 3, "limit": 3}, {"offset": 6, "limit": 3},
                                                 {"offset": 0, "limit": 1}]


def test_a_sheet_that_changes_between_pages_is_read_again(tmp_path, monkeypatch):
    sync = make_sync(tmp_path)
    monkeypatch.setattr(module, "RAW_TRADES_PAGE_SIZE", 3)
    calls = paged_gas(sync, [5, 6, 6, 6, 6, 6])   # the second page saw a new revision
    assert sync._gas_raw_trades() == ROWS
    assert [payload["offset"] for _, payload in calls] == [0, 3, 0, 3, 6, 0]


def test_a_sheet_that_keeps_changing_stops_the_sync(tmp_path, monkeypatch):
    sync = make_sync(tmp_path)
    monkeypatch.setattr(module, "RAW_TRADES_PAGE_SIZE", 3)
    paged_gas(sync, [1, 2, 3, 4, 5, 6])
    with pytest.raises(ActualAccountError, match="持續變動"):
        sync._gas_raw_trades()


def test_a_change_after_the_last_page_reads_the_sheet_again(tmp_path, monkeypatch):
    """A row deleted by hand after the pages were read: the status after them has moved on."""
    sync = make_sync(tmp_path)
    monkeypatch.setattr(module, "RAW_TRADES_PAGE_SIZE", 5)
    calls = paged_gas(sync, [5, 5, 6, 6, 6, 6])   # both pages at 5, but the confirming read says 6
    assert sync._gas_raw_trades() == ROWS
    assert [payload["offset"] for _, payload in calls] == [0, 5, 0, 0, 5, 0]


@pytest.mark.parametrize("answer, message", [
    ({"ok": True, "count": 7, "items": ROWS}, "不是分頁回應"),          # the GAS script before R14-25
    ({"ok": True, "items": ROWS[:3], "next_offset": 0, "raw_revision": 1}, "下一頁位置"),
])
def test_an_answer_that_is_not_a_page_is_refused(tmp_path, answer, message):
    sync = make_sync(tmp_path)
    sync._gas_request = lambda action, payload=None, **_: answer
    with pytest.raises(ActualAccountError, match=message):
        sync._gas_raw_trades()


def test_the_read_stops_after_its_budget(tmp_path, monkeypatch):
    sync = make_sync(tmp_path)
    monkeypatch.setattr(module, "RAW_TRADES_PAGE_SIZE", 1)
    clock = iter(range(0, 10_000, 100))
    monkeypatch.setattr(module.time, "monotonic", lambda: next(clock))
    calls = paged_gas(sync)
    with pytest.raises(ActualAccountError, match="超過"):
        sync._gas_raw_trades()
    assert len(calls) < len(ROWS)


def test_an_answer_sent_back_to_exec_as_a_get_is_named(tmp_path, monkeypatch):
    """What the 10-22 trace showed: POST /exec -> 302 echo -> 302 back to /exec (now a GET) -> doGet's answer."""
    import requests
    sync = make_sync(tmp_path)
    sync.save_config("https://script.google.com/macros/s/X/exec", "FAKE-token")
    sync.ledger._shutdown_event = SimpleNamespace(is_set=lambda: False, wait=lambda delay: False)
    exec_url, echo_url = "https://script.google.com/macros/s/X/exec", "https://script.googleusercontent.com/macros/echo?k=1"
    hop = lambda method, url: SimpleNamespace(status_code=302, request=SimpleNamespace(method=method, url=url), url=url)
    sent = []

    class Session:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def request(self, method, url, **kwargs):
            sent.append(method)
            return SimpleNamespace(status_code=200, url=echo_url, raise_for_status=lambda: None,
                                   request=SimpleNamespace(method="GET", url=echo_url),
                                   history=[hop("POST", exec_url), hop("GET", echo_url), hop("GET", exec_url)],
                                   text=json.dumps({"ok": False, "error": "請改用 POST"}))
    monkeypatch.setattr(requests, "Session", Session)
    with pytest.raises(ActualAccountError, match="轉回 /exec") as caught:
        sync._gas_request("actualRawTrades", {"offset": 0, "limit": 300})
    assert "請改用 POST" not in str(caught.value) and "可能已經完成" not in str(caught.value)
    assert sent == ["POST"], "not retried: the same request would be sent back again"
    # A write's doPost ran, so its change may be in the sheet.
    with pytest.raises(ActualAccountError, match="寫入可能已經完成"):
        sync._gas_request("actualTradeDelete", {"trade_id": "t1"}, write=True)
