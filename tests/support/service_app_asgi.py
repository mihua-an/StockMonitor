"""A bare business-API service app (api.service_host's middleware stack, no resources) and one raw ASGI request to it:
what one service admits, all of them admit."""
import asyncio

from api.service_host import create_service_app


def create_app(*, client_token):
    return create_service_app("settings_api", lambda app, host: None, client_token=client_token)


def request(app, method="DELETE", headers=(), path="/api/settings/shioaji/credentials", kind="http", query=b""):
    async def run():
        output = []
        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}
        async def send(message):
            output.append(message)
        await app({"type": kind, "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method,
                   "scheme": "http", "path": path, "raw_path": path.encode(), "root_path": "",
                   "query_string": query, "headers": list(headers), "client": ("127.0.0.1", 123),
                   "server": ("127.0.0.1", 8000)}, receive, send)
        return output
    return asyncio.run(run())
