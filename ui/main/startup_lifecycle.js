"use strict";

const { sourceSettings } = require("../../config/js/source_settings");

const VALID_STATES = new Set([
  "STARTING",
  "WINDOW_CREATED",
  "DAEMON_CHECKING",
  "BACKEND_STARTING",
  "BACKEND_WAITING",
  "BACKEND_READY",
  "BACKEND_FAILED",
  "RUNNING",
  "SHUTTING_DOWN",
]);

// What the provider startup rows wait for in the realtime API's /api/diagnostics/heartbeat
// (api/services/quote_api.py). tests/test_quote_api_heartbeat_contract.py runs these on the payload Python serves.
const HEARTBEAT_READY = Object.freeze({
  shioajiAttached: (payload) => payload?.stream?.attached === true || payload?.stream?.client_lease_attached === true,
  liveIngressUp: (payload) => payload?.live_ingress?.running === true || payload?.live_ingress?.ready === true,
  futuAttached: (payload) => payload?.moomoo?.attached === true,
});

// Registry-driven startup units. The UI derives [x/N] from this registry, so N
// is never hard-coded. Keep each unit small enough that a slow/failing startup
// can be attributed to one subsystem instead of one large "page loading" step.
const STARTUP_UNITS = Object.freeze([
  // display_ms: how long a row may show "running" before it is shown degraded (the work goes on in the background);
  // wait_ms: the whole wall-clock budget of the unit's own wait, every request included. moomoo_attach waits in two
  // halves: while the daemon is ensured, and once more after.
  { id: "electron_ready", label: "Electron 應用程式", phase: "CORE", owner: "main", required: true, depends_on: [] },
  { id: "window_shell", label: "建立主視窗", phase: "CORE", owner: "main", required: true, depends_on: ["electron_ready"] },
  { id: "fastapi_process", label: "Python Process 建立", phase: "BACKEND", owner: "main", required: true, depends_on: ["window_shell"] },
  { id: "fastapi_listener", label: "FastAPI 啟動並監聽", phase: "BACKEND", owner: "main", required: true, depends_on: ["fastapi_process"] },
  { id: "fastapi_api", label: "Heartbeat 驗證", phase: "BACKEND", owner: "main", required: true, depends_on: ["fastapi_listener"] },

  { id: "product_catalog_parquet", label: "本地商品目錄 Parquet", phase: "CATALOG", owner: "main", required: true, depends_on: ["fastapi_api"] },
  { id: "product_search_index", label: "商品搜尋記憶體索引", phase: "CATALOG", owner: "main", required: true, depends_on: ["product_catalog_parquet"] },

  { id: "shioaji_daemon", label: "Shioaji Market Daemon", phase: "SHIOAJI", source: "shioaji", owner: "main", required: false, depends_on: ["fastapi_api"], display_ms: 12000 },
  { id: "shioaji_attach", label: "Shioaji Client Attach", phase: "SHIOAJI", source: "shioaji", owner: "main", required: false, depends_on: ["fastapi_api", "shioaji_daemon"], display_ms: 8000, wait_ms: 8000 },
  { id: "live_ingress", label: "Live Ingress", phase: "SHIOAJI", source: "shioaji", owner: "main", required: false, depends_on: ["fastapi_api", "shioaji_daemon"], display_ms: 8000, wait_ms: 8000 },

  { id: "moomoo_daemon", label: "Futu Market Daemon", phase: "FUTU", source: "futu", owner: "main", required: false, depends_on: ["fastapi_api"], display_ms: 8000 },
  { id: "moomoo_attach", label: "Futu Client Attach", phase: "FUTU", source: "futu", owner: "main", required: false, depends_on: ["fastapi_api", "moomoo_daemon"], display_ms: 8000, wait_ms: 20000 },
  { id: "futu_catalog_refresh", label: "Futu US + CC 商品主檔更新", phase: "FUTU", source: "futu", owner: "main", required: false, depends_on: ["moomoo_attach", "product_search_index"], display_ms: 3000, wait_ms: 12000 },

  { id: "renderer_core", label: "Renderer Core", phase: "UI", owner: "renderer", required: true, depends_on: ["window_shell"] },
  { id: "realtime_ws", label: "Realtime WebSocket", phase: "UI", owner: "renderer", required: false, depends_on: ["fastapi_api", "renderer_core"] },
  { id: "realtime_html", label: "即時報價頁面結構", phase: "UI", owner: "renderer", required: true, depends_on: ["fastapi_api", "renderer_core"] },
  { id: "dashboard_components", label: "即時報價元件掛載", phase: "UI", owner: "renderer", required: true, depends_on: ["realtime_html"] },
  { id: "taiwan_products", label: "Shioaji 自選商品載入", phase: "SHIOAJI", source: "shioaji", owner: "renderer", required: true, depends_on: ["dashboard_components"] },
  { id: "moomoo_products", label: "Futu 自選商品載入", phase: "FUTU", source: "futu", owner: "renderer", required: false, depends_on: ["fastapi_api", "renderer_core"] },
  { id: "futu_product_cache", label: "Futu 行情快取", phase: "FUTU", source: "futu", owner: "renderer", required: false, depends_on: ["moomoo_products"] },
  { id: "first_paint", label: "即時報價首屏 Render", phase: "UI", owner: "renderer", required: true, depends_on: ["taiwan_products"] },
]);

const SETTLED_STEP_STATES = new Set(["done", "degraded", "failed", "skipped"]);
// Between two checks of a startup wait.
const WAIT_POLL_MS = 250;
// One heartbeat request at most; a wait's last request gets only what is left of its budget.
const HEARTBEAT_REQUEST_MS = 800;

function isoNow(nowMs) {
  return new Date(nowMs).toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

class StartupCoordinator {
  constructor({ electronPid, now = () => Date.now(), logger = console, units = STARTUP_UNITS, sources = sourceSettings } = {}) {
    this.sources = sources;
    this._now = now;
    this._logger = logger;
    this._startedMs = now();
    this._listeners = new Set();
    this._units = Object.freeze((Array.isArray(units) ? units : STARTUP_UNITS).map((unit) => ({
      ...unit,
      depends_on: Object.freeze([...(unit.depends_on || [])]),
    })));
    this._validateRegistry();
    this._stepMap = new Map(this._units.map((definition, index) => [definition.id, {
      ...definition,
      index: index + 1,
      status: index === 0 ? "running" : "pending",
      started_at: index === 0 ? isoNow(this._startedMs) : null,
      finished_at: null,
      duration_ms: null,
      detail: null,
    }]));
    this._state = {
      electron_pid: Number(electronPid) || null,
      state: "STARTING",
      startup_started_at: isoNow(this._startedMs),
      window_created_at: null,
      daemon_checked_at: null,
      backend_spawned_at: null,
      backend_ready_at: null,
      renderer_ready_at: null,
      last_startup_progress_at: isoNow(this._startedMs),
      last_detail: null,
    };
    this._runStarted = false;
    this._stopped = false;
    for (const step of this._stepMap.values()) {
      // A unit that belongs to a source names it (STARTUP_UNITS `source`); a disabled source's units are skipped.
      if (step.source && !this.sources.enabled_sources.includes(step.source)) {
        step.sourceDisabled = true;
        const nowText = isoNow(this._now());
        step.status = "skipped";
        step.started_at = nowText;
        step.finished_at = nowText;
        step.duration_ms = 0;
        step.detail = "來源未啟用";
      }
    }
  }

  _validateRegistry() {
    const ids = new Set();
    for (const unit of this._units) {
      const id = String(unit?.id || "").trim();
      if (!id) throw new Error("startup unit id is required");
      if (ids.has(id)) throw new Error(`duplicate startup unit id: ${id}`);
      ids.add(id);
    }
    for (const unit of this._units) {
      for (const dependency of unit.depends_on || []) {
        if (!ids.has(dependency)) throw new Error(`startup unit ${unit.id} depends on unknown unit ${dependency}`);
      }
      if (unit.source !== undefined && !Object.hasOwn(this.sources.sources || {}, unit.source)) {
        throw new Error(`startup unit ${unit.id} belongs to unknown source ${unit.source}`);
      }
    }
  }

  _computedSteps(currentMs = this._now()) {
    return this._units.map(({ id }) => {
      const step = this._stepMap.get(id);
      let elapsed = step.duration_ms;
      if (step.status === "running" && step.started_at) {
        elapsed = Math.max(0, currentMs - Date.parse(step.started_at));
      }
      return { ...step, elapsed_ms: elapsed == null ? 0 : Math.round(elapsed) };
    });
  }

  snapshot() {
    const currentMs = this._now();
    const steps = this._computedSteps(currentMs);
    const blockingFailure = steps.some((step) => step.required && step.status === "failed");
    const progressComplete = steps.every((step) => SETTLED_STEP_STATES.has(step.status));
    return {
      ...this._state,
      startup_elapsed_ms: Math.max(0, Math.round(currentMs - this._startedMs)),
      startup_steps_total: steps.length,
      startup_steps_completed: steps.filter((step) => SETTLED_STEP_STATES.has(step.status)).length,
      startup_progress_complete: progressComplete,
      startup_blocking_failure: blockingFailure,
      steps,
    };
  }

  _emit() {
    const value = this.snapshot();
    for (const listener of [...this._listeners]) {
      try { listener(value); } catch (error) { console.warn("[STARTUP progress listener] failed", error); }
    }
    return value;
  }

  _step(id) {
    const step = this._stepMap.get(String(id || ""));
    if (!step) throw new Error(`unknown startup unit: ${id}`);
    return step;
  }

  startStep(id, detail = null) {
    const step = this._step(id);
    if (SETTLED_STEP_STATES.has(step.status)) return this._emit();
    if (!step.started_at) step.started_at = isoNow(this._now());
    step.status = "running";
    step.detail = detail == null ? step.detail : String(detail);
    step.finished_at = null;
    step.duration_ms = null;
    return this._emit();
  }

  updateStep(id, detail = null) {
    const step = this._step(id);
    if (detail != null) step.detail = String(detail);
    this._state.last_startup_progress_at = isoNow(this._now());
    this._state.last_detail = detail == null ? this._state.last_detail : String(detail);
    return this._emit();
  }

  _settleStep(id, status, detail = null) {
    const step = this._step(id);
    // Mirrors startStep's no-op guard: once a step reaches a terminal state it
    // must stay terminal for this coordinator's lifetime. Without this guard, a
    // renderer session that restarts (e.g. after "close UI only") can re-run its
    // startup gate and clobber an already-"done" step with a stale started_at
    // hours old, producing bogus multi-hour duration_ms and a misleading failure.
    // One exception: degraded -> done. The background recovery watches (e.g. the Futu attach watch) report a
    // late success through completeStep, and the guard swallowed it, so the row stayed degraded.
    const recovered = step.status === "degraded" && status === "done";
    if (SETTLED_STEP_STATES.has(step.status) && !recovered) return this._emit();
    if (step.sourceDisabled && status !== "skipped") return this._emit();
    const currentMs = this._now();
    if (!step.started_at) step.started_at = isoNow(currentMs);
    step.status = status;
    step.finished_at = isoNow(currentMs);
    step.duration_ms = Math.max(0, currentMs - Date.parse(step.started_at));
    step.detail = detail == null ? step.detail : String(detail);
    return this._emit();
  }

  completeStep(id, detail = null) { return this._settleStep(id, "done", detail); }
  degradeStep(id, detail = null) { return this._settleStep(id, "degraded", detail); }
  failStep(id, detail = null) { return this._settleStep(id, "failed", detail); }
  skipStep(id, detail = null) { return this._settleStep(id, "skipped", detail); }

  markProgress(nextState, milestone = null, detail = null) {
    if (!VALID_STATES.has(nextState)) throw new Error(`invalid startup state: ${nextState}`);
    const currentMs = this._now();
    this._state.state = nextState;
    this._state.last_startup_progress_at = isoNow(currentMs);
    this._state.last_detail = detail == null ? null : String(detail);
    if (milestone && Object.prototype.hasOwnProperty.call(this._state, milestone)) {
      this._state[milestone] = isoNow(currentMs);
    }
    this._logger.log?.(`[STARTUP] state=${nextState}${detail ? ` detail=${detail}` : ""}`);
    return this._emit();
  }

  markMilestone(name) {
    if (!Object.prototype.hasOwnProperty.call(this._state, name)) {
      throw new Error(`unknown startup milestone: ${name}`);
    }
    const currentMs = this._now();
    this._state[name] = isoNow(currentMs);
    this._state.last_startup_progress_at = isoNow(currentMs);
    return this._emit();
  }

  subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  stop() {
    this._stopped = true;
    this._listeners.clear();
  }

  reportRendererStep({ step_id: stepId, action, detail = null } = {}) {
    const step = this._step(stepId);
    if (step.owner !== "renderer") {
      throw new Error(`startup unit ${stepId} is owned by ${step.owner}, renderer may not mutate it`);
    }
    const normalized = String(action || "").toLowerCase();
    if (normalized === "start") return this.startStep(stepId, detail);
    if (normalized === "progress") return this.updateStep(stepId, detail);
    if (normalized === "complete") return this.completeStep(stepId, detail);
    if (normalized === "degraded") return this.degradeStep(stepId, detail);
    if (normalized === "failed") return this.failStep(stepId, detail);
    if (normalized === "skipped") return this.skipStep(stepId, detail);
    throw new Error(`invalid renderer startup unit action: ${action}`);
  }

  // Waits until `predicate(remainingMs)` is true, for at most `budgetMs` of wall-clock time: the predicate's own
  // request is bounded by what is left, and no new check starts past the deadline.
  async waitUntil(predicate, { budgetMs, intervalMs = WAIT_POLL_MS } = {}) {
    const deadline = this._now() + Math.max(0, Number(budgetMs) || 0);
    for (;;) {
      if (this._stopped) return false;
      const remaining = deadline - this._now();
      if (remaining <= 0) return false;
      if (await predicate(remaining)) return true;
      if (this._stopped || deadline - this._now() <= intervalMs) return false;
      await sleep(intervalMs);
    }
  }

  // The unit's wait budget (STARTUP_UNITS wait_ms).
  _waitBudget(stepId) {
    const budget = Number(this._step(stepId).wait_ms);
    if (!(budget > 0)) throw new Error(`startup unit ${stepId} has no wait_ms budget`);
    return budget;
  }

  async waitForHeartbeat(fetchHeartbeat, predicate, { budgetMs, intervalMs = WAIT_POLL_MS } = {}) {
    return this.waitUntil(async (remaining) => {
      try {
        const { response, payload } = await fetchHeartbeat(Math.min(HEARTBEAT_REQUEST_MS, remaining));
        return Boolean(response?.ok && predicate(payload || {}));
      } catch (error) { console.warn("[STARTUP heartbeat predicate read] failed", error); return false; }
    }, { budgetMs, intervalMs });
  }

  async runUnit(id, executor, {
    detail = null,
    successDetail = null,
    failure = "failed",
    failureDetail = null,
  } = {}) {
    if (this._stopped) return { ok: false, stopped: true };
    this.startStep(id, detail);
    try {
      const result = await executor();
      this.completeStep(id, typeof successDetail === "function" ? successDetail(result) : successDetail);
      return { ok: true, result };
    } catch (error) {
      this._logger.error?.(`[STARTUP][${id}] failed: ${error?.stack || error?.message || error}`);
      const message = failureDetail || String(error?.message || error);
      if (failure === "degraded") this.degradeStep(id, message);
      else this.failStep(id, message);
      return { ok: false, error };
    }
  }

  // The unit's display threshold (STARTUP_UNITS display_ms): past it a running row is shown degraded with `detail`.
  _displayTimeout(stepId, detail) {
    const timeoutMs = Number(this._step(stepId).display_ms);
    if (!(timeoutMs > 0)) throw new Error(`startup unit ${stepId} has no display_ms threshold`);
    return setTimeout(() => {
      const step = this._step(stepId);
      if (step.status === "running") this.degradeStep(stepId, detail);
    }, timeoutMs);
  }

  _launchBackground(label, runner) {
    return Promise.resolve()
      .then(runner)
      .catch((error) => {
        this._logger.error?.(`[STARTUP][${label}] ${error?.stack || error?.message || error}`);
        return { ok: false, error };
      });
  }

  _bindRendererCompletion(windowRef, onRendererReady = null) {
    const webContents = windowRef?.webContents;
    if (!webContents?.once) return;
    this.startStep("renderer_core", "等待 renderer did-finish-load");
    webContents.once("did-finish-load", () => {
      this.markMilestone("renderer_ready_at");
      this.updateStep("renderer_core", "Renderer shell 已載入，初始化核心模組中");
      try { onRendererReady?.(); } catch (error) {
        this._logger.warn?.(`[STARTUP] renderer ready callback failed: ${error?.message || error}`);
      }
    });
  }

  _startShioajiDaemonUnit({
    ensureMarketDaemon,
    previousShutdownHandoff,
    markStartupTrace,
    markStartupMetric,
  }) {
    if (!this.sources.enabled_sources.includes("shioaji")) return Promise.resolve({ ok: true, skipped: true });
    return this._launchBackground("shioaji-daemon", async () => {
      this.startStep("shioaji_daemon", "檢查既有 daemon 或啟動新 instance");
      const displayTimeout = this._displayTimeout("shioaji_daemon", "背景繼續啟動，不阻塞主介面");
      const startedAt = typeof performance !== "undefined" ? performance.now() : this._now();
      markStartupTrace("DAEMON_PROBE_START");
      try {
        const daemonResult = await ensureMarketDaemon();
        this.markMilestone("daemon_checked_at");
        markStartupTrace("DAEMON_PROBE_RESULT", {
          action: daemonResult.action || daemonResult.decision || "",
          pid: daemonResult.health?.daemon_pid || null,
          instance_id: daemonResult.health?.daemon_instance_id || null,
          warm_handoff_reused: Boolean(
            previousShutdownHandoff?.clean
            && previousShutdownHandoff?.daemon_instance_id
            && previousShutdownHandoff.daemon_instance_id === daemonResult.health?.daemon_instance_id
          ),
        });
        clearTimeout(displayTimeout);
        this.completeStep("shioaji_daemon", `pid=${daemonResult.health?.daemon_pid || "?"}`);
        markStartupMetric("market_daemon_ready", startedAt, {
          action: daemonResult.action,
          pid: daemonResult.health?.daemon_pid || null,
          instance_id: daemonResult.health?.daemon_instance_id || null,
        });
        return { ok: true, result: daemonResult };
      } catch (error) {
        clearTimeout(displayTimeout);
        this.degradeStep("shioaji_daemon", String(error?.message || error));
        this.degradeStep("shioaji_attach", "Shioaji Market Daemon 尚未可用");
        this.degradeStep("live_ingress", "Shioaji Market Daemon 尚未可用");
        this._logger.error?.(`[MARKET DAEMON] startup/attach failed: ${error.message}`);
        markStartupTrace("DAEMON_PROBE_FAILED", { error: String(error?.message || error) });
        return { ok: false, error };
      }
    });
  }

  _startShioajiRuntimeUnits({ daemonStartupPromise, fetchBackendHeartbeat }) {
    if (!this.sources.enabled_sources.includes("shioaji")) return Promise.resolve({ ok: true, skipped: true });
    return this._launchBackground("shioaji-runtime-units", async () => {
      // The daemon discovery/recovery lane is optional and may legitimately stay
      // busy while a stale singleton owner finishes shutdown. Never leave the
      // attach/canonical rows in PENDING behind that promise: PENDING units keep
      // the startup overlay open even after shioaji_daemon has degraded to a
      // background task. Start both lightweight heartbeat checks immediately.
      const attachPromise = this._launchBackground("shioaji-attach", async () => {
        this.startStep("shioaji_attach", "等待 FastAPI client lease / stream attach");
        const timeout = this._displayTimeout("shioaji_attach", "背景持續連線，不阻塞主介面");
        const attached = await this.waitForHeartbeat(
          fetchBackendHeartbeat,
          HEARTBEAT_READY.shioajiAttached,
          { budgetMs: this._waitBudget("shioaji_attach") },
        );
        clearTimeout(timeout);
        if (attached) this.completeStep("shioaji_attach");
        else this.degradeStep("shioaji_attach", "FastAPI 尚未連上 Shioaji stream，背景重試中");
        return attached;
      });

      const canonicalPromise = this._launchBackground("live-ingress", async () => {
        this.startStep("live_ingress", "等待 Live Ingress 連上 Market Runtime");
        const timeout = this._displayTimeout("live_ingress", "Live Ingress 背景啟動，不阻塞主介面");
        const ready = await this.waitForHeartbeat(
          fetchBackendHeartbeat,
          HEARTBEAT_READY.liveIngressUp,
          { budgetMs: this._waitBudget("live_ingress") },
        );
        clearTimeout(timeout);
        if (ready) this.completeStep("live_ingress");
        else this.degradeStep("live_ingress", "Live Ingress 尚未回報 ready，背景持續初始化");
        return ready;
      });

      const runtimeChecksPromise = Promise.all([attachPromise, canonicalPromise]);

      void Promise.resolve(daemonStartupPromise).then((daemonStartup) => {
        if (daemonStartup?.ok) return;
        for (const stepId of ["shioaji_attach", "live_ingress"]) {
          const step = this._step(stepId);
          if (step.status === "running") this.degradeStep(stepId, "Shioaji Market Daemon 尚未可用；背景恢復中");
        }
      });

      const [attached, canonicalReady] = await runtimeChecksPromise;
      return { ok: Boolean(attached && canonicalReady), attached, canonicalReady };
    });
  }

  _startMoomooUnits({
    ensureMoomooDaemon,
    fetchBackendHeartbeat,
    markStartupTrace,
  }) {
    if (!this.sources.enabled_sources.includes("futu")) return Promise.resolve({ ok: true, skipped: true });
    return this._launchBackground("moomoo-units", async () => {
      this.startStep("moomoo_daemon", "檢查既有 daemon 或啟動新 instance");
      // Client attach is an independent observable state. Start watching it at
      // the same time as daemon discovery so a slow/incompatible-daemon probe
      // cannot leave the optional startup row pending for tens of seconds.
      this.startStep("moomoo_attach", "等待 FastAPI client attach");
      const daemonTimeout = this._displayTimeout("moomoo_daemon", "背景繼續啟動，不阻塞主介面");
      const attachTimeout = this._displayTimeout("moomoo_attach", "背景持續連線，不阻塞主介面");
      const attachBudget = this._waitBudget("moomoo_attach") / 2;
      const initialAttachProbe = this.waitForHeartbeat(
        fetchBackendHeartbeat,
        HEARTBEAT_READY.futuAttached,
        { budgetMs: attachBudget },
      ).then((attached) => {
        if (attached) {
          clearTimeout(attachTimeout);
          this.completeStep("moomoo_attach");
        }
        return attached;
      });
      markStartupTrace("MOOMOO_DAEMON_PROBE_START_AFTER_FASTAPI_READY");
      let result;
      try {
        result = await ensureMoomooDaemon();
        markStartupTrace("MOOMOO_DAEMON_PROBE_RESULT", {
          action: result.action || result.decision || "",
          pid: result.health?.daemon_pid || null,
          instance_id: result.health?.daemon_instance_id || null,
        });
        clearTimeout(daemonTimeout);
        this.completeStep("moomoo_daemon", `pid=${result.health?.daemon_pid || "?"}`);
      } catch (error) {
        clearTimeout(daemonTimeout);
        clearTimeout(attachTimeout);
        this.degradeStep("moomoo_daemon", String(error?.message || error));
        this.degradeStep("moomoo_attach", "Futu Market Daemon 尚未可用");
        this._logger.error?.(`[MOOMOO DAEMON] background startup failed: ${error.message}`);
        markStartupTrace("MOOMOO_DAEMON_PROBE_FAILED", { error: String(error?.message || error) });
        return { ok: false, error };
      }

      try {
        // The first probe may have elapsed while daemon discovery was still
        // running. Give the freshly ensured daemon one bounded attach window.
        let attached = await initialAttachProbe;
        if (!attached) {
          attached = await this.waitForHeartbeat(
            fetchBackendHeartbeat,
            HEARTBEAT_READY.futuAttached,
            { budgetMs: attachBudget },
          );
        }
        clearTimeout(attachTimeout);
        if (attached) this.completeStep("moomoo_attach");
        // Startup projects what Health and the API report; it runs no recovery watch of its own -- the
        // provider's reconnect is the provider's, and 連線診斷 shows the live state.
        else this.degradeStep("moomoo_attach", "FastAPI 尚未連上 Moomoo（啟動期間未完成）");
        return { ok: attached, result };
      } finally {
        clearTimeout(attachTimeout);
      }
    });
  }

  _startCatalogUnits({
    loadProductCatalogIndex,
    refreshFutuCatalog,
    reloadProductCatalogIndex,
    fetchBackendHeartbeat,
  }) {
    return this._launchBackground("product-catalog-units", async () => {
      this.startStep("product_catalog_parquet", "讀取/重建 var/data/reference/product_catalog.parquet");
      this.startStep("product_search_index", "等待本地 Parquet 商品目錄");
      let local;
      try {
        local = await loadProductCatalogIndex();
        this.completeStep("product_catalog_parquet", `${local?.status?.file || "product_catalog.parquet"}`);
        this.completeStep("product_search_index", `${local?.count || 0} 檔商品`);
      } catch (error) {
        this.failStep("product_catalog_parquet", String(error?.message || error));
        this.failStep("product_search_index", "本地商品索引建立失敗");
        this.degradeStep("futu_catalog_refresh", "本地商品索引失敗");
        return { ok: false, error };
      }

      const providerRefresh = async (stepId, providerLabel, heartbeatPredicate, refreshFn) => {
        if (this._step(stepId).sourceDisabled) return { ok: true, skipped: true };
        this.startStep(stepId, `等待 ${providerLabel} 連線後背景更新`);
        const displayTimeout = this._displayTimeout(stepId, "使用本地 Parquet；供應商主檔背景更新中");
        const attached = await this.waitForHeartbeat(fetchBackendHeartbeat, heartbeatPredicate, { budgetMs: this._waitBudget(stepId) });
        if (!attached) {
          clearTimeout(displayTimeout);
          this.degradeStep(stepId, `${providerLabel} 尚未 attach；保留本地主檔`);
          return { ok: false, skipped: true };
        }
        try {
          const result = await refreshFn();
          clearTimeout(displayTimeout);
          const warnings = Array.isArray(result?.warnings) ? result.warnings.filter(Boolean) : [];
          if (result?.ok === false) {
            this.degradeStep(stepId, result.error || result.errors?.[0] || `${providerLabel} 更新失敗`);
          } else if (warnings.length) {
            this.degradeStep(stepId, `${Number(result?.count || 0)} 檔；${warnings[0]}`);
          } else {
            this.completeStep(stepId, `${Number(result?.count || 0)} 檔`);
          }
          return result;
        } catch (error) {
          clearTimeout(displayTimeout);
          this.degradeStep(stepId, String(error?.message || error));
          return { ok: false, error };
        }
      };

      // Futu's master is asked for once OpenD is attached; search stays usable from local Parquet meanwhile.
      // Shioaji's is written by the provider's login (its contracts exist only after it), and the catalog this
      // copy follows rebuilds on that write's notice -- nothing here asks for it.
      const futu = await providerRefresh("futu_catalog_refresh", "Futu", HEARTBEAT_READY.futuAttached, refreshFutuCatalog);
      try { await reloadProductCatalogIndex(); } catch (error) {
        this._logger.warn?.(`[PRODUCT CATALOG] post-refresh reload failed: ${error?.message || error}`);
      }
      return { ok: Boolean(futu?.ok), futu };
    });
  }

  _settleRendererForBackendFailure() {
    this.failStep("product_catalog_parquet", "FastAPI 未就緒，無法載入本地商品目錄");
    this.skipStep("product_search_index", "前置 FastAPI 失敗");
    this.degradeStep("futu_catalog_refresh", "前置 FastAPI 失敗");
    this.degradeStep("realtime_ws", "FastAPI 未就緒，略過 WebSocket");
    this.failStep("realtime_html", "FastAPI 未就緒，無法載入即時報價");
    this.skipStep("dashboard_components", "前置 FastAPI 失敗");
    this.skipStep("taiwan_products", "前置 FastAPI 失敗");
    this.skipStep("moomoo_products", "前置 FastAPI 失敗");
    this.skipStep("futu_product_cache", "前置 FastAPI 失敗");
    this.skipStep("first_paint", "前置 FastAPI 失敗");
  }

  async run({
    applyStartupTestDelay = async () => {},
    createWindow,
    onRendererReady,
    startPythonBackend,
    getBackendPid = () => null,
    getBackendReadinessFailure = () => ({}),
    getBackendProbe = () => ({}),
    fetchBackendReadiness = async () => ({ response: { ok: false }, payload: null }),
    ensureMarketDaemon,
    fetchBackendHeartbeat,
    ensureMoomooDaemon,
    loadProductCatalogIndex = async () => ({ count: 0, status: {} }),
    reloadProductCatalogIndex = async () => ({ count: 0, status: {} }),
    refreshFutuCatalog = async () => ({ ok: false, error: "not configured" }),
    onBackendReady,
    onBackendFailed,
    previousShutdownHandoff = null,
    markStartupTrace = () => {},
    markStartupMetric = () => {},
    runAutomatedStartupAcceptance = async () => {},
    electronProcessStartedAt = 0,
  } = {}) {
    if (this._runStarted) throw new Error("StartupCoordinator.run() may only execute once");
    this._runStarted = true;

    this.completeStep("electron_ready");
    this.markProgress("STARTING", null, "primary app ready");
    await applyStartupTestDelay("STARTUP_TEST_CREATE_WINDOW_DELAY_MS", "createWindow");

    if (!(await this._runWindowShell({ createWindow, onRendererReady }))) return { ok: false, backendReady: false };
    if (!(await this._runBackendProcess({ startPythonBackend, getBackendPid, getBackendReadinessFailure }))) {
      await onBackendFailed?.();
      return { ok: false, backendReady: false, daemonStartupPromise: Promise.resolve({ ok: false }) };
    }
    const backendWaitStartedAt = this._clock();
    // Provider daemons are checked only after the Backend listener and FastAPI
    // readiness contract are valid. Electron remains the only startup authority.
    markStartupTrace("MARKET_DAEMONS_START_DEFERRED", { until: "FASTAPI_READY" });
    this._completeBackendListener(getBackendProbe);
    if (!(await this._verifyBackendApi(fetchBackendReadiness))) {
      await onBackendFailed?.();
      return { ok: false, backendReady: false, daemonStartupPromise: Promise.resolve({ ok: false, skipped: true }) };
    }

    const { daemonStartupPromise, moomooStartupPromise } = this._startProviderDaemons({
      ensureMarketDaemon, ensureMoomooDaemon, fetchBackendHeartbeat, previousShutdownHandoff, markStartupTrace, markStartupMetric,
    });
    this.markProgress("BACKEND_READY", "backend_ready_at");
    markStartupMetric("fastapi_ready_detected", electronProcessStartedAt);
    markStartupMetric("backend_wait", backendWaitStartedAt);
    await onBackendReady?.();
    this.markProgress("RUNNING", null, "FastAPI ready; startup units continue independently");
    void runAutomatedStartupAcceptance();
    this._fanOutAfterBackendReady({
      daemonStartupPromise, loadProductCatalogIndex, refreshFutuCatalog, reloadProductCatalogIndex,
      fetchBackendHeartbeat,
    });
    void moomooStartupPromise;

    return { ok: true, backendReady: true, daemonStartupPromise, moomooStartupPromise };
  }

  _clock() {
    return typeof performance !== "undefined" ? performance.now() : this._now();
  }

  // Without a window there is nothing to show the startup state in: the failure goes to the App's startup error
  // boundary (logged, error dialog) instead of an ordinary { ok: false } result.
  async _runWindowShell({ createWindow, onRendererReady }) {
    const windowUnit = await this.runUnit("window_shell", async () => {
      const windowRef = createWindow();
      this.markProgress("WINDOW_CREATED", "window_created_at");
      this._bindRendererCompletion(windowRef, onRendererReady);
      return windowRef;
    });
    if (!windowUnit.ok && !windowUnit.stopped) {
      throw new Error(`主視窗建立失敗：${String(windowUnit.error?.message || windowUnit.error)}`);
    }
    return windowUnit.ok;
  }

  // The FastAPI process: spawned or reused. false = it could not be started (every dependent step is settled).
  async _runBackendProcess({ startPythonBackend, getBackendPid, getBackendReadinessFailure }) {
    this.startStep("fastapi_process", "建立 Python backend process");
    this.markProgress("BACKEND_STARTING", null, "preflighting port 8000 and spawning FastAPI backend");
    try {
      const backendStart = await startPythonBackend();
      const backendAction = String(backendStart?.action || "spawn").toLowerCase();
      this.completeStep(
        "fastapi_process",
        `${backendAction === "reuse" ? "沿用" : "建立"} pid=${getBackendPid() || backendStart?.pid || "unknown"}`,
      );
    } catch (error) {
      const backendFailure = getBackendReadinessFailure?.() || {};
      this.failStep("fastapi_process", backendFailure.detail || String(error?.message || error));
      this.skipStep("fastapi_listener", "Python process 未建立");
      this.skipStep("fastapi_api", "FastAPI listener 未建立");
      this._settleRendererForBackendFailure();
      this.markProgress("BACKEND_FAILED", null, "FastAPI process launch failed");
      return false;
    }
    this.startStep("fastapi_listener", "等待 /api/diagnostics/readiness");
    this.markProgress("BACKEND_WAITING", "backend_spawned_at", `pid=${getBackendPid() || "unknown"}`);
    return true;
  }

  _completeBackendListener(getBackendProbe) {
    const probe = getBackendProbe?.() || {};
    this.completeStep(
      "fastapi_listener",
      `wait=${Math.round(Number(probe.waitMs || 0))}ms probe=${Math.round(Number(probe.readinessRttMs || 0))}ms attempts=${Number(probe.probeCount || 0)}`
    );
  }

  // The listener answers the readiness contract. false = it does not (every dependent step is settled).
  async _verifyBackendApi(fetchBackendReadiness) {
    this.startStep("fastapi_api", "再次驗證已在線 listener RTT");
    const heartbeatStartedAt = this._clock();
    try {
      const { response, payload } = await fetchBackendReadiness();
      if (!response?.ok || payload?.ok !== true) throw new Error(`HTTP ${response?.status || "unreachable"}`);
      const heartbeatMs = Math.max(0, this._clock() - heartbeatStartedAt);
      this.completeStep("fastapi_api", `RTT=${Math.round(heartbeatMs)}ms`);
      return true;
    } catch (error) {
      this.failStep("fastapi_api", `已監聽但 Heartbeat 驗證失敗：${error?.message || error}`);
      this._settleRendererForBackendFailure();
      this.markProgress("BACKEND_FAILED", null, "FastAPI heartbeat verification failed");
      return false;
    }
  }

  _startProviderDaemons({ ensureMarketDaemon, ensureMoomooDaemon, fetchBackendHeartbeat, previousShutdownHandoff, markStartupTrace,
    markStartupMetric }) {
    const daemonStartupPromise = this._startShioajiDaemonUnit({
      ensureMarketDaemon,
      previousShutdownHandoff,
      markStartupTrace,
      markStartupMetric,
    });
    const moomooStartupPromise = this._startMoomooUnits({
      ensureMoomooDaemon,
      fetchBackendHeartbeat,
      markStartupTrace,
    });
    markStartupTrace("MARKET_DAEMONS_START_AFTER_FASTAPI_READY", {
      shioaji_enabled: this.sources.enabled_sources.includes("shioaji"),
      futu_enabled: this.sources.enabled_sources.includes("futu"),
    });
    return { daemonStartupPromise, moomooStartupPromise };
  }

  _fanOutAfterBackendReady({ daemonStartupPromise, loadProductCatalogIndex, refreshFutuCatalog,
    reloadProductCatalogIndex, fetchBackendHeartbeat }) {
    // Local product catalog is loaded once into Electron memory. Provider
    // refresh lanes fan out in parallel and never block search from the local
    // Parquet snapshot.
    void this._startCatalogUnits({
      loadProductCatalogIndex,
      refreshFutuCatalog,
      reloadProductCatalogIndex,
      fetchBackendHeartbeat,
    });
    // Once FastAPI is ready, data-plane units fan out. Each unit owns its own
    // timeout/status so one slow subsystem does not serialize the rest.
    void this._startShioajiRuntimeUnits({
      daemonStartupPromise,
      fetchBackendHeartbeat,
    });
  }
}

module.exports = { StartupCoordinator, STARTUP_UNITS, HEARTBEAT_READY };
