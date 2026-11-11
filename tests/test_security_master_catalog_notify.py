"""A provider's security-master write reaches the product catalog while the App runs: the daily relogin rewrites the
master, and the catalog is rebuilt then -- not only at the next start, recorded as catalog_stale.

writer -> security_master_feed (provider SSE) -> SecurityMasterWatch (app_api) -> ProductCatalogService.source_written
-> catalog feed (app_api SSE) -> Electron main's copy (tests/product_catalog_store_follow.mjs)."""
from __future__ import annotations

import asyncio
import os
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

HEADER = "code,name,market,type,source,updated_at\n"


def _write(path: Path, rows: str, stamp: str = "2026-10-20 08:05:04", *, before_catalog: bool = False) -> None:
    path.write_text(HEADER + "".join(f"{row},{stamp}\n" for row in rows.splitlines()), encoding="utf-8")
    # An initial master is an hour older than the catalog built from it, however long the build takes; a later write
    # keeps its real time: newer than the catalog built before it, older than one rebuilt from it.
    if before_catalog:
        moment = time.time() - 3600
        os.utime(path, (moment, moment))


def _rebuild_events(monkeypatch):
    from service.platform import remediation

    emitted = []
    monkeypatch.setattr(remediation, "emitter", lambda: SimpleNamespace(emit=lambda **kw: emitted.append(kw)))
    return lambda: [e for e in emitted if e.get("mechanism_id") == "reference.catalog_rebuild"]


def _catalog(tmp_path: Path):
    from service.market.projection.product_catalog_service import ProductCatalogService

    shioaji, futu = tmp_path / "shioaji.csv", tmp_path / "futu.csv"
    _write(shioaji, "2330,台積電,tse,stock,shioaji", before_catalog=True)
    _write(futu, "US.AAPL,Apple,us,stock,futu", before_catalog=True)
    catalog_file = tmp_path / "catalog.parquet"
    service = ProductCatalogService(catalog_file, shioaji_master_file=shioaji, futu_master_file=futu)
    assert service.ensure_current()["rebuilt"] is True
    return service, shioaji, futu, catalog_file


def test_a_written_master_rebuilds_the_catalog_as_the_normal_update_not_a_remediation(tmp_path: Path, monkeypatch) -> None:
    pytest.importorskip("pyarrow")
    service, shioaji, _futu, catalog_file = _catalog(tmp_path)
    rebuilds = _rebuild_events(monkeypatch)
    published = []
    service.feed.publish = published.append
    before = service.revision()

    _write(shioaji, "2330,台積電,tse,stock,shioaji\n2454,聯發科,tse,stock,shioaji")   # the 08:05 relogin's new contracts
    result = service.source_written({"source": "shioaji", "revision": "x"})
    assert result["rebuilt"] is True and result["count"] == 3
    assert rebuilds() == [], "the daily update is not a remediation"
    assert published == [{"revision": service.revision()}] and service.revision() != before, "Electron main is told"
    assert [row["code"] for row in service.search("shioaji", "2454")] == ["2454"], "searches see it at once"

    # The stream's next connection opens with the same master state: nothing to do -- not even a re-read -- and
    # nothing recorded.
    monkeypatch.setattr(service, "rebuild", lambda: pytest.fail("the same master state was read again"))
    assert service.source_written({"source": "shioaji"})["rebuilt"] is False
    assert published == [{"revision": service.revision()}] and rebuilds() == []
    # And the next start finds the catalog current: no catalog_stale.
    from service.market.projection.product_catalog_service import ProductCatalogService

    restarted = ProductCatalogService(catalog_file, shioaji_master_file=shioaji, futu_master_file=_futu)
    monkeypatch.setattr(restarted, "rebuild", lambda: pytest.fail("the next start rebuilt a current catalog"))
    assert restarted.ensure_current()["rebuilt"] is False and rebuilds() == []
    assert [row["code"] for row in restarted.search("shioaji", "2454")] == ["2454"], "loaded from the catalog file"


def test_a_write_with_the_same_products_rewrites_and_tells_nothing(tmp_path: Path, monkeypatch) -> None:
    pytest.importorskip("pyarrow")
    service, shioaji, _futu, catalog_file = _catalog(tmp_path)
    rebuilds = _rebuild_events(monkeypatch)
    published = []
    service.feed.publish = published.append
    before = catalog_file.read_bytes()
    _write(shioaji, "2330,台積電,tse,stock,shioaji", stamp="2026-10-21 08:05:03")
    result = service.source_written({"source": "shioaji"})
    assert result["ok"] is True and result["rebuilt"] is False and result["unchanged"] is True
    assert catalog_file.read_bytes() == before and published == [] and rebuilds() == []


def test_a_master_written_while_nothing_listened_is_found_and_recorded_at_start(tmp_path: Path, monkeypatch) -> None:
    pytest.importorskip("pyarrow")
    from service.market.projection.product_catalog_service import ProductCatalogService

    _service, shioaji, futu, catalog_file = _catalog(tmp_path)
    _write(shioaji, "2330,台積電,tse,stock,shioaji\n2454,聯發科,tse,stock,shioaji")   # while the App was closed
    rebuilds = _rebuild_events(monkeypatch)
    restarted = ProductCatalogService(catalog_file, shioaji_master_file=shioaji, futu_master_file=futu)
    assert restarted.ensure_current()["rebuilt"] is True
    assert [e["trigger_reason"] for e in rebuilds()] == ["catalog_stale"]


def test_a_failed_rebuild_after_a_write_is_recorded_and_stated(tmp_path: Path, monkeypatch) -> None:
    pytest.importorskip("pyarrow")
    from service.market.projection import product_catalog_service as module

    service, shioaji, _futu, _catalog_file = _catalog(tmp_path)
    failures = []
    monkeypatch.setattr(module, "record_failure", lambda log, what, exc: failures.append((what, str(exc))))
    monkeypatch.setattr(module, "write_frame", lambda *a, **k: (_ for _ in ()).throw(OSError("disk full")))
    _write(shioaji, "2330,台積電,tse,stock,shioaji\n2454,聯發科,tse,stock,shioaji")
    result = service.source_written({"source": "shioaji"})
    assert result["ok"] is False and "disk full" in result["error"] and service.status()["state"] == "DEGRADED"
    assert failures and "shioaji security master" in failures[0][0]


def test_reads_never_rederive_staleness(tmp_path: Path, monkeypatch) -> None:
    pytest.importorskip("pyarrow")
    service, shioaji, _futu, _catalog_file = _catalog(tmp_path)
    monkeypatch.setattr(service, "ensure_current", lambda **kw: pytest.fail("a read checked the masters"))
    monkeypatch.setattr(service, "rebuild", lambda: pytest.fail("a read rebuilt the catalog"))
    _write(shioaji, "2330,台積電,tse,stock,shioaji\n2454,聯發科,tse,stock,shioaji")
    assert [row["code"] for row in service.search("shioaji", "")] == ["2330"]
    assert len(service.rows()) == 2


def test_the_shioaji_writer_publishes_after_the_master_is_on_disk(tmp_path: Path, monkeypatch) -> None:
    from service.market.reference import security_master_feed
    from service.market.reference.security_master_service import SecurityMasterService

    master = tmp_path / "security_master.csv"
    seen = []
    monkeypatch.setattr(security_master_feed.FEED, "publish", lambda payload: seen.append((payload, master.exists())))
    contract = SimpleNamespace(code="2330", name="台積電", category="24", exchange="TSE")
    api = SimpleNamespace(SecurityType=SimpleNamespace(Stock="STK"),
                          contracts=SimpleNamespace(list=lambda kind: [contract]))
    assert SecurityMasterService(master).update_master(api)["ok"] is True
    assert seen == [({"source": "shioaji", "revision": security_master_feed.master_revision(master)}, True)]


def test_the_shioaji_master_lists_the_index_futures_the_contract_table_lists(tmp_path: Path, monkeypatch) -> None:
    from service.market.reference import futures_contracts as fc
    from service.market.reference import security_master_feed
    from service.market.reference.security_master_service import SecurityMasterService

    monkeypatch.setattr(security_master_feed.FEED, "publish", lambda payload: None)
    txf = fc.FuturesMonth(code="TXFK6", symbol="TXF202611", category="TXF", name="臺股期貨", underlying_code="",
                          unit=200, delivery_month="202611", delivery_date="2026-11-18")
    monkeypatch.setattr(fc, "current_table", lambda: fc.FuturesTable([txf]))
    contract = SimpleNamespace(code="2330", name="台積電", category="24", exchange="TSE")
    api = SimpleNamespace(SecurityType=SimpleNamespace(Stock="STK"), contracts=SimpleNamespace(list=lambda kind: [contract]))
    service = SecurityMasterService(tmp_path / "security_master.csv")
    assert service.update_master(api)["count"] == 2
    rows = service.load_master()
    assert (rows["TXF"].name, rows["TXF"].market, rows["TXF"].type) == ("台指期", "FUT", "future")
    assert "MXF" not in rows, "a category the broker does not list is not a product"


def test_the_futu_writer_publishes_after_the_master_is_on_disk() -> None:
    source = Path("service/market/futu/security_master.py").read_text(encoding="utf-8")
    write = source.index("self._catalog.write_security_master(rows)")
    assert source.index('security_master_feed.publish_written("futu", self.path)') > write


def test_the_feed_stream_opens_with_the_state_now_then_each_change_until_closed() -> None:
    from service.platform.change_feed import ChangeFeed, revision_events

    async def scenario():
        feed = ChangeFeed()
        stream = revision_events(feed, "security_master.changed", lambda: {"revision": "1:1"}, 5.0)
        first = await stream.__anext__()
        threading.Thread(target=feed.publish, args=({"revision": "2:2"},)).start()
        second = await asyncio.wait_for(stream.__anext__(), 2)
        feed.close()
        with pytest.raises(StopAsyncIteration):
            await asyncio.wait_for(stream.__anext__(), 2)
        return first, second

    first, second = asyncio.run(scenario())
    assert first == 'event: security_master.changed\ndata: {"revision": "1:1"}\n\n'
    assert second == 'event: security_master.changed\ndata: {"revision": "2:2"}\n\n'


class _Response:
    def __init__(self, lines, status_code=200, then=None):
        self.lines, self.status_code, self.then = lines, status_code, then

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def iter_lines(self, decode_unicode=True):
        yield from self.lines
        if self.then is not None:
            raise self.then

    def close(self):
        pass


def test_the_app_api_watch_hands_every_write_to_the_catalog_and_records_a_break(monkeypatch, caplog) -> None:
    import requests

    from service.market.reference import security_master_watch as module
    from service.platform import remediation

    events = []

    class Operation:
        def finish(self, outcome, **kw):
            events.append(("finish", outcome))

    monkeypatch.setattr(remediation, "emitter", lambda: SimpleNamespace(
        begin=lambda **kw: events.append(("begin", kw["trigger_reason"])) or Operation()))
    monkeypatch.setattr(module, "authorization_headers", lambda: {"Authorization": "Bearer daemon"})
    written = []
    responses = [
        requests.ConnectionError("refused"),   # the provider is not up yet: logged, not an outage
        _Response(["event: security_master.changed", 'data: {"source": "shioaji", "revision": "1:1"}', "",
                   ": heartbeat", "", 'data: {"source": "shioaji", "revision": "2:2"}', ""],
                  then=requests.ConnectionError("reset")),
        _Response(['data: {"source": "shioaji", "revision": "2:2"}', ""]),
    ]

    class Session:
        def get(self, url, **kw):
            assert url.endswith("/v1/security-master/events") and kw["headers"]["Authorization"] == "Bearer daemon"
            item = responses.pop(0)
            if isinstance(item, Exception):
                raise item
            return item

    watch = module.SecurityMasterWatch("provider_shioaji", written.append, session=Session())
    monkeypatch.setattr(watch._stop, "wait", lambda delay: watch.stop() if not responses else None)
    with caplog.at_level("WARNING", logger=module.__name__):
        watch.run()
    assert [w["revision"] for w in written] == ["1:1", "2:2", "2:2"]
    # The refusal before the first connection is not an outage; the reset after it is, ended by the next connection's
    # first event; the provider ending the stream is a break too, abandoned when the watch stops.
    assert events == [("begin", "stream_error"), ("finish", "succeeded"), ("begin", "eof"), ("finish", "abandoned")]
    # Every break leaves a log line naming the provider and why -- the refusal before the first connection included.
    logged = [r.getMessage() for r in caplog.records if r.name == module.__name__]
    assert len(logged) == 3, logged
    for line, reason, why in zip(logged, ("connect_failed", "stream_error", "eof"),
                                 ("ConnectionError: refused", "ConnectionError: reset", "the provider ended the stream")):
        assert "provider_shioaji" in line and reason in line and why in line, line


def _scripted_session(responses):
    class Session:
        closed = False

        def get(self, url, **kw):
            item = responses.pop(0)
            if isinstance(item, Exception):
                raise item
            return item

        def close(self):
            Session.closed = True

    return Session()


def _recording_emitter(monkeypatch, events):
    from service.platform import remediation

    monkeypatch.setattr(remediation, "emitter", lambda: SimpleNamespace(
        begin=lambda **kw: events.append(("begin", kw["mechanism_id"], kw["trigger_reason"])) or SimpleNamespace(
            finish=lambda outcome, **k: events.append(("finish", kw["mechanism_id"], outcome)))))


def test_a_write_the_catalog_failed_to_take_is_handed_again_at_a_heartbeat_after_the_delay(monkeypatch) -> None:
    from service.market.reference import security_master_watch as module

    events = []
    _recording_emitter(monkeypatch, events)
    monkeypatch.setattr(module, "authorization_headers", lambda: {})
    clock = [1000.0]
    monkeypatch.setattr(module.time, "monotonic", lambda: clock[0])
    answers = [{"ok": False, "error": "PRODUCT_CATALOG_REBUILD_FAILED: OSError: disk full"},
               {"ok": False, "error": "PRODUCT_CATALOG_REBUILD_FAILED: OSError: disk full"},
               {"ok": True, "rebuilt": True}]
    handed = []

    def on_written(payload):
        handed.append(payload["revision"])
        return answers.pop(0)

    class Stream(_Response):
        def iter_lines(self, decode_unicode=True):
            yield 'data: {"source": "shioaji", "revision": "2:2"}'
            yield ""
            yield ": heartbeat"            # inside the first delay: not handed again
            clock[0] += module.CATALOG_RETRY_INITIAL_S
            yield ": heartbeat"            # the first delay passed: handed again, fails, the delay doubles
            clock[0] += module.CATALOG_RETRY_INITIAL_S
            yield ": heartbeat"            # inside the doubled delay
            clock[0] += module.CATALOG_RETRY_INITIAL_S
            yield ": heartbeat"            # handed again and taken

    watch = module.SecurityMasterWatch("provider_shioaji", on_written, session=_scripted_session([Stream([])]))
    monkeypatch.setattr(watch._stop, "wait", lambda delay: watch.stop())
    watch.run()
    assert handed == ["2:2", "2:2", "2:2"]
    retry = [e for e in events if e[1] == "client.security_master_catalog_retry"]
    assert retry == [("begin", "client.security_master_catalog_retry", "catalog_rebuild_failed"),
                     ("finish", "client.security_master_catalog_retry", "succeeded")]
    assert watch._pending is None


def test_a_hand_over_that_raises_is_recorded_and_kept_for_the_retry(monkeypatch) -> None:
    from service.market.reference import security_master_watch as module

    events = []
    _recording_emitter(monkeypatch, events)
    failures = []
    monkeypatch.setattr(module, "record_failure", lambda log, what, exc=None: failures.append((what, str(exc))))
    watch = module.SecurityMasterWatch("provider_futu", lambda payload: (_ for _ in ()).throw(OSError("locked")),
                                       session=_scripted_session([]))
    watch._hand_over({"source": "futu", "revision": "3:3"})
    assert watch._pending == {"source": "futu", "revision": "3:3"}
    assert failures and "provider_futu" in failures[0][0] and "locked" in failures[0][1]
    assert events == [("begin", "client.security_master_catalog_retry", "catalog_rebuild_failed")]


def test_join_waits_for_the_reader_and_closes_the_session(monkeypatch) -> None:
    from service.market.reference import security_master_watch as module

    monkeypatch.setattr(module, "authorization_headers", lambda: {})
    release = threading.Event()

    class Held(_Response):
        def iter_lines(self, decode_unicode=True):
            yield 'data: {"source": "shioaji", "revision": "1:1"}'
            yield ""
            release.wait(5)            # the provider's stream until the provider stops

    session = _scripted_session([Held([])])
    watch = module.SecurityMasterWatch("provider_shioaji", lambda payload: {"ok": True}, session=session)
    watch.start()
    time.sleep(0.1)
    watch.stop()
    assert watch.join(0.1) is False, "still waiting on the stream: reported, not claimed stopped"
    release.set()
    assert watch.join(5) is True and session.closed


def test_a_revision_that_cannot_be_read_never_fails_the_committed_write(tmp_path: Path, monkeypatch) -> None:
    from service.market.reference import security_master_feed

    master = tmp_path / "security_master.csv"
    master.write_text("x", encoding="utf-8")
    failures = []
    monkeypatch.setattr(security_master_feed, "record_failure", lambda log, what, exc=None: failures.append(str(exc)))
    real_stat = Path.stat
    monkeypatch.setattr(Path, "stat", lambda self, **kw: (_ for _ in ()).throw(PermissionError("sharing violation"))
                        if self == master else real_stat(self, **kw))
    seen = []
    monkeypatch.setattr(security_master_feed.FEED, "publish", seen.append)
    notice = security_master_feed.publish_written("shioaji", master)
    assert notice == {"notified": True, "revision": "unreadable:PermissionError"}
    assert seen == [{"source": "shioaji", "revision": "unreadable:PermissionError"}]
    assert failures == ["sharing violation"]

    monkeypatch.setattr(security_master_feed.FEED, "publish", lambda payload: (_ for _ in ()).throw(RuntimeError("feed broken")))
    notice = security_master_feed.publish_written("shioaji", master)
    assert notice["notified"] is False and "feed broken" in notice["error"]


def test_the_shioaji_writer_reports_a_failed_notice_without_failing_the_write(tmp_path: Path, monkeypatch) -> None:
    from service.market.reference import security_master_feed
    from service.market.reference.security_master_service import SecurityMasterService

    master = tmp_path / "security_master.csv"
    monkeypatch.setattr(security_master_feed.FEED, "publish", lambda payload: (_ for _ in ()).throw(RuntimeError("feed broken")))
    contract = SimpleNamespace(code="2330", name="台積電", category="24", exchange="TSE")
    api = SimpleNamespace(SecurityType=SimpleNamespace(Stock="STK"), contracts=SimpleNamespace(list=lambda kind: [contract]))
    result = SecurityMasterService(master).update_master(api)
    assert result["ok"] is True and master.exists()
    assert result["notice"]["notified"] is False


def test_the_daemons_close_the_master_streams_only_once_they_exit() -> None:
    """A stop that fails leaves a live provider: its security-master stream must keep working, so the feed is closed
    at the stop's last step, inside its recorded handling."""
    shioaji = Path("backend/shioaji/daemon_shutdown.py").read_text(encoding="utf-8")
    body = shioaji[shioaji.index("def shutdown_daemon"):shioaji.index("def idle_watchdog")]
    close = body.index('record_shutdown_phase(ctx, "CLOSE_SECURITY_MASTER_STREAMS"')
    assert body.index("try:") < body.index("security_master_feed.FEED.close()") < close
    assert close < body.index("ctx.lifecycle.mark_stopped(reason)") < body.index('"STOP_UVICORN"')
    assert body.count("FEED.close()") == 1


def test_the_futu_daemon_closes_the_master_streams_only_after_a_stop_that_succeeded(monkeypatch) -> None:
    from backend.futu import server
    from service.market.reference import security_master_feed

    closed = []
    monkeypatch.setattr(security_master_feed.FEED, "close", lambda: closed.append(True))
    monkeypatch.setattr(server, "publish_lifecycle", lambda state: None)
    runtime = SimpleNamespace(stop=lambda timeout: {"ok": False, "error": "callbacks still running"})
    daemon = server.FutuDaemon(runtime)
    assert daemon.shutdown("explicit_stop")["ok"] is False
    assert closed == [], "a failed stop keeps the stream of a provider that stays alive"
    daemon.runtime = SimpleNamespace(stop=lambda timeout: {"ok": True})
    assert daemon.shutdown("explicit_stop")["ok"] is True
    assert closed == [True]

def test_stopping_the_watch_does_not_wait_for_the_providers_next_heartbeat(monkeypatch) -> None:
    """A drain stops the watch while its reader waits inside read() for the provider's next heartbeat (20 s). stop()
    returns at once; the provider ending the stream (its stop, after the APIs drained) ends the reader, and that end
    is not an outage (closing the response from the drain would block until that heartbeat)."""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    from service.market.reference import security_master_watch as module
    from service.platform import remediation

    events = []
    monkeypatch.setattr(remediation, "emitter", lambda: SimpleNamespace(
        begin=lambda **kw: events.append(("begin", kw["trigger_reason"])) or SimpleNamespace(
            finish=lambda outcome, **k: events.append(("finish", outcome)))))
    monkeypatch.setattr(module, "authorization_headers", lambda: {})
    connected, end_stream = threading.Event(), threading.Event()

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            self.wfile.write(b'data: {"source": "shioaji", "revision": "1:1"}\n\n')
            self.wfile.flush()
            connected.set()
            end_stream.wait(30)   # no heartbeat until the provider stops

    server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    written = []
    watch = module.SecurityMasterWatch("provider_shioaji", written.append)
    watch.url = f"http://127.0.0.1:{server.server_address[1]}/v1/security-master/events"
    try:
        watch.start()
        assert connected.wait(5)
        time.sleep(0.2)   # the reader is now blocked in read()
        started = time.monotonic()
        watch.stop()
        assert time.monotonic() - started < 0.5
        end_stream.set()   # the provider stops
        watch._thread.join(5)
        assert not watch._thread.is_alive()
    finally:
        end_stream.set()
        server.shutdown()
    # This provider's response is not chunked: its event reaches the reader only with the stream's end, after the
    # stop -- and nothing read after a stop is handed to the catalog.
    assert written == []
    assert ("begin", "eof") not in events and ("begin", "stream_error") not in events
