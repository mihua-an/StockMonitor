"""Bounded INFO records for broker mutations, never callback or heartbeat data."""
from __future__ import annotations

import logging
from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps
from typing import Callable, Iterator, ParamSpec, TypeVar

logger = logging.getLogger(__name__)
_BatchRecords = dict[tuple[str, str, int], tuple[list[int], list[str]]]
_batch: ContextVar[_BatchRecords | None] = ContextVar("broker_operation_batch", default=None)
_P = ParamSpec("_P")
_R = TypeVar("_R")


def _emit(provider: str, operation: str, generation: int, counts, samples: list[str]) -> None:
    succeeded, failed = counts
    result = "partial" if succeeded and failed else "failed" if failed else "ok"
    logger.info(
        "[%s] %s symbol/lane=%s session_generation=%s result=%s ok=%s failed=%s",
        provider.upper(), operation, ",".join(samples), generation, result, succeeded, failed,
    )


@contextmanager
def broker_operation(provider: str, operation: str, generation: int, *,
                     symbol: str = "-", lane: str = "-") -> Iterator[None]:
    """Record only an actual SDK call; omit exception text and credentials."""
    success = False
    try:
        yield
        success = True
    finally:
        sample = f"{symbol}/{lane}"
        batch = _batch.get()
        key = (provider, operation, generation)
        if batch is None:
            _emit(*key, (int(success), int(not success)), [sample])
        else:
            counts, samples = batch.setdefault(key, ([0, 0], []))
            counts[0 if success else 1] += 1
            if sample not in samples and len(samples) < 3:
                samples.append(sample)


@contextmanager
def broker_operation_batch() -> Iterator[None]:
    """One summary per operation/generation, with at most three lane samples."""
    if _batch.get() is not None:
        yield
        return
    records: _BatchRecords = {}
    token = _batch.set(records)
    try:
        yield
    finally:
        _batch.reset(token)
        for key, (counts, samples) in records.items():
            _emit(*key, counts, samples)


def batch_broker_operations(func: Callable[_P, _R]) -> Callable[_P, _R]:
    @wraps(func)
    def wrapped(*args: _P.args, **kwargs: _P.kwargs) -> _R:
        with broker_operation_batch():
            return func(*args, **kwargs)
    return wrapped
