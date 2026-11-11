"""Refuse an optimized interpreter (user decision: ``python -O`` is not allowed).

``-O`` / ``PYTHONOPTIMIZE`` strips every ``assert``. Data-integrity checks do not rely on asserts (they are explicit
``if`` checks), but the code base still uses asserts as invariants and tests, so a
service started optimized would run with checks silently gone. Each process entry point calls this first and stops.
"""
from __future__ import annotations

import sys

EXIT_OPTIMIZED = 4


def refuse_optimized_interpreter(name: str) -> None:
    if sys.flags.optimize:
        sys.stderr.write(f"{name}: refusing to run under python -O / PYTHONOPTIMIZE={sys.flags.optimize} "
                         "(assert-based invariants would be stripped); start it without optimization\n")
        raise SystemExit(EXIT_OPTIMIZED)
