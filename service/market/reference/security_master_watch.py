"""app_api follows a provider's security-master writes (security_master_feed.py) and hands each to the catalog.

One thread per enabled provider holds the provider's SSE stream open with the daemon credential app_api already
holds for the provider's data routes. The stream's first event is the master as it is now, so a write made while the
stream was down is not lost: the catalog compares it with the state it was built from and rebuilds only on a
difference. A dead connection is noticed by the stream's heartbeat (read timeout); the stream is then opened again
with backoff, and the outage is one recorded recovery (``client.security_master_events_reconnect``). Before the
first connection the provider may simply not be up yet: those refusals are logged, not recorded as an outage.

A write the catalog failed to take (``source_written`` answered ``ok: false`` or raised) is not left waiting for the
next write: the watch keeps that master state and hands it again at the first stream event (a write or a heartbeat)
after a doubling, capped delay -- one recorded recovery (``client.security_master_catalog_retry``) until the catalog
takes it. The reader thread is the only one that calls the catalog: once ``join`` saw it end, nothing this watch
started can write the catalog any more.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any, Callable

import requests

from service.market.shared.daemon_connection import ReconnectBackoff
from service.platform.daemon_auth import authorization_headers
from service.platform.failure_record import record_failure
from service.platform.remediation import Recovery

_log = logging.getLogger(__name__)

EVENTS_PATHS = {"provider_shioaji": "/v1/security-master/events", "provider_futu": "/v1/futu/security-master/events"}
# The provider sends a heartbeat comment every security_master_feed.STREAM_HEARTBEAT_S (20 s); three missed is dead.
READ_TIMEOUT_S = 60.0
# A master state the catalog failed to take is handed again at the first stream event after this delay.
CATALOG_RETRY_INITIAL_S = 20.0
CATALOG_RETRY_MAX_S = 300.0
# What parse_events yields for a heartbeat comment: the reader's turn to hand a failed master state again.
HEARTBEAT = object()


def parse_events(lines) -> Any:
    """Yields each SSE event's decoded ``data``, and ``HEARTBEAT`` for each comment line; event names are framing."""
    data: list[str] = []
    for line in lines:
        if line is None:
            continue
        if line == "":
            if data:
                yield json.loads("\n".join(data))
                data = []
            continue
        if line.startswith("data:"):
            data.append(line[5:].lstrip())
        elif line.startswith(":"):
            yield HEARTBEAT


class SecurityMasterWatch:
    def __init__(self, service_id: str, on_written: Callable[[dict[str, Any]], Any], *,
                 session: requests.Session | None = None) -> None:
        from config.network_settings import endpoint

        host, port = endpoint(service_id)
        self.service_id = service_id
        self.url = f"http://{host}:{int(port)}{EVENTS_PATHS[service_id]}"
        self._on_written = on_written
        self._session = session or requests.Session()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.recovery = Recovery(component="security_master_watch", mechanism_id="client.security_master_events_reconnect")
        self.catalog_retry = Recovery(component="security_master_watch", mechanism_id="client.security_master_catalog_retry")
        self._retry_backoff = ReconnectBackoff(CATALOG_RETRY_INITIAL_S, CATALOG_RETRY_MAX_S, 2.0)
        self._pending: dict[str, Any] | None = None   # the master state the catalog has not taken yet
        self._retry_at = 0.0
        self.received = 0

    def start(self) -> None:
        self._thread = threading.Thread(target=self.run, name=f"SecurityMasterWatch-{self.service_id}", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        # Only the flag: closing the response from this thread blocks on the lock its reader holds inside read() until
        # the provider's next heartbeat (up to 20 s per watch). The watch is told to stop on drain, before the providers
        # stop; the provider stopping ends the stream and the reader, seeing the flag, exits without recording an
        # outage. The flag is checked before every hand-over, so nothing reaches the catalog after this returns except
        # a hand-over already running -- which ``join`` waits for.
        self._stop.set()

    def join(self, timeout_s: float) -> bool:
        """After ``stop``: waits up to ``timeout_s`` for the reader to end, then closes the HTTP session. True when the
        reader ended; False when it still waits on the provider's stream (it hands nothing more to the catalog)."""
        thread = self._thread
        if thread is not None:
            thread.join(timeout_s)
        ended = thread is None or not thread.is_alive()
        try:
            self._session.close()
        except Exception as exc:  # noqa: BLE001 -- recorded; the process is closing the watch anyway
            record_failure(_log, f"closing the {self.service_id} security-master watch's HTTP session", exc)
        return ended

    def _hand_over(self, payload: dict[str, Any]) -> None:
        """Gives the catalog one master state; a failure keeps it to be handed again after the retry delay."""
        try:
            result = self._on_written(payload)
        except Exception as exc:  # noqa: BLE001 -- recorded below and handed again after the delay
            record_failure(_log, f"handing the {self.service_id} security master to the product catalog", exc)
            result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"[:300]}
        if not (isinstance(result, dict) and result.get("ok") is False):
            self._pending = None
            self._retry_backoff.reset()
            self.catalog_retry.finish("succeeded", detail={"service_id": self.service_id})
            return
        self._pending = payload
        delay = self._retry_backoff.next_delay()
        self._retry_at = time.monotonic() + delay
        error = str(result.get("error") or result.get("state") or "ok: false")[:300]
        self.catalog_retry.failed("catalog_rebuild_failed", detail={"service_id": self.service_id, "error": error})
        _log.warning("[SECURITY MASTER] the product catalog did not take the %s master (%s); handing it again in %.0f s",
                     self.service_id, error, delay)

    def _retry_due(self) -> bool:
        return self._pending is not None and time.monotonic() >= self._retry_at

    def _record_break(self, reason: str, detail: str, connected_once: bool) -> None:
        if connected_once:
            self.recovery.failed(reason, detail={"service_id": self.service_id, "error": detail})
        _log.warning("[SECURITY MASTER] %s events stream %s (%s); connecting again", self.service_id, reason, detail)

    def run(self) -> None:
        backoff = ReconnectBackoff(0.5, 30.0, 2.0)
        connected_once = False
        while not self._stop.is_set():
            opened = False
            try:
                with self._session.get(self.url, headers={**authorization_headers(), "Accept": "text/event-stream"},
                                       stream=True, timeout=(3.0, READ_TIMEOUT_S)) as response:
                    if response.status_code >= 400:
                        raise requests.HTTPError(f"HTTP {response.status_code}")
                    opened = connected_once = True
                    if self._stop.is_set():   # stopped while this connection opened
                        break
                    for payload in parse_events(response.iter_lines(decode_unicode=True)):
                        if self._stop.is_set():
                            break
                        if payload is HEARTBEAT:
                            if self._retry_due():
                                self._hand_over(self._pending)
                            continue
                        self.received += 1
                        # The connection holds and delivered the master's state: an outage is over.
                        backoff.reset()
                        self.recovery.finish("succeeded", detail={"service_id": self.service_id})
                        self._hand_over(payload)
            except Exception as exc:  # noqa: BLE001 -- every break is recorded (or logged before the first connection)
                if self._stop.is_set():   # not an error: the stop (or the provider's planned stop after it) ended the stream
                    break
                reason = ("http_failure" if isinstance(exc, requests.HTTPError)
                          else "connect_failed" if not opened
                          else "stream_error")
                self._record_break(reason, f"{type(exc).__name__}: {exc}"[:300], connected_once)
            else:
                if self._stop.is_set():
                    break
                self._record_break("eof", "the provider ended the stream", connected_once)
            self._stop.wait(backoff.next_delay())
        self.recovery.finish("abandoned", detail={"service_id": self.service_id, "reason": "stopped"})
        self.catalog_retry.finish("abandoned", detail={"service_id": self.service_id, "reason": "stopped"})
