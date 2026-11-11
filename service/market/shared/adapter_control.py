"""A provider's adapter-control connection to Market Runtime (docs/system-architecture/03 section 2).

One connection registers the adapter, receives ``adapter.subscription.replace`` plans, applies them through the
provider's callback and reports what was ACTUALLY subscribed (``adapter.subscription.status``); when the provider's
broker state moves it reports the plan in force again. Split out of the event sink (rust_live.py), which keeps only
event delivery and starts this connection beside its ingest connection.
"""
from __future__ import annotations

import json
import threading
from typing import Any, Callable, Mapping

from service.platform import remediation

ReplaceSubscriptions = Callable[[list[dict[str, Any]], int], Mapping[str, Any]]
ReportSubscriptions = Callable[[], Mapping[str, Any]]


class AdapterControlConnection:
    def __init__(self, *, source: str, max_subscriptions: int | None, kinds: list[str] | None,
                 replace_subscriptions: ReplaceSubscriptions, report_subscriptions: ReportSubscriptions,
                 url: Callable[[], str | None], auth_headers: Callable[[], dict[str, str]],
                 on_transport_error: Callable[[str], None], stream_budget: Mapping[str, Any] | None = None) -> None:
        """replace_subscriptions(items, generation): make the plan's instruments -- ``{"market", "code", "kinds"}``,
            named as Market Runtime names them -- the provider's subscriptions, and return what the BROKER did:
            ``{"subscribed": [{"market", "code"[, "since_ns"]}], "failed": [{"market", "code", "reason"}]}``; ``since_ns``
            is when the instrument's print stream was subscribed, stated by a provider that fills gaps.
        report_subscriptions(): the same report for the plan in force, without changing anything.
        url / auth_headers: where and as whom to connect (the event sink's); on_transport_error(message): a failure of
            this connection, counted with the sink's transport errors.
        stream_budget: for a provider whose broker counts streams (Shioaji), ``{"streams": N, "kinds_by_market":
            {market: {kind: streams}}}`` -- its capacity in the broker's unit and what each kind of an instrument of a
            market takes, registered beside the instrument count. With it the provider bills a plan by streams itself
            (refusing past the budget with a reason), so the plan is not cut at the instrument count here.
        max_subscriptions None: the capacity is the broker's to say and not known yet (Futu: OpenD's quota); the adapter
            is registered once set_max_subscriptions states it, never with an assumed one."""
        self.source = str(source).strip().lower()
        self._max_subscriptions = None if max_subscriptions is None else max(1, int(max_subscriptions))
        self._stream_budget = self._valid_stream_budget(stream_budget)
        self._kinds = list(kinds or ["quote", "trade", "orderbook"])
        self._replace_subscriptions = replace_subscriptions
        self._report_subscriptions = report_subscriptions
        self._url = url
        self._auth_headers = auth_headers
        self._on_transport_error = on_transport_error
        self._lock = threading.Lock()
        # The plan last received (generation, items) and whether the provider asked to report it again.
        self._plan_generation: int | None = None
        self._planned: list[dict[str, Any]] = []
        self._report_due = threading.Event()
        # The provider's capacity changed (set_max_subscriptions): registered again on the open control connection.
        self._register_due = threading.Event()
        self._plans_applied = 0
        self._last_plan: dict[str, Any] | None = None

    @staticmethod
    def _valid_stream_budget(budget: Mapping[str, Any] | None) -> dict[str, Any] | None:
        if budget is None:
            return None
        markets = {str(market).upper(): {str(kind): int(count) for kind, count in dict(kinds).items()}
                   for market, kinds in dict(budget.get("kinds_by_market") or {}).items()}
        streams = int(budget.get("streams") or 0)
        if (streams < 1 or not markets or any(not kinds for kinds in markets.values())
                or any(kind not in ("quote", "trade", "orderbook") or count < 1 for kinds in markets.values() for kind, count in kinds.items())):
            raise ValueError(f"stream budget needs at least one stream and one market of at least one kind of at least one stream: {budget!r}")
        return {"streams": streams, "kinds_by_market": {market: dict(sorted(kinds.items())) for market, kinds in sorted(markets.items())}}

    def set_max_subscriptions(self, max_subscriptions: int, *, stream_budget: Mapping[str, Any] | None = None) -> None:
        """The provider can carry a different number of instruments (or streams) now (設定 → 永豐行情連線): Market
        Runtime is told on the open control connection and plans again within the new limit."""
        value = max(1, int(max_subscriptions))
        budget = self._valid_stream_budget(stream_budget) if stream_budget is not None else None
        with self._lock:
            budget = budget if stream_budget is not None else self._stream_budget
            if value == self._max_subscriptions and budget == self._stream_budget:
                return
            self._max_subscriptions = value
            self._stream_budget = budget
        self._register_due.set()

    # A view opened on a partition holding nothing (``adapter.history.view``): called with its identity.
    on_history_view: Any = None

    def subscriptions_changed(self) -> None:
        """The provider's broker state moved: report the plan in force again."""
        self._report_due.set()

    def stats(self) -> dict[str, Any]:
        with self._lock:
            return {"plans_applied": self._plans_applied, "last_plan": self._last_plan}

    def _register_message(self) -> str:
        with self._lock:
            limit = self._max_subscriptions
            budget = self._stream_budget
        payload: dict[str, Any] = {"source": self.source, "max_subscriptions": limit, "kinds": self._kinds}
        if budget is not None:
            payload["stream_budget"] = budget
        return json.dumps({"type": "adapter.register", "payload": payload}, separators=(",", ":"))

    @staticmethod
    def plan_items(payload: Mapping[str, Any]) -> list[dict[str, Any]]:
        """The plan's instruments, each with its market (never a bare code to guess a type from)."""
        out: list[dict[str, Any]] = []
        for item in payload.get("items") or ():
            if not isinstance(item, Mapping):
                continue
            code = str(item.get("code") or "").strip().upper()
            market = str(item.get("market") or "").strip().upper()
            if code and market:
                out.append({"market": market, "code": code, "kinds": [str(k) for k in item.get("kinds") or ()]})
        return out

    @staticmethod
    def report_rows(result: Any, planned: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, str]], list[dict[str, str]]]:
        """(subscribed, failed, draining) rows of a provider report. subscribed / failed are restricted to the plan; a
        planned instrument the report does not mention is failed (UNREPORTED), never assumed subscribed. A subscribed
        row keeps the provider's ``since_ns``: Market Runtime judges a late join by it (late_join.rs). draining is
        what the broker still holds outside the plan (an unsubscribe not done yet), never a planned instrument."""
        planned_keys = {(i["market"], i["code"]) for i in planned}
        result = result if isinstance(result, Mapping) else {}

        def key(row: Any) -> tuple[str, str] | None:
            if not isinstance(row, Mapping):
                return None
            k = (str(row.get("market") or "").strip().upper(), str(row.get("code") or "").strip().upper())
            return k if k in planned_keys else None
        subscribed: dict[tuple[str, str], dict[str, Any]] = {}
        for row in result.get("subscribed") or ():
            if k := key(row):
                subscribed[k] = {"market": k[0], "code": k[1], **({"since_ns": row["since_ns"]} if "since_ns" in row else {})}
        failed: dict[tuple[str, str], str] = {}
        for row in result.get("failed") or ():
            k = key(row)
            if k and k not in subscribed:
                failed[k] = str(row.get("reason") or "SUBSCRIBE_FAILED")[:120]
        for k in planned_keys - set(subscribed) - set(failed):
            failed[k] = "UNREPORTED"
        draining = set()
        for row in result.get("draining") or ():
            if isinstance(row, Mapping):
                k = (str(row.get("market") or "").strip().upper(), str(row.get("code") or "").strip().upper())
                if all(k) and k not in planned_keys:
                    draining.add(k)
        return ([subscribed[k] for k in sorted(subscribed)],
                [{"market": m, "code": c, "reason": r} for (m, c), r in sorted(failed.items())],
                [{"market": m, "code": c} for m, c in sorted(draining)])

    def _send_report(self, websocket: Any, generation: int, planned: list[dict[str, Any]], result: Any, ok: bool) -> None:
        subscribed, failed, draining = self.report_rows(result, planned)
        with self._lock:
            self._last_plan = {"generation": generation, "planned": len(planned), "subscribed": len(subscribed),
                               "failed": len(failed), "ok": ok}
        websocket.send(json.dumps({"type": "adapter.subscription.status", "payload": {
            "source": self.source, "generation": generation, "subscribed": subscribed, "failed": failed,
            "draining": draining}}, separators=(",", ":")))

    def apply_plan(self, websocket: Any, payload: Mapping[str, Any]) -> None:
        with self._lock:
            limit = self._max_subscriptions
            budgeted = self._stream_budget is not None
        planned = self.plan_items(payload)
        if not budgeted:
            planned = planned[:limit]
        generation = max(0, int(payload.get("generation") or 0))
        ok = True
        try:
            result = self._replace_subscriptions(planned, generation)
        except Exception as exc:
            # Reported to Market Runtime as the failure of every planned instrument, with the error as its reason.
            ok = False
            result = {"failed": [{**i, "reason": f"{type(exc).__name__}: {exc}"[:120]} for i in planned]}
        with self._lock:
            self._plans_applied += 1
            self._plan_generation = generation
            self._planned = planned
        self._report_due.clear()
        self._send_report(websocket, generation, planned, result, ok)

    def send_due_report(self, websocket: Any) -> None:
        """The provider's broker state moved since the last report: report the plan in force again."""
        if not self._report_due.is_set():
            return
        self._report_due.clear()
        with self._lock:
            generation, planned = self._plan_generation, list(self._planned)
        if generation is None:
            return
        try:
            result, ok = self._report_subscriptions(), True
        except Exception as exc:
            # Reported to Market Runtime as the failure of every planned instrument, with the error as its reason.
            result, ok = {"failed": [{**i, "reason": f"{type(exc).__name__}: {exc}"[:120]} for i in planned]}, False
        self._send_report(websocket, generation, planned, result, ok)

    def run(self, stop: threading.Event) -> None:
        from websockets.sync.client import connect

        delay = 0.05
        # A lost (or unopenable) control connection is one recovery, ended when the full plan Market Runtime
        # re-sends after registering this adapter again has been applied -- that is what replays the subscriptions;
        # the registration alone restored none of them.
        recovery = remediation.Recovery(component="adapter_control", mechanism_id="provider.adapter_control_reconnect")
        while not stop.is_set():
            url = self._url()
            with self._lock:
                capacity_known = self._max_subscriptions is not None
            if url is None or not capacity_known:
                # not an error: no address yet, or a capacity the broker has not stated yet -- registered when it has
                stop.wait(0.2)
                continue
            opened = False
            try:
                with connect(url, additional_headers=self._auth_headers(), proxy=None, open_timeout=2.0, close_timeout=0.1) as websocket:
                    opened = True
                    websocket.send(self._register_message())
                    registered = json.loads(websocket.recv(timeout=2.0))
                    if str(registered.get("type") or "") != "adapter.registered":
                        raise RuntimeError(f"adapter registration rejected: {registered}")
                    plan_applied = False
                    self._register_due.clear()
                    while not stop.is_set():
                        if self._register_due.is_set():
                            self._register_due.clear()
                            websocket.send(self._register_message())
                        self.send_due_report(websocket)
                        try:
                            raw = websocket.recv(timeout=0.25)
                        except TimeoutError:  # not an error: no plan change in this window is the normal case
                            continue
                        if isinstance(raw, bytes):
                            raw = raw.decode("utf-8")
                        message = json.loads(raw)
                        kind = str(message.get("type") or "")
                        payload = message.get("payload") if isinstance(message.get("payload"), dict) else {}
                        if kind == "adapter.subscription.replace" and str(payload.get("source") or "").lower() == self.source:
                            self.apply_plan(websocket, payload)
                            if not plan_applied:
                                plan_applied = True
                                delay = 0.05   # recovered: the plan is applied again, not just the socket open
                                recovery.finish("succeeded", identity={"source": self.source})
                        elif kind == "adapter.history.view" and self.on_history_view is not None:
                            self.on_history_view(payload)
            except Exception as exc:
                # Every way the connection or the registration fails takes the same path: counted, recorded with
                # what failed, and retried after a growing wait.
                if not opened:
                    trigger = "connect_failed"
                elif isinstance(exc, TimeoutError):
                    trigger = "registration_timeout"
                else:
                    trigger = "control_lost"
                message = f"adapter control {type(exc).__name__}: {exc}"[:500]
                self._on_transport_error(message)
                recovery.failed(trigger, identity={"source": self.source}, detail={"error": message})
                stop.wait(delay)
                delay = min(2.0, delay * 2.0)
        recovery.finish("abandoned", detail={"reason": "sink stopped"})
