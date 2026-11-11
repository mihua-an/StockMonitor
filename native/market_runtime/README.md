# market_runtime (Rust A)

Spec: `docs/system-architecture/01_rust_a.md`, `03_protocol_and_storage.md`, `04_latency_and_recovery.md`.

The one intraday renderer WebSocket entry (`service_id` `market_runtime`) and the one raw-market WAL writer.

| Module | Responsibility |
| --- | --- |
| `event` | raw event contract v2 (v1 WAL records still deserialize), market clocks/time zones |
| `contract` | roles + permissions compiled from `config/system_contract.json`; credential file (token SHA-256 per role) |
| `state` | LatestState: reference, latest quote, recent 100 trades, latest BidAsk, generation/sequence fences |
| `breadth` | one combined STK+OTC advance/decline figure (`computed` or `source`, never both) |
| `demand` | background list + views + workspace + focus -> one plan per provider; desired/planned/actual status |
| `projection` | validated cache of Rust B results and producer signals (epoch / watermark / revision rules) |
| `wal` | bounded reservation, background writer, commit watermark, sparse index, chunked replay, tail repair vs corruption |
| `checkpoint` | state exactly at a committed prefix; checksum, atomic replace, previous-version fallback |
| `latency` | per-stage histograms (exchange->backend, backend->A, accept->commit, A->UI, backend->UI) |
| `wire` | snapshot / delta shapes; per-block cut-offs |
| `server` | hub, role-gated commands, contiguous per-state view sequence, slow-consumer resync, market clock, drain/shutdown |

The historical materialization job is Rust B's `analysis_runtime --materialize` (folded by B's engine); the v1 `live.rs` engine and the `historical_materializer` binary are gone.

Start (Health does this with the resolved config):

```
market_runtime_daemon --port 8010 --data-dir <data>/market-runtime --credentials <auth>/market_runtime_credentials.json \
    --config-revision <n> --config-root <var>/config
```

Build: `cargo build --release`. Tests: `cargo test --release` (unit + `tests/e2e_*.rs` over real sockets, sharing `tests/support`; a daemon binds port 0 and its `listening` line names the port).
