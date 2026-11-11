"""A provider daemon is READY in its owner record only once its HTTP server listens: Health attaches to a READY owner by
asking its /health, and READY published before the socket was bound read as a broken owner on every cold start."""
from __future__ import annotations

import socket
import threading
import time

import uvicorn


def test_ready_is_published_after_the_socket_listens(monkeypatch):
    from backend.shared import daemon_server

    seen = []

    def publish(state):
        # The port must accept a connection at the moment READY is published.
        with socket.create_connection(("127.0.0.1", server.servers[0].sockets[0].getsockname()[1]), timeout=2):
            seen.append((state, server.started))

    monkeypatch.setattr(daemon_server, "publish_lifecycle", publish)

    async def app(scope, receive, send):  # a minimal ASGI app: lifespan and nothing else
        if scope["type"] == "lifespan":
            while True:
                message = await receive()
                if message["type"] == "lifespan.startup":
                    await send({"type": "lifespan.startup.complete"})
                elif message["type"] == "lifespan.shutdown":
                    await send({"type": "lifespan.shutdown.complete"})
                    return

    server = daemon_server.ReadyWhenServing(uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not seen and time.monotonic() < deadline:
        time.sleep(0.02)
    server.should_exit = True
    thread.join(10)
    assert seen == [("READY", True)]


def test_a_server_asked_to_exit_during_startup_is_not_ready(monkeypatch):
    from backend.shared import daemon_server

    seen = []
    monkeypatch.setattr(daemon_server, "publish_lifecycle", seen.append)

    async def app(scope, receive, send):
        if scope["type"] == "lifespan":
            message = await receive()
            if message["type"] == "lifespan.startup":
                server.should_exit = True
                await send({"type": "lifespan.startup.complete"})
            while (await receive())["type"] != "lifespan.shutdown":
                pass
            await send({"type": "lifespan.shutdown.complete"})

    server = daemon_server.ReadyWhenServing(uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    thread.join(10)
    assert seen == []
