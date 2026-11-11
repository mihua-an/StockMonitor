"""Python service dispatcher: `python main.py <service_id> [--port N --config-revision R]`.

The business APIs run as two processes, realtime_api and app_api (docs/system-architecture/00 section 1; merged from
seven); Health starts each with
`python -m api.services.<service_id>`. This entry exists for the same thing from one well-known file (and as the
project-root marker other tooling looks for). It builds nothing on import.
"""
from __future__ import annotations

import importlib
import os
import sys
from pathlib import Path

SERVICES = ("realtime_api", "app_api")


def main(argv: list[str] | None = None) -> None:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] not in SERVICES:
        raise SystemExit(f"usage: main.py <{'|'.join(SERVICES)}> [--port N] [--config-revision R]")
    service_id, rest = argv[0], argv[1:]
    module = importlib.import_module(f"api.services.{service_id}")
    from api.service_host import run_service

    run_service(service_id, module.build_app, rest)


if __name__ == "__main__":
    os.chdir(Path(__file__).resolve().parent)
    main()
