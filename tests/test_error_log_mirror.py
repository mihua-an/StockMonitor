"""The error log must contain errors, not every line whose text happens to say "error".

ErrorOnlyMirror used to decide with a broad word match (\\berror\\b, \\bfailed\\b, \\btimeout\\b,
unavailable, disconnected, ...) applied to every line at any level. Because
service/platform/logging_setup.py configures the root logger at DEBUG, that copied ordinary wire traffic
into the error log: one measured run mirrored 18013 identical
`websockets.client: < TEXT '{"error":"unknown command",...}'` DEBUG frames, and
var/output/runtime_errors.log reached 8.3 MB (plus a 29 MB rotated sibling) while containing no
actual error. Selection is by log LEVEL now, with a narrow fallback for level-less output.
"""
from __future__ import annotations

import io

from service.platform.error_logging import ErrorOnlyMirror


def _mirror(tmp_path, lines):
    primary = io.StringIO()
    path = tmp_path / "runtime_errors.log"
    mirror = ErrorOnlyMirror(primary, error_path=path, source="SHIOAJI_DAEMON")
    for line in lines:
        mirror.write(line + "\n")
    mirrored = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    return primary.getvalue(), mirrored


NOISE = [
    '2026-09-26 04:32:28,220 DEBUG websockets.client: < TEXT \'{"error":"unknown command","type":"error"}\' [42 bytes]',
    "2026-09-26 04:32:28,220 INFO backend.futu.server: [FUTU DAEMON] active clients=1",
    "2026-09-26 04:32:46,874 DEBUG websockets.client: % sent keepalive ping",
    "2026-09-26 05:00:00,000 WARNING service.market.shioaji.session: daemon disconnected, retrying",
    "2026-09-26 05:00:00,000 INFO service.market.shioaji.subscriptions: subscription failed for 2330, will retry",
]


def test_ordinary_traffic_is_never_mirrored_into_the_error_log(tmp_path):
    primary, mirrored = _mirror(tmp_path, NOISE)
    assert primary.splitlines() == NOISE, "the process's own stdout must be untouched"
    assert mirrored == [], f"non-error lines were copied into the error log: {mirrored}"


def test_real_errors_and_their_tracebacks_are_mirrored(tmp_path):
    lines = [
        "2026-09-26 05:20:12,809 ERROR service.platform.http.errors: Unhandled exception in GET /api/monitor/context/2344",
        "Traceback (most recent call last):",
        '  File "C:\\\\app\\\\service\\\\x.py", line 218, in build',
        "NameError: name 'capacity' is not defined",
        "ERROR:    Exception in ASGI application",
        "2026-09-26 05:20:13,000 CRITICAL service.market.shared.rust_live: live ingress lost",
    ]
    _, mirrored = _mirror(tmp_path, lines)
    text = "\n".join(mirrored)
    assert "Unhandled exception in GET" in text
    assert "Traceback (most recent call last)" in text
    assert "NameError" in text, "a traceback's own final line must survive with it"
    assert "Exception in ASGI application" in text
    assert "live ingress lost" in text


def test_an_error_record_ends_at_the_next_record_header(tmp_path):
    """Only the error record's own continuation lines come with it; the next record, whatever its
    level, is judged by its own header. Observed: a shioaji startup ERROR pulled the five keyring
    DEBUG records logged right after it into error-shioaji_daemon.log."""
    lines = [
        "2026-11-03 23:06:05,069 ERROR service.market.shioaji.maintenance: futures contract table not written",
        "2026-11-03 23:06:05,131 DEBUG keyring.backend: Loading KWallet",
        "2026-11-03 23:06:05,155 DEBUG win32ctypes.core.ctypes: Loaded ctypes backend",
        "2026-11-03 23:06:05,176 INFO service.market.shioaji.session: login ok",
        *NOISE,
    ]
    _, mirrored = _mirror(tmp_path, lines)
    assert len(mirrored) == 1 and "futures contract table not written" in mirrored[0], mirrored


def test_a_bare_traceback_ends_at_its_exception_line(tmp_path):
    lines = [
        "Traceback (most recent call last):",
        '  File "x.py", line 1, in <module>',
        "    boom()",
        "RuntimeError: boom",
        "plain stdout after the traceback",
    ]
    _, mirrored = _mirror(tmp_path, lines)
    assert [line.split("] [SHIOAJI_DAEMON] ", 1)[1] for line in mirrored] == lines[:4], mirrored


def test_noise_far_from_any_error_is_never_mirrored(tmp_path):
    lines = [*(NOISE * 6), "2026-09-26 05:00:09,000 ERROR b: second"]
    _, mirrored = _mirror(tmp_path, lines)
    assert len(mirrored) == 1 and "ERROR b: second" in mirrored[0]
