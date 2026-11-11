"use strict";

const { makeTempDir } = require("./support/temp_dirs.cjs");
const assert = require("node:assert/strict");
const path = require("node:path");
// Daemon hosts read/write their state under var/: point it at a disposable directory.
process.env.STOCK_MONITOR_VAR_ROOT = makeTempDir("provider-host-var-");
const { ShioajiDaemonHost } = require("../health/services/shioaji_daemon_host");
const { FutuDaemonHost } = require("../health/services/futu_daemon_host");

const projectRoot = path.resolve(__dirname, "..");
const logger = { log() {}, warn() {}, error() {} };

function http(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

(async () => {
  let futuAt = { host: "127.0.0.1", port: 18011 };
  const futu = new FutuDaemonHost({
    projectRoot,
    endpoint: () => futuAt,
    expected: { identity: "futu-test", protocolVersion: 1, runtimeVersion: "v1" },
    providerMode: "live",
    callbackSource: "sdk",
    enabled: false,
    fetchImpl: async () => http({ ok: true, stopped: true }),
    logger,
  });
  assert.deepEqual(await futu.ensure(), { ok: true, skipped: true, source: "futu" });
  // The address is read at each use -- an applied revision that moves the daemon moves the host with it.
  assert.equal(futu.daemonUrl, "http://127.0.0.1:18011");
  futuAt = { host: "127.0.0.1", port: 18111 };
  assert.deepEqual([futu.daemonUrl, futu.daemonPort], ["http://127.0.0.1:18111", 18111]);
  futuAt = { host: "127.0.0.1", port: 18011 };
  futu.isPortOpen = async () => false;
  assert.equal((await futu.stop("test")).stopped, true);

  const shioaji = new ShioajiDaemonHost({
    app: { getPath: () => projectRoot },
    projectRoot,
    endpoint: () => ({ host: "127.0.0.1", port: 18010 }),
    expected: { identity: "shioaji-test", protocolVersion: 1, runtimeVersion: "v1" },
    providerMode: "live",
    callbackSource: "sdk",
    enabled: false,
    fetchImpl: async () => http({ ok: true, stopped: true, pipeline_drained: false }),
    logger,
  });
  assert.deepEqual(await shioaji.ensure(), { ok: true, skipped: true, source: "shioaji" });
  // A disabled source's daemon is still stoppable from its owner record; with no owner and a free port it is gone.
  shioaji.isPortOpen = async () => false;
  assert.deepEqual(await shioaji.stop("test"), { ok: true, stopped: true, already_exited: true, reason: "test" });
  // A held port with no live owner record is not ours to stop: reported, never forced.
  shioaji.isPortOpen = async () => true;
  const foreign = await shioaji.stop("test");
  assert.deepEqual([foreign.ok, foreign.stopped], [false, false]);

  // The log tail is read where the daemon writes it: this run's log directory (backend/shared/detached_output.py).
  const { logSessionPath } = require("../service/platform/js/log_session");
  assert.equal(futu.detachedLogPath(), logSessionPath("moomoo_daemon.log"));
  assert.equal(shioaji.detachedLogPath(), logSessionPath("market_daemon.log"));
  console.log("provider daemon host contract passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
