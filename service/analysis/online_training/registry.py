"""Registry of deployable ONNX models, one champion per horizon/direction slot.

The inference config's slots_provider is ``slot_model``: it hands a slot's manifest to Rust B only when the
manifest is valid for THAT slot under the current authority and its artifact still hashes to what the manifest says,
and otherwise the registry's reason the slot has no model (B reports it as given, never infers its own).
Whether the model's FeatureSpec is the one B computes is B's own check (FEATURE_SPEC mismatch -> INCOMPATIBLE); the
registry reports it too when it knows B's digest (``spec_provider``, from B's status file), never assumes it.
File presence alone is never enough; every refusal has a reason (``status``).

A model is registered by writing a complete staging directory and renaming it into place: a failed
registration leaves no half-written model directory behind, and a retry is not blocked by one.

``champions.json`` is the one record of which model is live: each slot's entry carries the run's last decision for it
(run, candidate, the champion it found, rule, time, ``promoted``). A candidate that went live is the entry's model; one
that must not (``promoted`` false with its ``reason``, e.g. a winner below the constant baseline) leaves the slot on
the model it already had -- or, with ``model_id`` null, on none when it had none or when the model it had is bound to
another FeatureSpec than the run's (``retired``: the run trains what B computes now, so that model can never be
served again). A run's decisions are one operation
(``promote``): every model going live is checked first, then the whole file is replaced durably in one step, so a
failure at any point leaves either every slot of the run decided or none, and nothing else says otherwise. The run
report is written after it (job.py).

Reading it tells four cases apart: no file, or no entry, is no champion yet; an entry without a model is a slot whose
run's winner did not go live and that had no model to keep, with why; a file that cannot be read (I/O) or does not
parse as champions (damaged) raises
``ChampionsUnreadable`` with its kind, so a damaged file is never shown as "no model" nor replaced by the next
promotion.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any, Callable

from service.analysis.inference.contract import (
    ContractError, load_horizon_authority, prediction_key, validate_model_manifest,
)
from service.analysis.online_training.cleanup import remove_tree
from service.platform.atomic_files import write_json_atomic
from service.platform.model_storage_layout import process_model_layout
import logging
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)

MODEL_FILE = "model.onnx"
MANIFEST_FILE = "manifest.json"
RUN_FILE = "run.json"
CHAMPIONS_IO_ERROR, CHAMPIONS_DAMAGED = "CHAMPIONS_IO_ERROR", "CHAMPIONS_DAMAGED"


class ChampionsUnreadable(RuntimeError):
    """champions.json exists but could not be read (``CHAMPIONS_IO_ERROR``) or is not a champions object
    (``CHAMPIONS_DAMAGED``). ``detail`` names no path (it is shown on the model center)."""

    def __init__(self, kind: str, detail: str) -> None:
        super().__init__(f"{kind}: {detail}")
        self.kind = kind
        self.detail = detail


def _no_model(entry: dict[str, Any]) -> bool:
    """A champions entry naming no model: the run's winner did not go live and the slot had none to keep -- the
    promotion says it was not promoted and why."""
    promotion = entry.get("promotion")
    return (entry.get("model_id") is None and isinstance(promotion, dict) and promotion.get("promoted") is False
            and bool(promotion.get("reason")))


def _held_reason(promotion: dict[str, Any]) -> str:
    """Why a run's winner did not go live."""
    baseline = promotion.get("baseline") or {}
    if promotion.get("reason") == "BELOW_BASELINE" and baseline:
        text = (f"run {promotion.get('run_id')}: {promotion.get('candidate')} validation log loss "
                f"{baseline.get('winner_validation_log_loss'):.4f} is not below the constant baseline "
                f"{(baseline.get('log_loss') or {}).get('validation'):.4f}")
    else:
        text = f"run {promotion.get('run_id')} did not put {promotion.get('candidate')} live: {promotion.get('reason')}"
    retired = promotion.get("retired")
    if isinstance(retired, dict):
        text += f"; the slot's model {retired.get('model_id')} was not kept: {retired.get('reason')}"
    return text


def _spec_digest(manifest: dict[str, Any] | None) -> str | None:
    return ((manifest or {}).get("feature_spec") or {}).get("schema_digest")


def _absent(entry: dict[str, Any] | None, unreadable: ChampionsUnreadable | None) -> dict[str, str] | None:
    """{state, reason} when the champions record names no model for the slot, else None (it names one): never had
    one (``NONE``), a run's winner that did not go live on a slot with none to keep (its reason, e.g.
    ``BELOW_BASELINE``), or an unreadable champions file -- which is not "no model"."""
    if not entry:
        if unreadable:
            return {"state": unreadable.kind, "reason": f"champions file unreadable: {unreadable}"}
        return {"state": "NONE", "reason": "no champion"}
    if _no_model(entry):
        return {"state": str(entry["promotion"]["reason"]), "reason": _held_reason(entry["promotion"])}
    return None


def default_registry_root() -> Path:
    return process_model_layout().registry


class OnlineModelRegistry:
    def __init__(self, root: Path | None = None, *, spec_provider: Callable[[], str | None] | None = None) -> None:
        self.root = Path(root or default_registry_root())
        self._spec_provider = spec_provider

    @property
    def champions_path(self) -> Path:
        return self.root / "champions.json"

    def model_dir(self, model_id: str) -> Path:
        return self.root / "models" / model_id

    def read_run(self, model_id: str) -> Any:
        """The run report registered with `model_id`; raises OSError / ValueError for the caller."""
        return json.loads((self.model_dir(model_id) / RUN_FILE).read_text(encoding="utf-8"))

    def register(self, model_id: str, *, artifact: bytes, manifest: dict[str, Any], run: dict[str, Any]) -> Path:
        directory = self.model_dir(model_id)
        if directory.exists():
            raise ContractError(f"model {model_id} already registered")
        manifest = dict(manifest)
        manifest["artifact"] = {**manifest["artifact"], "path": MODEL_FILE, "sha256": hashlib.sha256(artifact).hexdigest()}
        problems = validate_model_manifest(manifest, load_horizon_authority())
        if problems:
            raise ContractError(f"manifest invalid: {problems}")
        staging = directory.with_name(f".{model_id}.staging")
        remove_tree(staging, "a leftover model staging directory")   # one that stays makes mkdir below fail
        staging.mkdir(parents=True)
        try:
            (staging / MODEL_FILE).write_bytes(artifact)
            write_json_atomic(staging / MANIFEST_FILE, manifest, indent=2)
            write_json_atomic(staging / RUN_FILE, run, indent=2)
            os.replace(staging, directory)
        finally:
            remove_tree(staging, "a model staging directory")
        return directory

    def champions(self) -> dict[str, Any]:
        """{slot: {model_id, horizon_authority_version, promotion}}; {} when there is no file yet. Raises
        ``ChampionsUnreadable`` (recorded) for a file that cannot be read or is not champions."""
        try:
            text = self.champions_path.read_text(encoding="utf-8")
        except FileNotFoundError:  # not an error: no champions yet
            return {}
        except OSError as exc:
            record_failure(_failure_log, "reading model champions", exc)
            raise ChampionsUnreadable(CHAMPIONS_IO_ERROR, exc.strerror or type(exc).__name__) from exc
        try:
            data = json.loads(text)
        except ValueError as exc:
            record_failure(_failure_log, "parsing model champions", exc)
            raise ChampionsUnreadable(CHAMPIONS_DAMAGED, f"not JSON ({exc})") from exc
        if not isinstance(data, dict) or not all(isinstance(v, dict) and (v.get("model_id") or _no_model(v)) for v in data.values()):
            error = ChampionsUnreadable(CHAMPIONS_DAMAGED, "not an object of slots each naming a model_id or why it has none")
            record_failure(_failure_log, "parsing model champions", error)
            raise error
        return data

    def promote(self, run_id: str, models: list[tuple[int, str, str]], *, rule: str, decided_at: str,
                held: list[tuple[int, str, str, dict[str, Any]]] = ()) -> dict[str, dict[str, Any]]:
        """Decide every slot of one run in one durable step: each ``(minutes, direction, model_id)`` of ``models`` goes
        live; each ``(minutes, direction, model_id, why)`` of ``held`` -- a candidate that must not -- leaves the slot on
        the model it already has (none when it has none), ``why`` (its ``reason`` and evidence) recorded on the entry --
        unless that model is bound to another FeatureSpec than the held candidate: the run was trained on what B
        computes now, so the old model is ``retired`` and the slot has none. Returns each slot's promotion record. Every
        model going live, and every held candidate (it is registered), is read before anything is written: one that
        cannot, or a champions file that cannot be read, raises and leaves the file as it was. A model a slot keeps is
        otherwise not checked again: it is the one already live, and status() reports it if it has become unusable."""
        for minutes, direction, model_id in models:
            manifest, reason = self._checked(model_id, minutes, direction)
            if manifest is None:
                raise ContractError(f"cannot promote {model_id} to {prediction_key(minutes, direction)}: {reason}")
        candidate_specs = {}
        for minutes, direction, model_id, _why in held:
            manifest, reason = self._checked(model_id, minutes, direction)
            if manifest is None:
                raise ContractError(f"cannot decide {prediction_key(minutes, direction)} on {model_id}: {reason}")
            candidate_specs[model_id] = _spec_digest(manifest)
        champions = self.champions()
        version = load_horizon_authority().version
        promotions = {}
        decisions = [(m, d, model_id, None) for m, d, model_id in models] + list(held)
        for minutes, direction, model_id, why in decisions:
            slot = prediction_key(minutes, direction)
            current = champions.get(slot) or {}
            promotions[slot] = {"slot": slot, "run_id": run_id, "candidate": model_id,
                                "champion": current.get("model_id"), "rule": rule,
                                "promoted": why is None, "decided_at": decided_at, **(why or {})}
            retired = None if why is None else self._retired(current.get("model_id"), candidate_specs[model_id])
            if why is None:
                champions[slot] = {"model_id": model_id, "horizon_authority_version": version, "promotion": promotions[slot]}
            elif retired is not None:
                promotions[slot]["retired"] = retired
                champions[slot] = {"model_id": None, "horizon_authority_version": version, "promotion": promotions[slot]}
            else:
                # The live model, and the authority it went live under, stay as they were.
                champions[slot] = {"model_id": current.get("model_id"),
                                   "horizon_authority_version": current.get("horizon_authority_version", version),
                                   "promotion": promotions[slot]}
        if promotions:
            write_json_atomic(self.champions_path, champions, durable=True, indent=2)
        return promotions

    def _retired(self, model_id: str | None, run_spec: str | None) -> dict[str, Any] | None:
        """{model_id, feature_spec, reason} when the slot's current model is bound to another FeatureSpec than the run's,
        else None (no model, the same spec, or a manifest that cannot be read -- status() reports that one as unusable)."""
        if not model_id:
            return None
        try:
            manifest = json.loads((self.model_dir(model_id) / MANIFEST_FILE).read_text(encoding="utf-8"))
        except (OSError, ValueError):  # not an error: kept as it is; status()/slot_model() report it as MODEL_UNUSABLE
            return None
        spec = _spec_digest(manifest)
        if spec == run_spec:
            return None
        version = (manifest.get("feature_spec") or {}).get("feature_version")
        return {"model_id": model_id, "feature_spec": spec,
                "reason": f"it is bound to FeatureSpec {version} ({str(spec)[:12]}), the run trained {str(run_spec)[:12]}"}

    def _checked(self, model_id: str, minutes: int, direction: str) -> tuple[dict[str, Any] | None, str]:
        directory = self.model_dir(model_id)
        try:
            manifest = json.loads((directory / MANIFEST_FILE).read_text(encoding="utf-8"))
        except (OSError, ValueError):  # not an error: answered as the model's stated refusal reason, which the caller reports
            return None, "manifest missing or unreadable"
        authority = load_horizon_authority()
        problems = validate_model_manifest(manifest, authority)
        if problems:
            return None, f"invalid manifest: {problems[0]}"
        if (manifest.get("horizon_minutes"), manifest.get("direction")) != (int(minutes), str(direction)):
            return None, f"manifest is for {prediction_key(manifest.get('horizon_minutes'), manifest.get('direction'))}"
        if int(minutes) not in authority.allowed_minutes:
            return None, f"{minutes}m is not an allowed horizon"
        if manifest["artifact"].get("format") != "onnx":
            return None, f"artifact format {manifest['artifact'].get('format')!r} is not onnx"
        artifact = directory / str(manifest["artifact"].get("path") or "")
        try:
            digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
        except OSError:  # not an error: answered as the model's stated refusal reason, which the caller reports
            return None, "artifact missing"
        if digest != manifest["artifact"].get("sha256"):
            return None, "artifact does not match the manifest hash"
        return manifest, "ok"

    def _worker_digest(self) -> str | None:
        try:
            return self._spec_provider() if self._spec_provider else None
        except Exception as exc:
            record_failure(_failure_log, "reading the Rust B feature spec digest", exc)
            return None

    def slot_model(self, minutes: int, direction: str) -> dict[str, Any]:
        """What the inference config says about one slot: ``{"manifest", "manifest_dir"}`` of its champion, or
        ``{"no_model": {"state", "reason"}}`` -- the registry's own answer for why there is none (``NONE``, a run's
        ``BELOW_BASELINE``, an unreadable champions file, ``MODEL_UNUSABLE``), which Rust B reports as given."""
        try:
            champions, unreadable = self.champions(), None
        except ChampionsUnreadable as exc:  # not an error: champions() recorded it; the slot reports it below
            champions, unreadable = {}, exc
        entry = champions.get(prediction_key(minutes, direction))
        absent = _absent(entry, unreadable)
        if absent is not None:
            return {"no_model": absent}
        manifest, reason = self._checked(str(entry["model_id"]), minutes, direction)
        if manifest is None:
            # A champion that is named but cannot be deployed is a damaged model, not "no model yet".
            record_failure(_failure_log, f"loading the {prediction_key(minutes, direction)} champion "
                                         f"{entry['model_id']} ({reason})")
            return {"no_model": {"state": "MODEL_UNUSABLE", "reason": f"champion {entry['model_id']}: {reason}"}}
        return {"manifest": manifest, "manifest_dir": str(self.model_dir(str(entry["model_id"])))}

    def status(self) -> dict[str, Any]:
        """Per allowed slot: champion, and why it is (not) deployable."""
        authority = load_horizon_authority()
        try:
            champions, unreadable = self.champions(), None
        except ChampionsUnreadable as exc:  # not an error: champions() recorded it; every slot reports it below
            champions, unreadable = {}, exc
        worker_digest = self._worker_digest()
        slots = {}
        for minutes in authority.allowed_minutes:
            for direction in authority.directions:
                key = prediction_key(minutes, direction)
                entry = champions.get(key)
                absent = _absent(entry, unreadable)
                if absent is not None:
                    slots[key] = {"champion": None, "deployable": False, "champion_state": absent["state"],
                                  "reason": absent["reason"],
                                  "enabled_by_default": minutes in authority.default_enabled_minutes,
                                  "last_promotion": (entry or {}).get("promotion")}
                    continue
                promotion = entry.get("promotion") or {}
                held = promotion.get("promoted") is False
                manifest, reason = self._checked(str(entry["model_id"]), minutes, direction)
                model_digest = (manifest or {}).get("feature_spec", {}).get("schema_digest")
                spec_state = ("UNKNOWN" if worker_digest is None or manifest is None
                              else "MATCH" if model_digest == worker_digest else "MISMATCH")
                slots[key] = {"champion": entry["model_id"], "deployable": manifest is not None and spec_state != "MISMATCH",
                              "champion_state": "OK" if manifest is not None else "MODEL_UNUSABLE",
                              "reason": "bound to a FeatureSpec the worker does not compute" if spec_state == "MISMATCH" else reason,
                              "feature_spec": spec_state, "enabled_by_default": minutes in authority.default_enabled_minutes,
                              "kind": (manifest or {}).get("artifact", {}).get("kind"),
                              "validation": (manifest or {}).get("validation"), "dataset": (manifest or {}).get("dataset_version"),
                              "trained_at": (manifest or {}).get("model_version"), "last_promotion": entry.get("promotion"),
                              # The latest run's winner did not go live, so this model stayed: why (else None).
                              "kept": str(promotion["reason"]) if held else None,
                              "kept_reason": _held_reason(promotion) if held else None,
                              # Absent from a model trained before 特徵權重 (10-29): shown as no data, not an error.
                              "feature_importance": (manifest or {}).get("feature_importance")}
        return {"slots": slots, "worker_feature_spec": worker_digest,
                "champions_error": {"kind": unreadable.kind, "detail": unreadable.detail} if unreadable else None}
