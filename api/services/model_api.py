"""model_api (part of realtime_api): model settings, training management and the registry (00 sections 1-3, 05).

Rust B is NOT started here: Health manages it as its own process. B is also the model-signal
authority: it reads the inference config this service writes (service/analysis/inference_files.py), validates its own
results and publishes them to market_runtime. Nothing on the signal path runs here, so stopping FastAPI (the
"關閉介面與 FastAPI" close) leaves model signals running. Training is not here either: POST /api/training/run leaves a
request that Health turns into the training job process, so that close does not interrupt a training run.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import Body, FastAPI
from fastapi.responses import JSONResponse

from api.components import Components
from api.service_host import ServiceHost
from config.observability_contract import metric

SERVICE_ID = "model_api"


class Resources:
    def __init__(self, host: ServiceHost) -> None:
        import threading

        from service.analysis.producer.inference_config import InferenceConfigAuthority
        from config.config_revisions import ConfigRevisionStore
        from service.platform.project_root import CONFIG_ROOT

        self.host = host
        self.components = Components.for_host(host)
        self.options_store = ConfigRevisionStore(CONFIG_ROOT, InferenceConfigAuthority.DOMAIN)
        self.config = InferenceConfigAuthority(slots_provider=lambda m, d: self.components.online_registry().slot_model(m, d),
                                               store=self.options_store)
        self._stop = threading.Event()
        self._writer: threading.Thread | None = None
        self.config_writes = 0
        self.config_write_error: str | None = None

    # ------------------------------------------------------------------ inference config file (read by Rust B)
    def write_config(self) -> None:
        from service.analysis.inference_files import write_config

        try:
            if write_config(self.config.current()):
                self.config_writes += 1
            self.config_write_error = None
        except Exception as exc:  # noqa: BLE001 -- B keeps the last config; the status route reports this
            # Reported by the status route: the exception's class, not its text (a path). Full text in the log.
            logging.getLogger(__name__).warning("[MODEL API] inference config write failed: %r", exc)
            self.config_write_error = f"{type(exc).__name__}（詳細原因已寫入 log）"

    def _write_loop(self) -> None:
        # The config also changes without a request here (a new champion in the registry): rewritten when it does.
        while not self._stop.wait(2.0):
            self.write_config()

    def b_status(self) -> dict[str, Any] | None:
        from service.analysis.inference_files import read_status

        return read_status()

    def capability(self) -> Any:
        status = self.b_status()
        return None if status is None or status.get("stale") else status.get("capability")

    def bind(self, app: FastAPI) -> None:
        from api.routes.training_routes import create_training_router
        from api.training_application import TrainingDependencies, create_training_application
        from config.feature_settings import SHIOAJI_FEATURES
        from service.analysis.inference.contract import ContractError

        c = self.components

        self.training_app = create_training_application(TrainingDependencies(
            registry=c.online_registry, worker_status=self.b_status, enabled_minutes=self.config.enabled_minutes,
            training_enabled=SHIOAJI_FEATURES.model_training))
        app.include_router(create_training_router(self.training_app))

        @app.get("/api/model/options")
        def get_model_options():
            config = self.config.current()
            return {"ok": True, "enabled_minutes": sorted({slot["horizon_minutes"] for slot in config["slots"]}),
                    "revision": config["model_options_revision"],
                    "pointer": self.options_store.pointer(), "authority": "model_api", "config": config}

        @app.put("/api/model/options")
        def put_model_options(payload: dict = Body(...)):
            from config.config_revisions import RevisionConflict, RevisionRejected
            from service.analysis.inference.contract import load_horizon_authority

            authority = load_horizon_authority()
            try:
                minutes = authority.validate_enabled(payload.get("enabled_minutes") or [])
            except ContractError as exc:  # not an error: invalid horizons are the API's 422 answer
                return JSONResponse({"ok": False, "error": "INVALID_HORIZONS", "detail": str(exc)}, status_code=422)
            try:
                doc = self.options_store.save({"enabled_minutes": list(minutes)}, expected_revision=payload.get("expected_revision"),
                                              source="model_api", summary=str(payload.get("summary") or ""), activate=True)
            except RevisionConflict as exc:  # not an error: a revision conflict is the API's 409 answer
                return JSONResponse({"ok": False, "error": "REVISION_CONFLICT", "current": exc.current, "diff": exc.diff}, status_code=409)
            except RevisionRejected as exc:  # not an error: a rejected revision is the API's 422 answer
                return JSONResponse({"ok": False, "error": "REVISION_REJECTED", "problems": exc.problems}, status_code=422)
            self.write_config()
            return {"ok": True, "revision": doc}

        @app.get("/api/system/inference")
        def inference_status():
            # The signal authority is Rust B: its own status file says what it validated and published.
            minutes, revision = self.config.snapshot()
            return {"ok": True, "authority": "analysis_runtime", "status": self.b_status(),
                    "config": {"enabled_minutes": list(minutes), "revision": revision,
                               "writes": self.config_writes, "write_error": self.config_write_error}}

        @app.get("/api/model/features")
        def feature_status():
            # The switch is intent; capability is what Rust B last reported for inference (None = never reported).
            # Training capability has no reporter yet, so it stays None rather than being assumed.
            reported = self.capability()
            slots = reported.get("slots") if isinstance(reported, dict) else None
            capabilities = {"model_inference": None if not isinstance(slots, list) else any(s.get("inference_available") for s in slots)}
            return {"ok": True, "features": SHIOAJI_FEATURES.status(capabilities)}

        @app.get("/api/model/inference/capability")
        def inference_capability():
            return {"ok": True, "capability": self.capability(), "formal_model_verified": False}

    async def start(self) -> None:
        import threading

        self.write_config()
        self._writer = threading.Thread(target=self._write_loop, name="inference-config-writer", daemon=True)
        self._writer.start()

    async def close(self) -> None:
        self._stop.set()

    def metrics(self) -> list[dict[str, Any]]:
        return [metric("inference_config.writes", SERVICE_ID, value=self.config_writes, unit="writes", kind="counter")]

    def prepare_shutdown(self) -> dict[str, Any]:
        # Nothing on the signal path lives here: Rust B keeps publishing with the last config file.
        self._stop.set()
        # Training is Health's own process: stopping this API never interrupts it.
        return {"inference_config": "writer stopped; Rust B keeps the last config"}
