from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import functools

from service.platform import project_root as process_paths


@dataclass(frozen=True)
class MarketStorageLayout:
    """Single physical layout used by production market-data code.

    ``part`` contains live append-only fragments. ``evidence`` contains irreplaceable market facts.  ``replay`` contains
    rebuildable data products optimized for history/closed-session reads.
    Live writers may create many small part files, but hour is catalog metadata,
    not a permanent directory boundary; finalized compaction is free to merge
    across hours within one canonical session identity.
    """

    data_root: Path

    @property
    def market_root(self) -> Path: return self.data_root / "market"
    @property
    def accounts_root(self) -> Path: return self.data_root / "accounts"
    @property
    def reference_root(self) -> Path: return self.data_root / "reference"
    @property
    def preferences_root(self) -> Path: return self.data_root / "preferences"
    @property
    def shioaji_root(self) -> Path: return self.market_root / "shioaji"
    @property
    def futu_root(self) -> Path: return self.market_root / "futu"
    @property
    def evidence_root(self) -> Path: return self.shioaji_root / "evidence"
    @property
    def replay_root(self) -> Path: return self.shioaji_root / "replay"
    @property
    # Replay is cross-source data, kept outside the Shioaji storage tree.
    def tradereplay_root(self) -> Path: return self.data_root / "tradereplay"
    @property
    def volume_baseline_root(self) -> Path: return self.shioaji_root / "volume_baseline"
    @property
    def canonical_root(self) -> Path: return self.shioaji_root / "canonical"
    @property
    def recovery_root(self) -> Path: return self.canonical_root / "recovery"
    @property
    def cache_root(self) -> Path: return self.shioaji_root / "cache"
    @property
    def metadata_db(self) -> Path: return self.canonical_root / "market_runtime.db"
    @property
    def session_finalization(self) -> Path: return self.canonical_root / "session_finalization"

    def source_root(self, source: str) -> Path:
        normalized = str(source or "").strip().lower()
        if normalized == "shioaji":
            return self.shioaji_root
        if normalized == "futu":
            return self.futu_root
        raise ValueError(f"unknown market data source: {source}")

    def source_path(self, source: str, responsibility: str, name: str = "") -> Path:
        root = self.source_root(source) / str(responsibility).strip().lower()
        return root / str(name) if name else root

    @property
    def futu_evidence_root(self) -> Path: return self.source_path("futu", "evidence")
    @property
    def futu_canonical_root(self) -> Path: return self.source_path("futu", "canonical")
    @property
    # Mirrors session_finalization above (Shioaji): the durable
    # per-session completeness/materialization manifest, Futu side, so
    # FutuSessionArchive.seal()'s completeness/
    # materialization_status does not live only in the in-memory
    # last_archive_result, which a daemon restart would silently lose.
    def futu_session_finalization(self) -> Path: return self.futu_canonical_root / "session_finalization"
    @property
    def shioaji_reference_root(self) -> Path: return self.reference_root / "shioaji"
    @property
    def futu_reference_root(self) -> Path: return self.reference_root / "futu"
    @property
    def shioaji_security_master(self) -> Path: return self.shioaji_reference_root / "security_master.csv"
    @property
    def shioaji_futures_contracts(self) -> Path: return self.shioaji_reference_root / "futures_contracts.csv"
    @property
    def futu_security_master(self) -> Path: return self.futu_reference_root / "security_master-A.csv"
    @property
    def watch_pages_file(self) -> Path: return self.preferences_root / "watch_pages.csv"
    @property
    def product_catalog_file(self) -> Path: return self.reference_root / "product_catalog.parquet"
    @property
    def actual_accounts_root(self) -> Path: return self.accounts_root / "actual"
    @property
    def paper_accounts_root(self) -> Path: return self.accounts_root / "paper"
    @property
    def traded_codes_root(self) -> Path:
        """Each ledger's traded codes, read by Market Runtime's raw-history prune (config/system_contract.json
        data_children)."""
        from config.system_contract import data_child

        return self.data_root.joinpath(*data_child("traded_codes").split("/"))
    @property
    def paper_matching_root(self) -> Path:
        """模擬下單's orders / matching results, shared with Rust B (config/system_contract.json data_children)."""
        from config.system_contract import data_child
        return self.data_root.joinpath(*data_child("paper_matching").split("/"))

    def replay_view(self, name: str) -> Path:
        # Generic live/history projections belong to canonical. ``tradereplay``
        # is reserved for dates/codes proven to have an actual account trade.
        return self.canonical_view(str(name))

    def tradereplay_product(self, date: str, code: str, kind: str = "") -> Path:
        root = self.tradereplay_root / str(date)[:10] / str(code).upper()
        return root / str(kind).lower() if kind else root

    def canonical_view(self, name: str) -> Path:
        return self.canonical_root / str(name)

    def cache_dir(self, name: str) -> Path:
        return self.cache_root / str(name)


@functools.cache
def process_market_layout() -> MarketStorageLayout:
    """This process's layout: DATA_ROOT as the entry point's environment resolves it (F1).

    Called where a path is needed, never at import, so a process that sets its var/ environment before first use
    gets that root. Reusable stores take their paths as arguments; their composition roots pass this layout's."""
    return MarketStorageLayout(data_root=Path(process_paths.DATA_ROOT))


def require_market_storage_ready() -> None:
    """Create the directories this provider writes (the WAL is Market Runtime's, which creates its own)."""
    layout = process_market_layout()
    for path in (layout.canonical_root, layout.evidence_root, layout.volume_baseline_root):
        path.mkdir(parents=True, exist_ok=True)
