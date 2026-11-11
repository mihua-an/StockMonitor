"""settings_api configuration routes (docs/system-architecture/06).

settings_api is the only writer of shared saved configuration. Every domain is a series of immutable revisions with
``expected_revision`` conflict detection. What "saving" means depends on the effect mode (06 section 4):

* ``network``: saved as the desired revision only -- nothing restarts. Health applies it (controlled operation).
* ``background`` / ``flow_rules`` / ``event_rules`` / ``breadth``: saved AND activated; market_runtime / Rust B pick
  up the active revision themselves and report the version they applied.

Model options (horizons) are owned by model_api; this module never stores a copy.
"""
from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass
from typing import Any, Callable

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from config import network_config as nc
from config.config_revisions import ConfigRevisionStore, RevisionConflict, RevisionRejected
from config import broker_connection_settings
from config.background_list import validate_background
from config import subscription_preferences
from config import training_data_settings
from config import kbar_retention_settings
from config import closing_data_settings
from config import query_cache_settings
from config.storage_settings import DEFAULT_LOCATION, DEFAULT_RETENTION, location_apply_operation, validate_location, validate_retention

KINDS = {"quote", "trade", "orderbook"}
EVENT_TYPES = {"window_move", "opening_move"}


class SaveRequest(BaseModel):
    expected_revision: int | None = None
    values: dict[str, Any] = Field(default_factory=dict)
    summary: str = ""


class ValidateRequest(BaseModel):
    values: dict[str, Any] = Field(default_factory=dict)


MATCH_FIELDS = ("source", "market", "code")


def _problem(code: str, message: str, **extra: Any) -> dict[str, Any]:
    return {"code": code, "message": message, **extra}


def _number(value: Any) -> float | None:
    """A real number Rust B can read as a finite f64 -- never a bool, a numeric string, NaN/inf, or an integer too large
    for a float (which serde_json refuses, failing the whole revision)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        number = float(value)
    except OverflowError:  # not an error: an integer too large for a float is the refusal this answers
        return None
    return number if math.isfinite(number) else None


# Rust B's integer types: an integer outside them makes the whole revision undeserializable there.
I32_RANGE = (-(2 ** 31), 2 ** 31 - 1)
# usize on the narrowest platform B is built for.
COUNT_RANGE = (0, 2 ** 32 - 1)


def _int_in(value: Any, bounds: tuple[int, int]) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and bounds[0] <= value <= bounds[1]


def _rule_id_problems(rule: dict[str, Any], index: int, ids: set[str]) -> list[dict[str, Any]]:
    """rule_id is a String in Rust B: a number or any other type there fails the whole revision."""
    rid = rule.get("rule_id")
    if not isinstance(rid, str) or not rid.strip():
        return [_problem("RULE_ID", "rule_id must be a non-empty string", index=index)]
    if rid in ids:
        return [_problem("RULE_ID", "rule_id must be unique", index=index)]
    ids.add(rid)
    return []


def _minute_range(value: Any) -> bool:
    return (isinstance(value, (list, tuple)) and len(value) == 2 and all(isinstance(m, int) and not isinstance(m, bool)
            and 0 <= m < 24 * 60 for m in value) and value[0] <= value[1])


def _match_problems(rule: dict[str, Any], index: int) -> list[dict[str, Any]]:
    """`match` as Rust B deserializes it (native/analysis_runtime/src/rules.rs Match): an object whose source / market /
    code are each a string or absent -- one non-string member made the whole revision undeserializable."""
    match = rule.get("match")
    if match is None:
        return []
    if not isinstance(match, dict):
        return [_problem("MATCH", "match must be an object", index=index)]
    problems = []
    for name in sorted(match):
        if name not in MATCH_FIELDS:
            problems.append(_problem("MATCH_FIELD", f"match.{name} is not a match field ({', '.join(MATCH_FIELDS)})", index=index))
        elif match[name] is not None and not (isinstance(match[name], str) and match[name].strip()):
            problems.append(_problem("MATCH_FIELD", f"match.{name} must be a non-empty string", index=index))
    return problems


def _optional_types(rule: dict[str, Any], index: int, fields: dict[str, str]) -> list[dict[str, Any]]:
    """Each field Rust B reads with its type there: present and of another type fails the whole revision."""
    problems = []
    for name, kind in fields.items():
        value = rule.get(name)
        if value is None:
            continue
        ok = {"string": isinstance(value, str),
              "number": _number(value) is not None,
              "positive": (_number(value) or 0) > 0,
              "integer": _int_in(value, I32_RANGE),
              "count": _int_in(value, COUNT_RANGE)}[kind]
        if not ok:
            wanted = {"positive": "a positive number", "count": f"an integer in [0, {COUNT_RANGE[1]}]",
                      "integer": f"an integer in [{I32_RANGE[0]}, {I32_RANGE[1]}]"}.get(kind, "a " + kind)
            problems.append(_problem("FIELD_TYPE", f"{name} must be {wanted}", index=index))
    return problems


def _rule_objects(values: dict[str, Any]) -> tuple[list[tuple[int, dict[str, Any]]], list[dict[str, Any]]]:
    """The rules that are objects, and a problem for every element that is not (never a crash of the validator)."""
    rules = values.get("rules")
    if not isinstance(rules, list):
        return [], [_problem("RULES_REQUIRED", "rules must be a list")]
    good, problems = [], []
    for i, rule in enumerate(rules):
        if isinstance(rule, dict):
            good.append((i, rule))
        else:
            problems.append(_problem("INVALID_RULE", "rule must be an object", index=i))
    return good, problems


def validate_flow_rules(values: dict[str, Any]) -> list[dict[str, Any]]:
    if not isinstance(values.get("rules"), list):
        return [_problem("RULES_REQUIRED", "rules must be a list")]
    rules, problems = _rule_objects(values)
    ids: set[str] = set()
    for i, rule in rules:
        problems.extend(_rule_id_problems(rule, i, ids))
        if rule.get("threshold_type") not in ("volume", "amount"):
            problems.append(_problem("THRESHOLD_TYPE", "threshold_type must be volume or amount", index=i))
        threshold = _number(rule.get("threshold"))
        if threshold is None or threshold <= 0:
            problems.append(_problem("THRESHOLD", "threshold must be a positive number", index=i))
        if rule.get("threshold_type") == "amount" and not rule.get("currency"):
            problems.append(_problem("CURRENCY", "an amount rule names its currency", index=i))
        problems.extend(_match_problems(rule, i))
        problems.extend(_optional_types(rule, i, {"unit": "string", "currency": "string", "unit_size": "positive",
                                                  "multiplier": "positive"}))
        # The accumulated-attack part (Rust B's episode impact rule): both or neither.
        impact, gap = rule.get("impact_ratio"), rule.get("episode_gap_ms")
        if (impact is None) != (gap is None):
            problems.append(_problem("IMPACT_RULE", "impact_ratio and episode_gap_ms are set together", index=i))
        elif impact is not None:
            if _number(impact) is None or not 0 < _number(impact) <= 10:
                problems.append(_problem("IMPACT_RATIO", "impact_ratio must be a number in (0, 10]", index=i))
            if isinstance(gap, bool) or not isinstance(gap, int) or not 1 <= gap <= 60000:
                problems.append(_problem("EPISODE_GAP", "episode_gap_ms must be an integer in [1, 60000]", index=i))
            longest = rule.get("episode_max_ms")
            if longest is not None and (isinstance(longest, bool) or not isinstance(longest, int) or not 1 <= longest <= 600000):
                problems.append(_problem("EPISODE_MAX", "episode_max_ms must be an integer in [1, 600000]", index=i))
            floor = rule.get("impact_min_fraction")
            if floor is not None and (_number(floor) is None or not 0 <= _number(floor) <= 1):
                problems.append(_problem("IMPACT_MIN_FRACTION", "impact_min_fraction must be a number in [0, 1]", index=i))
            member = rule.get("member_min_fraction")
            if member is not None and (_number(member) is None or not 0 <= _number(member) <= 1):
                problems.append(_problem("MEMBER_MIN_FRACTION", "member_min_fraction must be a number in [0, 1]", index=i))
    if values.get("side_inference", "quote_rule") not in ("quote_rule", "none"):
        problems.append(_problem("SIDE_INFERENCE", "side_inference must be quote_rule or none"))
    return problems


def validate_event_rules(values: dict[str, Any]) -> list[dict[str, Any]]:
    """Every field Rust B's evaluator reads (native/analysis_runtime/src/events.rs), checked with the meaning it has
    there, for the two rule types it evaluates: a window_move over 1/3/5/15/30/60 minutes and an opening_move. A
    percent move is a positive magnitude in (0, 100] (`direction` gives the sign), and reset_ratio is the fraction of
    the threshold the move must fall back to, in (0, 1)."""
    if not isinstance(values.get("rules"), list):
        return [_problem("RULES_REQUIRED", "rules must be a list")]
    rules, problems = _rule_objects(values)
    ids: set[str] = set()
    for i, rule in rules:
        problems.extend(_rule_id_problems(rule, i, ids))
        kind = rule.get("type")
        if kind not in EVENT_TYPES:
            problems.append(_problem("TYPE", f"type must be one of {sorted(EVENT_TYPES)}", index=i))
        if rule.get("direction") not in (None, "up", "down"):
            problems.append(_problem("DIRECTION", "direction must be up or down", index=i))
        problems.extend(_match_problems(rule, i))
        problems.extend(_optional_types(rule, i, {"label": "string", "window": "integer", "threshold_pct": "number",
                                                  "reset_ratio": "number"}))
        if "enabled" in rule and not isinstance(rule["enabled"], bool):
            problems.append(_problem("ENABLED", "enabled must be true or false", index=i))
        # The rank a chart uses to pick one of several events in a minute; every rule states its own.
        if isinstance(rule.get("priority"), bool) or not isinstance(rule.get("priority"), int) or not -2**31 <= rule["priority"] < 2**31:
            problems.append(_problem("PRIORITY", "priority must be an integer", index=i))
        reset = rule.get("reset_ratio")
        if kind in ("window_move", "opening_move"):
            if kind == "window_move" and (isinstance(rule.get("window"), bool) or rule.get("window") not in (1, 3, 5, 15, 30, 60)):
                problems.append(_problem("WINDOW_MOVE", "window must be 1/3/5/15/30/60", index=i))
            pct = _number(rule.get("threshold_pct"))
            if pct is None or not 0 < pct <= 100:
                problems.append(_problem("THRESHOLD_PCT", "threshold_pct must be a number in (0, 100]", index=i))
            # Here reset_ratio is the fraction of the threshold the move must fall back to before it can fire again.
            if reset is not None and ((_number(reset) is None) or not 0 < _number(reset) < 1):
                problems.append(_problem("RESET_RATIO", "reset_ratio must be a number in (0, 1)", index=i))
        if rule.get("active_minutes") is not None and not _minute_range(rule["active_minutes"]):
            problems.append(_problem("ACTIVE_MINUTES", "active_minutes is [from, to] minutes of the day", index=i))
        excluded = rule.get("exclude_minutes", [])
        if not isinstance(excluded, list) or not all(_minute_range(r) for r in excluded):
            problems.append(_problem("EXCLUDE_MINUTES", "exclude_minutes is a list of [from, to] minutes of the day", index=i))
    return problems


def validate_breadth(values: dict[str, Any]) -> list[dict[str, Any]]:
    if values.get("mode") not in ("computed", "source", "off"):
        return [_problem("MODE", "mode must be computed, source or off")]
    return []


def network_problems(values: dict[str, Any]) -> list[dict[str, Any]]:
    """The candidate on its own AND as it would actually take effect: manifest <- candidate <- this machine's allowed
    env overrides (06 section 2). A candidate that is only valid until an override lands on top of it is rejected."""
    manifest = nc.load_manifest()
    if not isinstance(values, dict) or not isinstance(values.get("services"), dict):
        # The resolvers refuse a revision of any other shape (SAVED_REVISION_MALFORMED): it is never saved.
        return [{"code": "SAVED_REVISION_MALFORMED", "service_id": None, "message": "values.services must be an object"}]
    problems = nc.validate_values(manifest, values["services"])
    seen = {json.dumps(p, sort_keys=True) for p in problems}
    effective = nc.resolve(manifest, saved={"revision": None, "values": values or {}}, env=dict(os.environ))
    for problem in effective["problems"]:
        key = json.dumps(problem, sort_keys=True)
        if key not in seen:
            seen.add(key)
            problems.append({**problem, "effective_with_overrides": True})
    return problems


def _seed_flow_rules() -> dict[str, Any]:
    from config.settings import (LARGE_ORDER_EPISODE_GAP_MS, LARGE_ORDER_EPISODE_MAX_MS, LARGE_ORDER_FALLBACK_VOLUME, LARGE_ORDER_IMPACT_MIN_FRACTION,
                                 LARGE_ORDER_IMPACT_RATIO, LARGE_ORDER_MEMBER_MIN_FRACTION)

    return {"rules": [
        {"rule_id": "tw-stock-large-volume", "match": {"source": "shioaji", "market": "STK"}, "threshold_type": "volume",
         "threshold": float(LARGE_ORDER_FALLBACK_VOLUME), "unit": "lot", "unit_size": 1000, "currency": "TWD",
         "impact_ratio": float(LARGE_ORDER_IMPACT_RATIO), "episode_gap_ms": int(LARGE_ORDER_EPISODE_GAP_MS),
         "episode_max_ms": int(LARGE_ORDER_EPISODE_MAX_MS), "impact_min_fraction": LARGE_ORDER_IMPACT_MIN_FRACTION,
         "member_min_fraction": LARGE_ORDER_MEMBER_MIN_FRACTION},
    ], "side_inference": "quote_rule",
        "note": "seeded from config/settings.py LARGE_ORDER_* (single-print volume and accumulated attack); other markets have no rule until one is saved"}


def _seed_event_rules() -> dict[str, Any]:
    return {"rules": [
        {"rule_id": f"win{n}_{d}", "type": "window_move", "window": n, "direction": d, "threshold_pct": pct, "priority": priority,
         "label": f"{n}分{'急拉' if d == 'up' and n < 5 else '緩漲' if d == 'up' else '急殺' if n < 5 else '緩跌'}",
         "match": {"source": "shioaji", "market": "STK"}, "exclude_minutes": [[805, 810]]}
        for n, pct, priority in ((1, 0.8, 400), (3, 1.5, 350), (5, 2.5, 300)) for d in ("up", "down")
    ] + [
        {"rule_id": f"open_{d}", "type": "opening_move", "direction": d, "threshold_pct": 1.5, "priority": 450, "active_minutes": [540, 555],
         "label": "開盤急拉" if d == "up" else "開盤急殺", "match": {"source": "shioaji", "market": "STK"}}
        for d in ("up", "down")
    ], "note": "default rule thresholds; Rust B (native/analysis_runtime) is the only evaluator"}


@dataclass(frozen=True)
class ConfigDomainSpec:
    """Everything settings_api knows about one saved-configuration domain (06 section 4). Saving, validating,
    describing and seeding are all derived from this one record.

    effect_contract: the system_contract.json "effect_modes" key of how a saved revision takes effect; applied_by: who
    reports that it did (saving is never the same as loaded). validator: the domain's problems for a candidate.
    default: the revision-1 values seeded at first start (None: never seeded). generic_routes:
    served by /api/config/{domain}; network has routes of its own (validate with impact, effective views).
    owner_written: read and validated through /api/config/{domain} but never saved there -- its owners write it (the
    background list: background_demand.py; the 訂閱偏好: POST /api/subscriptions/ops), so a whole-list write cannot
    be a second writer beside them.
    """
    name: str
    effect_contract: str
    applied_by: str
    activate_on_save: bool
    note: str
    validator: Callable[[dict[str, Any]], list[dict[str, Any]]]
    default: Callable[[], dict[str, Any]] | None = None
    generic_routes: bool = True
    owner_written: bool = False
    describe_extra: Callable[[Any], dict[str, Any]] | None = None


_ACTIVE_ON_SAVE = "active on save; {applied_by} loads it and reports the revision it applied"

DOMAINS: dict[str, ConfigDomainSpec] = {spec.name: spec for spec in (
    ConfigDomainSpec("background", "background_list", "market_runtime", True, _ACTIVE_ON_SAVE, validate_background,
                     owner_written=True),
    # 設定 → 訂閱管理 and 商品頁設定 (config/subscription_preferences.py): written by POST /api/subscriptions/ops only,
    # which saves the background list they make in the same step.
    ConfigDomainSpec("subscriptions", "background_list", "market_runtime", True, _ACTIVE_ON_SAVE,
                     subscription_preferences.validate, default=subscription_preferences.defaults, owner_written=True),
    ConfigDomainSpec("breadth", "background_list", "market_runtime", True, _ACTIVE_ON_SAVE, validate_breadth,
                     default=lambda: {"mode": "source", "source": "shioaji", "markets": ["STK", "OTC"], "stock_code_digits": 4,
                                      "excluded_prefixes": ["00"], "index_symbols": ["shioaji:IDX:TAIEX", "shioaji:IDX:OTC"],
                                      "universe_size": None}),
    ConfigDomainSpec("flow_rules", "flow_event_rules", "analysis_runtime", True, _ACTIVE_ON_SAVE, validate_flow_rules,
                     default=_seed_flow_rules),
    ConfigDomainSpec("event_rules", "flow_event_rules", "analysis_runtime", True, _ACTIVE_ON_SAVE, validate_event_rules,
                     default=_seed_event_rules),
    ConfigDomainSpec("network", "service_port", "service_controller", False,
                     "saved as the desired revision; Health applies it with a controlled operation",
                     network_problems, generic_routes=False),
    # 設定 → 資料儲存 (config/storage_settings.py): retention is read by A on its next prune; a new folder is prepared
    # by Health while the App runs and switched to at a full start, before anything opens the store. Defaults (user decision):
    # Shioaji keeps 3 trading dates, Futu keeps none past its session.
    ConfigDomainSpec("storage_retention", "storage_retention", "market_runtime", True, _ACTIVE_ON_SAVE, validate_retention,
                     default=lambda: json.loads(json.dumps(DEFAULT_RETENTION))),
    ConfigDomainSpec("storage_location", "storage_location", "service_controller", False,
                     "saved as the desired revision; Health copies the stored history there in the background and switches at a full start",
                     validate_location, default=lambda: dict(DEFAULT_LOCATION),
                     describe_extra=lambda root: {"apply_operation": location_apply_operation(root)}),
    # 設定 → 資料儲存 → 模型訓練資料 (config/training_data_settings.py): the training job reads it at every run.
    # Defaults (user decision): training data kept forever, 20 trading dates per run.
    ConfigDomainSpec("training_data", "storage_retention", "training_job", True, _ACTIVE_ON_SAVE,
                     training_data_settings.validate, default=lambda: dict(training_data_settings.DEFAULTS)),
    # 設定 → 資料儲存 → K 棒保存 (config/kbar_retention_settings.py): the close-of-day materialization ages the K-bar store by it.
    ConfigDomainSpec("kbar_retention", "storage_retention", "materializer", True, _ACTIVE_ON_SAVE,
                     kbar_retention_settings.validate, default=kbar_retention_settings.defaults),
    # 設定 → 資料儲存 → 查詢快取 (config/query_cache_settings.py): each session's materialization removes what is past it.
    ConfigDomainSpec("query_cache", "storage_retention", "materializer", True, _ACTIVE_ON_SAVE,
                     query_cache_settings.validate, default=lambda: dict(query_cache_settings.DEFAULTS)),
    # 設定 → 資料儲存 → 收盤資料來源 (config/closing_data_settings.py): read at each request; empty connects nowhere.
    ConfigDomainSpec("closing_data", "provider", "provider_shioaji", True, _ACTIVE_ON_SAVE,
                     closing_data_settings.validate, default=lambda: dict(closing_data_settings.DEFAULTS)),
    # 設定 → 券商帳號 → 永豐行情連線 (config/broker_connection_settings.py): the Shioaji provider reads it on its
    # subscription loop; less than what is in use takes a new login.
    ConfigDomainSpec("broker_connections", "provider", "provider_shioaji", True, _ACTIVE_ON_SAVE,
                     broker_connection_settings.validate,
                     default=lambda: json.loads(json.dumps(broker_connection_settings.DEFAULTS)),
                     describe_extra=lambda _root: {"choices": broker_connection_settings.choices()}),
)}


def effect_of(domain: str) -> dict[str, Any]:
    from config.system_contract import contract

    spec = DOMAINS[domain]
    return {"mode": contract()["effect_modes"][spec.effect_contract], "applied_by": spec.applied_by,
            "activated_on_save": spec.activate_on_save, "note": spec.note.format(applied_by=spec.applied_by)}


def network_impact(effective: dict[str, Any], candidate: dict[str, Any]) -> dict[str, Any]:
    """Which services and clients a candidate endpoint set touches (06 section 5: shown before applying)."""
    manifest = nc.load_manifest()
    table = nc.services(manifest)
    changed = []
    for sid, entry in (candidate.get("services") or {}).items():
        current = effective["services"].get(sid) or {}
        if entry.get("port", current.get("port")) != current.get("port") or entry.get("host", current.get("host")) != current.get("host"):
            changed.append(sid)
    # The same graph Health applies with (network_config.topology()): who reads a changed address at start.
    graph = nc.topology(manifest)
    dependents = sorted({client for sid in changed for client in graph["clients"].get(sid, [])} - set(changed))
    renderer = sorted(set(changed) & set(nc.renderer_services(manifest)))
    self_restart = sorted(set(changed) & set(graph["self_services"]))
    return {
        "changed_services": sorted(changed), "dependent_services": dependents,
        "renderer_reconnect": bool(renderer), "renderer_endpoints_changed": renderer,
        "effect_mode": "full_restart_bootstrap" if self_restart else ("controlled_restart" if changed else "none"),
        "self_endpoint_change": self_restart,
        # An unknown service_id is a validation problem (UNKNOWN_SERVICE), never a crash of the preview.
        "external_only": sorted(s for s in changed if (table.get(s) or {}).get("kind") == "external"),
        "preserved": ["WAL stream", "data root", "models", "ledgers", "watch lists", "background list"],
        "in_flight_jobs": "Health drains each affected service before stopping it; long jobs are reported, not killed",
    }


def create_config_router(*, config_root: Callable[[], Any]) -> APIRouter:
    router = APIRouter()

    def store(domain: str) -> ConfigRevisionStore:
        return ConfigRevisionStore(config_root(), domain)

    def describe(domain: str) -> dict[str, Any]:
        spec = DOMAINS[domain]
        s = store(domain)
        pointer = s.pointer()
        described = {"ok": True, "domain": domain, "pointer": pointer, "latest": s.latest(), "active": s.active(),
                     "last_good": s.last_good(), "history": s.history(20), "activate_on_save": spec.activate_on_save,
                     "effect": effect_of(domain)}
        if spec.describe_extra is not None:
            described.update(spec.describe_extra(config_root()))
        return described

    def save(domain: str, req: SaveRequest) -> dict[str, Any]:
        spec = DOMAINS[domain]
        try:
            doc = store(domain).save(req.values, expected_revision=req.expected_revision, source="settings_api",
                                     summary=req.summary, activate=spec.activate_on_save, validator=spec.validator)
        except RevisionConflict as exc:  # not an error: a stale expected revision is the API's 409 answer with the diff
            return JSONResponse({"ok": False, "error": "REVISION_CONFLICT", "expected_revision": exc.expected,
                                 "current": exc.current, "diff": exc.diff}, status_code=409)
        except RevisionRejected as exc:  # not an error: a rejected revision is the API's 422 answer with the problems
            return JSONResponse({"ok": False, "error": "REVISION_REJECTED", "problems": exc.problems}, status_code=422)
        return {"ok": True, "revision": doc, "activated": DOMAINS[domain].activate_on_save, "effect": effect_of(domain)}

    @router.get("/api/config/network")
    def get_network():
        s = store("network")
        manifest = nc.load_manifest()
        effective_active = nc.resolve(manifest, saved=s.active(), env={})
        effective_latest = nc.resolve(manifest, saved=s.latest(), env={})
        return {**describe("network"), "manifest": manifest,
                "default": nc.resolve(manifest, saved=None, env={}),
                "saved_effective": effective_latest, "active_effective": effective_active,
                "pending_apply": (s.pointer().get("latest") or 0) != (s.pointer().get("active") or 0)}

    @router.post("/api/config/network/validate")
    def validate_network(req: ValidateRequest):
        manifest = nc.load_manifest()
        problems = network_problems(req.values or {})
        effective = nc.resolve(manifest, saved=store("network").active(), env=dict(os.environ))
        return {"ok": not problems, "problems": problems, "impact": network_impact(effective, req.values or {})}

    @router.put("/api/config/network")
    def put_network(req: SaveRequest):
        return save("network", req)

    def generic(domain: str) -> ConfigDomainSpec | None:
        spec = DOMAINS.get(domain)
        return spec if spec is not None and spec.generic_routes else None

    @router.get("/api/config/{domain}")
    def get_domain(domain: str):
        if generic(domain) is None:
            return JSONResponse({"ok": False, "error": "UNKNOWN_DOMAIN", "domains": sorted(DOMAINS)}, status_code=404)
        return describe(domain)

    @router.post("/api/config/{domain}/validate")
    def validate_domain(domain: str, req: ValidateRequest):
        spec = generic(domain)
        if spec is None:
            return JSONResponse({"ok": False, "error": "UNKNOWN_DOMAIN"}, status_code=404)
        problems = spec.validator(req.values or {})
        return {"ok": not problems, "problems": problems}

    @router.put("/api/config/{domain}")
    def put_domain(domain: str, req: SaveRequest):
        spec = generic(domain)
        if spec is None:
            return JSONResponse({"ok": False, "error": "UNKNOWN_DOMAIN"}, status_code=404)
        if spec.owner_written:
            return JSONResponse({"ok": False, "error": "OWNER_WRITTEN", "domain": domain,
                                 "message": f"{domain} is written by its owners, not replaced whole"}, status_code=405)
        return save(domain, req)

    return router


def seed_defaults(config_root: Any) -> dict[str, Any]:
    """First start only: revision 1 of each domain with a default holds it."""
    seeded = {}
    for domain, spec in DOMAINS.items():
        if spec.default is None:
            continue
        s = ConfigRevisionStore(config_root, domain)
        state = s.state()["state"]
        if state in ("CORRUPT", "INCONSISTENT"):
            # A damaged store is never re-seeded over: its routes answer CONFIG_STORE_<state> instead.
            seeded[domain] = state
            continue
        if s.latest() is None:
            s.save(spec.default(), expected_revision=None, source="defaults", summary="initial revision", activate=True)
            seeded[domain] = 1
    return seeded
