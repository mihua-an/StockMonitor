from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable, Iterable, Mapping

from service.platform import remediation
from service.platform.api_call_log import record_api_call
from service.market.shared.provider import ProviderSubscriptionManager
from service.market.shared.provider_contract import FUTU_CAPABILITIES, ProviderCapabilities

logger = logging.getLogger(__name__)


class FutuSubscriptionManager(ProviderSubscriptionManager):
    """Own desired and session-scoped confirmed OpenD subscriptions.

    What is desired is exactly Market Runtime's plan: each plan instrument, named as Market
    Runtime names it, resolved through the capabilities; one planned with the order book gets the full lane set
    (QUOTE/RT_DATA/TICKER/ORDER_BOOK), one without it the quote lanes. The watchlist, focus and workspace are not
    owner sets here: nothing is subscribed beside the plan. The manager also owns Moomoo's one-minute minimum subscription
    lifetime and unsubscribe retry policy so provider lifecycle rules do not leak into the market service.
    """

    def __init__(
        self,
        *,
        capabilities: ProviderCapabilities = FUTU_CAPABILITIES,
        minimum_subscription_seconds: float = 60.0,
        unsubscribe_retry_seconds: float = 5.0,
    ) -> None:
        super().__init__("futu")
        if capabilities.provider != self.provider:
            raise ValueError("Futu subscription manager requires Futu capabilities")
        self.capabilities = capabilities
        self.minimum_subscription_seconds = max(0.0, float(minimum_subscription_seconds))
        self.unsubscribe_retry_seconds = max(0.1, float(unsubscribe_retry_seconds))
        self._lock = threading.RLock()
        # Market Runtime's plan: (market, code) -> the lanes it is subscribed with.
        self._plan: dict[tuple[str, str], tuple[str, ...]] = {}
        # The market Market Runtime named each code with, kept while OpenD still holds a pair of it (a code that left
        # the plan inside its minimum subscription time is reported as draining under that name).
        self._market_of: dict[str, str] = {}
        self.confirmed_pairs: set[tuple[str, str]] = set()
        self.subscription_objects: dict[tuple[str, str], Any] = {}
        self.subscription_started_at: dict[tuple[str, str], float] = {}
        self.unsubscribe_retry_after: dict[tuple[str, str], float] = {}
        self.subscribe_retry_after: dict[tuple[str, str], float] = {}
        self.subscribe_failures: dict[tuple[str, str], int] = {}
        # The last SDK error of a pair that is not subscribed (what the plan report says about it).
        self.subscribe_errors: dict[tuple[str, str], str] = {}
        self._subscribe_count = 0
        self._unsubscribe_count = 0
        self._deferred_unsubscribe_count = 0
        self._errors = 0
        # The current error (a pair still failing to subscribe or unsubscribe) and the last one with its recovery.
        self._last_error = ""
        self._last_failure: dict[str, Any] | None = None
        # Open pair retries: (kind, pair) -> [remediation operation, attempts].
        self._retry_ops: dict[tuple[str, tuple[str, str]], list[Any]] = {}
        # OpenD's subscription quota as query_subscription last answered it (None: not read on this context yet), and
        # whether it is to be read again (a new context, a sync that moved pairs, a refused subscribe, a reader).
        self._quota: dict[str, Any] | None = None
        self._quota_due = True
        # Desired pairs the last sync left unsubscribed because OpenD had no room for them yet: pairs it still holds
        # wait out their one-minute minimum first.
        self.waiting_for_room: set[tuple[str, str]] = set()

    # ------------------------------------------------------------------ OpenD quota
    def observe_quota(self, data: Mapping[str, Any]) -> bool:
        """OpenD's ``query_subscription(is_all_conn=True)`` answer. OpenD counts every type of every instrument as one
        subscription, across all of its connections: this connection may hold its own plus what remains (another
        connection keeps what it holds). Returns whether that capacity changed."""
        total_used, remain, own_used = (int(data[name]) for name in ("total_used", "remain", "own_used"))
        if min(total_used, remain, own_used) < 0 or own_used > total_used:
            raise ValueError(f"OpenD query_subscription answered an impossible quota: {dict(data)!r}")
        quota = {"streams": own_used + remain, "total": total_used + remain, "own_used": own_used,
                 "used_by_others": total_used - own_used, "remain": remain, "read_at": time.time()}
        with self._lock:
            changed = self._quota is None or self._quota["streams"] != quota["streams"]
            self._quota = quota
            self._quota_due = False
        return changed

    def quota_due(self) -> bool:
        with self._lock:
            return self._quota_due

    def request_quota_read(self) -> None:
        with self._lock:
            self._quota_due = True

    def quota_streams(self) -> int | None:
        with self._lock:
            return None if self._quota is None else int(self._quota["streams"])

    def quota_snapshot(self) -> dict[str, Any]:
        """OpenD's quota beside what this connection holds of it: held pairs, the ones held outside the plan (退訂中:
        an unsubscribe waiting out the one-minute minimum) and the desired ones waiting for room."""
        with self._lock:
            desired = {(code, lane) for (_market, code), lanes in self._plan.items() for lane in lanes}
            draining = sorted(self.confirmed_pairs - desired)
            return {"known": self._quota is not None, **(self._quota or {}),
                    "held": len(self.confirmed_pairs), "planned": len(desired),
                    "draining": [{"code": code, "lane": lane} for code, lane in draining],
                    "waiting": [{"code": code, "lane": lane} for code, lane in sorted(self.waiting_for_room)]}

    # ------------------------------------------------------------------ pair retries
    _RETRY_MECHANISM = {"subscribe": "provider.futu_subscribe_retry", "unsubscribe": "provider.futu_unsubscribe_retry"}
    _RETRY_TRIGGER = {"subscribe": "subscribe_failed", "unsubscribe": "unsubscribe_failed"}

    @staticmethod
    def _log_if_session_ended(session_current: Callable[[], bool], kind: str, pair: tuple[str, str], error: str) -> bool:
        """True (and logged) when the context this call was made on was closed while it ran.

        Whether the session is current is the context owner's answer (the OpenD lifecycle), asked at the moment of the
        failure: the provider's stop closes the context from its own thread at any point of a pass, and a call that
        failed because of that close is no pair to retry -- reset_session has already abandoned the open retries and
        no one would ever finish a new one."""
        ended = not session_current()
        if ended:
            logger.info("[FUTU] %s %s %s failed on a closed session (%s): not retried, the session is gone", kind, pair[0], pair[1], error)
        return ended

    def _retry_failed(self, kind: str, pair: tuple[str, str], error: str) -> None:
        """A pair whose subscribe/unsubscribe failed is one remediation until it succeeds or stops being wanted;
        each later failed try is an attempt of it. Caller holds no lock."""
        key = (kind, pair)
        with self._lock:
            entry = self._retry_ops.get(key)
            if entry is not None:
                entry[1] += 1
                return
        operation = remediation.emitter().begin(
            component="futu_subscriptions", mechanism_id=self._RETRY_MECHANISM[kind], trigger_reason=self._RETRY_TRIGGER[kind],
            identity={"source": "futu", "code": pair[0], "lane": pair[1]}, detail={"error": error})
        with self._lock:
            self._retry_ops.setdefault(key, [operation, 1])

    def confirmed_snapshot(self) -> set[tuple[str, str]]:
        """The (code, lane) pairs OpenD has confirmed, copied under this manager's lock."""
        with self._lock:
            return set(self.confirmed_pairs)

    def plan_snapshot(self) -> tuple[set[tuple[str, str]], dict[tuple[str, str], str], set[tuple[str, str]]]:
        """(confirmed pairs, subscribe errors by pair, pairs waiting for OpenD's room), read together under this
        manager's lock."""
        with self._lock:
            return set(self.confirmed_pairs), dict(self.subscribe_errors), set(self.waiting_for_room)

    def _retry_finished(self, kind: str, pair: tuple[str, str], outcome: str, reason: str = "") -> None:
        with self._lock:
            entry = self._retry_ops.pop((kind, pair), None)
        if entry is not None:
            entry[0].finish(outcome, attempt=entry[1], detail={"reason": reason} if reason else {})

    def _abandon_retries(self, reason: str, keep: Callable[[str, tuple[str, str]], bool] = lambda _k, _p: False) -> None:
        with self._lock:
            dropped = [key for key in self._retry_ops if not keep(*key)]
        for kind, pair in dropped:
            self._retry_finished(kind, pair, "abandoned", reason)

    def reset_session(self) -> None:
        # The quote context went with every pair it held: no pair retry outlives it (a new context subscribes anew).
        self._abandon_retries("session_reset")
        with self._lock:
            self.confirmed_pairs.clear()
            self.subscription_objects.clear()
            self.subscription_started_at.clear()
            self.unsubscribe_retry_after.clear()
            self.subscribe_retry_after.clear()
            self.subscribe_failures.clear()
            self.subscribe_errors.clear()
            self.waiting_for_room.clear()
            # A new context is read again before it subscribes (another connection may hold more or less by then).
            self._quota = None
            self._quota_due = True
            self._clear_current_error()

    def _failed(self, error: str) -> None:
        """Under _lock: a subscribe/unsubscribe just failed."""
        self._errors += 1
        self._last_error = error
        self._last_failure = {"error": error, "at": time.time(), "recovered_at": None}

    def _clear_current_error(self) -> None:
        """Under _lock: once no pair is failing, the last error is history, not the current state."""
        failing = self.subscribe_errors or any(kind == "unsubscribe" for kind, _pair in self._retry_ops)
        if self._last_error and not failing:
            self._last_error = ""
            if self._last_failure is not None:
                self._last_failure["recovered_at"] = time.time()

    def replace_plan(self, items: Iterable[Mapping[str, Any]]) -> dict[tuple[str, str], str]:
        """Make the plan's instruments the desired pairs. Returns those refused (no capability), with the reason."""
        plan: dict[tuple[str, str], tuple[str, ...]] = {}
        refused: dict[tuple[str, str], str] = {}
        for item in items:
            key = (str(item.get("market") or "").strip().upper(), str(item.get("code") or "").strip().upper())
            if not key[1] or key in plan:
                continue
            resolved = self.capabilities.resolve(*key)
            if resolved is None:
                refused[key] = "UNSUPPORTED_INSTRUMENT"
                continue
            # 報價＋分時 (QUOTE, RT_DATA) always: the price and the trend are drawn from them; 明細 (TICKER) and 五檔
            # (ORDER_BOOK) as the plan's kinds say (設定 → 訂閱管理).
            kinds = {str(k).lower() for k in item.get("kinds") or ()}
            wanted = {"QUOTE", "RT_DATA"} | ({"TICKER"} if "trade" in kinds else set()) | ({"ORDER_BOOK"} if "orderbook" in kinds else set())
            plan[key] = tuple(lane for lane in resolved.lanes if lane in wanted)
        with self._lock:
            self._plan = plan
            self._market_of.update({code: market for market, code in plan})
        return refused

    def planned(self) -> dict[tuple[str, str], tuple[str, ...]]:
        with self._lock:
            return dict(self._plan)

    def draining(self) -> list[tuple[str, str]]:
        """(market, code) of every instrument OpenD still holds a pair of although the plan dropped it: its unsubscribe
        waits out Moomoo's one-minute minimum (or a retry). The broker still pushes it, so Market Runtime keeps it
        covered until the pair is really gone."""
        with self._lock:
            planned = {code for _market, code in self._plan}
            held = {code for code, _lane in self.confirmed_pairs if code not in planned}
            for code in [c for c in self._market_of if c not in planned and c not in held]:
                self._market_of.pop(code, None)
            return sorted((self._market_of.get(code) or code.split(".", 1)[0], code) for code in held)

    def planned_codes(self) -> tuple[str, ...]:
        with self._lock:
            return tuple(code for _market, code in self._plan)

    def desired_pairs(self) -> set[tuple[str, str]]:
        with self._lock:
            return {(code, lane) for (_market, code), lanes in self._plan.items() for lane in lanes}

    def subscription_plan(self, code: str):
        normalized = str(code or "").strip().upper()
        security_type = normalized.split(".", 1)[0] if "." in normalized else ""
        return self.capabilities.plan_for(security_type, normalized)

    def is_confirmed(self, code: str, subtype: str) -> bool:
        pair = (str(code or "").strip().upper(), str(subtype or "").strip().upper())
        with self._lock:
            return pair in self.confirmed_pairs

    def code_ready(self, code: str, subtypes: Iterable[str]) -> bool:
        normalized = str(code or "").strip().upper()
        required = {str(item or "").strip().upper() for item in subtypes if str(item or "").strip()}
        with self._lock:
            return all((normalized, subtype) in self.confirmed_pairs for subtype in required)

    @staticmethod
    def _sdk_subtype(sdk: Any, subtype_key: str) -> Any:
        subtypes = getattr(sdk, "SubType", None)
        if subtypes is None:
            raise RuntimeError("Futu SDK does not expose SubType")
        subtype = getattr(subtypes, subtype_key, None)
        if subtype is None:
            raise RuntimeError(f"Futu SDK does not support subtype {subtype_key}")
        return subtype

    def subscribe(
        self,
        context: Any,
        sdk: Any,
        codes: list[str],
        subtype_keys: list[str],
        *,
        call: Callable[..., Any],
        session_current: Callable[[], bool],
        session_all: Any = None,
    ) -> None:
        for subtype_key in subtype_keys:
            subtype_key = str(subtype_key).upper()
            subtype = self._sdk_subtype(sdk, subtype_key)
            with self._lock:
                now = time.monotonic()
                missing = [
                    code for code in codes
                    if (str(code).upper(), subtype_key) not in self.confirmed_pairs
                    and now >= float(self.subscribe_retry_after.get((str(code).upper(), subtype_key), 0.0))
                ]
            for raw_code in missing:
                code = str(raw_code).upper()
                pair = (code, subtype_key)
                kwargs: dict[str, Any] = {"subscribe_push": True}
                if session_all is not None and code.startswith("US."):
                    kwargs["session"] = session_all
                # A closed context takes no call: reset_session cleared every confirmed pair, so a pass that went on
                # would send the whole plan to a closed context.
                if not session_current():
                    return
                try:
                    call(context, "subscribe", [code], [subtype], **kwargs)
                except Exception as exc:
                    ended = self._log_if_session_ended(session_current, "subscribe", pair, f"{type(exc).__name__}: {exc}"[:300])
                    if ended:
                        return
                    self._retry_failed("subscribe", pair, f"{type(exc).__name__}: {exc}"[:300])
                    with self._lock:
                        self.subscribe_errors[pair] = f"{type(exc).__name__}: {exc}"[:120]
                        failures = min(8, int(self.subscribe_failures.get(pair, 0)) + 1)
                        self.subscribe_failures[pair] = failures
                        delay = min(15.0, 1.0 * (2 ** min(4, failures - 1)))
                        self.subscribe_retry_after[pair] = time.monotonic() + delay
                        self._failed(f"subscribe {code} {subtype_key}: {exc}")
                        # A refusal may be the quota (another connection took some): it is read again.
                        self._quota_due = True
                    continue
                with self._lock:
                    self.confirmed_pairs.add(pair)
                    self.subscription_objects[pair] = subtype
                    self.subscription_started_at[pair] = time.monotonic()
                    self.unsubscribe_retry_after.pop(pair, None)
                    self.subscribe_retry_after.pop(pair, None)
                    self.subscribe_failures.pop(pair, None)
                    self.subscribe_errors.pop(pair, None)
                    self._subscribe_count += 1
                self._retry_finished("subscribe", pair, "succeeded")
                with self._lock:
                    self._clear_current_error()

    def unsubscribe_pair(self, context: Any, code: str, subtype_key: str, *, call: Callable[..., Any],
                         session_current: Callable[[], bool]) -> bool:
        pair = (str(code).upper(), str(subtype_key).upper())
        with self._lock:
            subtype = self.subscription_objects.get(pair)
            if subtype is None:
                self.confirmed_pairs.discard(pair)
                self.subscription_started_at.pop(pair, None)
                self.unsubscribe_retry_after.pop(pair, None)
                return True
            now = time.monotonic()
            started_at = float(self.subscription_started_at.get(pair, now))
            earliest = started_at + self.minimum_subscription_seconds
            retry_after = float(self.unsubscribe_retry_after.get(pair, 0.0))
            if now < max(earliest, retry_after):
                self._deferred_unsubscribe_count += 1
                return False
        if not session_current():
            return False
        try:
            call(context, "unsubscribe", [pair[0]], [subtype])
        except Exception as exc:
            ended = self._log_if_session_ended(session_current, "unsubscribe", pair, f"{type(exc).__name__}: {exc}"[:300])
            if ended:
                return False
            self._retry_failed("unsubscribe", pair, f"{type(exc).__name__}: {exc}"[:300])
            with self._lock:
                self.unsubscribe_retry_after[pair] = time.monotonic() + self.unsubscribe_retry_seconds
                self._failed(f"unsubscribe {pair[0]} {pair[1]}: {exc}")
            return False
        with self._lock:
            self.confirmed_pairs.discard(pair)
            self.subscription_objects.pop(pair, None)
            self.subscription_started_at.pop(pair, None)
            self.unsubscribe_retry_after.pop(pair, None)
            self._unsubscribe_count += 1
        self._retry_finished("unsubscribe", pair, "succeeded")
        with self._lock:
            self._clear_current_error()
        return True

    def subscribed_since(self, pair: tuple[str, str]) -> float | None:
        with self._lock:
            return self.subscription_started_at.get(pair) if pair in self.confirmed_pairs else None

    def sync(self, context: Any, sdk: Any, *, call: Callable[..., Any], session_current: Callable[[], bool],
             session_all: Any = None) -> dict[str, Any]:
        """Bring OpenD to the plan. Returns the outcome: ok only when every desired pair is confirmed -- a subscribe that
        failed is retried later, so this sync did not reach the plan.

        ``session_current`` is the context owner's answer to whether ``context`` is still the open session; once it is
        not, the pass stops and the outcome says ``session_ended`` (the context was closed under it: nothing failed)."""
        desired = self.desired_pairs()
        # A retry whose goal the plan dropped ends: a subscribe for a pair no longer wanted, an unsubscribe for one
        # wanted again.
        self._abandon_retries("plan_changed", lambda kind, pair: (pair in desired) == (kind == "subscribe"))

        # One API-call record per direction per sync, never one per (code, subtype) pair: a
        # single sync can move dozens of pairs and the point of that log is the operation, not
        # the iteration. Diff the confirmed set around the work so the record states what this
        # sync actually changed at OpenD rather than what it intended.
        # Unsubscribes go first: OpenD counts what it holds against the quota, so the room a new pair takes is the
        # room an unsubscribe frees. The plan can be replaced while this pass waits on OpenD (it is written from the
        # adapter control connection), so each call below is decided by the plan as it is at that call.
        with self._lock:
            before = set(self.confirmed_pairs)
            errors_before = self._errors
        unsubscribe_started_ns = time.perf_counter_ns()
        for code, subtype_key in sorted(before):
            if (code, subtype_key) not in self.desired_pairs():
                self.unsubscribe_pair(context, code, subtype_key, call=call, session_current=session_current)
        # Closed under this pass: reset_session emptied the confirmed set, so a diff taken now would report every
        # pair as unsubscribed and every desired pair as missing.
        if not session_current():
            return {"ok": False, "pending": False, "session_ended": True, "desired": len(desired), "missing": [],
                    "retry_in_seconds": None, "error": None}
        with self._lock:
            after_unsubscribe = set(self.confirmed_pairs)
            removed = sorted({code for code, _ in (before - after_unsubscribe)})
            unsubscribe_errors = self._errors - errors_before
        if removed or unsubscribe_errors:
            record_api_call(
                "futu", "unsubscribe", reason="subscription_sync", market=self.provider.upper(),
                symbols=removed,
                duration_ms=(time.perf_counter_ns() - unsubscribe_started_ns) / 1e6,
                ok=unsubscribe_errors == 0,
                error_type="UnsubscribeError" if unsubscribe_errors else None,
                detail={"failed_count": unsubscribe_errors,
                        "deferred_count": self._deferred_unsubscribe_count,
                        "last_error": self._last_error if unsubscribe_errors else None},
            )

        # Only what OpenD has room for is asked of it: Market Runtime plans within the quota, so a desired pair finds
        # no room only while pairs the plan dropped wait out their one-minute minimum (or before the quota is read on
        # this context). not an error: those pairs wait for the room and are subscribed by the sync that has it.
        with self._lock:
            # In the plan's order: with too little room the instruments Market Runtime put first are subscribed first.
            planned_pairs = [(code, lane) for (_market, code), lanes in self._plan.items() for lane in lanes]
            desired = set(planned_pairs)
            streams = -1 if self._quota is None else int(self._quota["streams"])
            missing_now =[pair for pair in planned_pairs if pair not in self.confirmed_pairs]
            room = max(0, streams - len(self.confirmed_pairs))
            fitting, self.waiting_for_room = missing_now[:room], set(missing_now[room:])
            errors_before = self._errors
        subscribe_started_ns = time.perf_counter_ns()
        for code, subtype_key in fitting:
            if (code, subtype_key) in self.desired_pairs():
                self.subscribe(context, sdk, [code], [subtype_key], call=call, session_current=session_current,
                               session_all=session_all)
        with self._lock:
            after_subscribe = set(self.confirmed_pairs)
            subscribe_errors = self._errors - errors_before
            if after_subscribe != before:
                self._quota_due = True
        added = sorted({code for code, _ in (after_subscribe - after_unsubscribe)})
        if added or subscribe_errors:
            record_api_call(
                "futu", "subscribe", reason="subscription_sync", market=self.provider.upper(),
                symbols=added,
                duration_ms=(time.perf_counter_ns() - subscribe_started_ns) / 1e6,
                ok=subscribe_errors == 0,
                error_type="SubscribeError" if subscribe_errors else None,
                detail={"failed_count": subscribe_errors, "desired_pair_count": len(desired),
                        "waiting_for_room": len(self.waiting_for_room),
                        "last_error": self._last_error if subscribe_errors else None},
            )
        if not session_current():
            return {"ok": False, "pending": False, "session_ended": True, "desired": len(desired), "missing": [],
                    "retry_in_seconds": None, "error": None}
        with self._lock:
            # Against the plan as it is now: a pair the plan dropped during this pass was skipped, not missed.
            desired = self.desired_pairs()
            missing = sorted(desired - self.confirmed_pairs)
            last_error = self._last_error
            now = time.monotonic()
            waits = [float(self.subscribe_retry_after.get(pair, 0.0)) - now for pair in missing]
        # Pending: pairs are missing but this sync tried none of them -- each waits out its own retry time or OpenD's
        # room. Not a new failure (a failure that started a retry wait was recorded when it happened).
        pending = bool(missing) and subscribe_errors == 0 and unsubscribe_errors == 0
        return {"ok": not missing, "pending": pending, "desired": len(desired),
                "missing": [f"{code}:{subtype}" for code, subtype in missing],
                "retry_in_seconds": round(max(0.0, min(waits)), 1) if pending and waits else None,
                "error": None if not missing else f"{len(missing)} of {len(desired)} desired pairs not confirmed"
                                                  f" ({', '.join(f'{c}:{s}' for c, s in missing[:5])}); last error: {last_error}"}

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            desired = sorted(self.desired_pairs())
            return {
                "provider": self.provider,
                "planned": [{"market": m, "code": c, "lanes": list(lanes)} for (m, c), lanes in sorted(self._plan.items())],
                "desired_count": len(desired),
                "confirmed_count": len(self.confirmed_pairs),
                "desired": [{"code": code, "subtype": subtype} for code, subtype in desired],
                "confirmed": [{"code": code, "subtype": subtype} for code, subtype in sorted(self.confirmed_pairs)],
                "subscribe_count": self._subscribe_count,
                "unsubscribe_count": self._unsubscribe_count,
                "deferred_unsubscribe_count": self._deferred_unsubscribe_count,
                "errors": self._errors,
                "subscribe_backoff_count": len(self.subscribe_retry_after),
                "last_error": self._last_error or None,
                "last_failure": dict(self._last_failure) if self._last_failure else None,
                "provider_capabilities": self.capabilities.snapshot(),
            }

    def readiness_snapshot(self) -> dict[str, Any]:
        """O(number of planned symbols), allocation-light readiness input."""
        with self._lock:
            return {
                "provider": self.provider,
                "planned_codes": tuple(code for _market, code in self._plan),
                "confirmed_pairs": frozenset(self.confirmed_pairs),
            }
