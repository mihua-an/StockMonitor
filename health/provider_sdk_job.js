"use strict";

// 券商 SDK inside the App: the installer never carries Shioaji or moomoo-api; an installed App
// installs them on request. Health owns it because Health owns the providers: it downloads the exact versions and
// hashes the App was built with (resources/app-runtime/python/provider_sdk/<provider>.txt) from PyPI with the same
// script the docs describe (resources/install_provider_sdk.ps1), into the user's profile -- never the install
// directory -- and then restarts that provider itself, so the SDK is used at once. Electron only starts the job and
// reads its progress (it never asks for an individual service; tests/startup_ownership_contract.cjs).
//
// A source checkout runs the developer's own Python: there the SDK is installed with pip (requirements/*.lock), and
// this only reports whether it is importable.

const { spawn } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const { terminateProcessTree } = require("../service/platform/js/forced_termination");

const PROVIDERS = { shioaji: ["shioaji"], futu: ["moomoo", "futu"] };
// The distribution whose installed version is reported (and the installer checks against its pin).
const DISTRIBUTIONS = { shioaji: "shioaji", futu: "moomoo-api" };
const MAX_LINES = 200;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const TAIL_BYTES = 64 * 1024;

function createProviderSdkJob({ isPackaged, resourcesPath, pythonExecutable, supervisor, env = process.env, spawnImpl = spawn,
  logger = console, now = () => new Date().toISOString(), killTree = terminateProcessTree }) {
  let job = null;          // the latest install: { job_id, provider, state, started_at, finished_at, lines, error, restart }
  let installer = null;    // the running install_provider_sdk.ps1, ended on full shutdown
  let lineSeq = 0;

  // A process's output is followed line by line and only its tail is kept (TAIL_BYTES, oldest dropped first, the
  // dropped byte count recorded): an install runs up to ten minutes and its whole output stayed in Health's heap.
  function run(command, args, { onLine = () => {}, timeoutMs, onSpawn = () => {} }) {
    return new Promise((resolve) => {
      let tail = "";
      let droppedBytes = 0;
      let partial = "";
      let lastLine = "";
      let timedOut = false;
      const proc = spawnImpl(command, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const keep = (text) => {
        tail += text;
        const excess = Buffer.byteLength(tail, "utf8") - TAIL_BYTES;
        if (excess > 0) {
          droppedBytes += excess;
          tail = Buffer.from(tail, "utf8").subarray(excess).toString("utf8");
        }
      };
      const line = (text) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        lastLine = trimmed;
        onLine(trimmed);
      };
      // A line split across two chunks is one line.
      const take = (chunk) => {
        const text = chunk.toString("utf8");
        keep(text);
        const lines = (partial + text).split(/\r?\n/);
        partial = lines.pop();
        for (const item of lines) line(item);
      };
      let timer = null;
      const finish = (code) => {
        clearTimeout(timer);
        if (partial) { line(partial); partial = ""; }
        resolve({ code, tail, lastLine, droppedBytes, timedOut });
      };
      proc.stdout?.on("data", take);
      proc.stderr?.on("data", take);
      timer = setTimeout(() => {
        timedOut = true;
        // The whole tree: PowerShell runs pip in a child python that kill() on the parent left writing.
        void killTree(proc.pid).then((exited) => {
          if (!exited) logger.error?.(`[PROVIDER SDK] a timed-out process tree (pid ${proc.pid}) did not exit`);
        });
      }, timeoutMs);
      proc.on("error", (error) => { keep(String(error?.message || error)); finish(-1); });
      proc.on("close", (code) => finish(code));
      onSpawn(proc);
    });
  }

  function addLine(text) {
    if (!job) return;
    lineSeq += 1;
    job.lines.push({ seq: lineSeq, text: String(text).slice(0, 500) });
    if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES);
  }

  /** { can_install, reason, probe_error, providers: { shioaji: { installed }, futu: { installed } }, job } */
  async function status() {
    // Imported for real, with its version: a package folder left by a broken install was "found" by
    // find_spec and hid the install button while the provider could not import it.
    const probe = "import importlib, importlib.metadata as m, json\n"
      + `out = {}\nfor k, (mods, dist) in ${JSON.stringify(Object.fromEntries(Object.keys(PROVIDERS).map((k) => [k, [PROVIDERS[k], DISTRIBUTIONS[k]]])))}.items():\n`
      + "    try:\n        [importlib.import_module(n) for n in mods[:1]]\n        out[k] = {'installed': True, 'version': m.version(dist)}\n"
      + "    except Exception as exc:\n        out[k] = {'installed': False, 'error': f'{type(exc).__name__}: {exc}'[:200]}\n"
      // Why an installed SDK's folder could not be used (the bundled sitecustomize.py records it): the reason, not
      // a bare ModuleNotFoundError that reads as "not installed".
      + "import sys\nfor k, e in getattr(sys.modules.get('sitecustomize'), 'PROVIDER_SDK_ERRORS', {}).items():\n"
      + "    if k in out and not out[k].get('installed'):\n        out[k]['error'] = str(e)[:300]\n"
      + "print(json.dumps(out))";
    const result = await run(pythonExecutable, ["-c", probe], { timeoutMs: 30000 });
    let found = null;
    try { found = JSON.parse(result.lastLine || "null"); }
    catch (error) { logger.warn?.(`[PROVIDER SDK] import probe answered no JSON (exit ${result.code}): ${result.tail.slice(-300)}`, error); }
    return {
      can_install: Boolean(isPackaged),
      reason: isPackaged ? null : "原始碼版使用開發環境的 Python：請用 pip 安裝（requirements/shioaji.lock、futu.lock）",
      probe_error: found ? null : `無法檢查（exit ${result.code}）`,
      providers: Object.fromEntries(Object.keys(PROVIDERS).map((name) => [name, found
        ? { installed: Boolean(found[name]?.installed), version: found[name]?.version || null, error: found[name]?.error || null }
        : { installed: null }])),
      job: snapshot(),
    };
  }

  function snapshot() {
    return job ? { ...job, lines: job.lines.slice() } : null;
  }

  async function execute(provider) {
    const script = path.join(resourcesPath, "install_provider_sdk.ps1");
    const systemRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
    const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    addLine(`從 PyPI 下載並安裝 ${provider} SDK ...`);
    const result = await run(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
      "-Provider", provider], { onLine: addLine, timeoutMs: INSTALL_TIMEOUT_MS, onSpawn: (proc) => { installer = proc; } });
    installer = null;
    if (result.code !== 0) {
      logger.error?.(`[PROVIDER SDK] ${provider} install failed (exit ${result.code}${result.timedOut ? ", timed out" : ""}`
        + `${result.droppedBytes ? `; ${result.droppedBytes} earlier bytes of output not kept` : ""}): ${result.tail.slice(-1000)}`);
      return { state: "FAILED", error: result.timedOut ? "安裝逾時（10 分鐘）" : `安裝失敗（exit ${result.code}）` };
    }
    const serviceId = `provider_${provider}`;
    logger.log?.(`[PROVIDER SDK] ${provider} installed; restarting ${serviceId}`);
    addLine("安裝完成，重新啟動行情來源 ...");
    const restart = await supervisor.restart(serviceId, "provider SDK installed")
      .catch((error) => ({ ok: false, error: String(error?.message || error) }));   /* not an error: recorded -- ok is false, logged right below */
    if (restart?.ok === false) {
      logger.error?.(`[PROVIDER SDK] ${serviceId} restart after install failed: ${restart.error || JSON.stringify(restart)}`);
      return { state: "INSTALLED", restart: { ok: false, error: restart.error || "未知原因" },
        error: `已安裝，但重新啟動行情來源失敗：${restart.error || "未知原因"}；請重新啟動 App` };
    }
    return { state: "INSTALLED", restart: { ok: true } };
  }

  /** Starts an install; answers at once with the job, whose progress and outcome status() reports. */
  function install(provider) {
    if (!PROVIDERS[provider]) return { ok: false, http: 400, error: "UNKNOWN_PROVIDER" };
    if (!isPackaged) return { ok: false, http: 409, error: "SOURCE_CHECKOUT", message: "原始碼版請在開發環境用 pip 安裝 SDK" };
    if (job?.state === "RUNNING") return { ok: false, http: 409, error: "INSTALL_RUNNING", message: `正在安裝 ${job.provider}，請稍候`, job: snapshot() };
    job = { job_id: crypto.randomUUID(), provider, state: "RUNNING", started_at: now(), finished_at: null, lines: [], error: null, restart: null };
    const current = job;
    void execute(provider)
      .catch((error) => {
        logger.error?.(`[PROVIDER SDK] ${provider} install crashed`, error);
        return { state: "FAILED", error: `安裝失敗：${error?.message || error}` };
      })
      .then((outcome) => { Object.assign(current, { error: null, restart: null, ...outcome, finished_at: now() }); });
    return { ok: true, job: snapshot() };
  }

  /** Full shutdown: a running install is ended -- its whole process tree, pip included -- and waited for:
   * a pip left writing the SDK folder after Health exits would race the next start. Answers the receipt. */
  async function stop() {
    if (!installer) return { ok: true, running: false };
    const pid = installer.pid;
    const exited = await killTree(pid);
    if (!exited) logger.error?.(`[PROVIDER SDK] the install (pid ${pid}) did not exit at shutdown`);
    return { ok: exited, running: true, pid, exited };
  }

  return { status, install, stop, job: snapshot, PROVIDERS };
}

module.exports = { createProviderSdkJob, PROVIDERS };
