from __future__ import annotations

import threading
from typing import Any, Callable, Generic, TypeVar

T = TypeVar("T")


class LazyComponent(Generic[T]):
    """Thread-safe lazy owner for heavyweight optional service components.

    The proxy keeps backend module import and FastAPI readiness independent from
    ML/training stacks.  The concrete service is created on the first real use
    and then retained for the lifetime of the process.
    """

    def __init__(self, name: str, factory: Callable[[], T]) -> None:
        self.name = str(name or "component")
        self._factory = factory
        self._instance: T | None = None
        self._lock = threading.RLock()
        self._closing = threading.Event()

    def freeze(self) -> None:
        """Fence new allocation immediately, even while a factory holds the lock."""
        self._closing.set()

    def peek(self, timeout: float = 5.0) -> T | None:
        """Observe an already-built resource without allocating one during cleanup."""
        if not self._lock.acquire(timeout=timeout):
            raise TimeoutError(f"{self.name} initialization is still running")
        try:
            return self._instance
        finally:
            self._lock.release()

    @property
    def loaded(self) -> bool:
        with self._lock:
            return self._instance is not None

    def get(self) -> T:
        if self._closing.is_set():
            raise RuntimeError(f"{self.name} is shutting down")
        instance = self._instance
        if instance is not None:
            return instance
        with self._lock:
            if self._closing.is_set():
                raise RuntimeError(f"{self.name} is shutting down")
            instance = self._instance
            if instance is None:
                instance = self._factory()
                self._instance = instance
                # Publish ownership for shutdown to drain a factory that completed
                # after the fence, but never hand that late object to new work.
                if self._closing.is_set():
                    raise RuntimeError(f"{self.name} completed during shutdown")
            return instance

    def __getattr__(self, name: str) -> Any:
        if name.startswith("__"):
            raise AttributeError(name)
        return getattr(self.get(), name)

    def diagnostic(self) -> dict[str, Any]:
        return {"name": self.name, "loaded": self.loaded}
