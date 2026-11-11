"""Small lifecycle contract; broker capabilities remain source-specific."""

from __future__ import annotations

from typing import Any

SOURCE_STATUS_CONTRACT_VERSION = 1
SOURCE_LIFECYCLES = frozenset({
    "disabled", "starting", "started", "stopping", "stopped",
    "start_failed", "stop_failed",
})


# The one body every layer returns for a source that is not selected (API 409s, provider runtimes, disabled clients).
def disabled_source(source: str) -> dict:
    return {"ok": False, "source": source, "enabled": False, "error": "SOURCE_DISABLED",
            "message": f"Source {source} is not enabled", "accepted": False,
            "lifecycle": "disabled", "connected": False, "running": False,
            "need_restart": False, "source_status": {
                "contract_version": SOURCE_STATUS_CONTRACT_VERSION, "source": source, "enabled": False,
                "lifecycle": "disabled", "start_accepted": False, "services_started": False,
                "broker_connected": False, "services_ready": False, "health": "disabled",
                "reason": "SOURCE_DISABLED"}}


def source_status(source: str, lifecycle: str, provider: dict[str, Any], *,
                  services_started: bool = False, error: str | None = None) -> dict[str, Any]:
    """Additive status, derived from the owner's session-aware readiness.

    Never infer market activity from an alive thread or absence of ticks.
    An idle/closed session is not a failure; absent readiness is unknown.
    """
    readiness = provider.get("readiness") or {}
    # The readiness contract is the one projection of "is this provider's
    # authoritative callback source up", and it is the only one that knows about
    # a non-SDK callback source.  The raw ``connected`` flag stays in the OR so
    # live behavior is unchanged: there ``readiness["connected"]`` is
    # ``connected and worker_alive``, a subset of this same value.
    connected = bool(provider.get("connected") or readiness.get("connected")) and lifecycle == "started"
    state = str(readiness.get("state") or "UNKNOWN").upper()
    canonical = readiness.get("canonical_ready")
    ready = bool(services_started and connected and canonical is True and
                 state in {"READY", "MARKET_CLOSED"})
    if lifecycle in {"stopped", "stopping", "disabled"}:
        health = lifecycle
    elif lifecycle in {"start_failed", "stop_failed"}:
        health = "failed"
    elif error or provider.get("last_error") or readiness.get("stale") or canonical is False:
        health = "degraded"
    elif ready:
        health = "idle" if state == "MARKET_CLOSED" else "ready"
    else:
        health = "waiting" if services_started else "starting"
    if lifecycle not in SOURCE_LIFECYCLES:
        raise ValueError(f"invalid source lifecycle: {lifecycle}")
    return {"contract_version": SOURCE_STATUS_CONTRACT_VERSION, "source": source, "enabled": True,
            "lifecycle": lifecycle, "start_accepted": lifecycle in {"starting", "started"},
            "services_started": bool(services_started), "broker_connected": connected,
            "services_ready": ready, "health": health,
            "reason": error or provider.get("last_error") or readiness.get("reason"),
            }


