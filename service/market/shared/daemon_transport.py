from __future__ import annotations

import errno
import time
from typing import Any

import requests
from requests.adapters import HTTPAdapter
from urllib3 import HTTPConnectionPool

from service.platform.daemon_auth import authorization_headers

# Keep-alive contract between the provider daemons' HTTP servers and this transport. A server closes a connection
# that sat idle for its keep-alive; a request sent on that connection in the same few milliseconds is reset (the
# server's close and the client's send cross on the wire, and a POST cannot be resent blindly). So the client is the
# one that closes: it never reuses a connection idle for DAEMON_CLIENT_IDLE_SECONDS, and the servers keep idle
# connections open twice as long, which leaves the server's close nothing to race.
DAEMON_CLIENT_IDLE_SECONDS = 30.0
DAEMON_SERVER_KEEP_ALIVE_SECONDS = int(2 * DAEMON_CLIENT_IDLE_SECONDS)


class _IdleRetiringPool(HTTPConnectionPool):
    """A connection pool that closes, instead of reusing, a connection idle for DAEMON_CLIENT_IDLE_SECONDS; the
    pool then opens a fresh one for the request."""

    def _put_conn(self, conn: Any) -> None:
        if conn is not None:
            conn.idle_since = time.monotonic()
        super()._put_conn(conn)

    def _get_conn(self, timeout: float | None = None) -> Any:
        conn = super()._get_conn(timeout)
        idle_since = getattr(conn, "idle_since", None)
        if idle_since is not None and time.monotonic() - idle_since >= DAEMON_CLIENT_IDLE_SECONDS:
            conn.close()
        return conn


class _DaemonAdapter(HTTPAdapter):
    def init_poolmanager(self, *args: Any, **kwargs: Any) -> None:
        super().init_poolmanager(*args, **kwargs)
        self.poolmanager.pool_classes_by_scheme = {"http": _IdleRetiringPool}


def _daemon_session() -> requests.Session:
    session = requests.Session()
    session.mount("http://", _DaemonAdapter())
    return session


class DaemonTransportError(RuntimeError):
    """``str()`` is a fixed message of this module's own; the underlying library text (it names the URL, host and port,
    and the OS error) stays in ``detail`` for the log only: MarketDaemonError(str(exc)) and
    the API error bodies would carry it to the client."""

    def __init__(self, message: str, *, classification: str, status_code: int | None = None, detail: str = "") -> None:
        super().__init__(message)
        self.classification = classification
        self.status_code = status_code
        self.detail = detail


_WSAECONNREFUSED = 10061


def _connection_refused(exc: BaseException) -> bool:
    """Whether the OS refused the connection, read from the error itself anywhere in the chain (requests wraps
    urllib3, which wraps the socket error) -- never from its text, which is localized and changes with the library."""
    seen: set[int] = set()
    pending: list[Any] = [exc]
    while pending:
        current = pending.pop()
        if not isinstance(current, BaseException) or id(current) in seen:
            continue
        seen.add(id(current))
        if isinstance(current, ConnectionRefusedError):
            return True
        if isinstance(current, OSError) and (current.errno == errno.ECONNREFUSED
                                              or getattr(current, "winerror", None) == _WSAECONNREFUSED):
            return True
        pending.extend([current.__cause__, current.__context__, getattr(current, "reason", None), *current.args])
    return False


class DaemonHttpTransport:
    """Provider-neutral localhost JSON transport; owns no compatibility policy."""

    def __init__(self, host: str, port: int, *, session: requests.Session | None = None) -> None:
        self.base_url = f"http://{host}:{int(port)}"
        self.session = session or _daemon_session()

    def request(self, method: str, path: str, *, params: dict[str, Any] | None = None,
                json_body: dict[str, Any] | None = None, timeout: float = 3.0) -> dict[str, Any]:
        try:
            response = self.session.request(
                method, f"{self.base_url}{path}", params=params, json=json_body,
                headers=authorization_headers(), timeout=timeout,
            )
        except requests.Timeout as exc:
            raise DaemonTransportError(f"daemon 請求逾時（{method} {path}）", classification="TIMEOUT", detail=str(exc)) from exc
        except requests.ConnectionError as exc:
            detail = str(exc)
            refused = _connection_refused(exc)
            raise DaemonTransportError("daemon 拒絕連線（未啟動或正在重啟）" if refused else "無法連線到 daemon",
                                       classification="CONNECTION_REFUSED" if refused else "NETWORK_UNREACHABLE",
                                       detail=detail) from exc
        except requests.RequestException as exc:
            raise DaemonTransportError(f"daemon 請求失敗（{type(exc).__name__}）", classification="NETWORK_ERROR",
                                       detail=str(exc)) from exc
        if response.status_code >= 400:
            raise DaemonTransportError(f"HTTP {response.status_code}", classification="HTTP_ERROR", status_code=response.status_code)
        try:
            payload = response.json()
        except Exception as exc:
            raise DaemonTransportError("daemon returned invalid JSON", classification="INVALID_RESPONSE", status_code=response.status_code) from exc
        if not isinstance(payload, dict):
            raise DaemonTransportError("daemon response is not an object", classification="INVALID_RESPONSE", status_code=response.status_code)
        return payload

    def get(self, path: str, *, params: dict[str, Any] | None = None, timeout: float = 3.0) -> dict[str, Any]:
        return self.request("GET", path, params=params, timeout=timeout)

    def post(self, path: str, *, json_body: dict[str, Any] | None = None,
             params: dict[str, Any] | None = None, timeout: float = 3.0) -> dict[str, Any]:
        return self.request("POST", path, params=params, json_body=json_body, timeout=timeout)
