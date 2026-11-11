//! analysis_runtime (Rust B): see the library (lib.rs) for what it is. This entry parses the command line and
//! starts the mode it names.

use analysis_runtime::{cli, run_daemon, run_job};
use serde_json::json;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = match cli::parse(&args) {
        Ok(mode) => mode,
        Err(error) => {
            // A job answers on stdout (its caller reads the result line); a bad command line is no transient failure.
            if args.first().map(String::as_str) == Some("--materialize") {
                println!("{}", json!({"ok": false, "status": "invalid_request", "outcome": "invalid_request", "error": error}));
            } else if cli::Mode::first_arg_is_job(&args) {
                println!("{}", json!({"ok": false, "error": error}));
            }
            eprintln!("[analysis_runtime] {error}");
            std::process::exit(2);
        }
    };
    match mode {
        cli::Mode::Daemon(options) => run_daemon(options),
        job => run_job(job),
    }
}
