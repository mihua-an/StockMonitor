from __future__ import annotations

from pathlib import Path

from service.platform import project_root as process_paths


def daemon_state_dir() -> Path:
    """Shared process-state directory (var/state); metadata is evidence, never lock authority."""
    process_paths.STATE_ROOT.mkdir(parents=True, exist_ok=True)
    return process_paths.STATE_ROOT
