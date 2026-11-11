//! ONNX model execution: the trainer (Python, service/analysis/online_training) exports each
//! horizon/direction champion as ONNX; this process runs it on its own online features through ONNX Runtime (`ort`,
//! CPU, statically linked -- no DLL ships beside the exe).
//!
//! The model's input is one float32 row: the online-v3 numeric columns it was trained on (`io.numeric`: any of this
//! build's columns, in spec order -- a model trained the online-v2 way reads the first 179; missing = NaN, the model
//! handles it), then the category columns the model reads (`io.categorical`, a subset of features::CATEGORY_COLUMNS)
//! encoded over the vocabulary it was trained with (`io.category_vocab`, each holding OTHER_TOKEN):
//! * `io.category_encoding` "one_hot": one 0/1 column per vocabulary entry (the logistic candidate);
//! * "code": one column, the entry's index as a number (LightGBM's native categorical split).
//! A value outside the vocabulary -- a stock the model never saw enough of, a new listing -- is OTHER_TOKEN, exactly
//! as the trainer encoded its rare values (service/analysis/online_training/models.py FeatureMatrix).
//! Its output is a probability per class; the manifest names which class is "the move happened".

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use ort::session::Session;
use ort::value::Tensor;
use serde_json::Value;

use crate::features::{CATEGORY_COLUMNS, NUMERIC_COLUMNS};

/// The vocabulary entry of every value a model was not trained on (models.py OTHER_TOKEN).
pub const OTHER_TOKEN: &str = "__OTHER__";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoding {
    OneHot,
    Code,
}

/// One category input: its place in CATEGORY_COLUMNS and its vocabulary.
#[derive(Debug, Clone, PartialEq)]
pub struct CategoryInput {
    pub column: usize,
    pub vocab: Vec<String>,
}

impl CategoryInput {
    /// The vocabulary index of `value`, OTHER_TOKEN's when it is not in the vocabulary.
    fn index(&self, value: &str) -> usize {
        self.vocab.iter().position(|t| t == value)
            .or_else(|| self.vocab.iter().position(|t| t == OTHER_TOKEN))
            .expect("Io::of checked the vocabulary holds OTHER_TOKEN")
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Io {
    /// The instruments the model was trained on (sources x markets): it is only ever applied to those. A model trained
    /// on Taiwan stocks says nothing about a TXF night session or a US stock.
    pub sources: Vec<String>,
    pub markets: Vec<String>,
    pub input: String,
    pub output: String,
    pub class_index: usize,
    /// The positions in NUMERIC_COLUMNS of the model's numeric inputs, ascending.
    pub numeric: Vec<usize>,
    pub categorical: Vec<CategoryInput>,
    pub encoding: Encoding,
}

impl Io {
    /// The manifest's `io` block, checked against what this build computes. Err = the model cannot be fed here.
    pub fn of(manifest: &Value) -> Result<Self, String> {
        let io = &manifest["io"];
        let names: Vec<&str> = io["numeric"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        let numeric: Vec<usize> = names.iter().map(|name| NUMERIC_COLUMNS.iter().position(|c| c == name)
            .ok_or(format!("model numeric input {name:?} is not a column this build computes"))).collect::<Result<_, _>>()?;
        if numeric.is_empty() || !numeric.windows(2).all(|w| w[0] < w[1]) {
            return Err("model numeric inputs are not this build's columns in spec order".into());
        }
        let mut categorical = Vec::new();
        for name in io["categorical"].as_array().into_iter().flatten() {
            let name = name.as_str().ok_or("io.categorical holds names")?;
            let column = CATEGORY_COLUMNS.iter().position(|c| *c == name)
                .ok_or(format!("model category input {name:?} is not one this build computes ({CATEGORY_COLUMNS:?})"))?;
            let vocab: Vec<String> = io["category_vocab"][name].as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default();
            if !vocab.iter().any(|t| t == OTHER_TOKEN) {
                return Err(format!("io.category_vocab.{name} has no {OTHER_TOKEN}: an unseen value would have no encoding"));
            }
            categorical.push(CategoryInput { column, vocab });
        }
        let encoding = match io["category_encoding"].as_str() {
            Some("one_hot") => Encoding::OneHot,
            Some("code") => Encoding::Code,
            None if categorical.is_empty() => Encoding::OneHot,
            other => return Err(format!("io.category_encoding {other:?} is not one_hot or code")),
        };
        let text = |name: &str| io[name].as_str().filter(|s| !s.is_empty()).map(str::to_string).ok_or(format!("io.{name} is required"));
        let list = |name: &str| -> Vec<String> {
            manifest["scope"][name].as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
        };
        let (sources, markets) = (list("sources"), list("markets"));
        if sources.is_empty() || markets.is_empty() {
            return Err("model manifest has no scope (sources and markets it was trained on)".into());
        }
        Ok(Self {
            sources,
            markets,
            input: text("input")?,
            output: text("output")?,
            class_index: io["class_index"].as_u64().ok_or("io.class_index is required")? as usize,
            numeric,
            categorical,
            encoding,
        })
    }

    pub fn covers(&self, source: &str, market: &str) -> bool {
        self.sources.iter().any(|s| s == source) && self.markets.iter().any(|m| m == market)
    }

    pub fn width(&self) -> usize {
        self.numeric.len() + match self.encoding {
            Encoding::OneHot => self.categorical.iter().map(|c| c.vocab.len()).sum(),
            Encoding::Code => self.categorical.len(),
        }
    }

    /// The model's input row from a snapshot's numeric values (NUMERIC_COLUMNS) and its CATEGORY_COLUMNS values (a
    /// missing one is features::MISSING_TOKEN).
    pub fn row(&self, values: &[f64], categories: &[String]) -> Vec<f32> {
        let mut row: Vec<f32> = self.numeric.iter()
            .map(|at| values.get(*at).copied().filter(|v| v.is_finite()).map_or(f32::NAN, |v| v as f32)).collect();
        for input in &self.categorical {
            let value = categories.get(input.column).map(String::as_str).unwrap_or(crate::features::MISSING_TOKEN);
            let index = input.index(value);
            match self.encoding {
                Encoding::OneHot => row.extend((0..input.vocab.len()).map(|i| if i == index { 1.0 } else { 0.0 })),
                Encoding::Code => row.push(index as f32),
            }
        }
        row
    }
}

/// An artifact whose bytes matched the manifest's sha256, with its parsed `io` block. The runtime is given these
/// very bytes: reading the path a second time could load a file replaced after the check.
#[derive(Clone)]
pub struct ValidatedArtifact {
    pub path: PathBuf,
    pub sha256: String,
    pub bytes: Arc<Vec<u8>>,
    pub io: Io,
}

impl std::fmt::Debug for ValidatedArtifact {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ValidatedArtifact").field("path", &self.path).field("sha256", &self.sha256)
            .field("bytes", &self.bytes.len()).finish()
    }
}

impl ValidatedArtifact {
    /// Read `path` once and check it against the manifest's sha256 and `io` block.
    pub fn read(path: &Path, manifest: &Value) -> Result<Self, ArtifactRefusal> {
        let bytes = std::fs::read(path).map_err(|e| ArtifactRefusal::Missing(format!("artifact {}: {e}", path.display())))?;
        let sha256 = market_runtime::sha256::hex(&bytes);
        if manifest["artifact"]["sha256"].as_str() != Some(sha256.as_str()) {
            return Err(ArtifactRefusal::Incompatible(format!("artifact {} does not match the manifest sha256", path.display())));
        }
        let io = Io::of(manifest).map_err(ArtifactRefusal::Incompatible)?;
        Ok(Self { path: path.to_path_buf(), sha256, bytes: Arc::new(bytes), io })
    }
}

/// Why an artifact is not one this build can run.
#[derive(Debug, Clone, PartialEq)]
pub enum ArtifactRefusal {
    Missing(String),
    Incompatible(String),
}

pub struct OnnxModel {
    session: Mutex<Session>,
    io: Io,
}

impl OnnxModel {
    /// The runtime session of exactly the bytes that were verified.
    pub fn load(artifact: &ValidatedArtifact) -> Result<Self, String> {
        let io = artifact.io.clone();
        let fail = |e: &dyn std::fmt::Display| format!("onnx load {}: {e}", artifact.path.display());
        let session = Session::builder().map_err(|e| fail(&e))?
            .with_intra_threads(1).map_err(|e| fail(&e))?
            .commit_from_memory(&artifact.bytes).map_err(|e| fail(&e))?;
        if !session.inputs().iter().any(|i| i.name() == io.input) {
            return Err(format!("onnx model has no input {:?}", io.input));
        }
        if !session.outputs().iter().any(|o| o.name() == io.output) {
            return Err(format!("onnx model has no output {:?}", io.output));
        }
        Ok(Self { session: Mutex::new(session), io })
    }

    pub fn covers(&self, source: &str, market: &str) -> bool {
        self.io.covers(source, market)
    }

    pub fn predict(&self, values: &[f64], categories: &[String]) -> Result<f64, String> {
        let row = self.io.row(values, categories);
        let tensor = Tensor::from_array(([1usize, self.io.width()], row)).map_err(|e| e.to_string())?;
        let mut session = self.session.lock().map_err(|_| "onnx session poisoned".to_string())?;
        let outputs = session.run(ort::inputs![self.io.input.as_str() => tensor]).map_err(|e| format!("onnx run: {e}"))?;
        let (_, probabilities) = outputs[self.io.output.as_str()].try_extract_tensor::<f32>().map_err(|e| format!("onnx output: {e}"))?;
        probabilities.get(self.io.class_index).map(|p| *p as f64).ok_or_else(|| "onnx output has no such class".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/inference_contract").join(name)
    }

    /// The fixture model and its expected outputs are written by the Python trainer's exporter
    /// (tests/test_online_training.py regenerates and checks them with onnxruntime): Rust must reproduce them.
    #[test]
    fn rust_runs_the_python_exported_model_to_the_same_probabilities() {
        let manifest: Value = serde_json::from_str(&std::fs::read_to_string(fixture("onnx_model_manifest.json")).unwrap()).unwrap();
        let model = OnnxModel::load(&ValidatedArtifact::read(&fixture("onnx_model.onnx"), &manifest).unwrap()).unwrap();
        let cases: Value = serde_json::from_str(&std::fs::read_to_string(fixture("onnx_model_cases.json")).unwrap()).unwrap();
        for case in cases.as_array().unwrap() {
            let values: Vec<f64> = case["values"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap_or(f64::NAN)).collect();
            let categories: Vec<String> = case["categories"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
            let got = model.predict(&values, &categories).unwrap();
            let expected = case["probability"].as_f64().unwrap();
            assert!((got - expected).abs() <= 1e-6, "{case}: rust {got}, python {expected}");
        }
    }

    #[test]
    fn the_input_row_is_the_numeric_columns_in_spec_order() {
        let manifest = serde_json::json!({"scope": {"sources": ["shioaji"], "markets": ["STK"]}, "io": {"input": "features", "output": "probabilities", "class_index": 1,
            "numeric": NUMERIC_COLUMNS.as_slice(), "categorical": [], "category_vocab": {}}});
        let io = Io::of(&manifest).unwrap();
        let mut values = vec![1.0; NUMERIC_COLUMNS.len()];
        values[3] = f64::NAN;
        let categories = vec!["tse:24".to_string(), "2330".to_string()];
        let row = io.row(&values, &categories);
        assert_eq!(row.len(), NUMERIC_COLUMNS.len());
        assert!(row[3].is_nan());
        let mut categorical = manifest.clone();
        categorical["io"]["categorical"] = serde_json::json!(["quote_status"]);
        assert!(Io::of(&categorical).is_err(), "a category this build does not compute is refused");
        // One-hot over the vocabulary; a value outside it is the vocabulary's OTHER_TOKEN.
        let mut one_hot = manifest.clone();
        one_hot["io"]["categorical"] = serde_json::json!(["industry"]);
        one_hot["io"]["category_vocab"] = serde_json::json!({"industry": ["__MISSING__", OTHER_TOKEN, "tse:24"]});
        one_hot["io"]["category_encoding"] = serde_json::json!("one_hot");
        let io = Io::of(&one_hot).unwrap();
        assert_eq!(io.width(), NUMERIC_COLUMNS.len() + 3);
        assert_eq!(io.row(&values, &categories)[NUMERIC_COLUMNS.len()..], [0.0, 0.0, 1.0]);
        assert_eq!(io.row(&values, &["otc:31".into(), "6488".into()])[NUMERIC_COLUMNS.len()..], [0.0, 1.0, 0.0]);
        assert_eq!(io.row(&values, &["__MISSING__".into(), "6488".into()])[NUMERIC_COLUMNS.len()..], [1.0, 0.0, 0.0]);
        // Codes: the vocabulary index of each category the model reads, in its io.categorical order.
        let mut codes = one_hot.clone();
        codes["io"]["categorical"] = serde_json::json!(["stock", "industry"]);
        codes["io"]["category_vocab"]["stock"] = serde_json::json!([OTHER_TOKEN, "2317", "2330"]);
        codes["io"]["category_encoding"] = serde_json::json!("code");
        let io = Io::of(&codes).unwrap();
        assert_eq!(io.width(), NUMERIC_COLUMNS.len() + 2);
        assert_eq!(io.row(&values, &categories)[NUMERIC_COLUMNS.len()..], [2.0, 2.0]);
        assert_eq!(io.row(&values, &["otc:31".into(), "9999".into()])[NUMERIC_COLUMNS.len()..], [0.0, 1.0], "unseen: OTHER");
        let mut no_other = codes.clone();
        no_other["io"]["category_vocab"]["stock"] = serde_json::json!(["2330"]);
        assert!(Io::of(&no_other).is_err(), "a vocabulary without OTHER_TOKEN cannot encode a new stock");
        let mut unknown_encoding = codes.clone();
        unknown_encoding["io"]["category_encoding"] = serde_json::json!("ordinal");
        assert!(Io::of(&unknown_encoding).is_err());
        // A model trained on some of the columns (the online-v2 way: the first 179) reads exactly those.
        let mut first = manifest.clone();
        first["io"]["numeric"] = serde_json::json!(NUMERIC_COLUMNS[..179]);
        let io_first = Io::of(&first).unwrap();
        values[178] = 7.0;
        let row = io_first.row(&values, &categories);
        assert_eq!((row.len(), io_first.width(), row[178]), (179, 179, 7.0));
        let mut other = manifest.clone();
        other["io"]["numeric"] = serde_json::json!(["last_price", "quote_status"]);
        assert!(Io::of(&other).is_err(), "a column this build does not compute is refused");
        other["io"]["numeric"] = serde_json::json!(["ret_1m", "last_price"]);
        assert!(Io::of(&other).is_err(), "columns out of spec order are refused, never reordered");
        other["io"]["numeric"] = serde_json::json!([]);
        assert!(Io::of(&other).is_err());
        assert!(io.covers("shioaji", "STK") && !io.covers("shioaji", "FUT") && !io.covers("futu", "US"), "only what it was trained on");
        let mut unscoped = manifest.clone();
        unscoped.as_object_mut().unwrap().remove("scope");
        assert!(Io::of(&unscoped).is_err(), "a model that does not say what it was trained on is not applied to anything");
    }

    #[test]
    fn the_model_run_is_the_verified_bytes_even_when_the_file_changes_afterwards() {
        // The check read the artifact to hash it, and the load opened the path again: a file replaced in between
        // ran unverified.
        let manifest: Value = serde_json::from_str(&std::fs::read_to_string(fixture("onnx_model_manifest.json")).unwrap()).unwrap();
        let dir = std::env::temp_dir().join(format!("ar-model-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("model.onnx");
        std::fs::copy(fixture("onnx_model.onnx"), &path).unwrap();
        let artifact = ValidatedArtifact::read(&path, &manifest).unwrap();
        std::fs::write(&path, b"not a model").unwrap();
        assert!(OnnxModel::load(&artifact).is_ok(), "the session is built from what was hashed");
        assert!(matches!(ValidatedArtifact::read(&path, &manifest), Err(ArtifactRefusal::Incompatible(_))), "a re-read is checked again");
        std::fs::remove_file(&path).unwrap();
        assert!(matches!(ValidatedArtifact::read(&path, &manifest), Err(ArtifactRefusal::Missing(_))));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
