// 帳務 配對回放's presenter: the panel under the pair's row -- two rows of three cards, 走勢資訊｜買賣報價｜成交明細 and
// 技術分析｜價量｜大單流向 (使用者 11-03) -- drawn by the replay itself (not 歷史回放's components), and the play bar
// under them. The cards' frames are drawn once with the panel; a frame writes only what the replay changed into
// them (morphInto), from Market Runtime's replay view of the stock and the day's 加權 / 產業指數 levels
// (pair_replay_session.js). It installs itself as the session's presenter when it loads.
import { morphInto } from "../../core/dom_morph.js";
import { ComponentHost } from "../../core/component_host.js";
import { componentRegistry } from "../../core/component_registry.js";
import { renderUnifiedBigOrderInOut } from "../../core/big_order_flow.js";
import { normalizeRustTradeFlow } from "../../market_data/realtime_market_math.js";
import { displayQuote } from "../../core/auction_price.js";
import { MarketPriceColorPolicy, TradeSideColorPolicy, signedValueClass } from "../../core/market_color_policy.js";
import { $, escapeHtml, formatQuantity } from "../../core/utility.js";
import { clockOfSecond, taipeiSecondOfDay } from "../history/timeline.js";
import { profitClass } from "./account_format.js";
import { actualAccountReplayState } from "./account_state.js";
import {
  REPLAY_KBAR_MINUTES, REPLAY_MINUTES, replayBook, replayKBars, replayLevelText, replayMinuteBars, replayMinuteOf,
  replayMinuteText, replayOverlayAt, replayPosition, replayQuote, replayTape,
  replayTradeSpan,
} from "./pair_replay_model.js";
import {
  installPairReplayPresenter, pairEntrySecond, pairReplayContext, pairReplaySecond, pairReplayStatus, pairReplayView, playPairReplay,
  seekPairReplay, setPairReplaySpeed, stopPairReplay,
} from "./pair_replay_session.js";

const REPLAY_SPEEDS = [1, 2, 5, 10];
// 09:00 .. 13:30: the bar before Market Runtime has said the recording's span.
const DAY_FIRST_SECOND = 9 * 3600;
const DAY_LAST_SECOND = 13 * 3600 + 30 * 60;
// ‹ › move a minute.
const STEP_SECONDS = 60;
// The charts' drawing box (stretched to the card): the line's top / bottom margin, and the band at the bottom of the
// 走勢 chart the 買 / 賣 marks sit on (no line is drawn into it, so a mark never covers one).
const W = 600, H = 190, PAD = 12, MARK_BAND = 30;
// The K chart: candles from PAD to K_PRICE_BOTTOM, the volume bars from K_VOLUME_TOP to K_VOLUME_BOTTOM.
const K_PRICE_BOTTOM = 132, K_VOLUME_TOP = 146, K_VOLUME_BOTTOM = 188;

const xOf = (minute) => minute / (REPLAY_MINUTES - 1) * W;
const fixed = (value) => Number(value.toFixed(1));

/** The row a replay opened from 個股數據 (`stockStats`) or 每日明細 (`pairs`) sits under (scrolled to after it opens);
 * 當沖分析's origins are daytrade_replay_host.js's own. */
export function actualReplayRowSelector(pairId, origin) {
  const escaped = CSS.escape(String(pairId ?? ""));
  if (origin === "stockStats") return `tr[data-stock-replay-id="${escaped}"]`;
  if (origin === "pairs") return `.account-pair-detail-row [data-pair-id="${escaped}"]`;
  throw new Error(`no replay row selector for origin ${origin}`);
}

// ---------------------------------------------------------------------------------------------------- the panel

const AXIS_HTML = `<div class="pair-replay-axis"><span>09:00</span><span>11:15</span><span>13:30</span></div>`;

function noteHtml(text, { busy = false, alert = false } = {}) {
  return `<div class="pair-replay-note"${alert ? ' role="alert"' : ""}>${busy ? '<span class="loading-spinner" aria-hidden="true"></span>' : ""}${escapeHtml(text)}</div>`;
}

function cardHtml(title, aside, body) {
  return `<div class="pair-replay-card"><div class="pair-replay-title"><span>${escapeHtml(title)}</span>${aside}</div>${body}</div>`;
}

function playBarHtml() {
  const state = actualAccountReplayState;
  const speeds = REPLAY_SPEEDS.map((speed) => `<button type="button" class="${Number(state.speed || 1) === speed ? "is-active" : ""}" data-replay-speed="${speed}">${speed}x</button>`).join("");
  return `<div class="replay-bar">
    <div class="replay-bar-transport"><button id="actualPairReplayPrev" type="button" aria-label="上一分鐘">‹</button><button id="actualPairReplayPlay" class="is-play" type="button">${state.playing ? "暫停" : "播放"}</button><button id="actualPairReplayNext" type="button" aria-label="下一分鐘">›</button><button id="actualPairReplayReset" type="button" aria-label="回到進場">↺</button></div>
    <b class="replay-bar-now" id="actualPairReplayTime">${escapeHtml(state.clock || "--:--:--")}</b>
    <div class="replay-bar-track"><span id="actualPairReplayStart">09:00</span><input id="actualPairReplayRange" type="range" min="${DAY_FIRST_SECOND}" max="${DAY_LAST_SECOND}" step="1" value="${pairEntrySecond() ?? DAY_FIRST_SECOND}" aria-label="回放時間"><span id="actualPairReplayEnd">13:30</span></div>
    <div class="replay-bar-speed">${speeds}</div>
  </div>`;
}

/** The panel under the pair's row: the six cards' frames (their contents are each frame's) and the play bar. */
export function replayPanelHtml(pair) {
  const minutes = actualAccountReplayState.kbarMinutes;
  const switches = REPLAY_KBAR_MINUTES.map((size) => `<button type="button" class="${size === minutes ? "is-active" : ""}" data-replay-kbar="${size}" aria-pressed="${size === minutes}">${size}分</button>`).join("");
  const plot = (slot, extra = "") => `<div class="pair-replay-plot${extra}" data-replay-${slot}></div>${AXIS_HTML}`;
  const cards = [
    cardHtml("走勢資訊", `<span class="pair-replay-legend" data-replay-legend></span>`, plot("overlay")),
    cardHtml("買賣報價", `<span class="pair-replay-quote" data-replay-quote></span>`,
      `<div class="pair-replay-book-host" data-replay-book></div><div class="pair-replay-position" data-replay-position></div>`),
    cardHtml("成交明細", `<span class="pair-replay-volume">總量 <b data-replay-volume>--</b> 張</span>`, `<div class="pair-replay-tape" data-replay-tape></div>`),
    cardHtml("技術分析", `<span class="expand-picker" role="group">${switches}</span>`,
      `<div class="pair-replay-ohlc" data-replay-ohlc></div><div class="pair-replay-plot is-probe" data-replay-kplot><div class="pair-replay-kline" data-replay-kline></div><span class="pair-replay-hover" data-replay-khover hidden></span></div>${AXIS_HTML}`),
    cardHtml("價量", "", `<div class="pair-replay-fill" data-replay-price-flow></div>`),
    cardHtml("大單流向", "", `<div class="pair-replay-fill"><div class="trade-flow"><div class="big-order-content" data-replay-flow></div></div></div>`),
  ].join("");
  return `<div class="pair-replay" data-pair-replay-panel data-pair-replay-pair="${escapeHtml(String(pair?.id ?? ""))}">`
    + `<div class="pair-replay-grid">${cards}</div>${playBarHtml()}</div>`;
}

// ---------------------------------------------------------------------------------------------------- the cards

function holdRectHtml(span) {
  const from = xOf(span.entryMinute);
  return `<rect class="pair-replay-hold" x="${fixed(from)}" y="0" width="${fixed(Math.max(2, xOf(span.exitMinute) - from))}" height="${H}"/>`;
}

function tradeMarkHtml(minute, buy) {
  return `<span class="pair-replay-mark ${buy ? "is-buy" : "is-sell"}" style="left:${(minute / (REPLAY_MINUTES - 1) * 100).toFixed(2)}%">${buy ? "買" : "賣"}</span>`;
}

function cursorHtml(minute) {
  const x = fixed(xOf(minute));
  return `<line class="pair-replay-cursor" x1="${x}" x2="${x}" y1="0" y2="${H}"/>`;
}

function polylineOf(series, y, className) {
  const points = series.map((value, minute) => (value === null ? "" : `${fixed(xOf(minute))},${y(value)}`)).filter(Boolean).join(" ");
  return points ? `<polyline class="pair-replay-line ${className}" points="${points}"/>` : "";
}

function svg(content) {
  return `<svg class="pair-replay-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${content}</svg>`;
}

/** 走勢資訊: the three lines' change from their own 昨收 on one axis (0% dashed), the held span, the cursor and the
 * 買 / 賣 marks; the legend says each one's level, change and change in percent (or why an index has no line). */
function renderOverlay(panel, frame) {
  const { overlay, span, minute } = frame;
  const y = (pct) => fixed(PAD + (overlay.range - pct) / (2 * overlay.range) * (H - PAD - MARK_BAND));
  // The stock's line is red above its 昨收 and green below (the same line twice, each clipped at the 0% level, so the
  // colour changes where it crosses); the indexes keep their own colours.
  const zero = y(0);
  const clips = `<defs><clipPath id="pairReplayAbove"><rect x="0" y="0" width="${W}" height="${zero}"/></clipPath>`
    + `<clipPath id="pairReplayBelow"><rect x="0" y="${zero}" width="${W}" height="${H - zero}"/></clipPath></defs>`;
  const lines = overlay.lines.filter((line) => line.drawn).map((line) => (line.key === "stock"
    ? polylineOf(line.pct, y, "is-stock-up").replace("<polyline", '<polyline clip-path="url(#pairReplayAbove)"')
      + polylineOf(line.pct, y, "is-stock-down").replace("<polyline", '<polyline clip-path="url(#pairReplayBelow)"')
    : polylineOf(line.pct, y, `is-${line.key}`))).join("");
  morphInto(panel.querySelector("[data-replay-overlay]"),
    svg(`${clips}${holdRectHtml(span)}<line class="pair-replay-ref" x1="0" x2="${W}" y1="${zero}" y2="${zero}"/>${cursorHtml(minute)}${lines}`)
    + tradeMarkHtml(span.entryMinute, span.long) + tradeMarkHtml(span.exitMinute, !span.long));
  // 股號 漲跌幅, 產業指數 漲跌幅 (使用者 11-03): short enough for a third of the panel. The stock has no colour dot
  // (its line is red / green by 昨收); 加權 is the faint line without a label.
  const label = { stock: frame.pair.code, industry: "產業指數" };
  const legend = ["stock", "industry"].map((key) => overlay.lines.find((line) => line.key === key)).map((line) => `<span class="pair-replay-legend-item is-${line.key}">`
    + `${line.key === "stock" ? "" : '<i aria-hidden="true"></i>'}${escapeHtml(label[line.key])}`
    + ` <span class="${line.quote.toneClass}">${escapeHtml(line.note ? "--" : line.quote.pctText || "--")}</span></span>`).join("");
  morphInto(panel.querySelector("[data-replay-legend]"), legend);
}

function bookHtml(book) {
  if (!book) return noteHtml("尚無五檔");
  const price = (level) => `<span class="pair-replay-book-price ${level.toneClass}${level.isLast ? " is-last" : ""}">${escapeHtml(level.priceText)}</span>`;
  const volume = (level, side) => `<span class="pair-replay-book-vol is-${side}"><i style="width:${level.share}%"></i><span>${escapeHtml(formatQuantity(level.volume))}</span></span>`;
  const rows = book.rows.map((row) => `<div class="pair-replay-book-row">${volume(row.bid, "bid")}${price(row.bid)}${price(row.ask)}${volume(row.ask, "ask")}</div>`).join("");
  return `<div class="pair-replay-book"><div class="pair-replay-book-head"><span>買量</span><span>買價</span><span>賣價</span><span>賣量</span></div>${rows}</div>`
    + `<div class="pair-replay-book-total"><span>${escapeHtml(formatQuantity(book.bidTotal))}</span><div class="pair-replay-book-total-bar"><span class="is-bid" style="width:${book.bidShare}%"></span><span class="is-ask" style="width:${100 - book.bidShare}%"></span></div><span>${escapeHtml(formatQuantity(book.askTotal))}</span></div>`;
}

function positionHtml(pair, position) {
  if (position.perShare === null) return `<span>${escapeHtml(position.state)}</span><span class="pair-replay-position-nums">–</span>`;
  const qty = Number(pair?.qty) || 0;
  const qtyText = qty % 1000 === 0 ? `${formatQuantity(qty / 1000)} 張` : `${formatQuantity(qty)} 股`;
  const pnl = position.pnl === null ? "--"
    : `${Math.abs(Math.round(position.pnl)).toLocaleString("zh-TW")}${position.roi === null ? "" : `(${Math.abs(position.roi * 100).toFixed(2)}%)`}`;
  return `<span>${escapeHtml(position.state)}</span><span class="pair-replay-position-nums"><span>${escapeHtml(qtyText)}</span>`
    + `<span>價差 <span class="${profitClass(position.perShare)}">${Math.abs(position.perShare).toFixed(2)}</span></span>`
    + `<b class="${profitClass(position.pnl)}">${escapeHtml(pnl)}</b></span>`;
}

function quoteHtml(quote) {
  return `<b>${escapeHtml(quote.valueText)}</b><span>${escapeHtml(quote.changeText)}</span><span>${escapeHtml(quote.pctText)}</span>`;
}

function tapeHtml(rows) {
  if (!rows.length) return noteHtml("回放尚未播到成交");
  const body = rows.map((row) => {
    const tone = signedValueClass(row.change);
    return `<div class="pair-replay-tape-row${row.isLarge ? " is-large" : ""}" data-morph-key="${escapeHtml(row.key)}"><span>${escapeHtml(row.time)}</span>`
      + `<span class="${tone}">${escapeHtml(replayLevelText(row.price))}</span>`
      + `<span class="${TradeSideColorPolicy.cssClass(row.tradeSide)}">${escapeHtml(formatQuantity(row.volume))}</span></div>`;
  }).join("");
  return `<div class="pair-replay-tape-head"><span>時間</span><span>成交價</span><span>單量</span></div><div class="pair-replay-tape-rows">${body}</div>`;
}

function kbarSvgHtml(k, prevClose, span, minute) {
  const { scale, bars, size } = k;
  const y = (value) => fixed(PAD + (scale.high - value) / ((scale.high - scale.low) || 1) * (K_PRICE_BOTTOM - PAD));
  const width = size / (REPLAY_MINUTES - 1) * W;
  const reference = prevClose === null ? "" : `<line class="pair-replay-ref" x1="0" x2="${W}" y1="${y(prevClose)}" y2="${y(prevClose)}"/>`;
  const candles = bars.map((bar) => {
    const tone = bar.close > bar.open ? "is-up" : bar.close < bar.open ? "is-down" : "is-flat";
    const center = fixed(xOf(bar.minute + (size - 1) / 2));
    const left = fixed(center - width * 0.32), body = fixed(width * 0.64);
    const volume = fixed(Math.max(1, scale.volume > 0 ? bar.volume / scale.volume * (K_VOLUME_BOTTOM - K_VOLUME_TOP) : 1));
    return `<g class="${tone}"><line class="pair-replay-wick" x1="${center}" x2="${center}" y1="${y(bar.high)}" y2="${y(bar.low)}"/>`
      + `<rect x="${left}" y="${Math.min(y(bar.open), y(bar.close))}" width="${body}" height="${fixed(Math.max(1, Math.abs(y(bar.open) - y(bar.close))))}"/>`
      + `<rect class="pair-replay-kvol" x="${left}" y="${fixed(K_VOLUME_BOTTOM - volume)}" width="${body}" height="${volume}"/></g>`;
  }).join("");
  return svg(`${holdRectHtml(span)}${reference}<line class="pair-replay-sep" x1="0" x2="${W}" y1="${K_VOLUME_TOP - 6}" y2="${K_VOLUME_TOP - 6}"/>${cursorHtml(minute)}${candles}`);
}

// The bar 開高低收量 is shown for: the one the mouse points at, the newest when the mouse is off the chart or past it.
function focusedBar(bars, hoverMinute) {
  if (!bars.length) return null;
  if (hoverMinute === null || hoverMinute === undefined) return bars[bars.length - 1];
  let focus = bars[0];
  for (const bar of bars) if (bar.minute <= hoverMinute) focus = bar;
  return focus;
}

function ohlcHtml(bar, prevClose) {
  if (!bar) return "";
  const value = (price) => `<b class="${MarketPriceColorPolicy.cssClass(price, prevClose)}">${escapeHtml(replayLevelText(price))}</b>`;
  return `<b class="price-flat">${replayMinuteText(bar.minute)}</b><span>開 ${value(bar.open)}</span><span>高 ${value(bar.high)}</span>`
    + `<span>低 ${value(bar.low)}</span><span>收 ${value(bar.close)}</span><span>量 <b class="price-flat">${escapeHtml(formatQuantity(bar.volume))}</b></span>`;
}

function renderKbars(panel, frame) {
  const k = replayKBars(frame.minuteBars, actualAccountReplayState.kbarMinutes, frame.prevClose);
  morphInto(panel.querySelector("[data-replay-kline]"), k.bars.length ? kbarSvgHtml(k, frame.prevClose, frame.span, frame.minute) : noteHtml("回放尚未播到成交"));
  const hover = actualAccountReplayState.kbarHover;
  const bar = focusedBar(k.bars, hover);
  morphInto(panel.querySelector("[data-replay-ohlc]"), ohlcHtml(bar, frame.prevClose));
  const band = panel.querySelector("[data-replay-khover]");
  const show = hover !== null && Boolean(bar);
  if (band.hidden === show) band.hidden = !show;
  if (show) {
    band.style.left = `${((bar.minute - 0.5) / (REPLAY_MINUTES - 1) * 100).toFixed(3)}%`;
    band.style.width = `${(k.size / (REPLAY_MINUTES - 1) * 100).toFixed(3)}%`;
  }
}

/** 大單流向: 即時報價's 進出 view (core/big_order_flow.js) -- 大單控盤, then the 大單 and 小單 net flows over the day,
 * 累計 or 分時 -- from the replay's flow, up to the replay time. */
function renderFlow(host, tradeflow, waiting, wait) {
  const flow = waiting ? null : normalizeRustTradeFlow(tradeflow || {});
  if (!flow?.available) {
    morphInto(host, waiting ? wait : noteHtml("等待 Rust B 計算回放的大單流向"));
    return;
  }
  morphInto(host, renderUnifiedBigOrderInOut(flow, { displayMode: actualAccountReplayState.flowMode }));
}

// ---------------------------------------------------------------------------------------------------- one frame

function positiveOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/** Everything the cards draw at the replay time, from the replay view and the day's indexes. */
function frameNow() {
  const state = actualAccountReplayState;
  const pair = state.pair;
  const view = pairReplayView();
  const summary = view.summary || {};
  const second = pairReplaySecond() ?? pairEntrySecond(pair);
  const minute = Math.max(0, Math.min(REPLAY_MINUTES - 1, replayMinuteOf(clockOfSecond(second ?? DAY_FIRST_SECOND)) ?? 0));
  const prevClose = displayQuote(summary).reference;
  const lastPrice = positiveOrNull(summary.current);
  const indexes = state.indexes || {
    market: { name: "加權", points: [], prevClose: null, note: "讀取中" },
    industry: { name: "產業指數", points: [], prevClose: null, note: "讀取中" },
  };
  return {
    pair, view, minute, second, prevClose, lastPrice,
    span: replayTradeSpan(pair),
    overlay: replayOverlayAt({ stockPoints: view.trend, stockPrevClose: prevClose, stockName: `${pair.code} ${pair.name || ""}`.trim(), indexes, untilMinute: minute }),
    minuteBars: replayMinuteBars(view.trend),
  };
}

export function renderPairReplayFrame() {
  const state = actualAccountReplayState;
  const panel = document.querySelector("[data-pair-replay-panel]");
  if (!panel || !state.pair) return;
  const waiting = state.loadState !== "ready";
  const wait = state.loadState === "error" ? noteHtml(state.loadError, { alert: true }) : noteHtml("回放載入中", { busy: true });
  const frame = frameNow();
  const { view } = frame;

  renderOverlay(panel, frame);
  morphInto(panel.querySelector("[data-replay-quote]"), quoteHtml(replayQuote(frame.lastPrice, frame.prevClose)));
  morphInto(panel.querySelector("[data-replay-book]"), waiting ? wait : bookHtml(replayBook(view.orderbook, frame.lastPrice, frame.prevClose)));
  morphInto(panel.querySelector("[data-replay-position]"), positionHtml(state.pair, replayPosition(state.pair, frame.second, frame.lastPrice)));
  morphInto(panel.querySelector("[data-replay-tape]"), waiting ? wait : tapeHtml(replayTape(view.trades, frame.prevClose, view.tradeflow)));
  const volume = panel.querySelector("[data-replay-volume]");
  const volumeText = Number.isFinite(Number(view.summary?.total_volume)) ? formatQuantity(Number(view.summary.total_volume)) : "--";
  if (volume.textContent !== volumeText) volume.textContent = volumeText;
  renderKbars(panel, frame);
  renderFlow(panel.querySelector("[data-replay-flow]"), view.tradeflow, waiting, wait);
}

// ---------------------------------------------------------------------------------------------------- play bar

let dragging = false;

function renderStatus(status) {
  const state = actualAccountReplayState;
  const range = $("actualPairReplayRange");
  const play = $("actualPairReplayPlay");
  if (play) {
    const text = state.playing ? "暫停" : "播放";
    if (play.textContent !== text) play.textContent = text;
  }
  if (!range || !status) return;
  const first = taipeiSecondOfDay(status.recording?.market_first_ns);
  const last = taipeiSecondOfDay(status.recording?.market_last_ns);
  if (first != null && last != null) {
    range.min = String(first);
    range.max = String(Math.max(first, last));
    const start = $("actualPairReplayStart"), end = $("actualPairReplayEnd");
    if (start) start.textContent = clockOfSecond(first).slice(0, 5);
    if (end) end.textContent = clockOfSecond(last).slice(0, 5);
  }
  const second = pairReplaySecond();
  if (second == null) return;
  if (!dragging) range.value = String(second);
  const time = $("actualPairReplayTime");
  const text = clockOfSecond(second);
  if (time && time.textContent !== text) time.textContent = text;
}

installPairReplayPresenter({ renderFrame: renderPairReplayFrame, renderStatus });

function moveTo(second) {
  stopPairReplay();
  const range = $("actualPairReplayRange");
  const min = Number(range?.min ?? DAY_FIRST_SECOND), max = Number(range?.max ?? DAY_LAST_SECOND);
  const target = Math.max(min, Math.min(max, Math.round(second)));
  if (range) range.value = String(target);
  const time = $("actualPairReplayTime");
  if (time) time.textContent = clockOfSecond(target);
  seekPairReplay(target);
}

// The panel element whose controls are bound (a redraw of the view draws a new one), and 價量's component mounted in
// it: one per panel element, destroyed with it.
let boundPanel = null;
let priceFlowHost = null;

function mountPriceFlow(panel) {
  priceFlowHost?.destroy();
  priceFlowHost = null;
  const element = panel?.querySelector("[data-replay-price-flow]");
  if (!element) return;
  priceFlowHost = new ComponentHost({ host: element, hostId: "account:pair-replay:priceFlow", hostType: "inline", pageId: "account",
    slotId: "replayPriceFlow", context: pairReplayContext, registry: componentRegistry, hydrate: false });
  priceFlowHost.mount("priceFlow");
}

/** After every draw of the view the replay belongs to: binds the new panel's controls and draws its frame. */
export function bindPairReplayControls() {
  const panel = document.querySelector("[data-pair-replay-panel]");
  const state = actualAccountReplayState;
  if (!panel || !state.pairId) {
    boundPanel = null;
    mountPriceFlow(null);
    return;
  }
  if (boundPanel === panel) return;
  boundPanel = panel;
  mountPriceFlow(panel);

  const range = $("actualPairReplayRange");
  range?.addEventListener("pointerdown", () => { dragging = true; });
  range?.addEventListener("pointerup", () => { dragging = false; });
  range?.addEventListener("input", () => moveTo(Number(range.value)));
  const current = () => pairReplaySecond() ?? Number(range?.value ?? DAY_FIRST_SECOND);
  $("actualPairReplayPrev")?.addEventListener("click", () => moveTo(current() - STEP_SECONDS));
  $("actualPairReplayNext")?.addEventListener("click", () => moveTo(current() + STEP_SECONDS));
  $("actualPairReplayReset")?.addEventListener("click", () => {
    const entry = pairEntrySecond();
    if (entry != null) moveTo(entry);
  });
  $("actualPairReplayPlay")?.addEventListener("click", () => {
    if (state.playing) stopPairReplay();
    else void playPairReplay();
  });
  panel.querySelectorAll("[data-replay-speed]").forEach((button) => {
    button.addEventListener("click", () => {
      const speed = Number(button.dataset.replaySpeed || 1);
      if (!REPLAY_SPEEDS.includes(speed)) return;
      setPairReplaySpeed(speed);
      panel.querySelectorAll("[data-replay-speed]").forEach((item) => item.classList.toggle("is-active", item === button));
    });
  });
  panel.querySelectorAll("[data-replay-kbar]").forEach((button) => {
    button.addEventListener("click", () => {
      const minutes = Number(button.dataset.replayKbar);
      if (!REPLAY_KBAR_MINUTES.includes(minutes)) return;
      state.kbarMinutes = minutes;
      state.kbarHover = null;
      panel.querySelectorAll("[data-replay-kbar]").forEach((item) => {
        item.classList.toggle("is-active", item === button);
        item.setAttribute("aria-pressed", String(item === button));
      });
      renderPairReplayFrame();
    });
  });
  // 大單流向's 累計／分時: the buttons are redrawn with the view, so the click is taken on the card.
  panel.querySelector("[data-replay-flow]")?.addEventListener("click", (event) => {
    const mode = event.target.closest("[data-flow-display-mode]")?.dataset.flowDisplayMode;
    if (mode !== "cumulative" && mode !== "minute") return;
    state.flowMode = mode;
    renderPairReplayFrame();
  });
  // 查價: the bar under the mouse (the chunk of the minute it points at); off the chart, the newest bar again.
  const plot = panel.querySelector("[data-replay-kplot]");
  plot?.addEventListener("mousemove", (event) => {
    const box = plot.getBoundingClientRect();
    const minute = Math.round(Math.max(0, Math.min(1, (event.clientX - box.left) / (box.width || 1))) * (REPLAY_MINUTES - 1));
    const chunk = Math.floor(minute / state.kbarMinutes) * state.kbarMinutes;
    if (chunk === state.kbarHover) return;
    state.kbarHover = chunk;
    renderPairReplayFrame();
  });
  plot?.addEventListener("mouseleave", () => {
    state.kbarHover = null;
    renderPairReplayFrame();
  });
  renderStatus(pairReplayStatus());
  renderPairReplayFrame();
}
