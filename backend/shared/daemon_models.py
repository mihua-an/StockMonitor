"""HTTP request contracts shared by both source daemons' client-lease surfaces (``/v1/client/*``).

These carry no Shioaji- or Futu-specific fields -- a daemon's own ``ClientAttachRequest`` subclasses the generic
shape here only to override a per-source default (e.g. ``client_name``).
Moved out of ``backend/shioaji/models.py`` (former ``backend.shioaji_daemon_models``)
because ``backend/futu/server.py`` importing daemon-specific-looking classes
from a sibling source's own module was exactly the cross-source coupling
docs/development/directory_recommendations.md's process-wiring boundary forbids --
neither daemon owns this shape, so neither daemon's own module should be its
home.
"""
from __future__ import annotations

from pydantic import BaseModel


class ClientAttachRequest(BaseModel):
    client_id: str = ""
    connection_id: str = "control"
    lease_id: str = ""
    client_name: str = "fastapi"
    client_pid: int | None = None
    electron_pid: int | None = None


class ClientLeaseRequest(BaseModel):
    client_id: str
    connection_id: str = "control"
    lease_id: str = ""
