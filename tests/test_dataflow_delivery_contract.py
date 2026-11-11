import asyncio

from backend.shioaji.stream_hub import DaemonStreamHub


def test_slow_consumer_is_disconnected_without_rejecting_healthy_client():
    class Socket:
        def __init__(self): self.closed=False
        async def close(self, **kwargs): self.closed=True
    async def run():
        hub=DaemonStreamHub(); slow,healthy=Socket(),Socket()
        slow_queue=asyncio.Queue(maxsize=1)
        slow_queue.put_nowait('occupied')
        hub._queues={slow:slow_queue,healthy:asyncio.Queue(maxsize=2)}
        assert await hub._enqueue(slow,'next') is False
        assert slow not in hub._queues and healthy in hub._queues
        assert await hub._enqueue(healthy,'next') is True
        assert hub.stats()['lag_disconnects']==1
        assert slow.closed
    asyncio.run(run())
