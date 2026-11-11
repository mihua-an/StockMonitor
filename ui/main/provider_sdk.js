"use strict";

// 設定 → 券商帳號 → 券商 SDK, Electron's side. Health installs the SDK and restarts the provider
// (health/provider_sdk_job.js); Electron starts that job and relays its progress lines to the settings page until it
// ends. It never runs the installer or touches a service itself.

const POLL_MS = 1000;
// A progress read that fails is asked again later each time, up to this gap: Health may be restarting.
const MAX_RETRY_MS = 10000;
const MAX_WAIT_MS = 15 * 60 * 1000;

function createProviderSdk({ controllerClient, logger = console, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  clock = () => Date.now() }) {
  /** { canInstall, reason, probeError, installing, providers: { shioaji: { installed }, futu: { installed } } } */
  async function status() {
    const payload = await controllerClient.getProviderSdk();
    return {
      canInstall: Boolean(payload?.can_install),
      reason: payload?.reason || null,
      probeError: payload?.probe_error || null,
      installing: payload?.job?.state === "RUNNING" ? payload.job.provider : null,
      providers: payload?.providers || {},
    };
  }

  // Starts the install in Health and follows its job until it ends. Following stops -- the job itself goes on in
  // Health -- when `signal` aborts (the asking window is gone) or `isClosing()` turns true (the App closes).
  async function install(provider, { onLine = () => {}, signal = null, isClosing = () => false } = {}) {
    const started = await controllerClient.installProviderSdk(provider);
    if (!started?.ok) {
      logger.warn?.(`[PROVIDER SDK] ${provider} install refused: ${started?.error || "no answer"}`);
      return { ok: false, provider, error: started?.message || started?.error || "Health 未接受安裝要求" };
    }
    const jobId = started.job.job_id;
    let lastSeq = 0;
    const relay = (job) => {
      for (const line of job?.lines || []) if (line.seq > lastSeq) { lastSeq = line.seq; onLine(line.text); }
    };
    relay(started.job);
    const deadline = clock() + MAX_WAIT_MS;
    let wait = POLL_MS;
    let failures = 0;
    while (clock() < deadline) {
      await sleep(wait);
      if (signal?.aborted || isClosing()) {
        const why = signal?.aborted ? String(signal.reason?.message || signal.reason || "aborted") : "the App is closing";
        logger.warn?.(`[PROVIDER SDK] stopped following install job ${jobId}: ${why}; the install goes on in Health`);
        return { ok: false, provider, error: "已停止追蹤安裝進度（安裝仍在 Health 進行）", following: "stopped" };
      }
      let job;
      try { job = (await controllerClient.getProviderSdkJob())?.job; }
      catch (error) {
        failures += 1;
        wait = Math.min(wait * 2, MAX_RETRY_MS);
        logger.warn?.(`[PROVIDER SDK] reading the install progress failed (${failures} in a row; next try in ${wait} ms)`, error);
        continue;
      }
      failures = 0;
      wait = POLL_MS;
      if (!job || job.job_id !== jobId) {
        logger.error?.(`[PROVIDER SDK] install job ${jobId} is gone from Health (Health restarted?)`);
        return { ok: false, provider, error: "安裝工作中斷（Health 已重新啟動），請再試一次" };
      }
      relay(job);
      if (job.state === "RUNNING") continue;
      return { ok: job.state === "INSTALLED", provider, restarted: job.restart?.ok === true, error: job.error || null };
    }
    logger.error?.(`[PROVIDER SDK] install job ${jobId} did not finish in ${MAX_WAIT_MS / 60000} min`);
    return { ok: false, provider, error: "安裝逾時" };
  }

  return { status, install };
}

module.exports = { createProviderSdk };
