"""Hive-partition path resolution for the raw evidence tree.

The physical layout under an evidence root is
``<kind>/market=<M>/trading_date=<D>/session=<S>/logical_code=<L>/part-*.parquet``,
compacting to a single ``<kind>/market=<M>/trading_date=<D>/session=<S>/<L>.parquet``
final target. Knowing this partition schema is storage-domain knowledge; operator
scripts under ``scripts/maintenance/`` call this instead of re-deriving it from
path parts themselves.
"""
from __future__ import annotations

from pathlib import Path


def locate_evidence_target(evidence_root: Path, part_path: Path) -> dict[str, str | Path] | None:
    """Resolve a raw ``part-*.parquet``'s logical identity and its compacted target.

    Returns ``None`` if ``part_path`` is not inside a ``logical_code=`` partition
    directory (i.e. it is not a raw part this layout applies to).
    """
    parents = part_path.parents
    logical_dir = next((p.name for p in parents if p.name.startswith("logical_code=")), "")
    if not logical_dir:
        return None
    parts = part_path.parts
    try:
        kind = parts[parts.index("evidence") + 1]
    except ValueError:  # not an error: a path outside an evidence tree has no evidence kind
        return None
    market = next((p.name.split("=", 1)[1] for p in parents if p.name.startswith("market=")), "")
    trading_date = next((p.name.split("=", 1)[1] for p in parents if p.name.startswith("trading_date=")), "")
    session = next((p.name.split("=", 1)[1] for p in parents if p.name.startswith("session=")), "")
    logical_code = logical_dir.split("=", 1)[1]
    target = (
        evidence_root / kind / f"market={market}" / f"trading_date={trading_date}"
        / f"session={session}" / f"{logical_code}.parquet"
    )
    return {
        "kind": kind, "market": market, "trading_date": trading_date,
        "session": session, "logical_code": logical_code, "target": target,
    }
