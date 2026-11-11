// The candles of one product on one stage: the chart, the timeframe buttons, the focused bar's readout, the earlier local
// days and, past them, the earlier bars the broker holds. 技術分析's pane and its detached window both are this one
// controller around their own layout. Its nodes are found by role under `root`.
import { KLineChart } from "../../core/trend/kline_chart.js";
import { morphInto } from "../../core/dom_morph.js";
import { MarketPriceColorPolicy } from "../../core/market_color_policy.js";
import { escapeHtml, formatQuantity } from "../../core/utility.js";
import { TECHNICAL_TIMEFRAMES as TIMEFRAMES, technicalBars, timeframeResolution } from "./technical_series.js";
import { TechnicalHistory } from "./technical_history.js";

const TIMEFRAME_KEY = "technicalAnalysisTimeframeV1";
const OLDER_POLL_MS = 1000;
const OLDER_TEXT = { running: "下載更早的 K 棒…", quota: "額度額滿，無法下載", failed: "下載失敗" };

export function storedTimeframe() {
  try {
    const value = String(localStorage.getItem(TIMEFRAME_KEY) || "5");
    return TIMEFRAMES.some(([key]) => key === value) ? value : "5";
  } catch (error) { console.warn("[technical analysis: reading the timeframe] failed", error); return "5"; }
}

const BAR_FIELDS = ["key", "trading_date", "open", "high", "low", "close", "volume", "label"];
function sameBars(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    for (const field of BAR_FIELDS) if (a[index][field] !== b[index][field]) return false;
  }
  return true;
}

/** The stage's own nodes: the canvas, the jump to the newest bar and the state of a download. */
export function candleStageHtml() {
  return `<canvas class="technical-analysis-canvas" data-role="ta-canvas"></canvas>`
    + `<button type="button" class="technical-analysis-latest" data-role="ta-latest" aria-label="回到最新" hidden>»</button>`
    + `<div class="technical-analysis-older" data-role="ta-older" role="status" hidden></div>`;
}

function ohlcvHtml(bar, previous, { showDate }) {
  const date = showDate ? `<span class="technical-analysis-date">${escapeHtml(bar?.crosshairLabel ?? bar?.label ?? "--")}</span>` : "";
  if (!bar) return `${date}<span>開 <b>--</b></span><span>高 <b>--</b></span><span>低 <b>--</b></span><span>收 <b>--</b></span><span>量 <b>--</b></span>`;
  const reference = previous?.close ?? bar.open;
  const tone = (value) => MarketPriceColorPolicy.cssClass(value, reference);
  const digits = bar.high >= 1000 ? 0 : 2;
  const cell = (label, value) => `<span>${label} <b class="${tone(value)}">${escapeHtml(value.toFixed(digits))}</b></span>`;
  return `${date}${cell("開", bar.open)}${cell("高", bar.high)}${cell("低", bar.low)}${cell("收", bar.close)}`
    + `<span>量 <b class="technical-analysis-volume">${escapeHtml(formatQuantity(bar.volume))}</b></span>`;
}

export class TechnicalCandles {
  // `service`: context.services.technicalAnalysis. showDate: the readout's date. No 均價: only the trend shows one
  // (decisions.md).
  // smaPeriods: the chart's moving averages (null: its own).
  constructor({ root, stage, service, showDate = false, smaPeriods = null }) {
    this.root = root; this.service = service; this.showDate = showDate;
    this.timeframe = storedTimeframe();
    this.code = ""; this.viewKey = ""; this.date = ""; this.state = null; this.unsubscribeView = null;
    this.history = new TechnicalHistory(service?.history || null);
    this.older = { state: "idle", asked: "", timer: 0, token: 0 };
    this.node = (name) => root.querySelector(`[data-role="${name}"]`);
    this.switches = this.node("ta-timeframe");
    this.onSwitch = (event) => this.#pick(event);
    this.switches?.addEventListener("click", this.onSwitch);
    this.latest = this.node("ta-latest");
    this.chart = new KLineChart(this.node("ta-canvas"), {
      smaPeriods,
      onHover: () => this.#renderOhlcv(),
      onOffsetChange: (offset, { user = false } = {}) => {
        if (this.latest) this.latest.hidden = offset <= 0;
        this.#loadOlderWhenNear();
        if (user) this.#askBrokerAtOldest();
      },
    });
    this.onLatest = () => { this.chart?.jumpToLatest(); if (this.latest) this.latest.hidden = true; };
    this.latest?.addEventListener("click", this.onLatest);
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => { this.chart?.schedule(); this.#loadOlderWhenNear(); });
      this.resizeObserver.observe(stage);
    }
  }

  #pick(event) {
    const button = event.target.closest?.("[data-pick]");
    if (!button || button.dataset.pick === this.timeframe) return;
    this.timeframe = button.dataset.pick;
    for (const item of this.switches.querySelectorAll("[data-pick]")) {
      const active = item === button;
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-pressed", String(active));
    }
    try { localStorage.setItem(TIMEFRAME_KEY, this.timeframe); } catch (error) { console.warn("[technical analysis: saving the timeframe] failed", error); }
    this.chart?.jumpToLatest();
    this.#render();
  }

  /**
   * Bind the candles to the view the code means now. A window can open before the session authority names a trading
   * date: there is nothing to subscribe yet. Called again on every update of what it follows, it binds as soon as the
   * view exists and follows a new trading date too.
   */
  follow(code = this.code) {
    const service = this.service;
    const key = code && service?.key ? service.key(code) : "";
    if (code === this.code && key === this.viewKey && (this.unsubscribeView || !key)) return;
    this.unsubscribeView?.(); this.unsubscribeView = null;
    if (code !== this.code) { this.state = null; this.chart?.jumpToLatest(); this.#resetOlder(); }
    this.code = code; this.viewKey = key;
    this.date = key ? String(service.sessionDate?.(code) || "") : "";
    this.history?.reset(code, this.date);
    // What this follows, readable from the DOM when it shows nothing.
    if (this.root?.dataset) { this.root.dataset.taCode = code; this.root.dataset.taKey = key; }
    this.#render();
    if (!key || !service?.subscribe) return;
    this.unsubscribeView = service.subscribe(code, (state) => {
      if (code !== this.code) return;
      this.state = state || null;
      this.#render();
    }) || null;
    if (!this.unsubscribeView) this.viewKey = "";
  }

  // The chart is given new bars only when this timeframe's bars changed: a 1-minute trend point does not move a
  // 5-minute chart until its bar does. The source (the trend, B's fixed K rows or the day block) is immutable: the same
  // array means the same bars, and a new one is compared bar by bar. A history page is a new series too.
  #render() {
    const state = this.state || {};
    const key = String(this.timeframe);
    const source = timeframeResolution(key) === "day" ? state.day : key === "1" ? state.trend : state.day?.fixed_k?.[`k${key}`];
    if (source === undefined || source !== this.barsSource || key !== this.barsTimeframe || this.history?.version !== this.barsHistory) {
      const today = technicalBars(state, key, this.date);
      this.barsSource = source;
      if (key !== this.barsTimeframe || this.history?.version !== this.barsHistory || !sameBars(today, this.todayBars)) {
        this.barsTimeframe = key;
        this.barsHistory = this.history?.version;
        this.todayBars = today;
        const series = this.history ? this.history.series(key, today) : today;
        this.chart?.setBars(series);
      }
    }
    this.#renderOhlcv();
    this.#loadOlderWhenNear();
  }

  // The next older local page is asked for while less than a screen of bars is held to the left of the view.
  #loadOlderWhenNear() {
    const { chart, history } = this;
    if (!chart || !history || !chart.hasSize() || chart.barsLeftOfView() >= chart.viewCapacity()) return;
    history.loadOlder(this.timeframe).then((added) => {
      if (added && this.history === history) this.#render();
    }).catch((error) => console.warn("[technical analysis: drawing a history page] failed", error));
  }

  #resetOlder() {
    clearTimeout(this.older.timer);
    this.older = { state: "idle", asked: "", timer: 0, token: this.older.token + 1 };
    this.#showOlder();
  }

  #setOlder(state) {
    this.older.state = state;
    this.#showOlder();
  }

  #showOlder() {
    const node = this.node("ta-older");
    if (!node) return;
    const text = OLDER_TEXT[this.older.state] || "";
    if (node.textContent !== text) node.textContent = text;
    node.hidden = !text;
    node.classList.toggle("is-loading", this.older.state === "running");
  }

  /**
   * The user scrolled and the view holds the oldest local bar: the broker is asked for the bars before it. Not while
   * the local pages still have more, not past this timeframe's own retention (what came would be aged away), not for a
   * date already asked about, and never again for a product found to end or while the quota is gone.
   */
  #askBrokerAtOldest() {
    const { chart, history, older } = this;
    const api = this.service?.older;
    if (!api || !chart || !history || !history.code || !history.date) return;
    if (older.state !== "idle" && older.state !== "failed") return;
    if (!history.localExhausted(this.timeframe) || chart.barsLeftOfView() > 0) return;
    const before = history.oldestDate(this.timeframe);
    if (before === older.asked || history.reachedHorizon(this.timeframe, before)) return;
    older.asked = before;
    this.#setOlder("running");
    const token = older.token;
    this.#followOlder(api.request(this.code, before), token, api);
  }

  async #followOlder(answer, token, api) {
    try {
      const status = await answer;
      if (token !== this.older.token) return;
      if (status?.state === "RUNNING") {
        this.older.timer = setTimeout(() => this.#followOlder(api.status(this.code), token, api), OLDER_POLL_MS);
        return;
      }
      await this.#finishOlder(status, token);
    } catch (error) {
      console.warn(`[technical analysis: downloading earlier bars of ${this.code}] failed`, error);
      if (token !== this.older.token) return;
      this.older.asked = "";
      this.#setOlder("failed");
    }
  }

  async #finishOlder(status, token) {
    const state = status?.state;
    if (state === "QUOTA_FULL") { this.#setOlder("quota"); return; }
    if (state === "END") { this.#setOlder("end"); return; }
    if (state === "FAILED") {
      console.warn(`[technical analysis: downloading earlier bars of ${this.code}] failed`, status?.error);
      this.older.asked = "";
      this.#setOlder("failed");
      return;
    }
    const added = status?.end_date ? await this.history.mergeThrough(status.end_date) : false;
    if (token !== this.older.token) return;
    // Nothing new for the chart: `asked` keeps the date, so the same answer is not asked for again.
    if (added) this.older.asked = "";
    this.#setOlder("idle");
    this.#render();
  }

  #renderOhlcv() {
    const node = this.node("ta-ohlcv");
    if (!node || !this.chart) return;
    const bar = this.chart.focusBar();
    const index = bar ? this.chart.bars.indexOf(bar) : -1;
    morphInto(node, ohlcvHtml(bar, index > 0 ? this.chart.bars[index - 1] : null, this));
  }

  resize() { this.chart?.schedule(); }

  destroy() {
    clearTimeout(this.older.timer);
    this.older.token += 1;
    this.unsubscribeView?.(); this.unsubscribeView = null;
    this.resizeObserver?.disconnect(); this.resizeObserver = null;
    this.switches?.removeEventListener("click", this.onSwitch);
    this.latest?.removeEventListener("click", this.onLatest);
    this.history?.reset("", ""); this.history = null;
    this.chart?.destroy(); this.chart = null;
  }
}
