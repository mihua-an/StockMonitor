"""Versioned, immutable configuration revisions (docs/system-architecture/06 sections 2-3).

One store per config domain ("network", "background", "flow_rules", "event_rules", "sources", "breadth", ...) under
the var layout's `config` root. settings_api is the only writer of saved revisions; Health is the only writer of the
`active` pointer for domains it applies (network); runtimes read.

Layout (identical in config/js/config_revisions.js):

    <config_root>/<domain>/revisions/r000007.json   immutable ConfigRevision documents
    <config_root>/<domain>/pointer.json             {"latest": 7, "active": 6, "last_good": 6, ...}

* `latest`    newest saved (desired) revision -- may be pending apply.
* `active`    the revision services start from; moved only by the domain's applier (Health for network) or, for
              domains that take effect without a controlled restart, by the saver itself.
* `last_good` the newest revision verified to work; the recovery target.

Every save carries `expected_revision` (the `latest` the editor started from). A mismatch is a conflict: nothing is
written and the caller gets the current revision plus a value diff, so a second window never silently overwrites a
first. Writes are temp-file + fsync + atomic replace. A revision holding a secret -- a secret-looking key at any depth, or a
value carrying one (a URL query token, an Authorization/Bearer string, a JWT, a private key; config/secret_scrub.json)
-- is refused before anything is stored.

Store state: ABSENT (never initialised: no pointer, no revision), OK, CORRUPT (the pointer is
unreadable, or missing while revisions exist) or INCONSISTENT (the pointer names a revision that does not load, or
`active`/`last_good` beyond `latest`). Anything but ABSENT/OK fails closed -- reads and writes raise StoreUnreadable;
a damaged store is never read as an empty one.

Writer lock: `<domain>/.lock` holds {token, pid, created_ms} and appears atomically (written aside, then
hard-linked in), so it is never seen half-written. Only the token that created it removes it. A lock is taken over
only when its owner process is gone (or its PID now belongs to another process) -- never because of its age -- and
each takeover is a `config.lock_takeover` remediation.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, Mapping
import logging
from config.secret_scrub import secret_paths

_failure_log = logging.getLogger(__name__)

REVISION_SCHEMA = "stock-monitor-config-revision-v1"
POINTER_SCHEMA = "stock-monitor-config-pointer-v1"
_DOMAIN = re.compile(r"^[a-z][a-z0-9_]{0,40}$")
# The only secret-looking keys a revision may hold: a reference to a stored credential, and whether one is configured.
_SECRET_ALLOWED = {"credential_ref", "credential_configured", "credentials_configured"}
_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()
# set_active() without an expected active pointer; None is a real expectation ("no saved revision is active").
_UNCHECKED: Any = object()
# Same tolerance as config/js/config_revisions.js: Node records its own start from its time origin, which trails the
# OS creation time by up to a second or so.
_CREATED_TOLERANCE_MS = 10_000
# How long a held lock is waited on before its owner's identity is checked (a write holds it for milliseconds).
_OWNER_CHECK_AFTER_S = 1.0


class RevisionConflict(Exception):
    def __init__(self, expected: int | None, current: Mapping[str, Any] | None, diff: list[dict[str, Any]]):
        super().__init__(f"expected revision {expected}, latest is {current.get('revision') if current else None}")
        self.expected = expected
        self.current = dict(current) if current else None
        self.diff = diff


class StoreUnreadable(Exception):
    """The store exists but cannot be trusted (CORRUPT / INCONSISTENT): nothing is read from it or written to it."""

    def __init__(self, domain: str, state: str, reason: str):
        super().__init__(f"config domain {domain} is {state}: {reason}")
        self.domain = domain
        self.state = state
        self.reason = reason


class RevisionRejected(Exception):
    def __init__(self, problems: list[Any]):
        super().__init__(f"revision rejected: {problems}")
        self.problems = problems


def config_root() -> Path:
    from service.platform.project_root import CONFIG_ROOT

    return CONFIG_ROOT


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def secret_keys(value: Any, prefix: str = "") -> list[str]:
    """Every path of ``value`` that holds a secret (by key or by value); empty when the revision may be stored."""
    return secret_paths(value, prefix, allowed_names=_SECRET_ALLOWED)


def value_diff(before: Any, after: Any, prefix: str = "") -> list[dict[str, Any]]:
    if isinstance(before, Mapping) and isinstance(after, Mapping):
        out: list[dict[str, Any]] = []
        for key in sorted(set(before) | set(after), key=str):
            path = f"{prefix}.{key}" if prefix else str(key)
            if key not in before:
                out.append({"path": path, "change": "added", "after": after[key]})
            elif key not in after:
                out.append({"path": path, "change": "removed", "before": before[key]})
            else:
                out.extend(value_diff(before[key], after[key], path))
        return out
    if before != after:
        return [{"path": prefix, "change": "changed", "before": before, "after": after}]
    return []


def _own_created_ms() -> int:
    from service.platform.process_observer import process_created_epoch_ns

    created = process_created_epoch_ns(os.getpid())
    return int(created // 1_000_000) if created else int((time.time() - time.monotonic() + _MONOTONIC_AT_IMPORT) * 1000)


_MONOTONIC_AT_IMPORT = time.monotonic()


# How deep takeover claims are followed (a claimant that died while taking over a lock, then one taking over its claim).
TAKEOVER_DEPTH = 3


def _owner_state(owner: Mapping[str, Any]) -> str:
    """"alive", "gone" (no such process) or "replaced" (the PID belongs to a process started at another time)."""
    from service.platform.process_observer import process_created_epoch_ns, process_exists

    pid = owner.get("pid")
    if not process_exists(pid):
        return "gone"
    created = process_created_epoch_ns(pid)
    recorded = owner.get("created_ms")
    if created is not None and isinstance(recorded, int) and abs(created // 1_000_000 - recorded) > _CREATED_TOLERANCE_MS:
        return "replaced"
    return "alive"


# The process's remediation emitter, installed by its composition root (api/service_host.py run_service); config/
# never starts one itself. Without one a takeover is still a WARNING in the service log.
_remediation_emitter: Callable[[], Any] | None = None


def set_remediation_emitter(provider: Callable[[], Any] | None) -> None:
    global _remediation_emitter
    _remediation_emitter = provider


def _record_takeover(domain: str, lock_path: Path, owner: Mapping[str, Any], trigger: str, outcome: str, result: str) -> None:
    detail = {"domain": domain, "path": str(lock_path), "stored_pid": owner.get("pid"), "contender_pid": os.getpid(),
              "age_ms": max(0, int(time.time() * 1000) - int(owner.get("at_ms") or 0)), "result": result}
    if _remediation_emitter is None:
        _failure_log.warning("config lock takeover (%s, %s) with no remediation emitter installed: %s", trigger, outcome, detail)
        return
    _remediation_emitter().emit(component="config_store", mechanism_id="config.lock_takeover", trigger_reason=trigger,
                                outcome=outcome, detail=detail)


def _atomic_write(path: Path, document: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    data = json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True).encode("utf-8")
    with open(tmp, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


class ConfigRevisionStore:
    LOCK_TIMEOUT_S = 5.0

    def __init__(self, root: str | os.PathLike, domain: str):
        if not _DOMAIN.match(domain):
            raise ValueError(f"invalid config domain {domain!r}")
        self.root = Path(root)
        self.domain = domain
        self.directory = self.root / domain
        self.revisions = self.directory / "revisions"
        self.pointer_path = self.directory / "pointer.json"

    # ------------------------------------------------------------------ reads
    def _revision_numbers(self) -> list[int]:
        if not self.revisions.exists():
            return []
        return sorted(int(p.stem[1:]) for p in self.revisions.glob("r*.json") if p.stem[1:].isdigit())

    def state(self) -> dict[str, Any]:
        """{"state": ABSENT | OK | CORRUPT | INCONSISTENT, "reason", "pointer"} -- see the module docstring."""
        empty = {"schema": POINTER_SCHEMA, "domain": self.domain, "latest": None, "active": None, "last_good": None}
        try:
            text = self.pointer_path.read_text(encoding="utf-8")
        except FileNotFoundError:  # not an error: no pointer file: answered as the ABSENT or CORRUPT state
            if self._revision_numbers():
                return {"state": "CORRUPT", "reason": "pointer missing while revisions exist", "pointer": None}
            return {"state": "ABSENT", "reason": None, "pointer": empty}
        except OSError as exc:  # not an error: answered as the CORRUPT state with the reason, which the caller reports
            return {"state": "CORRUPT", "reason": f"pointer unreadable: {exc.__class__.__name__}", "pointer": None}
        try:
            pointer = json.loads(text)
        except ValueError:  # not an error: answered as the CORRUPT state with the reason, which the caller reports
            return {"state": "CORRUPT", "reason": "pointer is not JSON", "pointer": None}
        if not isinstance(pointer, dict) or pointer.get("schema") != POINTER_SCHEMA:
            return {"state": "CORRUPT", "reason": "pointer schema", "pointer": None}
        # Every field is stated (null when there is none) and names this domain: a pointer missing them read as an
        # empty store, and the next save allocated revision 1 over the one on disk.
        missing = [name for name in ("domain", "latest", "active", "last_good") if name not in pointer]
        if missing:
            return {"state": "CORRUPT", "reason": f"pointer lacks {', '.join(missing)}", "pointer": None}
        if pointer.get("domain") != self.domain:
            return {"state": "CORRUPT", "reason": f"pointer names domain {pointer.get('domain')!r}", "pointer": None}
        fields = {name: pointer.get(name) for name in ("latest", "active", "last_good")}
        for name, value in fields.items():
            if value is not None and (not isinstance(value, int) or isinstance(value, bool) or value < 1):
                return {"state": "CORRUPT", "reason": f"pointer {name} is not a revision number", "pointer": None}
            if value is not None and self.get(value) is None:
                return {"state": "INCONSISTENT", "reason": f"pointer {name}={value} names no loadable revision", "pointer": None}
        latest = fields["latest"]
        # No latest over revisions on disk is the same damage as a missing pointer over them: the next save would
        # allocate revision 1 again. (A file past a stated latest is a save that crashed before its pointer moved.)
        if latest is None and self._revision_numbers():
            return {"state": "CORRUPT", "reason": "pointer names no latest while revisions exist", "pointer": None}
        for name in ("active", "last_good"):
            if fields[name] is not None and (latest is None or fields[name] > latest):
                return {"state": "INCONSISTENT", "reason": f"pointer {name}={fields[name]} is beyond latest={latest}", "pointer": None}
        return {"state": "OK", "reason": None, "pointer": pointer}

    def pointer(self) -> dict[str, Any]:
        """The pointer (an empty one for an ABSENT store). Raises StoreUnreadable for a CORRUPT / INCONSISTENT one."""
        state = self.state()
        if state["pointer"] is None:
            raise StoreUnreadable(self.domain, state["state"], state["reason"])
        return state["pointer"]

    def get(self, revision: int | None) -> dict[str, Any] | None:
        if revision is None:
            return None
        try:
            document = json.loads((self.revisions / f"r{int(revision):06d}.json").read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            _failure_log.warning("reading a config revision failed: %s: %s", type(exc).__name__, exc)
            return None
        if document.get("schema") != REVISION_SCHEMA or document.get("revision") != int(revision):
            return None
        return document

    def latest(self) -> dict[str, Any] | None:
        return self.get(self.pointer().get("latest"))

    def active(self) -> dict[str, Any] | None:
        return self.get(self.pointer().get("active"))

    def last_good(self) -> dict[str, Any] | None:
        return self.get(self.pointer().get("last_good"))

    def history(self, limit: int = 20) -> list[dict[str, Any]]:
        # Only committed revisions: a file past `latest` is a save that crashed before its pointer moved.
        latest = self.pointer().get("latest") or 0
        numbers = [n for n in reversed(self._revision_numbers()) if n <= latest]
        out = []
        for number in numbers[: max(1, int(limit))]:
            document = self.get(number)
            if document:
                out.append({k: document.get(k) for k in ("revision", "previous_revision", "created_at", "source", "summary")})
        return out

    # ----------------------------------------------------------------- writes
    @contextmanager
    def _locked(self) -> Iterator[None]:
        with _LOCKS_GUARD:
            local = _LOCKS.setdefault(str(self.directory.resolve()), threading.Lock())
        with local:
            self.directory.mkdir(parents=True, exist_ok=True)
            lock_path = self.directory / ".lock"
            token = uuid.uuid4().hex
            record = {"token": token, "pid": os.getpid(), "created_ms": _own_created_ms(), "at_ms": int(time.time() * 1000)}
            aside = self.directory / f".lock.{token}"
            started = time.monotonic()
            deadline = started + self.LOCK_TIMEOUT_S
            try:
                aside.write_text(json.dumps(record), encoding="utf-8")
                while True:
                    try:
                        os.link(aside, lock_path)
                        break
                    except FileExistsError:
                        # not an error: another writer holds the domain lock; wait (a dead owner's lock is taken over)
                        if time.monotonic() - started >= _OWNER_CHECK_AFTER_S and self._take_over(lock_path):
                            continue
                        if time.monotonic() > deadline:
                            raise TimeoutError(f"config domain {self.domain} is locked")
                        time.sleep(0.02)
            finally:
                try:
                    aside.unlink()
                except OSError as exc:
                    _failure_log.warning("removing a set-aside config file failed: %s: %s", type(exc).__name__, exc)
            try:
                yield
            finally:
                self._release(lock_path, token)

    @staticmethod
    def _read_lock(lock_path: Path) -> dict[str, Any] | None:
        try:
            owner = json.loads(lock_path.read_text(encoding="utf-8"))
        except FileNotFoundError:  # not an error: no lock held
            return None
        except (OSError, ValueError) as exc:
            _failure_log.warning("reading the config lock failed: %s: %s", type(exc).__name__, exc)
            return None
        return owner if isinstance(owner, dict) else None

    def _release(self, lock_path: Path, token: str) -> None:
        # Only the token that made the lock removes it: a lock someone else holds is never ours to drop.
        owner = self._read_lock(lock_path)
        if owner and owner.get("token") == token:
            try:
                lock_path.unlink()
            except OSError as exc:
                _failure_log.warning("releasing the config lock failed: %s: %s", type(exc).__name__, exc)

    def _take_over(self, lock_path: Path) -> bool:
        """Remove the lock when its owner process is gone. True when the lock was removed."""
        return self._remove_dead(lock_path, 0)

    def _remove_dead(self, path: Path, depth: int) -> bool:
        """Remove `path` -- the lock, or a takeover claim -- when the process that wrote it is gone. True when removed.

        The takeover of THIS dead file is claimed first: `<path>.takeover.<its token>`, made exclusively and carrying
        the claimant's own owner record, so one contender alone removes it. While the dead file exists no one can
        create a new one in its place, so the file read again under the claim is still the dead one when it is removed
        (a move-aside could carry off a live lock another contender had made in between). A claim whose claimant died
        before removing it is itself a dead file, removed the same way -- otherwise it would block every writer of the
        domain for good -- up to TAKEOVER_DEPTH levels."""
        owner = self._read_lock(path)
        if owner is None or not owner.get("token"):
            return False  # removed meanwhile (the next acquire attempt tells), or not a file this store wrote
        trigger = {"gone": "owner_process_gone", "replaced": "owner_process_replaced"}.get(_owner_state(owner))
        if trigger is None:
            return False
        token = re.sub(r"[^A-Za-z0-9_-]", "", str(owner.get("token")))[:64]
        claim = path.with_name(f"{path.name}.takeover.{token}")
        claim_token = self._make_claim(claim)
        if claim_token is None:
            # Another contender is taking it over -- or one that died doing so left its claim behind.
            if depth + 1 < TAKEOVER_DEPTH:
                self._remove_dead(claim, depth + 1)
            else:
                _failure_log.warning("taking over a config lock failed: takeover claims %s deep at %s", TAKEOVER_DEPTH, claim)
            return False
        try:
            current = self._read_lock(path) or {}
            if current.get("token") != owner.get("token"):
                return False      # already removed and replaced: nothing of ours to take over
            path.unlink()
        finally:
            self._release(claim, claim_token)
        _record_takeover(self.domain, path, owner, trigger, "succeeded", "lock removed" if depth == 0 else "takeover claim removed")
        return True

    @staticmethod
    def _make_claim(claim: Path) -> str | None:
        """Create `claim` exclusively, whole with this process's owner record; its token, or None when it exists.
        Any other failure (no space, no access) is the I/O error it is and is raised."""
        token = uuid.uuid4().hex
        aside = claim.with_name(f"{claim.name}.{token}.aside")
        aside.write_text(json.dumps({"token": token, "pid": os.getpid(), "created_ms": _own_created_ms(),
                                     "at_ms": int(time.time() * 1000)}), encoding="utf-8")
        try:
            os.link(aside, claim)
            return token
        except FileExistsError:  # not an error: the claim is someone else's
            return None
        finally:
            try:
                aside.unlink()
            except OSError as exc:
                _failure_log.warning("removing a set-aside takeover claim failed: %s: %s", type(exc).__name__, exc)

    def save(self, values: Mapping[str, Any], *, expected_revision: int | None, source: str, summary: str = "",
             activate: bool = False, validator=None) -> dict[str, Any]:
        """Persist a new immutable revision. `expected_revision` must equal the current `latest`."""
        leaks = secret_keys(values)
        if leaks:
            raise RevisionRejected([{"code": "SECRET_IN_CONFIG", "paths": leaks}])
        if validator is not None:
            problems = list(validator(values) or [])
            if problems:
                raise RevisionRejected(problems)
        with self._locked():
            pointer = self.pointer()
            latest = self.get(pointer.get("latest"))
            current_number = latest.get("revision") if latest else None
            if (expected_revision or None) != (current_number or None):
                raise RevisionConflict(expected_revision, latest,
                                       value_diff((latest or {}).get("values") or {}, dict(values)))
            number = (current_number or 0) + 1
            document = {
                "schema": REVISION_SCHEMA, "domain": self.domain, "revision": number,
                "previous_revision": current_number, "created_at": _now(), "source": str(source),
                "summary": str(summary or ""), "values": json.loads(json.dumps(values)),
            }
            _atomic_write(self.revisions / f"r{number:06d}.json", document)
            pointer.update({"latest": number, "updated_at": _now()})
            if activate:
                pointer.update({"active": number, "last_good": number})
            _atomic_write(self.pointer_path, pointer)
            return document

    def set_active(self, revision: int, *, verified: bool, expected_active: int | None = _UNCHECKED) -> dict[str, Any]:
        """Move the active pointer (the domain's applier only). `verified` also moves last_good.

        `expected_active` (a revision, or None for "the defaults") makes the move conditional on the current pointer.
        """
        with self._locked():
            if self.get(revision) is None:
                raise RevisionRejected([{"code": "UNKNOWN_REVISION", "revision": revision}])
            pointer = self.pointer()
            if expected_active is not _UNCHECKED and pointer.get("active") != expected_active:
                raise RevisionConflict(expected_active, self.get(pointer.get("active")), [])
            pointer["active"] = int(revision)
            if verified:
                pointer["last_good"] = int(revision)
            pointer["updated_at"] = _now()
            _atomic_write(self.pointer_path, pointer)
            return pointer
