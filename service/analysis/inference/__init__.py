"""Model inference: the contract with the out-of-process Rust analysis worker, and its supervisor.

Training stays in Python. Intraday inference runs in a separate Rust process
(native/analysis_runtime, Rust B) that consumes Market Runtime's durable stream with its own cursor, validates its
own results and publishes them to Market Runtime (native/analysis_runtime/src/signals.rs).
"""
