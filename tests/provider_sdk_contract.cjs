// The installer carries no broker SDK; an installed App installs it from PyPI. Health runs
// install_provider_sdk.ps1 and restarts that provider; Electron only starts the job and relays its progress.
// A source checkout only reports what is importable.
"use strict";
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createProviderSdkJob } = require("../health/provider_sdk_job.js");
const { createProviderSdk } = require("../ui/main/provider_sdk.js");

const quiet = { warn() {}, log() {}, error() {} };

function fakeSpawn(script) {
  const calls = [];
  const spawnImpl = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; setImmediate(() => child.emit("close", 1)); };
    const { out, code, hang } = script(command, args);
    if (!hang) setImmediate(() => { child.stdout.emit("data", Buffer.from(out)); child.emit("close", code); });
    calls.at(-1).child = child;
    return child;
  };
  return { spawnImpl, calls };
}

async function settle(job) {
  for (let i = 0; i < 100 && job.job()?.state === "RUNNING"; i += 1) await new Promise((r) => setImmediate(r));
  return job.job();
}

(async () => {
  // Source checkout: status only; Health refuses an install.
  {
    // The probe imports the package and reports its version (a broken folder is not "installed")
    const { spawnImpl, calls } = fakeSpawn(() => ({ out: '{"shioaji": {"installed": true, "version": "1.7.2"}, "futu": {"installed": false, "error": "ImportError: partial"}}\n', code: 0 }));
    const job = createProviderSdkJob({ isPackaged: false, pythonExecutable: "python", supervisor: {}, spawnImpl, logger: quiet });
    const status = await job.status();
    assert.equal(status.can_install, false);
    assert.match(status.reason, /pip/);
    assert.deepEqual(status.providers, { shioaji: { installed: true, version: "1.7.2", error: null },
      futu: { installed: false, version: null, error: "ImportError: partial" } });
    assert.match(calls[0].args[1], /import_module/, "imported, not find_spec");
    assert.deepEqual(job.install("shioaji").error, "SOURCE_CHECKOUT");
  }
  // Installed App: the script runs with the provider, its lines are kept, then Health restarts that provider.
  {
    const { spawnImpl, calls } = fakeSpawn((command) => (command === "python.exe"
      ? { out: '{"shioaji": {"installed": false}, "futu": {"installed": false}}\n', code: 0 }
      : { out: "安裝 shioaji SDK 到 X ...\r\n完成。\r\n", code: 0 }));
    const restarts = [];
    const supervisor = { restart: async (sid, reason) => { restarts.push([sid, reason]); return { ok: true }; } };
    const job = createProviderSdkJob({ isPackaged: true, resourcesPath: "C:\\App\\resources", pythonExecutable: "python.exe",
      supervisor, env: { SystemRoot: "C:\\Windows" }, spawnImpl, logger: quiet });
    assert.equal((await job.status()).providers.shioaji.installed, false);
    const started = job.install("shioaji");
    assert.equal(started.ok, true);
    assert.equal(started.job.state, "RUNNING");
    assert.equal(job.install("futu").error, "INSTALL_RUNNING", "one install at a time");
    const done = await settle(job);
    assert.equal(done.state, "INSTALLED");
    assert.deepEqual(done.restart, { ok: true });
    const ps = calls.find((c) => /powershell\.exe$/.test(c.command));
    assert.deepEqual(ps.args.slice(-4), ["-File", "C:\\App\\resources\\install_provider_sdk.ps1", "-Provider", "shioaji"]);
    assert.deepEqual(restarts, [["provider_shioaji", "provider SDK installed"]]);
    assert.ok(done.lines.some((l) => l.text.includes("完成")), "the script's own lines are kept for the page");
    assert.ok(done.lines.every((l, i, all) => i === 0 || l.seq > all[i - 1].seq), "lines carry increasing seq");
    assert.equal(job.install("ib").error, "UNKNOWN_PROVIDER");
  }
  // A failed pip run is FAILED with nothing restarted; a failed restart is INSTALLED with the reason.
  {
    const { spawnImpl } = fakeSpawn(() => ({ out: "ERROR: hash mismatch\n", code: 1 }));
    const restarts = [];
    const job = createProviderSdkJob({ isPackaged: true, resourcesPath: "R", pythonExecutable: "python.exe",
      supervisor: { restart: async (...a) => { restarts.push(a); return { ok: true }; } }, spawnImpl, logger: quiet });
    job.install("futu");
    const done = await settle(job);
    assert.equal(done.state, "FAILED");
    assert.ok(done.lines.some((l) => /hash mismatch/.test(l.text)));
    assert.deepEqual(restarts, []);
  }
  {
    const { spawnImpl } = fakeSpawn(() => ({ out: "ok\n", code: 0 }));
    const job = createProviderSdkJob({ isPackaged: true, resourcesPath: "R", pythonExecutable: "python.exe",
      supervisor: { restart: async () => ({ ok: false, error: "port busy" }) }, spawnImpl, logger: quiet });
    job.install("futu");
    const done = await settle(job);
    assert.equal(done.state, "INSTALLED");
    assert.deepEqual(done.restart, { ok: false, error: "port busy" });
    assert.match(done.error, /重新啟動 App/);
  }
  // Full shutdown ends a running installer's whole process tree and waits for it.
  {
    const { spawnImpl, calls } = fakeSpawn(() => ({ hang: true }));
    const killed = [];
    const killTree = async (pid) => { killed.push(pid); calls[0].child.emit("close", 1); return true; };
    const job = createProviderSdkJob({ isPackaged: true, resourcesPath: "R", pythonExecutable: "python.exe",
      supervisor: { restart: async () => ({ ok: true }) }, spawnImpl, logger: quiet, killTree });
    calls.length = 0;
    job.install("shioaji");
    await new Promise((r) => setImmediate(r));
    calls[0].child.pid = 4242;
    const receipt = await job.stop();
    const done = await settle(job);
    assert.deepEqual(killed, [4242], "the tree of the installer's pid");
    assert.deepEqual(receipt, { ok: true, running: true, pid: 4242, exited: true });
    assert.equal(done.state, "FAILED");
    assert.deepEqual(await job.stop(), { ok: true, running: false });
  }
  // An install's output is followed line by line (a line split across chunks is one line) and only a bounded tail is
  // kept; the failure log says how many earlier bytes were not kept.
  {
    const { spawnImpl, calls } = fakeSpawn(() => ({ hang: true }));
    const errors = [];
    const job = createProviderSdkJob({ isPackaged: true, resourcesPath: "R", pythonExecutable: "python.exe",
      supervisor: { restart: async () => ({ ok: true }) }, spawnImpl, logger: { ...quiet, error: (line) => errors.push(String(line)) } });
    job.install("futu");
    await new Promise((r) => setImmediate(r));
    const child = calls[0].child;
    const heapBefore = process.memoryUsage().heapUsed;
    for (let i = 0; i < 400; i += 1) child.stdout.emit("data", Buffer.from(`${"x".repeat(4000)} line ${i}\n`));
    child.stdout.emit("data", Buffer.from("pip: half a "));
    child.stdout.emit("data", Buffer.from("line\nERROR: no matching distribution"));
    child.emit("close", 1);
    const done = await settle(job);
    assert.equal(done.state, "FAILED");
    assert.equal(done.lines.at(-2).text, "pip: half a line");
    assert.equal(done.lines.at(-1).text, "ERROR: no matching distribution", "the last partial line is kept at close");
    assert.ok(done.lines.length <= 200);
    assert.match(errors.join("\n"), /earlier bytes of output not kept\): [\s\S]*ERROR: no matching distribution/);
    assert.ok(process.memoryUsage().heapUsed - heapBefore < 64 * 1024 * 1024, "1.6 MB of output did not stay whole");
  }
  // Electron relays each new line once and reports the job's outcome.
  {
    const jobs = [
      { job_id: "j1", provider: "futu", state: "RUNNING", lines: [{ seq: 1, text: "a" }, { seq: 2, text: "b" }] },
      { job_id: "j1", provider: "futu", state: "INSTALLED", lines: [{ seq: 2, text: "b" }, { seq: 3, text: "c" }], restart: { ok: true }, error: null },
    ];
    const controllerClient = {
      installProviderSdk: async (provider) => ({ ok: true, job: { job_id: "j1", provider, state: "RUNNING", lines: [{ seq: 1, text: "a" }] } }),
      getProviderSdkJob: async () => ({ ok: true, job: jobs.shift() }),
      getProviderSdk: async () => ({ ok: true, can_install: true, providers: { futu: { installed: false } }, job: { state: "RUNNING", provider: "futu" } }),
    };
    const sdk = createProviderSdk({ controllerClient, logger: quiet, sleep: async () => {} });
    const lines = [];
    assert.deepEqual(await sdk.install("futu", { onLine: (l) => lines.push(l) }), { ok: true, provider: "futu", restarted: true, error: null });
    assert.deepEqual(lines, ["a", "b", "c"]);
    assert.equal((await sdk.status()).installing, "futu");
    const refused = createProviderSdk({ controllerClient: { installProviderSdk: async () => ({ ok: false, error: "INSTALL_RUNNING", message: "正在安裝 shioaji，請稍候" }) }, logger: quiet });
    assert.deepEqual(await refused.install("futu"), { ok: false, provider: "futu", error: "正在安裝 shioaji，請稍候" });
    const lost = createProviderSdk({ controllerClient: { installProviderSdk: controllerClient.installProviderSdk,
      getProviderSdkJob: async () => ({ ok: true, job: null }) }, logger: quiet, sleep: async () => {} });
    assert.match((await lost.install("futu")).error, /中斷/);
  }
  // Following ends when the asking window is gone or the App closes; failed reads back off, bounded.
  {
    const waits = [];
    let reads = 0;
    const following = new AbortController();
    const flaky = createProviderSdk({ logger: quiet, sleep: async (ms) => { waits.push(ms); if (waits.length === 6) following.abort(new Error("the settings window closed")); },
      controllerClient: { installProviderSdk: async (provider) => ({ ok: true, job: { job_id: "j2", provider, state: "RUNNING", lines: [] } }),
        getProviderSdkJob: async () => { reads += 1; throw new Error("Health restarting"); } } });
    const stopped = await flaky.install("futu", { signal: following.signal });
    assert.equal(stopped.following, "stopped");
    assert.deepEqual(waits, [1000, 2000, 4000, 8000, 10000, 10000], "doubling, capped at 10 s");
    assert.equal(reads, 5, "no read after the window closed");
    let closing = false;
    const closed = createProviderSdk({ logger: quiet, sleep: async () => { closing = true; },
      controllerClient: { installProviderSdk: async (provider) => ({ ok: true, job: { job_id: "j3", provider, state: "RUNNING", lines: [] } }),
        getProviderSdkJob: async () => { throw new Error("must not be read"); } } });
    assert.equal((await closed.install("futu", { isClosing: () => closing })).following, "stopped");
  }
  console.log("provider sdk contract ok");
})().catch((error) => { console.error(error); process.exitCode = 1; });
