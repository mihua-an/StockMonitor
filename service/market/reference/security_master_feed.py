"""A provider's security-master writes, told to the product catalog's owner.

The security masters are written in the provider processes (Shioaji: after every login takes the day's contracts,
including the 08:05 daily relogin; Futu: the OpenD worker's refresh). The product catalog derived from them lives in
app_api. The writer publishes on this process's feed right after the new master is on disk; the provider serves the
feed as Server-Sent Events (Shioaji ``/v1/security-master/events``, Futu ``/v1/futu/security-master/events``, daemon
credential) and app_api follows it (service/market/reference/security_master_watch.py) and rebuilds the catalog.

Committing the master and telling about it are two results: ``publish_written`` (the one post-commit notifier both
writers call) never raises into the writer, so a notice that could not be made never turns a committed write into a
failed one. A revision that cannot be read is recorded and sent as ``unreadable``: the catalog judges the masters by
its own reading of them, and a catalog that cannot take the write either is handed it again by the watch.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from service.platform.change_feed import ChangeFeed, revision_events
from service.platform.failure_record import record_failure

_log = logging.getLogger(__name__)

EVENT = "security_master.changed"
STREAM_HEARTBEAT_S = 20.0

# One per process: a provider process writes exactly one source's master.
FEED = ChangeFeed()


def master_revision(path: str | Path) -> str:
    """The written master's identity (size and modification time); ``missing`` before its first write,
    ``unreadable:<error>`` when the file cannot be looked at (recorded)."""
    try:
        stat = Path(path).stat()
    except FileNotFoundError:  # not an error: no master written yet is a revision of its own
        return "missing"
    except OSError as exc:
        record_failure(_log, f"reading the revision of the security master {Path(path).name}", exc)
        return f"unreadable:{type(exc).__name__}"
    return f"{stat.st_size}:{stat.st_mtime_ns}"


def change(source: str, path: str | Path) -> dict[str, Any]:
    return {"source": source, "revision": master_revision(path)}


def publish_written(source: str, path: str | Path) -> dict[str, Any]:
    """Called by the master's writer once the new file replaced the old one. Never raises: the write is committed
    whatever this answers; ``notified`` says whether the notice went out (a failure is recorded)."""
    try:
        payload = change(source, path)
        FEED.publish(payload)
    except Exception as exc:  # noqa: BLE001 -- recorded; the committed write stands, the stream's next open carries it
        record_failure(_log, f"telling about the {source} security master written", exc)
        return {"notified": False, "error": f"{type(exc).__name__}: {exc}"[:300]}
    return {"notified": True, "revision": payload["revision"]}


def events_response(source: str, path: str | Path):
    from fastapi.responses import StreamingResponse

    return StreamingResponse(revision_events(FEED, EVENT, lambda: change(source, path), STREAM_HEARTBEAT_S),
                             media_type="text/event-stream", headers={"Cache-Control": "no-store"})
