"""Thin operator tool: PROPOSE materialization intents (creates no job).

Not a materializer and not a job requester. Sessions come from the durable
SESSION EVIDENCE (the sessions whose events actually reached Market Runtime),
not from any retired raw-evidence catalog. It proposes one idempotent *intent*
per WAL session; the per-source session owner (Shioaji SessionOrchestrator /
FutuSessionLifecycleCoordinator) decides whether each is sealed and submits it
through its deduped MaterializationLedger; Health then runs the Rust job.

    python -m scripts.maintenance.rebuild_materialized_projections [--source shioaji|futu] [--date YYYY-MM-DD] [--dry-run]
"""
from __future__ import annotations

import argparse
import json

from service.market.shared.materialization_ledger import propose_intent
from service.market.shared.partition_evidence import PartitionEvidence


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source", default="")
    parser.add_argument("--date", default="")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    targets = PartitionEvidence().sessions(args.source, args.date)
    proposed = []
    for source, market, trading_date, session in targets:
        entry = {"source": source, "market": market, "trading_date": trading_date, "session": session}
        if not args.dry_run:
            entry["intent"] = propose_intent(source, market, trading_date, reason="operator_rebuild")["key_id"]
        proposed.append(entry)
    print(json.dumps({"proposed": len(proposed), "dry_run": bool(args.dry_run), "intents": proposed},
                     ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
