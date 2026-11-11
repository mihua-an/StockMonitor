"""pandas, imported on first use.

Modules on every API's import path (the route modules -> session resolver -> calendar, the history caches, the
storage codec) used pandas only inside the functions that process frames, yet loaded it at import: 0.77 s of each
API process start, before it could listen. ``from service.platform.lazy_pandas import pd`` keeps their code as it is
(``pd.DataFrame``, ``pd.to_datetime`` ...) and pays for pandas only when a function first touches it. Modules using it
must have ``from __future__ import annotations`` so type hints do not touch it at import.
"""
from __future__ import annotations

from typing import Any


class _LazyPandas:
    __slots__ = ()

    def __getattr__(self, name: str) -> Any:
        import pandas

        return getattr(pandas, name)

    def __repr__(self) -> str:
        return "<pandas, imported on first use>"


pd: Any = _LazyPandas()
