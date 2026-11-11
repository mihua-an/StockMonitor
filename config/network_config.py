"""The one effective-network resolver (docs/system-architecture/06 section 3).

Resolution order, identical in config/js/network_config.js (tests/network_config_parity_contract.cjs runs the
shared cases in tests/fixtures/network_config/cases.json through both):

1. the read-only install manifest (config/network_manifest.json): service table, defaults, policy;
2. the ACTIVE saved revision of the "network" config domain (config/config_revisions.py), merged by service_id;
3. explicitly allowed start/environment overrides (STOCK_MONITOR_PORT_OVERRIDES), validated by the same rules and
   recorded with their source so Settings can show that a value is overridden.

A value that fails validation never becomes effective: the resolver keeps the previous layer's value for that service
and reports the problem. Ports are never auto-incremented on conflict.

This module has no side effects on import and reads no network state. Observed listeners belong to Health.
"""
from __future__ import annotations

import copy
import json
import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable, Mapping

EFFECTIVE_SCHEMA = "stock-monitor-effective-network-v1"
MANIFEST_SCHEMA = "stock-monitor-network-manifest-v2"
OVERRIDE_ENV = "STOCK_MONITOR_PORT_OVERRIDES"
REVISION_ENV = "STOCK_MONITOR_NETWORK_REVISION"
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
# A service a renderer may address (manifest "renderer_client": true) must speak one of these.
RENDERER_PROTOCOLS = ("http", "ws", "http+ws")

_MANIFEST_PATH = Path(__file__).resolve().parent / "network_manifest.json"


def manifest_path() -> Path:
    resources = str(os.environ.get("STOCK_MONITOR_RESOURCES_PATH") or "").strip()
    if resources:
        packaged = Path(resources) / "app-runtime" / "config" / "network_manifest.json"
        if packaged.exists():
            return packaged
    return _MANIFEST_PATH


@lru_cache(maxsize=4)
def _load(path: str) -> dict[str, Any]:
    manifest = json.loads(Path(path).read_text(encoding="utf-8"))
    problems = manifest_problems(manifest)
    if problems:
        raise RuntimeError(f"Invalid network manifest {path}: {problems}")
    return manifest


def load_manifest(path: str | os.PathLike | None = None) -> dict[str, Any]:
    return copy.deepcopy(_load(str(path or manifest_path())))


KINDS = ("api", "runtime", "controller", "provider", "external", "worker")
_SERVICE_ID = re.compile(r"^[a-z][a-z0-9_]{0,40}$")


def manifest_problems(manifest: Mapping[str, Any]) -> list[str]:
    """Every problem of the install manifest, the same strings as manifestProblems in config/js/network_config.js
    (shared cases: tests/fixtures/network_config/cases.json "manifest"). Each service's fields are checked, then the
    defaults are bound together as one candidate: without a saved layer they are the effective network."""
    if not isinstance(manifest, Mapping):
        return ["manifest must be an object"]
    problems: list[str] = []
    if manifest.get("schema") != MANIFEST_SCHEMA:
        problems.append(f"schema must be {MANIFEST_SCHEMA}")
    if manifest.get("loopback_host") not in LOOPBACK_HOSTS:
        problems.append("loopback_host must be one of 127.0.0.1, localhost, ::1")
    low, high, reserved = 1024, 65535, set()
    policy = manifest.get("port_policy")
    if not isinstance(policy, Mapping):
        problems.append("port_policy must be an object")
    else:
        low_value, high_value = policy.get("min_port"), policy.get("max_port")
        if _is_int(low_value) and _is_int(high_value) and 1 <= low_value <= high_value <= 65535:
            low, high = low_value, high_value
        else:
            problems.append("port_policy: min_port and max_port must be integers with 1 <= min_port <= max_port <= 65535")
        ports = policy.get("reserved_ports")
        if isinstance(ports, list) and all(_is_int(port) for port in ports):
            reserved = set(ports)
        else:
            problems.append("port_policy: reserved_ports must be a list of integers")
    specs = manifest.get("services")
    if not isinstance(specs, list) or not specs:
        problems.append("services must be a non-empty list")
        return problems
    ids = {spec.get("service_id") for spec in specs if isinstance(spec, Mapping)}
    seen: set[str] = set()
    for index, spec in enumerate(specs):
        if not isinstance(spec, Mapping):
            problems.append(f"services[{index}] must be an object")
            continue
        sid = spec.get("service_id")
        if not isinstance(sid, str) or not _SERVICE_ID.match(sid):
            problems.append(f"services[{index}]: service_id must be lower-case letters, digits and _")
            continue
        if sid in seen:
            problems.append(f"duplicate service_id {sid}")
            continue
        seen.add(sid)
        problems.extend(f"{sid}: {problem}" for problem in _service_problems(spec, low, high, reserved, ids))
    if not problems:
        problems.extend(f"defaults: {p['message']}" for p in validate_values(manifest, {}))
    if not problems:
        problems.extend(_topology_problems(manifest))
    return problems


def _service_problems(spec: Mapping[str, Any], low: int, high: int, reserved: set[int], ids: set[Any]) -> list[str]:
    problems: list[str] = []
    kind = spec.get("kind")
    if kind not in KINDS:
        problems.append(f"kind must be one of {', '.join(KINDS)}")
    for field in ("display_name", "protocol"):
        value = spec.get(field)
        if not isinstance(value, str) or not value.strip():
            problems.append(f"{field} must be a non-empty string")
    for field in ("listener", "managed"):
        if not isinstance(spec.get(field), bool):
            problems.append(f"{field} must be true or false")
    depends = spec.get("depends_on", [])
    if not isinstance(depends, list) or not all(isinstance(d, str) for d in depends):
        problems.append("depends_on must be a list of service_ids")
    else:
        for dependency in depends:
            if dependency == spec.get("service_id"):
                problems.append("depends_on names the service itself")
            elif dependency not in ids:
                problems.append(f"depends_on names unknown service {dependency}")
    port = spec.get("default_port")
    if spec.get("listener") is True or kind == "external":
        if not _is_int(port):
            problems.append("listener without integer default_port")
        elif not low <= port <= high:
            problems.append(f"default_port {port} is outside {low}-{high}")
        elif port in reserved and kind != "external":
            problems.append(f"default_port {port} is reserved")
    elif port is not None:
        problems.append("a no-listener service must not declare a port")
    reads = spec.get("reads_addresses_at_start", [])
    if not isinstance(reads, list) or not all(isinstance(r, str) for r in reads):
        problems.append("reads_addresses_at_start must be a list of service_ids")
    if not isinstance(spec.get("self_handoff", False), bool):
        problems.append("self_handoff must be true or false")
    client = spec.get("renderer_client", False)
    if not isinstance(client, bool):
        problems.append("renderer_client must be true or false")
    elif client and (spec.get("listener") is not True or spec.get("protocol") not in RENDERER_PROTOCOLS):
        problems.append(f"renderer_client needs a listener speaking one of {', '.join(RENDERER_PROTOCOLS)}")
    return problems


def renderer_services(manifest: Mapping[str, Any]) -> list[str]:
    """The services a renderer may address, in manifest order (manifest "renderer_client": true)."""
    return [spec["service_id"] for spec in manifest.get("services") or [] if spec.get("renderer_client") is True]


def _topology_of(manifest: Mapping[str, Any]) -> dict[str, Any]:
    specs = list(manifest.get("services") or [])
    managed = [spec["service_id"] for spec in specs if spec.get("managed") and spec.get("entry")]
    after = {spec["service_id"]: list(dict.fromkeys([*(spec.get("depends_on") or []), *(spec.get("reads_addresses_at_start") or [])]))
             for spec in specs}
    clients: dict[str, list[str]] = {}
    for spec in specs:
        for target in spec.get("reads_addresses_at_start") or []:
            clients.setdefault(target, []).append(spec["service_id"])
    start_order: list[str] = []
    while len(start_order) < len(managed):
        ready = [sid for sid in managed if sid not in start_order
                 and all(dep in start_order or dep not in managed for dep in after[sid])]
        if not ready:
            return {"managed": managed, "clients": clients, "start_order": None, "self_services": []}
        start_order.append(ready[0])
    return {"managed": managed, "clients": clients, "start_order": start_order,
            "self_services": [spec["service_id"] for spec in specs if spec.get("self_handoff") is True]}


def _topology_problems(manifest: Mapping[str, Any]) -> list[str]:
    ids = {spec.get("service_id") for spec in manifest.get("services") or []}
    problems = []
    for spec in manifest.get("services") or []:
        for field in ("depends_on", "reads_addresses_at_start"):
            for target in spec.get(field) or []:
                if target not in ids:
                    problems.append(f"{spec['service_id']}: {field} names unknown service {target}")
                if target == spec["service_id"]:
                    problems.append(f"{spec['service_id']}: {field} names itself")
    if not problems and _topology_of(manifest)["start_order"] is None:
        problems.append("depends_on / reads_addresses_at_start has a cycle")
    return problems


def topology(manifest: Mapping[str, Any]) -> dict[str, Any]:
    """{managed, clients, start_order, self_services} of a valid manifest -- the Node twin's topology()."""
    problems = _topology_problems(manifest)
    if problems:
        raise ValueError("Invalid network topology: " + "; ".join(problems))
    return _topology_of(manifest)


def services(manifest: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    return {spec["service_id"]: dict(spec) for spec in manifest.get("services") or []}


def _problem(code: str, service_id: str | None, message: str, **extra: Any) -> dict[str, Any]:
    return {"code": code, "service_id": service_id, "message": message, **extra}


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _host_problem(spec: Mapping[str, Any], host: Any, loopback: str) -> str | None:
    if not isinstance(host, str) or not host.strip():
        return "host must be a non-empty string"
    if spec.get("kind") == "external" and spec.get("host_configurable"):
        return None
    if host != loopback:
        return f"formal services listen on loopback {loopback} only"
    return None


def validate_values(manifest: Mapping[str, Any], values: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Validate a WHOLE candidate: every service's port/host, then cross-service duplicate binding.

    `values` is {service_id: {"port": int, "host": str}} for the services being set (sparse is fine: missing
    services keep their defaults for the duplicate check). Problems are returned, never raised.
    """
    table = services(manifest)
    policy = manifest.get("port_policy") or {}
    low, high = int(policy.get("min_port", 1024)), int(policy.get("max_port", 65535))
    reserved = set(policy.get("reserved_ports") or [])
    loopback = str(manifest.get("loopback_host") or "127.0.0.1")
    problems: list[dict[str, Any]] = []
    candidate: dict[str, tuple[str, int]] = {}
    for sid, spec in table.items():
        if spec.get("listener") or spec.get("kind") == "external":
            if isinstance(spec.get("default_port"), int):
                candidate[sid] = (loopback, int(spec["default_port"]))
    for sid, entry in (values or {}).items():
        spec = table.get(sid)
        if spec is None:
            problems.append(_problem("UNKNOWN_SERVICE", sid, "no such service_id in the manifest"))
            continue
        if not isinstance(entry, Mapping):
            problems.append(_problem("INVALID_ENTRY", sid, "entry must be an object"))
            continue
        unknown_keys = set(entry) - {"port", "host"}
        if unknown_keys:
            problems.append(_problem("UNKNOWN_FIELD", sid, f"only port/host are editable, got {json.dumps(sorted(unknown_keys), separators=(",", ":"))}"))
        if not spec.get("listener") and spec.get("kind") != "external":
            problems.append(_problem("NO_LISTENER", sid, "this service has no listener; a port cannot be assigned"))
            continue
        host, port = candidate.get(sid, (loopback, spec.get("default_port")))
        if "port" in entry:
            port = entry["port"]
            if not _is_int(port):
                problems.append(_problem("PORT_NOT_INTEGER", sid, "port must be an integer"))
                continue
            if not (low <= port <= high):
                problems.append(_problem("PORT_OUT_OF_RANGE", sid, f"port must be within {low}-{high}", port=port))
                continue
            if port in reserved and spec.get("kind") != "external":
                problems.append(_problem("PORT_RESERVED", sid, f"{port} is reserved/unassigned", port=port))
                continue
        if "host" in entry:
            host = entry["host"]
            reason = _host_problem(spec, host, loopback)
            if reason:
                problems.append(_problem("HOST_NOT_ALLOWED", sid, reason, host=host))
                continue
        candidate[sid] = (str(host), int(port))
    by_port: dict[int, list[str]] = {}
    for sid, (_host, port) in candidate.items():
        if table[sid].get("kind") == "external":
            continue
        by_port.setdefault(port, []).append(sid)
    for port, owners in sorted(by_port.items()):
        if len(owners) > 1:
            problems.append(_problem("DUPLICATE_BINDING", None, f"port {port} is assigned to {json.dumps(sorted(owners), separators=(",", ":"))}",
                                     port=port, services=sorted(owners)))
    return problems


def parse_env_overrides(raw: str | None) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    """`realtime_api=18000,market_runtime=18010` -> ({sid: {"port": n}}, problems)."""
    values: dict[str, dict[str, Any]] = {}
    problems: list[dict[str, Any]] = []
    for item in [part.strip() for part in str(raw or "").split(",") if part.strip()]:
        sid, sep, value = item.partition("=")
        sid = sid.strip()
        if not sep or not sid:
            problems.append(_problem("OVERRIDE_SYNTAX", sid or None, f"expected service_id=port, got {json.dumps(item)}"))
            continue
        text = value.strip()
        if not re.fullmatch(r"[+-]?[0-9]+", text):
            problems.append(_problem("PORT_NOT_INTEGER", sid, f"override {json.dumps(item)} is not an integer port"))
            continue
        values[sid] = {"port": int(text)}
    return values, problems


def resolve(manifest: Mapping[str, Any], *, saved: Mapping[str, Any] | None = None,
            env: Mapping[str, str] | None = None) -> dict[str, Any]:
    env = os.environ if env is None else env
    table = services(manifest)
    loopback = str(manifest.get("loopback_host") or "127.0.0.1")
    effective: dict[str, dict[str, Any]] = {}
    for sid, spec in table.items():
        effective[sid] = {
            "service_id": sid, "kind": spec.get("kind"), "display_name": spec.get("display_name"),
            "protocol": spec.get("protocol"), "listener": bool(spec.get("listener")),
            "managed": bool(spec.get("managed")), "renderer_client": spec.get("renderer_client") is True,
            "default_port": spec.get("default_port"),
            "host": loopback, "port": spec.get("default_port"), "source": "default",
        }
    problems: list[dict[str, Any]] = []
    overrides: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    revision = None

    def layer(values: Mapping[str, Any], source: str, prior_problems: list[dict[str, Any]] | None = None) -> bool:
        # A layer is validated, and applied, as a WHOLE: any problem in it -- an entry of its own or a
        # binding clash (a swap of two ports inside one layer is legal) -- and none of it applies. A revision is never
        # labelled on a mix of its good entries and defaults.
        found = [dict(p, layer=source) for p in (prior_problems or [])]
        for sid, entry in values.items():
            found.extend({**p, "layer": source} for p in validate_values(manifest, {sid: entry})
                         if p["code"] != "DUPLICATE_BINDING")
        trial = {sid: {"port": e["port"], "host": e["host"]} for sid, e in effective.items()
                 if e["port"] is not None and (e["listener"] or e["kind"] == "external")}
        for sid, entry in values.items():
            trial[sid] = {**trial.get(sid, {}), **dict(entry)}
        found.extend({**p, "layer": source} for p in validate_values(manifest, trial)
                     if p["code"] == "DUPLICATE_BINDING" and set(p.get("services", [])) & set(values))
        if found:
            problems.extend(found)
            return False
        accepted = {sid: dict(entry) for sid, entry in values.items()}
        for sid, entry in accepted.items():
            target = effective[sid]
            if "port" in entry:
                target["port"] = int(entry["port"])
            if "host" in entry:
                target["host"] = str(entry["host"])
            target["source"] = source
            if source == "override":
                overrides.append({"service_id": sid, **entry})
        return True

    if saved:
        # The saved revision's shape first: values and values.services are objects. A missing or mistyped one is a
        # rejected layer (fail-closed, last-good) -- never read as "no services changed" and run on the defaults.
        values = saved.get("values")
        malformed = ("values must be an object" if not isinstance(values, Mapping)
                     else "values.services must be an object" if not isinstance(values.get("services"), Mapping) else None)
        if malformed:
            problems.append(_problem("SAVED_REVISION_MALFORMED", None, malformed, layer="saved"))
            rejected.append({"layer": "saved", "revision": saved.get("revision")})
        elif layer(values["services"], "saved"):
            revision = saved.get("revision")
        else:
            rejected.append({"layer": "saved", "revision": saved.get("revision")})
    env_values, env_problems = parse_env_overrides(env.get(OVERRIDE_ENV))
    if (env_values or env_problems) and not layer(env_values, "override", env_problems):
        rejected.append({"layer": "override", "revision": None})
    return {
        "schema": EFFECTIVE_SCHEMA,
        "manifest_schema": manifest.get("schema"),
        "revision": revision,
        "services": effective,
        "overrides": overrides,
        "problems": problems,
        # Layers refused as a whole: a rejected saved revision is not the `revision` above.
        "rejected": rejected,
        "reserved_ports": list((manifest.get("port_policy") or {}).get("reserved_ports") or []),
    }


def endpoint(effective: Mapping[str, Any], service_id: str) -> tuple[str, int]:
    entry = effective["services"].get(service_id)
    if entry is None:
        raise KeyError(f"unknown service_id {service_id}")
    if entry["port"] is None:
        raise KeyError(f"{service_id} has no listener")
    return entry["host"], int(entry["port"])


def base_url(effective: Mapping[str, Any], service_id: str) -> str:
    host, port = endpoint(effective, service_id)
    scheme = "ws" if effective["services"][service_id]["protocol"] == "ws" else "http"
    return f"{scheme}://{host}:{port}"


def listeners(effective: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Own listeners (external dependencies and no-port processes excluded)."""
    return [dict(e) for e in effective["services"].values()
            if e["listener"] and e["kind"] != "external"]


def renderer_projection(effective: Mapping[str, Any]) -> dict[str, Any]:
    """Secret-free endpoint projection for the renderer (06 section 3): only client-facing services."""
    out = {}
    for sid, entry in effective["services"].items():
        if entry.get("renderer_client"):
            scheme = "ws" if entry["protocol"] == "ws" else "http"
            out[sid] = {"url": f"{scheme}://{entry['host']}:{entry['port']}", "port": entry["port"]}
    return {"schema": "stock-monitor-renderer-endpoints-v1", "revision": effective.get("revision"), "services": out}


def connect_sources(effective: Mapping[str, Any]) -> list[str]:
    """CSP connect-src entries: exactly the effective client endpoints, never every local port."""
    return sorted({svc["url"] for svc in renderer_projection(effective)["services"].values()})


def effective_from_disk(*, env: Mapping[str, str] | None = None, config_root: Path | None = None) -> dict[str, Any]:
    """Resolve using the ACTIVE network revision on disk (what a starting service must use)."""
    from config.config_revisions import ConfigRevisionStore, config_root as default_root

    env = os.environ if env is None else env
    store = ConfigRevisionStore(config_root or default_root(), "network")
    # Health names the revision a process must start from (during an apply it is the candidate, before the active
    # pointer moves). Absent: the active revision.
    pinned = str(env.get(REVISION_ENV) or "").strip()
    if pinned:
        saved = store.get(int(pinned)) if pinned.isdigit() else None
        if saved is None:
            raise RuntimeError(f"{REVISION_ENV}={pinned!r} names no saved network revision")
    else:
        saved = store.active()
    return resolve(load_manifest(), saved=saved, env=env)


def iter_problem_codes(problems: Iterable[Mapping[str, Any]]) -> list[str]:
    return sorted({str(p.get("code")) for p in problems})
