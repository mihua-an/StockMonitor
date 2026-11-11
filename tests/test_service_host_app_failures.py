"""A 2xx answer with ``ok: false`` is counted as an operation failure.

Host metrics counted only status >= 500, so a sync or write that failed on every call (HTTP 200, ``ok: false``)
left the service's metrics looking healthy.
"""
from __future__ import annotations

import asyncio
import json

from fastapi import FastAPI
from fastapi.responses import PlainTextResponse

from api.service_host import ServiceHost, ServiceHostMiddleware, _BodyProbe


def _client():
    host = ServiceHost("probe", port=None, config_revision=None)
    app = FastAPI()

    @app.get("/v1/sync/fail")
    def fail():
        return {"ok": False, "error": "GAS unreachable"}

    @app.get("/v1/sync/pass")
    def ok():
        return {"ok": True, "results": [{"ok": False}]}

    @app.get("/v1/sync/text")
    def text():
        return PlainTextResponse('{"ok": false}')

    return ServiceHostMiddleware(app, host=host), host


def _get(asgi, path):
    sent = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        sent.append(message)

    scope = {"type": "http", "method": "GET", "path": path, "raw_path": path.encode(), "query_string": b"",
             "headers": [], "http_version": "1.1", "scheme": "http", "server": ("test", 80), "client": ("t", 1),
             "root_path": "", "app": None}
    asyncio.run(asgi(scope, receive, send))
    return b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")


def test_ok_false_is_an_operation_failure_and_nothing_else_is():
    asgi, host = _client()
    assert json.loads(_get(asgi, "/v1/sync/fail"))["ok"] is False, "the body still reaches the caller"
    _get(asgi, "/v1/sync/pass")      # a nested ok:false is a detail of a successful answer
    _get(asgi, "/v1/sync/text")      # not JSON
    metrics = {m["name"]: m["value"] for m in host.requests.document("probe")}
    assert metrics["http.app_failures_total"] == 1
    assert metrics["http.errors_total"] == 0
    assert metrics["http.requests_total"] == 3
    assert metrics["http.app_failures/v1"] == 1


def test_idle_latency_window_drops_old_samples_on_read(monkeypatch):
    """Samples older than 60 s leave the histogram even when no new request arrives."""
    from api import service_host

    clock = [1000.0]
    monkeypatch.setattr(service_host.time, "monotonic", lambda: clock[0])
    metrics = service_host.RequestMetrics()
    metrics.begin("/v1")
    metrics.end("/v1", 200, 1500.0)
    clock[0] += 120.0
    latency = next(m for m in metrics.document("probe") if m["name"] == "http.latency/v1")
    assert latency["samples"] == 0 and latency["availability"] == "NO_SAMPLE", latency


def _probe(*chunks):
    probe = _BodyProbe()
    probe.start({"headers": [(b"content-type", b"application/json")]})
    for chunk in chunks:
        probe.add(chunk)
    return probe


def test_the_body_probe_copies_at_most_its_limit():
    failed = b'{"ok": false}'
    pad = b" " * (_BodyProbe.LIMIT - len(failed))
    assert _probe(failed + pad).reports_failure(), "exactly the limit is still read"
    huge = _probe(failed + pad + b" ")
    assert not huge.reports_failure(), "one byte over in a single chunk is not read"
    assert huge._chunks == [] and huge._size == 0, "and nothing of it is kept"
    split = _probe(failed + pad, b" ", b"x" * 1_000_000)
    assert not split.reports_failure() and split._chunks == [], "crossing the limit across chunks drops the copy"
    assert _probe(b'{"ok": ', b"false}").reports_failure(), "a small body in several chunks is read whole"
