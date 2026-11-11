"""Writes the shared inference-contract fixtures from the embedded FeatureSpec and the trainer's own exporter.

    python scripts/tooling/inference_contract_fixture.py

* ``onnx_model.onnx`` / ``onnx_model_manifest.json`` / ``onnx_model_cases.json``: a small LightGBM model fitted on
  synthetic rows, its category columns (industry, stock) native codes exactly as the trainer exports them
  (models.FeatureMatrix.for_candidate). The cases are rows with their categories -- a value outside the vocabulary
  and a missing industry among them -- and the probability ONNX Runtime gives; Rust B's model.rs must reproduce them
  (tests/test_online_training.py checks the Python side).
* ``model_manifest_onnx_example.json``: its feature_spec and io block are the current spec's (the rest is kept).

Run it again whenever the FeatureSpec's columns change.
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from service.analysis.online_training import models  # noqa: E402

FIXTURES = ROOT / "tests" / "fixtures" / "inference_contract"
SPEC = ROOT / "native" / "analysis_runtime" / "spec" / "feature_spec_online_v3.json"


def _write(path: Path, payload) -> None:
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\r\n")


def main() -> int:
    spec = json.loads(SPEC.read_text(encoding="utf-8"))
    numeric = [c["name"] for c in spec["columns"] if c["dtype"] == "f64"]
    categories = [c["name"] for c in spec["category_columns"]]
    identity = {k: spec[k] for k in ("spec_id", "schema_digest", "feature_version", "preprocessing_version")}
    rng = np.random.default_rng(7)
    rows = 4000
    frame = pd.DataFrame(rng.normal(size=(rows, len(numeric))), columns=numeric)
    frame.iloc[rng.random(rows) < 0.1, 3] = np.nan
    stocks = np.array(["2330", "2317", "2454", "1101", "6488"])
    groups = {"2330": "tse:24", "2317": "tse:31", "2454": "tse:24", "1101": "tse:01", "6488": "otc:24"}
    frame["stock"] = stocks[rng.integers(0, len(stocks), rows)]
    frame["industry"] = frame["stock"].map(groups)
    # Each stock appears on enough days to keep its own vocabulary entry.
    frame["trading_date"] = [f"2026-10-{1 + i % 20:02d}" for i in range(rows)]
    effect = frame["stock"].map({"2330": 1.0, "2317": -1.0, "2454": 0.5, "1101": 0.0, "6488": -0.5})
    y = (effect + frame[numeric[8]].fillna(0) + rng.normal(scale=0.5, size=rows) > 0).astype(int).to_numpy()
    matrix = models.FeatureMatrix.for_candidate("lightgbm", numeric, categories).fit(frame)
    x = matrix.matrix(frame)
    fitted = models.fit("lightgbm", x, y, categorical=matrix.code_columns())
    onnx_bytes = models.to_onnx("lightgbm", fitted, matrix.width)
    check = models.export_check(onnx_bytes, fitted, x)
    if not check["ok"]:
        raise SystemExit(f"the fixture model does not export within the tolerance: {check}")
    (FIXTURES / "onnx_model.onnx").write_bytes(onnx_bytes)
    manifest = json.loads((FIXTURES / "onnx_model_manifest.json").read_text(encoding="utf-8"))
    manifest["artifact"]["sha256"] = hashlib.sha256(onnx_bytes).hexdigest()
    manifest["feature_spec"] = identity
    manifest["io"] = matrix.io()
    _write(FIXTURES / "onnx_model_manifest.json", manifest)

    cases_frame = frame.iloc[:8].copy()
    cases_frame.loc[cases_frame.index[5], "stock"] = "9999"           # never seen: OTHER
    cases_frame.loc[cases_frame.index[6], "industry"] = models.MISSING_TOKEN
    cases_frame.iloc[7, :len(numeric)] = np.nan                       # an all-missing row
    probabilities = models.predict_onnx(onnx_bytes, matrix.matrix(cases_frame))
    cases = [{"values": [None if not np.isfinite(v) else float(v) for v in row[numeric]],
              "categories": [str(row[name]) for name in categories], "probability": float(p)}
             for (_, row), p in zip(cases_frame.iterrows(), probabilities)]
    _write(FIXTURES / "onnx_model_cases.json", cases)

    example = json.loads((FIXTURES / "model_manifest_onnx_example.json").read_text(encoding="utf-8"))
    example["feature_spec"] = identity
    example["io"] = {**matrix.io(), "category_vocab": {name: [models.OTHER_TOKEN] for name in matrix.categorical}}
    _write(FIXTURES / "model_manifest_onnx_example.json", example)
    print(json.dumps({"width": matrix.width, "max_abs_diff": check["max_abs_diff"], "cases": len(cases)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
