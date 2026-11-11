"use strict";
// Windows' shutdown/logoff reaches Rust A alone (native/market_runtime/src/server/session_end.rs); A writes a
// `session_ending` line on its stdout, which Health already reads, and Health runs the same full shutdown as the
// tray's 完整關閉. Before this, nothing in Health listened: Windows ended every process, and Health recorded the
// resource sampler it ended as a failure (10-28 17:04). The main window's own "session-end" shutdown is gone.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { makeTempDir } = require("./support/temp_dirs.cjs");
const { MarketRuntimeHost } = require("../health/services/market_runtime_host.js");

const root = path.resolve(__dirname, "..");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function main() {
  const project = makeTempDir("mr-session-end-");
  const exe = path.join(project, "native", "market_runtime", "target", "release", "market_runtime_daemon.exe");
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, "");
  const port = await freePort();
  const notices = [];
  const logged = { log: [], error: [] };
  const logger = { log: (l) => logged.log.push(l), error: (l) => logged.error.push(l), warn() {} };
  let child = null;
  const host = new MarketRuntimeHost({ fs, path, projectRoot: project, dataRoot: path.join(project, "data"), configRoot: project,
    logDir: path.join(project, "logs"), effective: { services: { market_runtime: { host: "127.0.0.1", port } }, revision: 1 },
    credentialsFile: "c.json", controllerToken: "t", logger, timing: { firstAnswerMs: 60000, pollMs: 10 },
    onSessionEnding: (notice) => notices.push(notice),
    spawnImpl: () => {
      child = new EventEmitter();
      Object.assign(child, { pid: 4242, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
      return child;
    } });
  const started = host.ensure().catch((error) => error);
  while (!child) await new Promise((resolve) => setImmediate(resolve));

  // Log text and A's other lines are not a session end; a broken JSON line is recorded, not dropped silently.
  child.stdout.write("market_runtime listening ws://127.0.0.1/live\n");
  child.stdout.write(`${JSON.stringify({ type: "ready", service_id: "market_runtime", port, pid: 4242 })}\n`);
  child.stdout.write("{not json\n");
  // The line may arrive split across reads.
  const line = JSON.stringify({ type: "session_ending", payload: { event: "shutdown", pid: 4242, instance_id: "mr-1" } });
  child.stdout.write(line.slice(0, 20));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notices.length, 0);
  child.stdout.write(`${line.slice(20)}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notices, [{ event: "shutdown", pid: 4242, instance_id: "mr-1" }]);
  assert.equal(logged.error.filter((l) => l.includes("not JSON")).length, 1, logged.error.join("\n"));
  assert.ok(logged.log.some((l) => l.includes("Windows shutdown announced")), logged.log.join("\n"));

  child.exitCode = 0;
  child.emit("exit", 0, null);
  assert.match(String((await started)?.message), /exited with code 0 during start/);

  // Health: the notice runs the full shutdown, which marks Health stopping and stops the resource sampler before the
  // first stage; a full shutdown already running is the one that finishes.
  const healthMain = fs.readFileSync(path.join(root, "health", "main.js"), "utf8");
  assert.match(healthMain, /onSessionEnding: \(notice\) => void graceful\(`windows_\$\{notice\.event\}`\)/);
  const full = healthMain.slice(healthMain.indexOf('if (scope !== "full")'), healthMain.indexOf("await stage(API_SERVICES)"));
  assert.ok(/supervisor\.stopping = true;[\s\S]*collector\.stop\(\);/.test(full), "stopping and the sampler stop come before any stage");
  assert.match(healthMain, /async function graceful\(signal\) \{[\s\S]{0,200}if \(shuttingDown \|\| supervisor\.stopping\) return;/);

  // Electron: one owner of the session end -- the main window no longer starts its own full shutdown.
  for (const file of ["desktop_windows.js", "desktop_application.js"]) {
    const source = fs.readFileSync(path.join(root, "ui", "main", file), "utf8");
    assert.ok(!/\.on\("session-end"/.test(source) && !/windows_session_end/.test(source), `${file} handles no session-end`);
  }
  console.log("health market_runtime session end contract ok");
}

main().catch((error) => { console.error(error); process.exit(1); });
