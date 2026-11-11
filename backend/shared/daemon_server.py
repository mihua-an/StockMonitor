"""The provider daemons' HTTP server: READY in the owner record only once it serves.

Health attaches to a READY owner by asking its /health as that instance. Published from the app's lifespan, READY would
come before uvicorn binds its socket, and a cold start would answer its first /health late and read as a broken owner.
So the lifecycle is published from the server's own startup, after the sockets listen.
"""
from __future__ import annotations

import uvicorn

from service.market.shared.daemon_singleton import publish_lifecycle


class ReadyWhenServing(uvicorn.Server):
    """A uvicorn server that marks its daemon READY once it is listening (and not already asked to exit)."""

    async def startup(self, sockets=None) -> None:
        await super().startup(sockets=sockets)
        if self.started and not self.should_exit:
            publish_lifecycle("READY")
