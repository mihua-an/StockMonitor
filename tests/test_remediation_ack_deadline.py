"""A ledger that accepts the pipe and stops acknowledging used to block the emitter's read forever: it stayed
"connected", never reconnected, and its queue filled. Now an acknowledgement has a deadline; past it the connection
is dropped, the event stays queued and is delivered on the next connection (R15-16)."""
from __future__ import annotations

import os
import struct
import threading
import time
import uuid
from multiprocessing.connection import Listener

import pytest

from service.platform import remediation

pytestmark = pytest.mark.skipif(os.name != "nt", reason="the Windows named-pipe read is the one that cannot time out by itself")


def test_a_silent_ledger_times_out_and_the_event_is_sent_again():
    address = rf"\\.\pipe\stockmonitor-test-{uuid.uuid4().hex}"
    listener = Listener(address, family="AF_PIPE")
    received: list[int] = []

    def ledger():
        silent = listener.accept()               # takes the frame, never acknowledges
        silent.recv_bytes()
        received.append(1)
        honest = listener.accept()
        honest.recv_bytes()
        received.append(2)
        honest.send_bytes(struct.pack("<Q", 1))
        time.sleep(0.5)
        silent.close()
        honest.close()

    server = threading.Thread(target=ledger, daemon=True)
    server.start()
    emitter = remediation.RemediationEmitter(service_id="test", pipe_path=address)
    emitter._ack_timeout = 0.3
    try:
        emitter.emit(component="c", mechanism_id="sink.client_loss", trigger_reason="queue_full", outcome="failed")
        assert emitter.flush(timeout=5.0), emitter.status()
        status = emitter.status()
        assert received == [1, 2]
        assert status["ack_timeouts"] == 1
        assert status["delivered"] == 1
        assert status["last_ack_at"]
        assert "acknowledge" in (status["last_error"] or "")
    finally:
        emitter.close()
        server.join(timeout=2)
        listener.close()
