import os
import inspect
import pytest

from service.market.shioaji.daemon_client import MarketDaemonClient
from service.platform.process_observer import process_exists


def test_daemon_process_exists_supports_windows_pid_queries() -> None:
    assert process_exists(os.getpid()) is True
    assert process_exists(2_147_483_647) is False


def test_fastapi_client_cannot_acquire_process_spawn_authority() -> None:
    with pytest.raises(TypeError):
        MarketDaemonClient(allow_spawn=True)
    source = inspect.getsource(MarketDaemonClient)
    assert "allow_spawn" not in source
    assert "subprocess" not in source
