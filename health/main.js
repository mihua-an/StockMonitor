#!/usr/bin/env node
"use strict";

// Health (service_id service_controller): the process-lifecycle, readiness, recovery, config-apply and
// monitoring authority -- docs/system-architecture/00, 04, 06, 07. A plain Node process (packaged: the Electron
// binary with ELECTRON_RUN_AS_NODE=1), started before Electron and independent of any window.
//
// Boot: resolve the effective network config from the local ACTIVE revision (never by asking settings_api), mint
// the per-role market_runtime credentials, start market_runtime first (it recovers its WAL), then the providers,
// Rust B and the seven business APIs in parallel. Health supervises them (bounded automatic restarts), publishes
// one monitoring snapshot for Electron main, and runs the durable shutdown order.

const { writeJsonAtomic } = require("../service/platform/js/atomic_files");
const fs = require("fs");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");

const { loadRuntime } = require("../service/platform/js/launch_runtime.js");
const { userDataDir } = require("../config/js/var_paths.js");
const { ensureDataLayoutVersion } = require("../service/platform/js/data_layout_version.js");
const { sourceEnabled } = require("../config/js/source_settings.js");
const { createDaemonAuthentication, createControllerAuthentication, createClientAuthentication, createManagementAuthentication, providerClientFetch } = require("../service/platform/js/daemon_auth.js");
const { childEnv, pythonServiceThreadDefaults } = require("../service/platform/js/child_env.js");
const { createShutdownHandoffStore } = require("../service/platform/js/shutdown_handoff.js");
const { resolveStartupNetwork, NoValidNetworkRevision } = require("./startup/network_revision.js");
const { pruneOldLogSessions } = require("../service/platform/js/log_session.js");
const { createStartupTimeline } = require("./startup/timeline.js");
const networkConfig = require("../config/js/network_config.js");
const { ConfigRevisionStore, setRemediationEmitter: setConfigStoreRemediation } = require("../config/js/config_revisions.js");
const { applyPendingLocation, advanceBackgroundMove, historicalRoot, storagePaths, locationChangePending, storageMoveStatus } = require("../config/js/storage_settings.js");
const { installStorageUserRegistry } = require("./startup/storage_users");
const { startStorageBackgroundMove } = require("./startup/storage_background_move");
const runtimeCredentials = require("../service/platform/js/runtime_credentials.js");
const { resolveVarPaths } = require("../config/js/var_paths.js");

const { Supervisor, restartSummary } = require("./supervisor.js");
const { PythonServiceHost } = require("./services/python_service_host.js");
const { MarketRuntimeHost, portOpen } = require("./services/market_runtime_host.js");
const { AnalysisRuntimeHost } = require("./services/analysis_runtime_host.js");
const { ShioajiDaemonHost } = require("./services/shioaji_daemon_host.js");
const { FutuDaemonHost } = require("./services/futu_daemon_host.js");
const { createMaterializerJobRunner } = require("./materializer_job_runner.js");
const { createTrainingJobRunner } = require("./training_job_runner.js");
const { jobBinary, pruneJobBinaries } = require("../service/platform/js/native_job_binary.js");
const { createProviderSdkJob } = require("./provider_sdk_job.js");
const { MonitoringCollector } = require("./monitoring/collector.js");
const { ProcessResources } = require("./monitoring/process_resources.js");
const { StorageUsage } = require("./monitoring/storage_usage.js");
const { createControllerHttpApi } = require("./control_api.js");
const { NetworkOperations } = require("./operations.js");
const { processAliveFast } = require("../service/platform/js/process_utils.js");
const { probeTcpPort } = require("../service/platform/js/daemon_connection.js");
const remediationContract = require("../config/js/remediation_contract.js");
const { RemediationLedger } = require("./remediation/ledger.js");

// Two processes: app_api serves settings/history/data center/accounts, realtime_api quotes and the model
// signal path (api/services/app_api.py, realtime_api.py). app_api first: realtime_api reads the settings it owns.
const API_SERVICES = ["app_api", "realtime_api"];

function log(...args) { console.log("[HEALTH]", ...args); }
// Every startup stage, with wall-clock and monotonic times; one structured line once startup is over
// (health/startup/timeline.js).
const timeline = createStartupTimeline();
function warn(...args) { console.warn("[HEALTH]", ...args); }

// One atomic JSON write for every Node owner; this state must survive a power loss.
const atomicWrite = (file, value) => writeJsonAtomic(file, value, { durable: true });

async function main() {
  const startedAt = Date.now();
  timeline.mark("main", { pid: process.pid });
  const resourcesPath = String(process.env.STOCK_MONITOR_RESOURCES_PATH || "").trim() || undefined;
  const isPackaged = Boolean(resourcesPath);
  const userDataPath = isPackaged ? userDataDir({ flavor: "installed", env: process.env }) : undefined;
  const runtime = timeline.stage("load_runtime", () => loadRuntime({ env: process.env, isPackaged, resourcesPath, userDataPath }));
  process.env.STOCK_MONITOR_MANAGED_BY_HEALTH = "1";
  const varPaths = resolveVarPaths({ projectRoot: runtime.projectRoot, env: process.env });
  // The on-disk layout this program reads: recorded on a new VAR_ROOT; data of another version is
  // refused before anything opens it.
  ensureDataLayoutVersion(varPaths.varRoot, { logger: console });
  const configRoot = varPaths.config;
  const manifest = networkConfig.loadManifest(networkConfig.manifestPath(process.env));
  const networkStore = new ConfigRevisionStore(configRoot, "network");
  const bootstrapOperation = NetworkOperations.pendingBootstrap(configRoot);
  // A saved revision that no longer validates never falls back to the defaults: the last good one, recorded
  // below once the ledger is open, or Health does not start.
  let started;
  try {
    started = resolveStartupNetwork({ networkConfig, manifest, store: networkStore, env: process.env,
      saved: bootstrapOperation?.startRevision ?? networkStore.active() });
  } catch (error) {
    if (!(error instanceof NoValidNetworkRevision)) throw error;
    console.error(`[HEALTH] ${error.message}; not starting on the defaults`);
    process.exit(78);
  }
  const effective = started.effective;
  const savedFallback = started.fallback;
  if (savedFallback) warn(`the saved network revision ${savedFallback.invalid_revision} is invalid; starting on the last good revision ${savedFallback.started_on}`);
  if (effective.problems.length) warn(`effective network config problems: ${JSON.stringify(effective.problems)}`);
  // A layer with any problem is refused whole: the endpoints are the defaults, not a half-applied revision.
  if (effective.rejected?.length) warn(`network config layers rejected whole: ${JSON.stringify(effective.rejected)}`);
  // Every process Health starts resolves exactly this revision (never "whatever is active by the time it reads").
  if (effective.revision !== null && effective.revision !== undefined) process.env.STOCK_MONITOR_NETWORK_REVISION = String(effective.revision);
  else delete process.env.STOCK_MONITOR_NETWORK_REVISION;
  log(`starting pid=${process.pid} network revision=${effective.revision ?? "defaults"} root=${runtime.projectRoot}`);
  timeline.mark("network_resolved", { revision: effective.revision ?? null });

  // Role credentials. Each file is minted here (first writer wins); none is exported into process.env, and
  // each child is started with an allowlisted environment carrying only what its role needs:
  //   business API      daemon token (it reads the provider daemons), digests of the client and management tokens
  //   provider daemon   digests of the daemon and management tokens
  //   Rust A/B, materializer, training job: no token in the environment (A/B get their own file by argument)
  // A verifier holds a digest, never the token, so it cannot present that credential to anyone else. Only Health
  // holds the management token: no API can stop another API, no daemon can stop an API.
  const daemonAuth = createDaemonAuthentication({ fs, path, processRef: process });
  const managementAuth = createManagementAuthentication({ fs, path, processRef: process });
  const controllerAuth = createControllerAuthentication({ fs, path, processRef: process });
  const clientAuth = createClientAuthentication({ fs, path, processRef: process });
  // Read at each spawn, not captured at boot: an applied network revision changes STOCK_MONITOR_NETWORK_REVISION.
  const roleEnv = {
    api: () => childEnv(process.env, { STOCK_MONITOR_DAEMON_TOKEN: daemonAuth.token,
      STOCK_MONITOR_CLIENT_TOKEN_SHA256: clientAuth.digest, STOCK_MONITOR_MANAGEMENT_TOKEN_SHA256: managementAuth.digest,
      ...pythonServiceThreadDefaults(process.env) }),
    provider: () => childEnv(process.env, { STOCK_MONITOR_DAEMON_TOKEN_SHA256: daemonAuth.digest,
      STOCK_MONITOR_MANAGEMENT_TOKEN_SHA256: managementAuth.digest, ...pythonServiceThreadDefaults(process.env) }),
    plain: () => childEnv(process.env),
  };
  const providerFetch = providerClientFetch({ daemonAuth, managementAuth });
  const credentialsFile = path.join(varPaths.authRoot, "market_runtime_credentials.json");
  runtimeCredentials.writeCredentialsFile(credentialsFile, process.env);
  const logDir = path.join(varPaths.logs, runtime.logSession || "current");
  const shutdownHandoff = createShutdownHandoffStore(runtime.projectRoot, { logger: console });
  const instanceId = `health-${process.pid}-${startedAt}`;
  timeline.mark("credentials_ready");

  // The remediation ledger (docs/BACKLOG.md) opens before any service starts, and every child learns where it is
  // through the environment it is spawned with: a remediation during startup is recorded like any other.
  const remediationPipe = remediationContract.pipePath({ logsRoot: varPaths.logs });
  process.env[remediationContract.PIPE_ENV] = remediationPipe;
  const remediation = new RemediationLedger({ logsRoot: varPaths.logs, sessionDir: logDir,
    summaryDir: path.join(varPaths.output, "remediation", "daily"), pipePath: remediationPipe,
    writer: { service_id: "service_controller", instance_id: instanceId, pid: process.pid }, logger: console });
  await timeline.stage("remediation_ledger", () => remediation.start(), () => remediation.replay);
  if (savedFallback) {
    remediation.local.emit({ component: "network_config", mechanismId: "network.saved_revision_fallback",
      triggerReason: "active_revision_invalid", outcome: "succeeded", identity: {}, detail: savedFallback });
  }
  // Config writer-lock takeovers are recorded in the same ledger.
  setConfigStoreRemediation(remediation.local);
  log(`remediation ledger ${remediation.stats.listening ? "listening" : "NOT listening"} on ${remediationPipe}`);

  // 設定 → 資料儲存: the raw-history folder (config/js/storage_settings.js). A folder saved since the last start is
  // activated here, before A or the materializer opens the store -- on the same drive by renames, on another by switching
  // to the copy the background has finished -- but only on a full start: an A that survived a Health restart still
  // writes the old folder, which then stays active until the next full start.
  const historicalLocation = () => historicalRoot({ configRoot, dataRoot: varPaths.data });
  const marketRuntime = new MarketRuntimeHost({ isPackaged, resourcesPath, fs, path, projectRoot: runtime.projectRoot, dataRoot: varPaths.data,
    configRoot, logDir, effective, credentialsFile, controllerToken: runtimeCredentials.loadOrCreateToken("controller", process.env),
    env: roleEnv.plain, historicalDir: historicalLocation, remediation: remediation.local,
    // service/market/shared/session_evidence_files.py default_evidence_root: the same rule.
    evidenceRoot: process.env.STOCK_MONITOR_SESSION_EVIDENCE_ROOT || path.join(varPaths.output, "session_evidence"),
    // Windows' shutdown/logoff reaches A alone; the App stops as on the tray's 完整關閉, A last.
    onSessionEnding: (notice) => void graceful(`windows_${notice.event}`) });
  // The folder switches only when every process that reads or writes the store has ended: every
  // such process an earlier Health spawned is in the storage-users registry until that exact process (pid + creation
  // time) is gone -- a closed port is not an exit --; on top of that Market Runtime's port free (an occupied port or an
  // unanswered probe is a live instance), the API and provider-daemon ports free, and no materializer child of an
  // earlier Health alive. Anything unknown keeps the change pending.
  const storageUsersRegistry = installStorageUserRegistry({ file: path.join(varPaths.state, "health", "storage_users.json"), logger: console });
  async function storageUsersAlive() {
    const alive = [...storageUsersRegistry.alive()];
    const probe = await marketRuntime.supervisorProbe().catch((error) => ({ failed: error }));
    if (probe.failed) alive.push(`market_runtime (probe failed: ${probe.failed?.message || probe.failed})`);
    else if (probe.occupied || probe.verified) alive.push("market_runtime");
    for (const sid of [...API_SERVICES, "provider_shioaji", "provider_futu"]) {
      const endpoint = networkConfig.endpoint(effective, sid);
      if (endpoint?.host && endpoint?.port && await portOpen(endpoint.host, Number(endpoint.port))) alive.push(sid);
    }
    const claimed = path.join(varPaths.output, "materialization_jobs", "claimed");
    let owners = [];
    try { owners = fs.readdirSync(claimed).filter((name) => name.endsWith(".owner.json")); }
    catch (error) { /* absent is not an error: no claimed jobs */ if (error?.code !== "ENOENT") alive.push(`materializer (claims unreadable: ${error?.message || error})`); }
    for (const name of owners) {
      let pid = 0;
      try { pid = Number(JSON.parse(fs.readFileSync(path.join(claimed, name), "utf8"))?.child_pid || 0); }
      catch (error) {
        // not an error: recorded -- the reason joins the alive list, which applyPendingStorageLocation() logs
        alive.push(`materializer (${name} unreadable: ${error?.message || error})`);
        continue;
      }
      if (pid > 0 && processAliveFast(pid)) alive.push(`materializer pid ${pid}`);
    }
    return alive;
  }
  let changePending = true;
  try { changePending = locationChangePending({ configRoot }); }
  catch (error) { console.error(`[HEALTH] storage location: ${error?.message || error}; checked as pending`); }
  // The pending change is applied once the control API listens and before start-all; the supervisor holds every service
  // start until it is done. It is short: the long part of a move across drives runs beside the App (below, after
  // start-all). `storageMove`: its progress while it runs (/status/startup), null otherwise.
  let storageMove = null;
  let storageBackgroundMove = null;
  async function applyPendingStorageLocation() {
    const storageUsers = await timeline.stage("storage_users", () => storageUsersAlive(), (users) => ({ alive: users.length }));
    if (storageUsers.length) {
      log(`storage location: ${storageUsers.join(", ")} still running; a pending folder change waits for the next full start`);
      return;
    }
    await timeline.stage("storage_move",
      () => applyPendingLocation({ configRoot, dataRoot: varPaths.data, logger: console, onProgress: (progress) => { storageMove = progress; },
        onRenameRetry: ({ from, to, code, retries, outcome }) => remediation.local.emit({ component: "storage_location", mechanismId: "storage.rename_retry",
          triggerReason: "folder_locked", outcome, identity: {}, detail: { from, to, code, retries } }) }),
      (result) => ({ applied: result.applied, revision: result.revision ?? null, mode: storageMove?.mode ?? null,
        files: storageMove?.files_total ?? null, bytes: storageMove?.bytes_total ?? null, error: result.error ?? null }));
  }
  // The Shioaji security master: Rust B's day features and the training job's feature export read this one path.
  const securityMaster = path.join(varPaths.data, "reference", "shioaji", "security_master.csv");
  // Resolved at each start of B, like historicalDir: applyPendingStorageLocation() may switch the folder after this line.
  const analysisRuntime = new AnalysisRuntimeHost({ isPackaged, resourcesPath, fs, path, projectRoot: runtime.projectRoot, dataRoot: varPaths.data,
    eventsDir: () => storagePaths({ configRoot, dataRoot: varPaths.data }).analysis_events,
    dailySummaryDir: () => storagePaths({ configRoot, dataRoot: varPaths.data }).daily_summary,
    securityMaster, historicalDir: historicalLocation,
    configRoot, logDir, effective, tokenFile: runtimeCredentials.tokenPath("analysis_runtime", process.env), env: roleEnv.plain,
    remediation: remediation.local });
  const apiHosts = Object.fromEntries(API_SERVICES.map((sid) => [sid, new PythonServiceHost({
    serviceId: sid, effective, pythonExecutable: runtime.pythonExecutable, projectRoot: runtime.projectRoot, logDir,
    managementToken: managementAuth.token, env: roleEnv.api, fs, path, remediation: remediation.local,
  })]));

  // Resolved at each use: an applied revision rewrites `effective` in place, and the hosts follow it.
  const providerNet = (sid) => () => networkConfig.endpoint(effective, sid);
  const shioajiEndpoint = providerNet("provider_shioaji");
  const futuEndpoint = providerNet("provider_futu");
  const shioaji = new ShioajiDaemonHost({
    userDataPath, projectRoot: runtime.projectRoot, pythonExecutable: runtime.pythonExecutable, endpoint: shioajiEndpoint,
    expected: { identity: runtime.marketDaemon.identity, protocolVersion: runtime.marketDaemon.protocolVersion, runtimeVersion: runtime.marketDaemon.runtimeVersion },
    enabled: sourceEnabled("shioaji"),
    fetchImpl: providerFetch, env: roleEnv.provider, startupCoordinator: null,
    markStartupTrace: () => {}, remediation: remediation.local, logger: console,
  });
  const futu = new FutuDaemonHost({
    projectRoot: runtime.projectRoot, pythonExecutable: runtime.pythonExecutable, endpoint: futuEndpoint,
    expected: { identity: runtime.moomooDaemon.identity, protocolVersion: runtime.moomooDaemon.protocolVersion, runtimeVersion: runtime.moomooDaemon.runtimeVersion },
    enabled: sourceEnabled("futu"), fetchImpl: providerFetch, env: roleEnv.provider,
    remediation: remediation.local, logger: console,
  });
  const providerHost = (daemon) => ({
    supervisorProbe: () => daemon.supervisorProbe(),
    ensure: () => daemon.ensure(), stop: (reason) => daemon.stop(reason),
    metrics: async () => (await daemon.probe?.(1500)) || null,
  });
  // Read at each probe, not captured at boot: an applied network revision updates the endpoint the panel shows, and
  // the knock must go to that same endpoint. 1 s, not 400 ms: OpenD busy at startup answered late and flapped red.
  const opendHost = { reachable: () => {
    const { host, port } = effective.services.external_futu_opend || {};
    return host && Number(port) ? probeTcpPort(net, Number(port), 1000, host) : Promise.resolve(null);
  } };
  // One-shot B jobs (materialize, training's feature exports) run a copy of B named by its content, so a deploy can
  // replace the release exe while one runs (service/platform/js/native_job_binary.js). The copies no job runs any
  // more go here, before any job starts; one still running (a provider daemon attached from before) is kept.
  const jobBinaryDir = path.join(varPaths.state, "native_jobs");
  try {
    const pruned = pruneJobBinaries({ fs, path, source: analysisRuntime.binaryPath(), dir: jobBinaryDir });
    if (pruned.removed.length || pruned.kept.length || pruned.failed.length) {
      log(`job binary copies: removed=${pruned.removed.length} kept_in_use=${pruned.kept.length}`);
    }
    for (const failure of pruned.failed) warn(`job binary copy ${failure.name} not removed: ${failure.error}`);
  } catch (error) { warn(`job binary copies not pruned: ${error?.message || error}`); }
  const materializerJobs = createMaterializerJobRunner({ projectRoot: runtime.projectRoot, dataRoot: varPaths.data, binaryPath: analysisRuntime.binaryPath(), fs, path, logger: console,
    marketRuntime, env: roleEnv.plain, historicalDir: historicalLocation, configRoot, jobBinaryDir,
    dailySummaryDir: () => storagePaths({ configRoot, dataRoot: varPaths.data }).daily_summary,
    kbarDir: () => storagePaths({ configRoot, dataRoot: varPaths.data }).kbars, remediation: remediation.local });
  // Model training: a process of its own, after the close or on a manual request; never inside an API.
  const trainingJobs = createTrainingJobRunner({ projectRoot: runtime.projectRoot, dataRoot: varPaths.data, pythonExecutable: runtime.pythonExecutable,
    analysisRuntimeBinary: () => jobBinary({ fs, path, source: analysisRuntime.binaryPath(), dir: jobBinaryDir }), securityMaster, logDir, fs, path, logger: console, env: roleEnv.plain, remediation: remediation.local,
    materializerIdle: () => { const p = materializerJobs.probe(); return p.in_flight === 0 && p.pending === 0; } });

  const entries = {
    // `after`: what each service needs READY before it starts (supervisor.startAll). Rust B and the provider daemons
    // feed Market Runtime.
    // app_api needs none of them at startup -- it reaches A per request -- so it does not wait for A's WAL scan
    // (which would hold Electron's "Python Process" step for ~27 s). Nor does realtime_api: it listens first, and its
    // provider clients attach once each daemon's owner record says READY (api/services/quote_api.py). Started after
    // the providers it held the window's API step for their broker logins (~5 s, 2026-10-14).
    market_runtime: { host: marketRuntime, autostart: true, watch: true },
    // Rust B also reads the flow/event rule revisions settings_api (in app_api) owns and seeds on a first start: started
    // before them, it ran under "no rules" and rebuilt the day when r1 appeared.
    analysis_runtime: { host: analysisRuntime, autostart: true, after: ["market_runtime", "app_api"], requires: ["market_runtime", "app_api"], watch: true },
    // The providers follow Rust B: Market Runtime hands unstored events (unlisted stocks, never-stored markets) only to
    // a connected B over the live lane, which nothing re-reads, and B is ready only once A confirmed its subscription.
    // A provider sending before that lost what B would have folded. Order only: a failed B does not hold back the feed.
    provider_shioaji: { host: providerHost(shioaji), autostart: true, after: ["market_runtime", "analysis_runtime"], requires: ["market_runtime"], watch: true, enabled: () => sourceEnabled("shioaji") },
    provider_futu: { host: providerHost(futu), autostart: true, after: ["market_runtime", "analysis_runtime"], requires: ["market_runtime"], watch: true, enabled: () => sourceEnabled("futu") },
    app_api: { host: apiHosts.app_api, autostart: true, watch: true },
    realtime_api: { host: apiHosts.realtime_api, autostart: true, watch: true },
  };
  const supervisor = new Supervisor({ entries, logger: console, remediation: remediation.local,
    budgetFile: path.join(varPaths.state, "health", "restart_budget.json"),
    // Each service's start (spawn or attach -> ready) is a stage of the startup timeline; later restarts are not.
    startupObserver: (sid) => (timeline.result() ? null : timeline.begin(`service:${sid}`)) });
  // Held before the control API listens: a start-all asked of it during the move waits for the move.
  let releaseStarts = null;
  if (changePending) supervisor.holdStarts(new Promise((resolve) => { releaseStarts = resolve; }));
  const collector = new MonitoringCollector({
    services: {
      ...Object.fromEntries(Object.entries(entries).map(([sid, e]) => [sid, { host: e.host, enabled: e.enabled, state: () => supervisor.stateOf(sid), stateReason: () => supervisor.reasonOf(sid) }])),
      external_futu_opend: { host: opendHost },
      service_controller: { host: { supervisorProbe: async () => ({ alive: true, verified: true, pid: process.pid, instance_id: identity().instance_id, config_revision: effective.revision, port: controllerEndpoint.port }) } },
    },
    effective, manifest, configStore: networkStore, resources: new ProcessResources({ remediation: remediation.local }),
    // 連線診斷 儲存空間: what the data root and the raw-history folder hold, and the disk left.
    storage: new StorageUsage({ varRoot: varPaths.varRoot, dataRoot: varPaths.data, storagePaths: () => storagePaths({ configRoot, dataRoot: varPaths.data }),
      moveStatus: () => storageMoveStatus({ configRoot }) }),
    // 連線診斷 記憶體: the training job's and the materializer jobs' processes while they run (user 10-22).
    jobPids: () => ({ training: [trainingJobs.probe().running?.pid], materializer: materializerJobs.childPids() }),
    extraStatus: () => {
      const remediationStatus = remediation.status();
      return { supervisor: supervisor.status(), materializer_jobs: materializerJobs.probe?.() || null,
        training_job: trainingJobs.probe(), remediation: remediationStatus, service_restarts: restartSummary(remediationStatus),
        // 系統拓樸 shows how long this Health has run (user 10-19).
        started_at: new Date(startedAt).toISOString() };
    },
  });

  const controllerEndpoint = networkConfig.endpoint(effective, "service_controller");
  // "Controller answers", "services ready" and "operation finished" are three things: /health says which.
  //   moving_storage     -- the control API answers, the stored history is switching to its new folder (no
  //                         service starts until it is done; /status/startup carries the progress);
  //   starting           -- the control API answers, services are being started;
  //   resuming_operation -- a network operation from before this Health's start is being finished (no new apply);
  //   ready              -- both done.
  let phase = "starting";
  function identity() {
    return { service_id: "service_controller", instance_id: instanceId, pid: process.pid, port: controllerEndpoint.port,
      config_revision: effective.revision ?? null, started_at: new Date(startedAt).toISOString(), uptime_ms: Date.now() - startedAt,
      phase, operation: operations.running?.operation_id || null };
  }

  // Reads of the effective endpoints held until they settle (control API `wait_ms`), released whenever the network
  // operation in progress changes or Health starts handing off.
  const networkWaiters = new Set();
  const networkChanged = () => { for (const release of [...networkWaiters]) release(); };
  const waitNetwork = (ms) => new Promise((resolve) => {
    const release = () => { clearTimeout(timer); networkWaiters.delete(release); resolve(); };
    const timer = setTimeout(release, ms);
    networkWaiters.add(release);
  });
  // Before the control API listens: a pending operation is claimed first, so no apply can start beside its resume.
  const operations = new NetworkOperations({ configRoot, manifest, supervisor, entries, effectiveRef: () => effective,
    hosts: { apiHosts, marketRuntime, analysisRuntime }, restartHealth: (op) => void finishForHandoff(op), instanceId,
    remediation: remediation.local, onRunningChange: networkChanged, logger: console });
  if (bootstrapOperation) operations.claim(bootstrapOperation.operation);
  let shuttingDown = false;
  // `uiEnds`: the UI goes with this shutdown, so its windows stop their live transports before the first service
  // stops -- whoever asked (the UI itself, a tool, a signal, Windows' session end). Only the network handoff keeps the
  // UI, which follows the restarted Health.
  async function announceUiClosing(scope) {
    const ui = await api.announceUiClosing(scope);
    log(`shutdown ${scope}: ui told=${ui.told} answered=${ui.answered} ${ui.ms} ms`);
    return ui;
  }
  async function performShutdown(scope, { uiEnds = true } = {}) {
    if (scope === "ui_only") return { ok: true, scope, retained: Object.keys(entries) };
    if (scope === "ui_backend") {
      // The UI and the business APIs go; market data keeps flowing and accumulating (providers, market_runtime,
      // analysis_runtime stay up under Health). The next UI start attaches to this Health and asks for start-all.
      await announceUiClosing(scope);
      const receipts = {};
      const outcomes = await Promise.allSettled(API_SERVICES.map((n) => supervisor.stop(n, "ui_backend_shutdown")));
      API_SERVICES.forEach((n, i) => {
        receipts[n] = outcomes[i].status === "fulfilled" ? outcomes[i].value : { ok: false, error: String(outcomes[i].reason?.message || outcomes[i].reason) };
      });
      const retained = Object.keys(entries).filter((n) => !API_SERVICES.includes(n));
      logFailedReceipts(scope, receipts, Object.entries(receipts).filter(([, r]) => r?.ok === false).map(([n]) => n));
      return { ok: Object.values(receipts).every((r) => r?.ok !== false), scope, receipts, retained };
    }
    if (scope !== "full") throw new Error("Invalid shutdown scope");
    const started = Date.now();
    // Stopping: a child that ends from here on is not a failure (Windows ends them all at a session end), and the
    // resource sampler is not replaced.
    supervisor.stopping = true;
    storageBackgroundMove?.stop();
    collector.stop();
    if (uiEnds) await announceUiClosing(scope);
    const receipts = {};
    // Each stop's duration is logged: a slow full shutdown names the service it waited on.
    const timedStop = async (n) => {
      const at = Date.now();
      try { return await supervisor.stop(n, "full_shutdown"); } finally { console.log(`[HEALTH] shutdown stop ${n} ${Date.now() - at} ms`); }
    };
    const stage = async (names) => {
      const outcomes = await Promise.allSettled(names.filter((n) => supervisor.enabled(n)).map(timedStop));
      names.filter((n) => supervisor.enabled(n)).forEach((n, i) => {
        receipts[n] = outcomes[i].status === "fulfilled" ? outcomes[i].value : { ok: false, error: String(outcomes[i].reason?.message || outcomes[i].reason) };
      });
    };
    // The APIs go first: they are not on the data path (providers feed Rust A directly), and stopped after the
    // providers their in-flight requests chased the dead daemons -- realtime_api's stop then ran past its 20 s budget
    // (a full shutdown took 28 s instead of ~13 s). Then the sources stop new input; Rust B catches up to the
    // committed head and checkpoints; market_runtime commits the WAL and checkpoints last.
    await stage(API_SERVICES);
    // Not on the data path either: a running training job is ended and reported (`interrupted`), not waited for.
    receipts.provider_sdk = await providerSdk.stop()
      .catch((error) => ({ ok: false, error: String(error?.message || error) })); /* not an error: recorded -- the failed receipt is part of the shutdown result that finish() persists in the shutdown handoff record */
    receipts.training_job = await trainingJobs.stopAndWait()
      .catch((error) => ({ ok: false, error: String(error?.message || error) })); /* not an error: recorded -- the failed receipt is part of the shutdown result that finish() persists in the shutdown handoff record */
    await stage(["provider_shioaji", "provider_futu"]);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const lag = analysisRuntime.latestMetrics?.stream?.lag;
      if (lag === 0 || !analysisRuntime.running()) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await stage(["analysis_runtime"]);
    await stage(["market_runtime"]);
    // Health exits right after this: a materializer still running would outlive it.
    receipts.materializer_jobs = await materializerJobs.stopAndWait()
      .catch((error) => ({ ok: false, error: String(error?.message || error) })); /* not an error: recorded -- the failed receipt is part of the shutdown result that finish() persists in the shutdown handoff record */
    const failed = Object.entries(receipts).filter(([, r]) => r?.ok !== true).map(([n]) => n);
    logFailedReceipts(scope, receipts, failed);
    return { ok: failed.length === 0, scope, receipts, failed_services: failed, duration_ms: Date.now() - started };
  }
  // A shutdown that is not ok names, in the log, each receipt that made it so and why: the reply goes to whoever asked
  // and the handoff record keeps only the latest, so without this an ok=false said nothing of its cause afterwards.
  function logFailedReceipts(scope, receipts, failed) {
    for (const n of failed) {
      const r = receipts[n] || {};
      const why = r.error || r.reason_not_ok || JSON.stringify(r).slice(0, 600);
      warn(`shutdown ${scope}: ${n} not ok: ${String(why).slice(0, 600)}`);
    }
  }

  // 設定 → 券商帳號: the broker SDK install and the provider restart that follows it (provider_sdk_job.js).
  const providerSdk = createProviderSdkJob({ isPackaged, resourcesPath, pythonExecutable: runtime.pythonExecutable, supervisor,
    env: process.env, logger: console });
  const api = createControllerHttpApi({
    host: controllerEndpoint.host, port: controllerEndpoint.port, token: controllerAuth.token, identity, supervisor, collector,
    performShutdown, onFullShutdown: (result) => { void finish(result, "ui_full_shutdown"); }, providerSdk,
    operations: { summary: () => operations.summary(), get: (id) => operations.get(id),
      preview: (body) => operations.preview(body), apply: (body) => operations.apply(body) },
    demandStatus: () => marketRuntime.demandStatus().catch((error) => {
      warn(`market_runtime demand.status failed: ${error?.message || error}`);
      return { error: String(error?.message || error) };
    }),
    storageMove: () => storageMove,
    // Electron main renews this while the monitoring page is visible (07 section 1): resources/metrics detail is
    // collected only then; the basic probes and the snapshot keep running regardless.
    // Effective while no network operation is open and Health is not handing off: the services are started (or
    // being started) on exactly these endpoints. An operation being applied or resumed may still move them (a
    // candidate that fails rolls back), and Electron does not publish them meanwhile.
    network: () => ({ revision: effective.revision ?? null, health_instance_id: instanceId, renderer: networkConfig.rendererProjection(effective),
      controller: { host: controllerEndpoint.host, port: controllerEndpoint.port },
      phase, operation: operations.running?.operation_id || null, effective: !operations.running && !shuttingDown }),
    waitNetwork,
    uiScope: (body) => {
      const detail = body?.monitoring_detail === true;
      // Electron main's own process ids (main first), for 系統 CPU.
      const appProcesses = Array.isArray(body?.app_pids) ? collector.setAppProcesses(body.app_pids) : null;
      if (detail) collector.requestDetail();
      return { monitoring_detail: detail, detail_ttl_ms: 8000, app_processes: appProcesses };
    },
  });
  try {
    await timeline.stage("control_listen", () => api.listen(), () => ({ host: controllerEndpoint.host, port: controllerEndpoint.port }));
  } catch (error) {
    if (bootstrapOperation?.useCandidate) {
      // The candidate's own endpoint cannot be bound: record it and let the bootstrap start the previous revision.
      await NetworkOperations.markCandidateFailed(configRoot, bootstrapOperation.operation, `Health could not bind ${controllerEndpoint.host}:${controllerEndpoint.port}: ${error?.message || error}`);
      console.error(`[HEALTH] candidate endpoint unusable; exiting for bootstrap rollback`);
      process.exit(75);
    }
    throw error;
  }
  atomicWrite(path.join(configRoot, "bootstrap", "health_endpoint.json"), { schema: "stock-monitor-health-endpoint-v1", ...identity(),
    host: controllerEndpoint.host, written_at: new Date().toISOString() });
  log(`control API on ${controllerEndpoint.host}:${controllerEndpoint.port}`);
  collector.start();
  // Expired log sessions go beside the service starts, not in front of them; a failure is recorded and costs nothing
  // else (the next start prunes again).
  void timeline.stage("log_prune", () => pruneOldLogSessions(), (result) => ({ removed: result.removed.length, failed: result.failed }))
    .catch((error) => warn(`log session prune failed: ${error?.message || error}`));

  const crashRecordPath = path.join(varPaths.state, "health", "last_crash.json");
  try {
    const crash = JSON.parse(fs.readFileSync(crashRecordPath, "utf8"));
    warn(`the previous Health ${crash.health_instance} ended on a fatal ${crash.kind} at ${crash.at}: ${String(crash.error).split("\n")[0]}`);
    fs.renameSync(crashRecordPath, `${crashRecordPath}.${Date.now()}.seen`);
  } catch (error) { /* absent is not an error: no crash record: the previous Health did not end on a fatal error */ if (error?.code !== "ENOENT") console.warn("[reading the previous Health crash record] failed", error); }
  const previous = shutdownHandoff.load();
  if (previous && previous.clean !== true) warn("previous exit was not marked clean; market_runtime and analysis_runtime recover from their WAL/checkpoints");
  // Registered before the first await on the services: a SIGTERM during startAll() (up to minutes) would otherwise
  // find no handler, performShutdown would never run and the children and their ports would be left behind.
  process.on("SIGINT", () => void graceful("SIGINT"));
  process.on("SIGTERM", () => void graceful("SIGTERM"));
  // The fatal boundary: an error no owner handled is not absorbed to keep Health "alive" -- it is persisted
  // with this instance's identity and Health exits, so the Electron bootstrap's crash recovery restarts it
  // and the next Health reports what ended this one.
  const fatal = (kind, error) => {
    const record = { schema: "stock-monitor-health-crash-v1", kind, health_instance: instanceId, pid: process.pid, phase,
      operation: operations.running?.operation_id || null, at: new Date().toISOString(),
      error: String(error?.stack || error?.message || error).slice(0, 4000) };
    console.error(`[HEALTH] fatal ${kind}; exiting for the bootstrap's crash recovery`, error);
    try { atomicWrite(crashRecordPath, record); } catch (error) { console.warn("[writing the Health crash record] failed", error); }
    process.exit(70);
  };
  process.on("uncaughtException", (error) => fatal("uncaughtException", error));
  process.on("unhandledRejection", (reason) => fatal("unhandledRejection", reason));
  // An apply interrupted before its commit left candidate services that may still run on the candidate endpoints:
  // they are stopped and proven gone before anything of the revision being restored starts. One not proven
  // gone is not started over -- the operation ends ROLLBACK_FAILED -- rather than two revisions running side by side.
  const fence = bootstrapOperation && !bootstrapOperation.useCandidate ? await operations.fenceInterrupted(bootstrapOperation) : null;
  if (fence && !fence.ok) warn(`interrupted network operation: candidates not proven gone (${fence.unfenced.join(",")}); they are not started`);
  if (changePending) {
    phase = "moving_storage";
    try { await applyPendingStorageLocation(); }
    finally {
      storageMove = null;
      phase = "starting";
      releaseStarts();
    }
  }
  const startup = await timeline.stage("start_all", () => supervisor.startAll("startup", { skip: fence?.unfenced || [] }),
    (results) => Object.fromEntries(Object.entries(results).map(([sid, r]) => [sid, r?.ok === false ? "failed" : (r?.skipped ? "skipped" : "ok")])));
  log(`startup: ${Object.entries(startup).map(([sid, r]) => `${sid}=${r?.ok === false ? "FAILED" : (r?.skipped ? "skipped" : "ok")}`).join(" ")}`);
  // A full shutdown asked for while the services were starting (the control API listens before start_all) already
  // stopped the jobs and is stopping the services: nothing more is started beside it -- no watcher to restart what
  // it stops, no materializer or training job for it to end.
  if (shuttingDown || supervisor.stopping) {
    log("startup finished during a shutdown; the watcher and the jobs are not started");
    timeline.finish("shutting_down");
    return;
  }
  supervisor.watch();
  // Runs the Rust materializer for sealed sessions and forwards WAL retention (B14). The rebuild (c60cdc9) created
  // it but never started it: every job request since then sat in pending/ and nothing reached historical/.
  materializerJobs.start();
  trainingJobs.start();
  // A new folder on another drive is copied beside the running App; the next full start switches to it.
  storageBackgroundMove = startStorageBackgroundMove({ logger: console,
    advance: (options) => advanceBackgroundMove({ configRoot, dataRoot: varPaths.data, logger: console, ...options }) });
  if (bootstrapOperation) {
    phase = "resuming_operation";
    const resumed = await operations.resumeAfterBootstrap(bootstrapOperation);
    // A candidate that did not come up hands over again (to the previous revision): this Health is going away.
    if (resumed.phase === "bootstrap_rollback") { timeline.finish("bootstrap_rollback"); return; }
  }
  phase = "ready";
  timeline.finish("ready");

  async function finish(result, signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdownHandoff.persist({ schema: "stock-monitor-shutdown-handoff-v1", health_pid: process.pid, clean: result?.ok === true, scope: "full",
      signal, duration_ms: result?.duration_ms ?? null, finished_at: new Date().toISOString(), receipts: result?.receipts || null });
    // How long the process still takes after its answer (the next start waits for it to be gone).
    const exitStarted = Date.now();
    await api.close();
    const apiClosedMs = Date.now() - exitStarted;
    await remediation.close(signal || "full_shutdown").catch((error) => warn(`remediation ledger close failed: ${error?.message || error}`));
    removeEndpointRecord();
    log(`shutdown complete ok=${result?.ok === true} duration_ms=${result?.duration_ms ?? "?"} at=${new Date().toISOString()} `
      + `control_api_close_ms=${apiClosedMs} after_answer_ms=${Date.now() - exitStarted}`);
    process.exit(result?.ok === true ? 0 : 1);
  }
  // The endpoint record outlived the process, so the next UI probed a dead (or, during shutdown, a stopping) Health
  // before starting a new one. Removed only while it still names this process.
  function removeEndpointRecord() {
    const recordFile = path.join(configRoot, "bootstrap", "health_endpoint.json");
    try {
      if (Number(JSON.parse(fs.readFileSync(recordFile, "utf8"))?.pid) === process.pid) fs.unlinkSync(recordFile);
    } catch (error) { /* absent is not an error: no record of ours to remove */ if (error?.code !== "ENOENT") console.warn("[removing the Health process record] failed", error); }
  }
  async function finishForHandoff(op) {
    // Health's own endpoint (or settings_api's) changes: the whole App restarts under bootstrap control. The shutdown
    // receipt goes into the operation under its handoff token; an unclean one turns it to bootstrap_rollback first,
    // so the next Health starts the previous revision. Either way this is a planned restart (75).
    if (shuttingDown) return;
    shuttingDown = true;
    networkChanged();
    const result = await performShutdown("full", { uiEnds: false }).catch((error) => {
      warn(`full shutdown for the network handoff failed: ${error?.stack || error?.message || error}`);
      return { ok: false, error: String(error?.message || error) };
    });
    const record = operations.recordHandoff(op, result);
    shutdownHandoff.persist({ schema: "stock-monitor-shutdown-handoff-v1", health_pid: process.pid, clean: result?.ok === true, scope: "full",
      signal: "network_self_apply", operation_id: record.operation_id, candidate_revision: record.candidate_revision,
      finished_at: new Date().toISOString(), receipts: result?.receipts || null });
    await api.close();
    await remediation.close("network_self_apply").catch((error) => warn(`remediation ledger close failed: ${error?.message || error}`));
    removeEndpointRecord();
    process.exit(75);
  }
  async function graceful(signal) {
    // A full shutdown already under way (the tray's, or an earlier signal) is the one that finishes.
    if (shuttingDown || supervisor.stopping) return;
    log(`received ${signal}; full shutdown`);
    const result = await performShutdown("full").catch((error) => {
      warn(`full shutdown on ${signal} failed: ${error?.stack || error?.message || error}`);
      return { ok: false, error: String(error?.message || error) };
    });
    await finish(result, signal);
  }
}

main().catch((error) => {
  timeline.finish("failed", { error: String(error?.message || error).slice(0, 300) });
  console.error("[HEALTH] fatal startup error:", error);
  process.exit(1);
});
