//! The command line of analysis_runtime, parsed once into a typed mode. The mode is the first argument (one of the
//! offline jobs) or none (the daemon Health runs); each mode takes only its own flags. An unknown, repeated or
//! valueless flag, a missing required one and an out-of-range number are errors -- never a silent default that
//! makes a typo another valid run.

use crate::dataset::ExportArgs;
use crate::day_context::ContextSource;
use market_runtime::historical_store::StoreConfig;
use market_runtime::cli::Flags;
use std::path::PathBuf;
use std::time::Duration;

/// The materialization job's flags (read by materialize.rs).
pub const MATERIALIZE_FLAGS: &[&str] = &[
    "--data-dir", "--out-dir", "--source", "--market", "--code", "--logical-code", "--trading-date", "--session",
    "--completeness", "--gap-codes", "--repaired-codes", "--start-gate", "--config-root", "--daily-summary-dir", "--rollover-cutoffs", "--traded-codes-dir",
    "--retention-config-root", "--input", "--fills-dir", "--voided-events", "--unresolved-codes", "--volume-baseline-root", "--kbar-dir",
    "--us-trading-calendar",
];

const DAEMON_FLAGS: &[&str] = &[
    "--runtime-url", "--token-file", "--data-dir", "--events-dir", "--config-root", "--inference-dir", "--publish-interval-ms",
    "--checkpoint-interval-s", "--paper-dir", "--market-holidays", "--market-sessions", "--volume-baseline-root",
    "--daily-summary-dir", "--industry-indexes", "--security-master", "--historical-dir", "--rollover-cutoffs", "--traded-codes-dir",
    "--voided-events", "--us-trading-calendar",
];

/// The day context the features read (day_context.rs): the daily summaries and the industry map.
fn context(flags: &Flags) -> Result<ContextSource, String> {
    ContextSource::new(flags.get("--daily-summary-dir").map(PathBuf::from), flags.get("--industry-indexes").map(std::path::Path::new),
                       flags.get("--security-master").map(std::path::Path::new))
}

/// The daemon: Rust B as Health starts it.
#[derive(Debug)]
pub struct DaemonOptions {
    pub runtime_url: String,
    pub token_file: PathBuf,
    pub data_dir: PathBuf,
    /// The rule-event archive (archive.rs): under the user's storage location, not the data dir -- it grows every
    /// trading day (config/var_layout.json "storage").
    pub events_dir: PathBuf,
    pub config_root: Option<PathBuf>,
    /// model_api writes the inference config here; B writes its inference status next to it.
    pub inference_dir: Option<PathBuf>,
    pub publish_interval: Duration,
    pub checkpoint_interval: Duration,
    pub paper_dir: Option<PathBuf>,
    pub market_holidays: Option<PathBuf>,
    /// Rust A's sessions file (its observed closures are non-trading days), read again whenever A rewrites it.
    pub market_sessions: Option<PathBuf>,
    /// OpenD's US calendar the Futu provider writes (Rust A reads it too): with the holidays file's NYSE days, the US
    /// half days B's sessions are split by.
    pub us_trading_calendar: Option<PathBuf>,
    /// Rust A's void-event list (market_runtime voided.rs): the durable events B's fold leaves out.
    pub voided_events: Option<PathBuf>,
    pub volume_baseline_root: Option<PathBuf>,
    pub context: ContextSource,
    /// The historical store B manages (market_runtime historical_store.rs): pruned at its start and at each session
    /// rollover. None without `--historical-dir`.
    pub historical: Option<StoreConfig>,
}

#[derive(Debug)]
pub enum Mode {
    /// The historical materialization job (materialize.rs); `stdin_gate`: wait for Health's "start".
    Materialize { flags: Flags, stdin_gate: bool, config_root: Option<PathBuf> },
    /// Whether materialized partitions are still what their manifests describe.
    VerifyPartitions(Vec<String>),
    /// The identity of the FeatureSpec this build computes.
    FeatureSpec,
    /// Where a materialized session is missing prints (history_gaps.rs).
    /// `expected_codes` (`--expected-codes`, comma separated): codes the session should hold; one without a partition
    /// gets the whole session as its window.
    GapReport { historical_root: PathBuf, source: String, market: String, trading_date: String, session: String, expected_codes: Vec<String> },
    /// The training feature dataset.
    ExportFeatures(ExportArgs),
    /// What each date's day context is made of (a training shard's identity includes it).
    FeatureContext { source: String, dates: Vec<String>, context: ContextSource },
    /// The daily summaries of sessions already in the historical store.
    SummarizeHistory { historical_root: PathBuf, out_dir: PathBuf, source: String, dates: Vec<String> },
    /// The K-bar store rebuilt from sessions already in the historical store (no `--date`: every date held).
    /// One product's broker download into the K-bar store (kbar_store.rs `Store::import`).
    ImportKbars { kbar_dir: PathBuf, input: PathBuf, retention_config_root: Option<PathBuf> },
    Daemon(DaemonOptions),
}

impl Mode {
    /// Whether the mode answers on stdout with a JSON result line (`{"ok": false, ...}` on a bad command line too).
    pub fn first_arg_is_job(args: &[String]) -> bool {
        matches!(args.first().map(String::as_str),
                 Some("--materialize" | "--verify-partitions" | "--feature-spec" | "--export-features"
                      | "--summarize-history" | "--import-kbars" | "--feature-context" | "--gap-report"))
    }
}

/// `args` without the program name.
pub fn parse(args: &[String]) -> Result<Mode, String> {
    let (first, rest) = match args.split_first() {
        Some((first, rest)) => (first.as_str(), rest),
        None => ("", args),
    };
    match first {
        "--materialize" => {
            let flags = Flags::parse(rest, MATERIALIZE_FLAGS, &[], false)?;
            let stdin_gate = match flags.get("--start-gate") {
                None => false,
                Some("stdin") => true,
                Some(other) => return Err(format!("--start-gate: expected stdin, got {other}")),
            };
            let config_root = flags.get("--config-root").map(PathBuf::from);
            Ok(Mode::Materialize { flags, stdin_gate, config_root })
        }
        "--verify-partitions" => {
            let flags = Flags::parse(rest, &[], &[], true)?;
            Ok(Mode::VerifyPartitions(flags.positional))
        }
        "--feature-spec" => {
            Flags::parse(rest, &[], &[], false)?;
            Ok(Mode::FeatureSpec)
        }
        "--gap-report" => {
            let flags = Flags::parse(rest, &["--historical-root", "--source", "--market", "--trading-date", "--session", "--expected-codes"], &[], false)?;
            Ok(Mode::GapReport { historical_root: PathBuf::from(flags.required("--historical-root")?),
                                 source: flags.get("--source").unwrap_or("shioaji").to_owned(), market: flags.required("--market")?.to_owned(),
                                 trading_date: flags.required("--trading-date")?.to_owned(), session: flags.required("--session")?.to_owned(),
                                 expected_codes: flags.get("--expected-codes").unwrap_or("").split(',').map(|c| c.trim().to_uppercase())
                                     .filter(|c| !c.is_empty()).collect() })
        }
        "--export-features" => export_args(rest).map(Mode::ExportFeatures),
        "--feature-context" => {
            let flags = Flags::parse_repeating(rest, &["--source", "--daily-summary-dir", "--industry-indexes", "--security-master"],
                                               &["--date"], &[], false)?;
            Ok(Mode::FeatureContext { source: flags.get("--source").unwrap_or("shioaji").to_owned(), dates: flags.all("--date").to_vec(),
                                      context: context(&flags)? })
        }
        "--import-kbars" => {
            let flags = Flags::parse_repeating(rest, &["--kbar-dir", "--input", "--retention-config-root"], &[], &[], false)?;
            Ok(Mode::ImportKbars { kbar_dir: PathBuf::from(flags.required("--kbar-dir")?), input: PathBuf::from(flags.required("--input")?),
                                   retention_config_root: flags.get("--retention-config-root").map(PathBuf::from) })
        }
        "--summarize-history" => {
            let flags = Flags::parse_repeating(rest, &["--historical-root", "--out-dir", "--source"], &["--date"], &[], false)?;
            let dates = flags.all("--date").to_vec();
            if dates.is_empty() {
                return Err("--date is required (one per trading date)".into());
            }
            Ok(Mode::SummarizeHistory { historical_root: PathBuf::from(flags.required("--historical-root")?),
                                        out_dir: PathBuf::from(flags.required("--out-dir")?),
                                        source: flags.get("--source").unwrap_or("shioaji").to_owned(), dates })
        }
        _ => daemon_options(args).map(Mode::Daemon),
    }
}

/// A comma list, upper-cased; an empty entry is an error.
fn list(flags: &Flags, name: &str, default: &str) -> Result<Vec<String>, String> {
    let text = flags.get(name).unwrap_or(default);
    text.split(',').map(|s| s.trim().to_uppercase())
        .map(|s| if s.is_empty() { Err(format!("{name} {text:?}: an empty entry")) } else { Ok(s) }).collect()
}

fn export_args(args: &[String]) -> Result<ExportArgs, String> {
    let flags = Flags::parse_repeating(args, &["--historical-root", "--out", "--source", "--markets", "--sample-markets", "--horizons",
                                               "--daily-summary-dir", "--industry-indexes", "--security-master"],
                                       &["--date"], &[], false)?;
    let dates = flags.all("--date").to_vec();
    if dates.is_empty() {
        return Err("--date is required (one per trading date)".into());
    }
    let horizons_minutes = list(&flags, "--horizons", "3,5,10,15,30")?.iter()
        .map(|m| m.parse::<u32>().ok().filter(|m| *m > 0).ok_or_else(|| format!("--horizons: {m:?} is not a positive number of minutes")))
        .collect::<Result<Vec<u32>, String>>()?;
    Ok(ExportArgs {
        historical_root: PathBuf::from(flags.required("--historical-root")?),
        dates,
        out: PathBuf::from(flags.required("--out")?),
        source: flags.get("--source").unwrap_or("shioaji").to_owned(),
        markets: list(&flags, "--markets", "STK,IDX")?,
        sample_markets: list(&flags, "--sample-markets", "STK")?,
        context: context(&flags)?,
        horizons_minutes,
    })
}

fn daemon_options(args: &[String]) -> Result<DaemonOptions, String> {
    let flags = Flags::parse(args, DAEMON_FLAGS, &[], false)?;
    let path = |name: &str| flags.get(name).map(PathBuf::from);
    Ok(DaemonOptions {
        runtime_url: flags.get("--runtime-url").ok_or("--runtime-url is required (from the resolved network config)")?.to_owned(),
        token_file: PathBuf::from(flags.get("--token-file").ok_or("--token-file with the analysis_runtime credential is required")?),
        data_dir: PathBuf::from(flags.required("--data-dir")?),
        events_dir: PathBuf::from(flags.required("--events-dir")?),
        config_root: path("--config-root"),
        inference_dir: path("--inference-dir"),
        publish_interval: Duration::from_millis(flags.at_least("--publish-interval-ms", 1)?.unwrap_or(250)),
        checkpoint_interval: Duration::from_secs(flags.at_least("--checkpoint-interval-s", 1)?.unwrap_or(30)),
        paper_dir: path("--paper-dir"),
        market_holidays: path("--market-holidays"),
        market_sessions: path("--market-sessions"),
        us_trading_calendar: path("--us-trading-calendar"),
        voided_events: path("--voided-events"),
        volume_baseline_root: path("--volume-baseline-root"),
        context: context(&flags)?,
        historical: path("--historical-dir").map(|root| StoreConfig { root, cutoffs: path("--rollover-cutoffs"),
            config_root: path("--config-root"), traded_codes_dir: path("--traded-codes-dir") }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn each_mode_takes_only_its_own_flags_and_refuses_a_typo() {
        let daemon = ["--runtime-url", "ws://127.0.0.1:1/live", "--token-file", "t", "--data-dir", "d", "--events-dir", "e"];
        let Mode::Daemon(d) = parse(&args(&daemon)).unwrap() else { panic!("daemon") };
        assert_eq!((d.publish_interval, d.checkpoint_interval), (Duration::from_millis(250), Duration::from_secs(30)));
        let mut typo = args(&daemon);
        typo.extend(args(&["--publish-intreval-ms", "100"]));
        assert_eq!(parse(&typo).unwrap_err(), "unknown argument --publish-intreval-ms");
        let mut zero = args(&daemon);
        zero.extend(args(&["--checkpoint-interval-s", "0"]));
        assert!(parse(&zero).unwrap_err().contains("at least 1"));
        let mut word = args(&daemon);
        word.extend(args(&["--publish-interval-ms", "fast"]));
        assert!(parse(&word).unwrap_err().contains("--publish-interval-ms"));
        assert!(parse(&args(&["--token-file", "t", "--data-dir", "d"])).unwrap_err().contains("--runtime-url"));
        assert!(parse(&args(&daemon[..6])).unwrap_err().contains("--events-dir"), "no default events folder under --data-dir");
        assert_eq!(d.events_dir, PathBuf::from("e"));
        // A job flag is not the daemon's, and a mode selector is only the first argument.
        let mut mixed = args(&daemon);
        mixed.push("--materialize".into());
        assert!(parse(&mixed).unwrap_err().contains("unknown argument --materialize"));
    }

    #[test]
    fn export_horizons_are_checked_not_filtered() {
        let base = ["--export-features", "--historical-root", "h", "--out", "o", "--date", "2026-10-01", "--date", "2026-10-02"];
        let Mode::ExportFeatures(e) = parse(&args(&base)).unwrap() else { panic!("export") };
        assert_eq!((e.dates.len(), e.horizons_minutes.clone()), (2, vec![3, 5, 10, 15, 30]));
        let mut bad = args(&base);
        bad.extend(args(&["--horizons", "3,x,5"]));
        assert!(parse(&bad).unwrap_err().contains("\"X\" is not a positive number"));
        let mut empty = args(&base);
        empty.extend(args(&["--markets", "STK,,IDX"]));
        assert!(parse(&empty).unwrap_err().contains("empty entry"));
        assert!(parse(&args(&["--export-features", "--historical-root", "h", "--out", "o"])).unwrap_err().contains("--date"));
    }

    #[test]
    fn job_modes_parse_their_operands() {
        let Mode::VerifyPartitions(dirs) = parse(&args(&["--verify-partitions", "a", "b"])).unwrap() else { panic!() };
        assert_eq!(dirs, ["a", "b"]);
        assert!(matches!(parse(&args(&["--feature-spec"])).unwrap(), Mode::FeatureSpec));
        assert!(parse(&args(&["--feature-spec", "--x"])).is_err());
        let Mode::Materialize { stdin_gate, .. } = parse(&args(&["--materialize", "--start-gate", "stdin", "--data-dir", "d"])).unwrap() else { panic!() };
        assert!(stdin_gate);
        assert!(parse(&args(&["--materialize", "--start-gate", "now"])).unwrap_err().contains("--start-gate"));
        assert!(parse(&args(&["--materialize", "--code", "1", "--code", "2"])).unwrap_err().contains("given twice"));
    }

    #[test]
    fn the_daemon_manages_the_historical_store_only_when_given_one() {
        let daemon = ["--runtime-url", "ws://127.0.0.1:1/live", "--token-file", "t", "--data-dir", "d", "--events-dir", "e"];
        let Mode::Daemon(d) = parse(&args(&daemon)).unwrap() else { panic!("daemon") };
        assert!(d.historical.is_none());
        let mut with = args(&daemon);
        with.extend(args(&["--historical-dir", "h", "--rollover-cutoffs", "c.json", "--traded-codes-dir", "tc", "--config-root", "cfg"]));
        let Mode::Daemon(d) = parse(&with).unwrap() else { panic!("daemon") };
        let store = d.historical.unwrap();
        assert_eq!((store.root, store.cutoffs, store.traded_codes_dir, store.config_root),
                   (PathBuf::from("h"), Some(PathBuf::from("c.json")), Some(PathBuf::from("tc")), Some(PathBuf::from("cfg"))));
    }
}
