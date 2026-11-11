"""Run dedicated fake-backend regressions in a source-only guarded copy."""
from pathlib import Path
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.diagnostics.check_offline import copy_sources

run = Path(tempfile.mkdtemp(prefix="audit-storage-check-"))
project = run / "StockMonitor"
project.mkdir()
for name in ("service", "config", "scripts"):
    copy_sources(ROOT / name, project / name)
(project / "tests").mkdir()
for name in ("test_audit_storage_sync.py", "test_watch_page_provider_projection.py"):
    shutil.copyfile(ROOT / "tests" / name, project / "tests" / name)
shutil.copyfile(ROOT / "main.py", project / "main.py")
shutil.copyfile(ROOT / "scripts/diagnostics/offline_guard.py", project / "sitecustomize.py")
env = {k: v for k, v in os.environ.items() if not k.startswith(("STOCK_MONITOR_", "STOCKMONITOR_", "SHIOAJI_", "FUTU_", "MOOMOO_", "PYTEST_"))}
env.update(PYTHONPATH=str(project), PYTHONDONTWRITEBYTECODE="1", PYTEST_DISABLE_PLUGIN_AUTOLOAD="1",
           STOCK_MONITOR_OFFLINE_CHECK="1", STOCK_MONITOR_CHECK_ORIGINAL=str(ROOT),
           TEMP=str(run), TMP=str(run), TMPDIR=str(run))
result = subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "tests"], cwd=project, env=env)
print("Guarded source-only workspace:", project)
raise SystemExit(result.returncode)
