"""app_api (8001): the on-demand pages -- history and replay, data center, actual and paper accounts, settings.

One process serving five parts. Every part answers a page the
user opened; none of them is on the live market path, which stays in realtime_api. Sharing one process means one
copy of the libraries and one owner of each shared file in memory (settings, security master, history readers).

settings_api is the only writer of shared saved configuration, so a change of this process's own endpoint is a
self-restart case for Health (health/operations.js SELF_SERVICES).
"""
from __future__ import annotations

from typing import Any

from fastapi import FastAPI

from api.service_host import create_composite_app, run_service
from api.services import actual_account_api, data_center_api, history_api, paper_account_api, settings_api

SERVICE_ID = "app_api"
PARTS = (
    ("settings_api", settings_api.Resources),
    ("history_api", history_api.Resources),
    ("data_center_api", data_center_api.Resources),
    ("actual_account_api", actual_account_api.Resources),
    ("paper_account_api", paper_account_api.Resources),
)


def build_app(**kwargs: Any) -> FastAPI:
    return create_composite_app(SERVICE_ID, PARTS, **kwargs)


if __name__ == "__main__":
    run_service(SERVICE_ID, build_app)
