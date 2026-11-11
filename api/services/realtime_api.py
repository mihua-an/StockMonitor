"""realtime_api (8000): what the live monitor page keeps using -- quotes, monitor events and model settings.

One process serving two parts:

* quote_api -- live page reads: display session, trade details, monitor events, TXF / TAIEX, Futu, broker status;
* model_api -- model settings, training management and the registry. It writes the inference config Rust B reads;
  B itself validates and publishes model signals into market_runtime, so stopping this process never
  stops a signal.

They share a process because both sit on the live path: the on-demand pages (history, data center, accounts,
settings) live in app_api, so a heavy history read never delays a quote request or a signal (measured:
one history read held a core for up to 4 s).
"""
from __future__ import annotations

from typing import Any

from fastapi import FastAPI

from api.service_host import create_composite_app, run_service
from api.services import model_api, quote_api

SERVICE_ID = "realtime_api"
PARTS = (("quote_api", quote_api.Resources), ("model_api", model_api.Resources))


def build_app(**kwargs: Any) -> FastAPI:
    return create_composite_app(SERVICE_ID, PARTS, **kwargs)


if __name__ == "__main__":
    run_service(SERVICE_ID, build_app)
