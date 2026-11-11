//! Strict command-line flags for the market_runtime and analysis_runtime executables: every flag is known, given
//! once (unless it is declared repeatable) and has a value. An unknown, repeated or valueless flag is an error naming
//! it -- a typo never becomes a silently different run.

use std::collections::BTreeMap;
use std::fmt::Display;
use std::str::FromStr;

/// `--name value` pairs (and, where a mode takes them, bare positional arguments), read in one pass.
#[derive(Debug, Default)]
pub struct Flags {
    values: BTreeMap<String, Vec<String>>,
    switches: Vec<String>,
    pub positional: Vec<String>,
}

impl Flags {
    /// `known`: the flags that take a value. `switches`: flags that stand alone (e.g. a mode selector).
    /// `positional`: whether bare arguments are accepted.
    pub fn parse(args: &[String], known: &[&str], switches: &[&str], positional: bool) -> Result<Self, String> {
        Self::parse_repeating(args, known, &[], switches, positional)
    }

    /// As `parse`, and the flags in `repeatable` may be given more than once (read them with `all`).
    pub fn parse_repeating(args: &[String], known: &[&str], repeatable: &[&str], switches: &[&str], positional: bool) -> Result<Self, String> {
        let mut flags = Flags::default();
        let mut it = args.iter();
        while let Some(arg) = it.next() {
            if switches.contains(&arg.as_str()) {
                if flags.switches.contains(arg) {
                    return Err(format!("{arg} given twice"));
                }
                flags.switches.push(arg.clone());
            } else if known.contains(&arg.as_str()) || repeatable.contains(&arg.as_str()) {
                let value = it.next().filter(|v| !v.starts_with("--")).ok_or_else(|| format!("{arg} needs a value"))?;
                let values = flags.values.entry(arg.clone()).or_default();
                if !values.is_empty() && !repeatable.contains(&arg.as_str()) {
                    return Err(format!("{arg} given twice"));
                }
                values.push(value.clone());
            } else if arg.starts_with("--") || !positional {
                return Err(format!("unknown argument {arg}"));
            } else {
                flags.positional.push(arg.clone());
            }
        }
        Ok(flags)
    }

    pub fn get(&self, name: &str) -> Option<&str> {
        self.values.get(name).and_then(|v| v.first()).map(String::as_str)
    }

    /// Every value of a repeatable flag, in order.
    pub fn all(&self, name: &str) -> &[String] {
        self.values.get(name).map_or(&[], Vec::as_slice)
    }

    pub fn switch(&self, name: &str) -> bool {
        self.switches.iter().any(|s| s == name)
    }

    pub fn required(&self, name: &str) -> Result<&str, String> {
        self.get(name).ok_or_else(|| format!("{name} is required"))
    }

    /// The flag parsed as `T`; None when absent.
    pub fn parsed<T: FromStr>(&self, name: &str) -> Result<Option<T>, String>
    where T::Err: Display {
        self.get(name).map(|v| v.parse::<T>().map_err(|e| format!("{name} {v:?}: {e}"))).transpose()
    }

    /// The flag parsed as a number at least `min`; None when absent.
    pub fn at_least<T: FromStr + PartialOrd + Display + Copy>(&self, name: &str, min: T) -> Result<Option<T>, String>
    where T::Err: Display {
        match self.parsed::<T>(name)? {
            Some(v) if v < min => Err(format!("{name} {v}: must be at least {min}")),
            other => Ok(other),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn unknown_repeated_and_valueless_flags_are_refused_by_name() {
        let known = ["--port", "--data-dir"];
        assert_eq!(Flags::parse(&args(&["--prot", "1"]), &known, &[], false).unwrap_err(), "unknown argument --prot");
        assert_eq!(Flags::parse(&args(&["--port", "1", "--port", "2"]), &known, &[], false).unwrap_err(), "--port given twice");
        assert_eq!(Flags::parse(&args(&["--port", "--data-dir", "d"]), &known, &[], false).unwrap_err(), "--port needs a value");
        assert_eq!(Flags::parse(&args(&["--port"]), &known, &[], false).unwrap_err(), "--port needs a value");
        assert_eq!(Flags::parse(&args(&["stray"]), &known, &[], false).unwrap_err(), "unknown argument stray");
        let f = Flags::parse(&args(&["--scan", "--port", "7", "1@8"]), &known, &["--scan"], true).unwrap();
        assert_eq!(f.parsed::<u16>("--port").unwrap(), Some(7));
        assert_eq!(f.positional, vec!["1@8"]);
        assert!(f.at_least::<u64>("--port", 8).unwrap_err().contains("at least 8"));
        assert!(f.parsed::<u16>("--data-dir").unwrap().is_none());
        assert!(Flags::parse(&args(&["--port", "x"]), &known, &[], false).unwrap().parsed::<u16>("--port").is_err());
        assert!(f.switch("--scan") && !f.switch("--port"));
        let r = Flags::parse_repeating(&args(&["--date", "a", "--date", "b", "--port", "1"]), &known, &["--date"], &[], false).unwrap();
        assert_eq!(r.all("--date"), ["a", "b"]);
        assert!(r.all("--data-dir").is_empty());
    }
}
