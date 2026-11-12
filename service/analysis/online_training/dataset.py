"""online-v3 training datasets. The features are Rust B's own, never recomputed here.

Rust B (``analysis_runtime --export-features``) streams one trading date's committed partitions through the live
feature fold and writes that date's samples and their future price paths (native/analysis_runtime/src/dataset.rs).
That output is a *shard*: it is reused for as long as the binary's FeatureSpec and fold version, the horizons, the partitions it
read (their manifests' content hashes) and the date's day context (the earlier sessions' daily summaries and the
industry map, as B reports them with ``--feature-context``) are unchanged, so the daily training run only exports
the new date.

Shards are the kept training data (user 10-22): they stay after the raw partitions they came from are pruned (the
raw history's own retention, config/storage_settings.py), and only the training data retention removes them
(config/training_data_settings.py, default forever). A date is trainable while it has raw partitions or a stored
shard of this FeatureSpec and horizons; with its raw data gone (or only the traded codes' partitions left, which the
raw retention keeps forever), the stored shard that folded more than what is still on disk (every partition left
among them) is used, never a new export of what is left.

This module turns shards into a dataset: it applies the label barriers (labels.py), checks every shard was computed
under one FeatureSpec, and records that FeatureSpec in the dataset manifest. The model inherits it, and Rust B refuses
a model bound to any FeatureSpec but its own.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Iterable

if TYPE_CHECKING:
    # Types only: pandas itself is imported where a dataset is read (load_dataset).
    import pandas as pd

from service.analysis.inference.contract import ContractError, load_horizon_authority
from service.analysis.online_training.cleanup import remove_tree
from service.analysis.online_training.labels import LABEL_POLICY, label, label_columns
from service.platform import project_root as process_paths
from service.platform.native_binaries import analysis_runtime_job_binary
import logging
from service.platform.failure_record import record_failure


_failure_log = logging.getLogger(__name__)

DATASET_SCHEMA = "online-dataset-v2"
SHARD_SCHEMA = "feature-dataset-v1"
EXPORT_TIMEOUT_SECONDS = 1800
# How often a phase counted here reports between its start and end: the same pace as B's export progress lines.
PROGRESS_INTERVAL_SECONDS = 0.5
SOURCE = "shioaji"
# A dataset's and a feature shard's manifest file, in its directory.
MANIFEST_FILE = "manifest.json"
FOLDED_MARKETS = ("STK", "IDX")
# B exports (one single-threaded process per date, about 0.8 GB each) run at the same time, at most this many. The
# daily run starts after the close while the materializer and the App keep running, so a quarter of the logical
# cores, capped here, leaves them room.
EXPORT_WORKERS_MAX = 3


def export_workers(dates: int) -> int:
    """How many dates are exported at once."""
    return max(1, min(EXPORT_WORKERS_MAX, (os.cpu_count() or 1) // 4, dates))


def _git_commit() -> str | None:
    try:
        out = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, cwd=process_paths.PROJECT_ROOT, timeout=10)
        return out.stdout.strip() or None
    except (OSError, subprocess.SubprocessError) as exc:
        record_failure(_failure_log, "reading the git commit for the dataset manifest", exc)
        return None


@dataclass(frozen=True)
class FeatureContext:
    """What the day features read besides the partitions (native/analysis_runtime/src/day_context.rs): the daily
    summaries under the storage location, the industry index table and the Shioaji security master."""

    summary_dir: Path | None = None
    industry_indexes: Path | None = None
    security_master: Path | None = None

    def args(self) -> list[str]:
        out: list[str] = []
        for flag, path in (("--daily-summary-dir", self.summary_dir), ("--industry-indexes", self.industry_indexes),
                           ("--security-master", self.security_master)):
            if path is not None:
                out += [flag, str(path)]
        return out


def _progress_line(line: str) -> dict[str, Any] | None:
    """The progress object of a B progress line, None for any other stderr line."""
    if not line.startswith('{"progress"'):
        return None
    try:
        update = json.loads(line)["progress"]
    except (ValueError, KeyError, TypeError):   # not an error: a line that only looks like one; kept as stderr text
        return None
    return update if isinstance(update, dict) else None


class RustFeatureExporter:
    """The one feature implementation, invoked as a process."""

    def __init__(self, binary: Path | None = None, context: FeatureContext | None = None) -> None:
        self.binary = Path(binary or analysis_runtime_job_binary())
        self.context = context or FeatureContext()

    def _run(self, args: list[str], timeout: float, on_progress: Callable[[dict[str, Any]], None] | None = None) -> str:
        """Stdout of the run. Stderr is read as it comes: its ``{"progress": ...}`` lines (dataset.rs) go to
        `on_progress`, every other line is kept for the error message."""
        if not self.binary.is_file():
            raise ContractError(f"analysis_runtime binary not found: {self.binary}")
        process = subprocess.Popen([str(self.binary), *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, encoding="utf-8", errors="replace")
        stdout: list[str] = []
        stderr: list[str] = []

        def read_stderr() -> None:
            failed = False
            for line in process.stderr:
                update = _progress_line(line)
                if update is None:
                    stderr.append(line)
                elif on_progress is not None and not failed:
                    try:
                        on_progress(update)
                    except Exception as exc:   # the export does not depend on its display; stderr keeps being drained
                        record_failure(_failure_log, f"showing the progress of analysis_runtime {args[0]}", exc)
                        failed = True

        readers = [threading.Thread(target=read_stderr, daemon=True),
                   threading.Thread(target=lambda: stdout.extend(process.stdout), daemon=True)]
        for reader in readers:
            reader.start()
        try:
            returncode = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            process.kill()
            process.wait()
            raise ContractError(f"analysis_runtime {args[0]} timed out after {timeout:.0f}s") from exc
        finally:
            for reader in readers:
                reader.join()
        out = "".join(stdout)
        if returncode != 0:
            raise ContractError(f"analysis_runtime {args[0]} failed ({returncode}): {(out or ''.join(stderr)).strip()[-500:]}")
        return out

    def spec(self) -> dict[str, Any]:
        spec = json.loads(self._run(["--feature-spec"], 60).strip().splitlines()[-1])
        if not spec.get("schema_digest") or not spec.get("fold_version"):
            raise ContractError("analysis_runtime reported no FeatureSpec digest or fold version")
        return spec

    def export(self, *, historical_root: Path, date: str, horizons: Iterable[int], out: Path,
               on_progress: Callable[[dict[str, Any]], None] | None = None) -> dict[str, Any]:
        """`on_progress` gets B's progress lines (phase, done, total, elapsed_ms); a B without them just never calls it."""
        self._run(["--export-features", "--historical-root", str(historical_root), "--date", date, "--out", str(out),
                   "--source", SOURCE, "--markets", ",".join(FOLDED_MARKETS), "--sample-markets", "STK",
                   "--horizons", ",".join(str(int(m)) for m in horizons), *self.context.args()], EXPORT_TIMEOUT_SECONDS,
                  on_progress)
        return read_manifest(Path(out))

    def context_fingerprint(self, date: str) -> Any:
        """What B's day context of `date` is made of (``--feature-context``): part of the shard identity."""
        answer = json.loads(self._run(["--feature-context", "--source", SOURCE, "--date", date, *self.context.args()], 60)
                            .strip().splitlines()[-1])
        return answer["dates"][date]


def partition_fingerprint(historical_root: Path, date: str) -> list[list[Any]]:
    """What a date's shard is computed from: every committed partition (it has a manifest) and its content hash."""
    entries = []
    for market in FOLDED_MARKETS:
        for path in sorted(Path(historical_root).glob(f"source={SOURCE}/market={market}/trading_date={date}/session=*/[!.]*/manifest.json")):
            try:
                manifest = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                record_failure(_failure_log, "reading a partition manifest for the training data fingerprint", exc)
                manifest = {}
            entries.append([path.parent.relative_to(historical_root).as_posix(), manifest.get("content_hash_fnv1a64"),
                            manifest.get("event_count")])
    return entries


def _raw_dates(historical_root: Path) -> set[str]:
    return {path.parts[-4].split("=", 1)[1]
            for path in Path(historical_root).glob(f"source={SOURCE}/market=STK/trading_date=*/session=*/[!.]*/manifest.json")}


def available_dates(historical_root: Path, shard_root: Path, *, spec_digest: str | None = None,
                    horizons: Iterable[int] | None = None) -> list[str]:
    """Trading dates with training data, oldest first: a committed STK partition, or a stored shard -- of
    `spec_digest` and exactly `horizons` when given (the dates a run of this build can train on)."""
    dates = _raw_dates(historical_root)
    for date, _directory, manifest in stored_shards(shard_root):
        if _shard_matches(manifest, spec_digest, horizons):
            dates.add(date)
    return sorted(dates)


def _shard_matches(manifest: dict[str, Any], spec_digest: str | None, horizons: Iterable[int] | None) -> bool:
    if spec_digest is not None and manifest.get("feature_spec", {}).get("schema_digest") != spec_digest:
        return False
    return horizons is None or [int(m) for m in manifest.get("horizons_minutes") or []] == [int(m) for m in horizons]


def stored_shards(shard_root: Path, date: str | None = None) -> list[tuple[str, Path, dict[str, Any]]]:
    """Every complete shard (its manifest written), of one date or all, as (date, directory, manifest)."""
    found = []
    for manifest_path in sorted(Path(shard_root).glob(f"{date or '*'}/*/manifest.json")):
        if ".tmp-" in manifest_path.parent.name:
            continue
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            record_failure(_failure_log, f"reading the stored training shard {manifest_path.parent}", exc)
            continue
        found.append((manifest_path.parent.parent.name, manifest_path.parent, manifest))
    return found


def _shard_partitions(manifest: dict[str, Any]) -> set[tuple[Any, Any]]:
    """The partitions a shard folded, as (relative path, content hash)."""
    return {(entry.get("partition"), entry.get("content_hash_fnv1a64"))
            for day in manifest.get("dates") or [] for entry in day.get("partitions") or []}


def covering_shard(shards: list[tuple[str, Path, dict[str, Any]]], entries: list[list[Any]], spec_digest: str,
                   horizons: Iterable[int]) -> tuple[Path, dict[str, Any]] | None:
    """The stored shard of this FeatureSpec and horizons that folded every partition still on disk (path and
    content hash): the most partitions, then the newest. None when no shard covers them -- what is on disk is
    then newer than any shard, and is exported. An older fold version still counts: these partitions are pruned, so
    the date cannot be exported again, and its columns still mean what the FeatureSpec says."""
    on_disk = {(path, content_hash) for path, content_hash, _count in entries}
    best = None
    for _date, directory, manifest in shards:
        if manifest.get("schema") != SHARD_SCHEMA or not _shard_matches(manifest, spec_digest, horizons):
            continue
        folded = _shard_partitions(manifest)
        # Strictly more: with every partition still there, what is on disk is exported again (a changed day context
        # gives a new shard), never stood in for by an old one.
        if not on_disk < folded:
            continue
        rank = (len(folded), directory.stat().st_mtime)
        if best is None or rank > best[0]:
            best = (rank, directory, manifest)
    return None if best is None else (best[1], best[2])


def _digest(payload: Any) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()


class _DatePhases:
    """How far one date of the dataset is, phase by phase, as its ``features <date>`` 執行紀錄 entry shows it
    (``detail.export``): B's export phases (verify, replay, labels, write) as its progress lines come, then ``load``,
    the shard read into the dataset. Every phase keeps its last done / total / elapsed_ms; ``phase`` is the current."""

    def __init__(self, report: Callable[[dict[str, Any]], None] | None) -> None:
        self.report = report
        self.phase: str | None = None
        self.phases: dict[str, dict[str, Any]] = {}

    def update(self, line: dict[str, Any]) -> None:
        self.phase = str(line.get("phase"))
        self.phases[self.phase] = {key: line.get(key) for key in ("done", "total", "elapsed_ms")}
        if self.report is not None:
            self.report(self.detail())

    def detail(self) -> dict[str, Any]:
        return {"export": {"phase": self.phase, "phases": dict(self.phases)}}

    def counter(self, phase: str, total: int) -> "_PhaseCounter":
        return _PhaseCounter(self, phase, total)


class _PhaseCounter:
    """A phase counted here (``load``), reported like B's: at its start and end and at most every
    PROGRESS_INTERVAL_SECONDS between."""

    def __init__(self, phases: _DatePhases, phase: str, total: int) -> None:
        self.phases, self.phase, self.total, self.done = phases, phase, total, 0
        self.started = self.last = time.monotonic()
        self._report(0)

    def _report(self, done: int) -> None:
        self.last = time.monotonic()
        self.phases.update({"phase": self.phase, "done": done, "total": self.total,
                            "elapsed_ms": int((self.last - self.started) * 1000)})

    def step(self) -> None:
        self.done += 1
        if time.monotonic() - self.last >= PROGRESS_INTERVAL_SECONDS:
            self._report(self.done)

    def end(self) -> None:
        self._report(self.total)


class OnlineDatasetBuilder:
    def __init__(self, historical_root: Path, out_root: Path, exporter: Any = None) -> None:
        self.historical_root = Path(historical_root)
        self.out_root = Path(out_root)
        self.shard_root = self.out_root / "shards"
        self.exporter = exporter or RustFeatureExporter()

    def discard_dead_staging(self) -> list[str]:
        """Remove the staging left by a job that ended mid-write (stopped by force, crashed): every ``*.tmp-<pid>``
        shard or dataset directory and ``.samples-<pid>-*.parquet.tmp`` whose process is gone. A live writer's (another
        job still running) is kept. Returns what was removed."""
        from service.platform.process_observer import ProcessTableUnavailable, process_exists

        candidates = [*self.out_root.glob("*.tmp-*"), *self.shard_root.glob("*/*.tmp-*"),
                      *self.out_root.glob(".samples-*.parquet.tmp")]
        removed = []
        for path in candidates:
            name = path.name
            owner = name.split("-")[1] if name.startswith(".samples-") else name.rsplit(".tmp-", 1)[-1]
            if not owner.isdigit() or int(owner) == os.getpid():
                continue   # not an error: not a staging name of this layout, or this job's own
            try:
                if process_exists(int(owner)):
                    continue   # not an error: its writer is still running
            except ProcessTableUnavailable as exc:
                record_failure(_failure_log, "listing processes before removing training staging", exc)
                return removed
            if path.is_dir():
                gone = remove_tree(path, "the staging of an ended training job")
            else:
                try:
                    path.unlink()
                    gone = True
                except FileNotFoundError:   # not an error: already gone
                    gone = True
                except OSError as exc:
                    record_failure(_failure_log, f"removing the staging of an ended training job {path}", exc)
                    gone = False
            if gone:
                removed.append(str(path))
        return removed

    def shard_id(self, date: str, horizons: tuple[int, ...], spec: dict[str, Any], entries: list) -> str:
        """Everything a date's shard is computed from."""
        return _digest({"schema": SHARD_SCHEMA, "spec": spec.get("schema_digest"), "fold": spec.get("fold_version"),
                        "horizons": list(horizons), "partitions": entries,
                        "context": self.exporter.context_fingerprint(date) if entries else None})[:16]

    def stored_shard(self, date: str, shard_id: str, horizons: tuple[int, ...], spec: dict[str, Any],
                     entries: list) -> tuple[Path, dict[str, Any]] | None:
        """The stored shard a run uses for `date`, None when the date is exported."""
        directory = self.shard_root / date / shard_id
        if (directory / MANIFEST_FILE).is_file():
            return directory, read_manifest(directory)
        # The raw partitions were pruned (all of them, or all but the traded codes'): the shard exported while they
        # were all there covers what is left.
        return covering_shard(stored_shards(self.shard_root, date), entries, spec["schema_digest"], horizons)

    def _shard(self, date: str, horizons: tuple[int, ...], spec: dict[str, Any], entries: list,
               on_progress: Callable[[dict[str, Any]], None] | None = None) -> tuple[Path, dict[str, Any], bool]:
        shard_id = self.shard_id(date, horizons, spec, entries)
        stored = self.stored_shard(date, shard_id, horizons, spec, entries)
        if stored is not None:
            return stored[0], stored[1], True
        directory = self.shard_root / date / shard_id
        if not entries:
            raise _NoTrainingData(date)
        staging = directory.with_name(f"{shard_id}.tmp-{os.getpid()}")
        remove_tree(staging, "a leftover shard staging directory")   # one that stays makes mkdir below fail
        staging.mkdir(parents=True)
        try:
            manifest = self.exporter.export(historical_root=self.historical_root, date=date, horizons=horizons, out=staging,
                                            on_progress=on_progress)
            os.replace(staging, directory)
        finally:
            remove_tree(staging, "a shard staging directory")
        return directory, manifest, False

    def build(self, trading_dates: Iterable[str], *, horizons_minutes: Iterable[int] | None = None,
              progress: Any = None) -> dict[str, Any]:
        authority = load_horizon_authority()
        # Refused, never substituted: a horizon the authority does not allow cannot get labels.
        horizons = authority.validate_enabled(horizons_minutes if horizons_minutes is not None else authority.allowed_minutes)
        dates = sorted({str(d)[:10] for d in trading_dates})
        if not dates:
            raise ContractError("dataset needs at least one trading date")
        self.discard_dead_staging()
        spec = self.exporter.spec()
        shards, skipped = [], []
        label_states: dict[str, dict[str, int]] = {f"{m}m": {} for m in horizons}
        self.out_root.mkdir(parents=True, exist_ok=True)
        samples = _SampleWriter(self.out_root / f".samples-{os.getpid()}-{uuid.uuid4().hex[:8]}.parquet.tmp",
                                [col for m in horizons for col in label_columns(m)])
        try:
            dataset_id, manifest = self._build_samples(dates, horizons, spec, entries_of=partition_fingerprint, samples=samples,
                                                       shards=shards, skipped=skipped, label_states=label_states,
                                                       progress=progress, authority=authority)
            if progress:
                progress(len(dates), len(dates), "dataset")
            directory = self.out_root / dataset_id
            if manifest is None:
                return read_manifest(directory)
            staging = directory.with_name(f"{dataset_id}.tmp-{os.getpid()}")
            remove_tree(staging, "a leftover dataset staging directory")   # one that stays makes mkdir below fail
            staging.mkdir(parents=True)
            try:
                os.replace(samples.path, staging / "samples.parquet")
                manifest["samples_sha256"] = _file_sha256(staging / "samples.parquet")
                (staging / MANIFEST_FILE).write_text(json.dumps(manifest, indent=2, default=str), encoding="utf-8")
                os.replace(staging, directory)
            finally:
                remove_tree(staging, "a dataset staging directory")
            return manifest
        finally:
            samples.discard()

    def _build_samples(self, dates, horizons, spec, *, entries_of, samples, shards, skipped, label_states, progress,
                       authority) -> tuple[str, dict[str, Any] | None]:
        """Shard by shard into `samples` (bounded memory: rows are written in chunks, label statistics counted as
        they pass); the dataset id, and its manifest -- None when that dataset is already built.

        The shards are made up to export_workers() dates at a time (each date's own directory, so two never write the
        same one) while this thread reads them in date order: a date is read once its shard is ready, the later
        dates' exports carry on meanwhile. Progress names the date being read; a date exported before its turn shows
        its export phases when it comes."""
        numeric: list[str] | None = None
        categorical: list[str] | None = None
        lock = threading.Lock()
        current: list[str | None] = [None]

        def reporter(index: int, date: str) -> Callable[[dict[str, Any]], None]:
            def report(detail: dict[str, Any]) -> None:
                with lock:
                    if current[0] == date:
                        progress(index, len(dates), f"features {date}", detail)
            return report

        phases_of = {date: _DatePhases(None if progress is None else reporter(index, date))
                     for index, date in enumerate(dates)}

        def make(date: str):
            entries = entries_of(self.historical_root, date)
            return entries, self._shard(date, horizons, spec, entries, phases_of[date].update)

        pool = ThreadPoolExecutor(max_workers=export_workers(len(dates)), thread_name_prefix="shard-export")
        futures = {date: pool.submit(make, date) for date in dates}
        try:
            for index, date in enumerate(dates):
                phases = phases_of[date]
                with lock:
                    current[0] = date
                    if progress:
                        progress(index, len(dates), f"features {date}")
                        if phases.phase is not None:
                            progress(index, len(dates), f"features {date}", phases.detail())
                try:
                    entries, (directory, shard, reused) = futures[date].result()
                except _NoTrainingData:   # not an error: listed in the manifest as skipped, with why
                    skipped.append({"trading_date": date, "reason": "NO_PARTITIONS_OR_STORED_SHARD"})
                    if progress:
                        progress(index, len(dates), f"features {date}", {"skipped": True})
                    continue
                if progress:
                    progress(index, len(dates), f"features {date}", {"reused": reused})
                if shard.get("schema") != SHARD_SCHEMA or shard.get("feature_spec", {}).get("schema_digest") != spec["schema_digest"]:
                    raise ContractError(f"shard {directory} was not computed under FeatureSpec {spec['schema_digest']}")
                if numeric is None:
                    numeric, categorical = list(shard["numeric_columns"]), list(shard.get("category_columns") or [])
                elif list(shard["numeric_columns"]) != numeric or list(shard.get("category_columns") or []) != categorical:
                    raise ContractError(f"shard {directory} has different feature columns")
                problems = [p for day in shard.get("dates", []) for p in day.get("problems", [])]
                shards.append({"trading_date": date, "shard": directory.name, "reused": reused, "samples": shard.get("samples"),
                               "raw_partitions_on_disk": len(entries),
                               "degraded": bool(shard.get("degraded")), "problems": problems})
                load = phases.counter("load", int(shard.get("samples") or 0))
                with open(directory / "samples.jsonl", encoding="utf-8") as handle:
                    for line in handle:
                        load.step()
                        row = json.loads(line)
                        record: dict[str, Any] = {
                            "sample_id": f"{row['source']}:{row['market']}:{row['trading_date']}:{row['session']}:{row['code']}@{row['durable_sequence']}",
                            **{k: row[k] for k in ("source", "market", "trading_date", "session", "code", "durable_sequence",
                                                   "cutoff_ns", "generation")},
                        }
                        record.update({name: (float("nan") if value is None else float(value))
                                       for name, value in zip(numeric, row["values"])})
                        record.update(zip(categorical, row.get("categories") or []))
                        for minutes in horizons:
                            up, down, state = label((row.get("future") or {}).get(str(minutes)))
                            up_col, down_col = label_columns(minutes)
                            record[up_col], record[down_col] = up, down
                            states = label_states[f"{minutes}m"]
                            states[state] = states.get(state, 0) + 1
                        samples.add(record, numeric, categorical)
                load.end()
        finally:
            # A failure stops the dates not started; one already exporting finishes in its own directory.
            pool.shutdown(wait=True, cancel_futures=True)
        samples.close()
        if not samples.rows:
            raise ContractError(f"no warm samples for {dates} under {self.historical_root}")
        identity = {"schema": DATASET_SCHEMA, "shards": [(s["trading_date"], s["shard"]) for s in shards], "label_policy": LABEL_POLICY,
                    "horizons": list(horizons), "authority": authority.version, "sources": [SOURCE], "markets": ["STK"]}
        dataset_id = f"ods-{shards[0]['trading_date']}-{shards[-1]['trading_date']}-{_digest(identity)[:12]}"
        if (self.out_root / dataset_id / MANIFEST_FILE).is_file():
            return dataset_id, None
        manifest: dict[str, Any] = {
            "schema": DATASET_SCHEMA,
            "dataset_id": dataset_id,
            "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "builder_commit": _git_commit(),
            "feature_spec": {k: spec[k] for k in ("spec_id", "schema_digest", "feature_version", "preprocessing_version")},
            "feature_source": {"builder": "analysis_runtime --export-features", **_binary_identity(getattr(self.exporter, "binary", None))},
            "numeric_columns": numeric,
            "category_columns": categorical,
            "label_policy": LABEL_POLICY,
            "sampling_policy": {"version": "sampling-online-v2", "rule": "last warm sample per key per 15 exchange seconds"},
            "future_path_policy": "future-path-v2",
            "horizon_authority_version": authority.version,
            "horizons_minutes": list(horizons),
            "trading_dates": [s["trading_date"] for s in shards],
            "skipped_dates": skipped,
            "sources": [SOURCE],
            "markets": ["STK"],
            "samples": samples.rows,
            "codes": len(samples.codes),
            "label_stats": samples.label_stats(),
            "label_states": label_states,
            "degraded": any(s["degraded"] for s in shards),
            "shards": shards,
        }
        return dataset_id, manifest

    def prune(self, *, used: dict[str, Any], retention_days: int | None, keep_datasets: int = 3,
              summary_root: Path | None = None) -> dict[str, list[str]]:
        """After a run: `used` is the dataset manifest just built. Drops, for each date it used, the other shards of the
        same FeatureSpec and horizons (computed from partition contents no longer on disk); the dates beyond the
        training data retention (`retention_days` newest trading dates with a shard; None = forever), their shards
        and daily summaries (`summary_root`); and all but the newest datasets. Shards of another FeatureSpec stay
        until the retention removes them. Lists only what is gone; what could not be removed is listed under
        "failed" (and recorded), to be tried again at the next prune."""
        removed: dict[str, list[str]] = {"shards": [], "dates": [], "summaries": [], "datasets": [], "failed": []}

        def drop(path: Path, what: str, bucket: str, name: str) -> None:
            if remove_tree(path, what):
                removed[bucket].append(name)
            else:
                removed["failed"].append(name)

        spec_digest = used["feature_spec"]["schema_digest"]
        horizons = used["horizons_minutes"]
        for entry in used.get("shards") or []:
            for _date, directory, manifest in stored_shards(self.shard_root, entry["trading_date"]):
                if _shard_matches(manifest, spec_digest, horizons) and directory.name != entry["shard"]:
                    drop(directory, "a superseded training shard", "shards", f"shards/{entry['trading_date']}/{directory.name}")
        if retention_days is not None:
            dated = sorted(p.name for p in self.shard_root.glob("*") if p.is_dir())
            for date in dated[:max(0, len(dated) - retention_days)]:
                drop(self.shard_root / date, "a training shard past the training data retention", "dates", date)
                for summary in sorted(Path(summary_root).glob(f"source=*/market=*/trading_date={date}")) if summary_root else []:
                    drop(summary, "a daily summary past the training data retention", "summaries",
                         summary.relative_to(summary_root).as_posix())
        datasets = sorted((p for p in self.out_root.glob("ods-*") if (p / MANIFEST_FILE).is_file()),
                          key=lambda p: p.stat().st_mtime, reverse=True)
        for stale in datasets[keep_datasets:]:
            drop(stale, "an old training dataset", "datasets", stale.name)
        return removed


class _NoTrainingData(Exception):
    """A date with neither raw partitions nor a stored shard."""


def _binary_identity(binary: Path | None) -> dict[str, Any]:
    """Which build exported the features: its file name and content hash. Never its absolute path -- that names this
    machine's user and install folder and means nothing on another one."""
    if binary is None:
        return {"binary": None, "binary_sha256": None}
    return {"binary": Path(binary).name, "binary_sha256": _file_sha256(binary)}


# Rows held before a chunk is written to the dataset's parquet file.
SAMPLE_CHUNK_ROWS = 50_000
_STRING_COLUMNS = ("sample_id", "source", "market", "trading_date", "session", "code")
_INT_COLUMNS = ("durable_sequence", "cutoff_ns", "generation")


class _SampleWriter:
    """The dataset's samples written to one parquet file chunk by chunk, with the counts the manifest states
    (rows, distinct codes, each label column's available / positive), so no build holds every sample at once."""

    def __init__(self, path: Path, label_cols: list[str]) -> None:
        self.path = Path(path)
        self.rows = 0
        self.codes: set[str] = set()
        self._labels = {col: [0, 0] for col in label_cols}     # available, positive
        self._pending: list[dict[str, Any]] = []
        self._writer = None
        self._schema = None

    def add(self, record: dict[str, Any], numeric: list[str], categorical: list[str]) -> None:
        self.rows += 1
        self.codes.add(record["code"])
        for col, counts in self._labels.items():
            value = record[col]
            if value == value:                                 # not NaN: the label is known
                counts[0] += 1
                counts[1] += value == 1
        self._pending.append(record)
        if self._schema is None:
            import pyarrow as pa

            self._schema = pa.schema([(name, pa.string()) for name in [*_STRING_COLUMNS, *categorical]]
                                     + [(name, pa.int64()) for name in _INT_COLUMNS]
                                     + [(name, pa.float64()) for name in [*numeric, *self._labels]])
        if len(self._pending) >= SAMPLE_CHUNK_ROWS:
            self._flush()

    def _flush(self) -> None:
        if not self._pending:
            return
        import pyarrow as pa
        import pyarrow.parquet as pq

        table = pa.Table.from_pylist(self._pending, schema=self._schema)
        if self._writer is None:
            self._writer = pq.ParquetWriter(self.path, self._schema)
        self._writer.write_table(table)
        self._pending = []

    def close(self) -> None:
        self._flush()
        if self._writer is not None:
            self._writer.close()
            self._writer = None

    def discard(self) -> None:
        """Close and remove the file unless it was moved into the dataset."""
        if self._writer is not None:
            self._writer.close()
            self._writer = None
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass                                               # not an error: moved into the dataset, or never written

    def label_stats(self) -> dict[str, dict[str, Any]]:
        return {col: {"samples": self.rows, "available": available, "positive": positive,
                      "positive_ratio": positive / available if available else None}
                for col, (available, positive) in self._labels.items()}


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def read_manifest(directory: Path) -> Any:
    """The manifest of the dataset or feature shard in `directory`; raises OSError / ValueError for the caller."""
    return json.loads((Path(directory) / MANIFEST_FILE).read_text(encoding="utf-8"))


def load_dataset(directory: Path) -> tuple[pd.DataFrame, dict[str, Any]]:
    # pandas (with numpy and pyarrow, ~80 MB) only when a dataset is read: realtime_api imports this module at start
    # for the training routes, and must not hold pandas for a training that may never run.
    import pandas as pd

    directory = Path(directory)
    manifest = read_manifest(directory)
    if manifest.get("schema") != DATASET_SCHEMA:
        raise ContractError(f"{directory} is not an {DATASET_SCHEMA} dataset")
    data = (directory / "samples.parquet").read_bytes()
    if hashlib.sha256(data).hexdigest() != manifest.get("samples_sha256"):
        raise ContractError(f"{directory}: samples do not match the manifest hash")
    frame = pd.read_parquet(directory / "samples.parquet")
    for name in manifest["numeric_columns"]:
        frame[name] = pd.to_numeric(frame[name], errors="coerce").astype(float)
    return frame, manifest
