"""Operator tool: ask the session owner to relaunch a materialization that ended FAILED_TERMINAL.

Proposes one explicit-retry intent (creates no job). The per-source session owner honours it only when the session
is sealed; the ledger then relaunches the terminal record with a fresh attempt budget and keeps the retry in the
record (``terminal_retries``: when, this reason, the attempts and error it replaced). Automatic proposals never carry
the retry flag, so nothing else can restart a terminal failure.

    python -m scripts.maintenance.retry_terminal_materialization --market FUT --date 2026-10-06 --session DAY \\
        --reason "120 s job bound fixed (622c432)"
"""
from __future__ import annotations

import argparse
import json

from service.market.shared.materialization_ledger import intent_or_job_status, propose_intent


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source", default="shioaji")
    parser.add_argument("--market", required=True)
    parser.add_argument("--date", required=True)
    parser.add_argument("--session", default="")
    parser.add_argument("--reason", required=True)
    args = parser.parse_args(argv)
    status = intent_or_job_status(args.source, args.market, args.date, session=args.session)
    if status.get("state") != "failed_terminal":
        print(json.dumps({"ok": False, "error": "not FAILED_TERMINAL: nothing to retry", "status": status}, ensure_ascii=False))
        return 1
    intent = propose_intent(args.source, args.market, args.date, session=args.session, reason=args.reason,
                            retry_terminal=True)
    print(json.dumps({"ok": True, "intent": intent, "was": status}, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
