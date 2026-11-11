import { escapeHtml, formatNumber, formatQuantity, volumeUnitLabel } from "./utility.js";
import { renderPanelTabs } from "./panel_tabs.js";
import { signedValueClass } from "./market_color_policy.js";

export const BIG_ORDER_FLOW_VIEWS = Object.freeze([
  { key: "inout", label: "進出" },
  { key: "ratio", label: "買賣比" },
  { key: "price-volume", label: "分時" },
]);

// The recent windows Rust B computes (1/3/5/15/30/60 minutes): there is no 10-minute one.
export const BIG_ORDER_FLOW_WINDOWS = Object.freeze([
  ["60s", "近1分"], ["180s", "近3分"], ["300s", "近5分"],
  ["900s", "近15分"], ["1800s", "近30分"], ["3600s", "近60分"],
]);

/** Rust B's `windows` block ({"1": {flow: {large, small, ...}}, ...}) in the ratio tab's shape ({"60s": {large, small}}).
 *  Without it every recent-window ratio would show the empty 50/50. */
export function bigOrderFlowWindowsFromRust(windowsBlock = {}) {
  const windows = windowsBlock && typeof windowsBlock === "object" ? (windowsBlock.windows || {}) : {};
  const out = {};
  for (const [key] of BIG_ORDER_FLOW_WINDOWS) {
    const flow = windows[String(Number.parseInt(key, 10) / 60)]?.flow;
    if (flow && typeof flow === "object") out[key] = { large: flow.large || {}, small: flow.small || {} };
  }
  return out;
}

const SIZE_ROWS = Object.freeze([["large", "大單"], ["small", "小單"]]);

// The three view keys are the only names: anything else is a caller's contract error, logged, and the first view.
export function normalizeBigOrderFlowView(value) {
  const key = String(value || "");
  if (BIG_ORDER_FLOW_VIEWS.some((item) => item.key === key)) return key;
  console.warn(`[big order flow] unknown view "${key}"; showing "inout" (views: ${BIG_ORDER_FLOW_VIEWS.map((item) => item.key).join(", ")})`);
  return "inout";
}

export function renderBigOrderFlowViewTabs(host, { activeKey = "inout", onSelect = null } = {}) {
  renderPanelTabs(host, {
    tabs: BIG_ORDER_FLOW_VIEWS,
    activeKey: normalizeBigOrderFlowView(activeKey),
    onSelect: (key) => typeof onSelect === "function" && onSelect(normalizeBigOrderFlowView(key)),
    scrollActive: false,
  });
}

export function renderBigOrderSignedCell(value) {
  const number = Number(value || 0);
  return `<b class="${signedValueClass(number)}">${number > 0 ? "+" : ""}${formatQuantity(number)}</b>`;
}

// Volumes are decimal quantities: formatQuantity keeps a fraction instead of rounding it to 0. The unit is the
// instrument's (flow.market), not a fixed 張. The number is the day's net either way; the title says what the chart
// under it draws -- the running total (累計) or each minute's net (分時).
function renderFlowNetSummary(sizeLabel, netValue, unit = "張", mode = "cumulative") {
  const net = Number(netValue || 0);
  const direction = net < 0 ? "賣超" : "買超";
  const signed = `${net > 0 ? "+" : ""}${formatQuantity(net)}`;
  const cls = signedValueClass(net);
  const title = mode === "minute" ? `${sizeLabel}每分鐘買賣超｜全日${direction}` : `${sizeLabel}累計${direction}`;
  return `<span class="flow-net-summary"><span>${escapeHtml(title)}</span><b class="${cls}">${escapeHtml(signed)}</b><span class="flow-net-unit">${escapeHtml(unit)}</span></span>`;
}

// The chart's frame is the session Rust B names (session_open_minute / session_close_minute, its first and last
// trading minute on the axis the series' `minute` is on); without one there is no frame and nothing to draw. Ticks
// are the clock hours inside it, every other hour across a long session (a futures night).
function axisSpec(flow = {}) {
  const start = Number(flow.session_open_minute), end = Number(flow.session_close_minute);
  if (flow.session_open_minute == null || flow.session_close_minute == null || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const step = end - start > 8 * 60 ? 120 : 60;
  const ticks = [];
  for (let minute = Math.ceil(start / 60) * 60; minute <= end; minute += step) {
    ticks.push({ label: String(((minute / 60) % 24 + 24) % 24).padStart(2, "0"), minute });
  }
  return { start, end, ticks };
}

// The plot's width in minutes: axis.end is the last minute that trades, so the plot runs to the end of it (each
// minute is drawn from its start to the next minute's start, and the closing minute keeps its full width).
function plotMinutes(axis) { return Math.max(1, axis.end + 1 - axis.start); }

// A row's place on the axis: B's `minute`, already on the session's axis.
function rowMinute(row) {
  return row?.minute == null || !Number.isFinite(Number(row.minute)) ? null : Number(row.minute);
}

// One 進出 chart: a y axis and an x axis drawn as text, and a plot of bars only. The plot is the one part that
// stretches to the pane (an SVG with preserveAspectRatio="none" over a 1000 x 100 box); its text used to live inside
// it and was stretched with it. The axes are HTML positioned in percent of the plot, so they line up and keep their
// glyphs.
const PLOT_PAD = 6;   // % of the plot height kept free above the highest and below the lowest bar

// One value per minute from the first to the last minute that traded. 累計 holds its total through a minute without
// a trade (the total did not change); 分時 has nothing to draw in such a minute.
function stepMinutes(values, mode) {
  if (!values.length || mode !== "cumulative") return values;
  const out = [];
  let index = 0, value = 0;
  for (let minute = values[0].minute; minute <= values.at(-1).minute; minute += 1) {
    while (index < values.length && values[index].minute <= minute) value = values[index++].value;
    out.push({ minute, value });
  }
  return out;
}

// Each minute is a full minute wide, so neighbouring minutes touch. Consecutive minutes on the same side of zero
// are one closed step outline: separate shapes per minute leave anti-aliasing seams (thin stripes) between them on a
// stretched plot. A non-zero value keeps a minimum visible height.
function flowAreaPaths(points, { axis, yPct, zero }) {
  const span = plotMinutes(axis);
  const x = (minute) => (Math.max(0, Math.min(span, minute - axis.start)) / span * 1000).toFixed(2);
  const level = (value) => {
    const y = yPct(value);
    return value > 0 ? Math.min(y, zero - 0.6) : Math.max(y, zero + 0.6);
  };
  const paths = { buy: "", sell: "" };
  let run = null;
  const close = () => {
    if (!run) return;
    paths[run.side] += `M${x(run.from)} ${zero.toFixed(2)}${run.steps}H${x(run.to + 1)}V${zero.toFixed(2)}Z`;
    run = null;
  };
  for (const point of points) {
    const side = point.value > 0 ? "buy" : point.value < 0 ? "sell" : null;
    if (!side || !run || run.side !== side || point.minute !== run.to + 1) close();
    if (!side) continue;
    if (!run) run = { side, from: point.minute, to: point.minute, steps: "" };
    else run.to = point.minute;
    run.steps += `${run.steps ? `H${x(point.minute)}` : ""}V${level(point.value).toFixed(2)}`;
  }
  close();
  return paths;
}

function flowChartHtml(flow = {}, { size = "large", mode = "cumulative", showXAxis = true } = {}) {
  const rows = Array.isArray(flow.minuteSeries) ? flow.minuteSeries : (Array.isArray(flow.minute_series) ? flow.minute_series : []);
  const framed = axisSpec(flow);
  // No session frame: an empty plot without an x axis.
  const axis = framed || { start: 0, end: 0, ticks: [] };
  // 累計 is B's running total of each minute (minuteSeries[].cumulative), 分時 that minute's own net.
  const values = (framed ? rows : []).map((row) => {
    const minute = rowMinute(row);
    if (minute == null || minute < axis.start || minute > axis.end) return null;
    return { minute, value: Number((mode === "cumulative" ? row?.cumulative?.[size] : row?.[size])?.net || 0) };
  }).filter(Boolean).sort((a, b) => a.minute - b.minute);

  let domainMin = Math.min(0, ...values.map((item) => item.value));
  let domainMax = Math.max(0, ...values.map((item) => item.value));
  if (domainMin === domainMax) { domainMin = Math.min(0, domainMin - 1); domainMax = Math.max(0, domainMax + 1); }
  // 累計 uses the observed domain (a one-sided day fills the height); 分時 is symmetric around zero.
  if (mode !== "cumulative") {
    const maxAbs = Math.max(1, Math.abs(domainMin), Math.abs(domainMax));
    domainMin = -maxAbs; domainMax = maxAbs;
  }
  const span = Math.max(1e-9, domainMax - domainMin);
  const xPct = (minute) => Math.max(0, Math.min(1, (minute - axis.start) / plotMinutes(axis))) * 100;
  const yPct = (value) => PLOT_PAD + ((domainMax - value) / span) * (100 - 2 * PLOT_PAD);
  const zero = yPct(0);
  const ticks = domainMax <= 0 ? [0, domainMin] : domainMin >= 0 ? [domainMax, 0] : [domainMax, 0, domainMin];
  const yLabels = ticks.map((value) => `<span class="flow-chart-y-label" style="top:${yPct(value).toFixed(2)}%">${escapeHtml(formatQuantity(value, { maxFractionDigits: 2 }))}</span>`).join("");
  const grid = axis.ticks.map((tick) => `<line class="flow-chart-grid" x1="${xPct(tick.minute) * 10}" y1="0" x2="${xPct(tick.minute) * 10}" y2="100"/>`).join("");
  const areas = flowAreaPaths(stepMinutes(values, mode), { axis, yPct, zero });
  const bars = ["buy", "sell"].map((side) => (areas[side] ? `<path class="flow-chart-area ${side}" d="${areas[side]}"/>` : "")).join("");
  const xAxis = showXAxis
    ? `<div class="flow-chart-x">${axis.ticks.map((tick) => `<span class="flow-chart-x-label" style="left:${xPct(tick.minute).toFixed(2)}%">${escapeHtml(tick.label)}</span>`).join("")}</div>`
    : "";
  const empty = values.length ? "" : `<span class="flow-chart-empty">尚無正式成交</span>`;
  return `<div class="flow-chart"${showXAxis ? " data-x-axis" : ""} data-flow-size="${escapeHtml(size)}"><div class="flow-chart-y">${yLabels}</div>`
    + `<div class="flow-chart-plot"><svg class="flow-chart-svg" viewBox="0 0 1000 100" preserveAspectRatio="none"${framed ? ` data-axis-start="${axis.start}" data-axis-end="${axis.end}"` : ""}>`
    + `${grid}<line class="flow-chart-zero" x1="0" y1="${zero.toFixed(2)}" x2="1000" y2="${zero.toFixed(2)}"/>${bars}</svg>${empty}</div>${xAxis}</div>`;
}

// 進出 crosshair: the minute under the mouse, from the same minuteSeries the charts draw. B keeps each minute's
// buy/sell per size and the running 累計 through it.
export function flowChartMinuteAt(svg, clientX) {
  const rect = svg?.getBoundingClientRect?.();
  const start = Number(svg?.dataset?.axisStart), end = Number(svg?.dataset?.axisEnd);
  if (!rect || !(rect.width > 0) || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  const frac = (clientX - rect.left) / rect.width;
  if (frac < 0 || frac > 1) return null;
  return Math.min(end, Math.floor(start + frac * plotMinutes({ start, end })));
}

/** x of `minute` as a percentage of the plot's width, for the crosshair line. */
export function flowChartMinutePercent(svg, minute) {
  const start = Number(svg?.dataset?.axisStart), end = Number(svg?.dataset?.axisEnd);
  return Math.max(0, Math.min(1, (minute + 0.5 - start) / plotMinutes({ start, end }))) * 100;
}

/** {time, large|small: {buy, sell, net, cumulative}} at `minute`, or null outside the traded minutes. */
export function flowMinuteDetail(flow = {}, minute) {
  const rows = Array.isArray(flow.minuteSeries) ? flow.minuteSeries : (Array.isArray(flow.minute_series) ? flow.minute_series : []);
  const axis = axisSpec(flow);
  if (!axis) return null;
  const points = rows.map((row) => ({ row, minute: rowMinute(row) }))
    .filter((p) => p.minute != null && p.minute >= axis.start && p.minute <= axis.end).sort((a, b) => a.minute - b.minute);
  if (!Number.isFinite(minute) || !points.length || minute < points[0].minute || minute > points.at(-1).minute) return null;
  // The last traded minute at or before `minute` holds the 累計 through it; its own buy/sell only when it is `minute`.
  const at = points.findLast((p) => p.minute <= minute);
  const out = {};
  for (const [size] of SIZE_ROWS) {
    const own = at.minute === minute ? at.row?.[size] || {} : {};
    out[size] = { buy: Number(own.buy || 0), sell: Number(own.sell || 0), net: Number(own.net || 0),
      cumulative: Number(at.row?.cumulative?.[size]?.net || 0) };
  }
  // The axis runs before 0 (a session from the previous day) and past 1440 (a futures night): the clock wraps.
  const clock = ((minute % 1440) + 1440) % 1440;
  const hh = Math.floor(clock / 60), mm = clock % 60;
  return { time: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`, ...out };
}

/** The 查價 window (as the broker's): per size, 時間 and the 累計 from the open to that minute, said as 買超 / 賣超;
 *  the arrow is that minute's own direction (red ↑ bought on balance, green ↓ sold). */
export function flowQuoteHtml(detail) {
  if (!detail) return "";
  const sections = SIZE_ROWS.map(([size, label]) => {
    const g = detail[size] || {};
    const cum = Number(g.cumulative || 0), minute = Number(g.net || 0);
    const tone = signedValueClass(cum);
    const arrow = minute > 0 ? '<i class="flow-quote-arrow price-up">↑</i>' : minute < 0 ? '<i class="flow-quote-arrow price-down">↓</i>' : "";
    return `<section><h5>${escapeHtml(label)}累計</h5><p>時間：<span class="flow-quote-time">${escapeHtml(detail.time)}</span></p>`
      + `<p>${cum < 0 ? "賣超" : "買超"}：<b class="${tone}">${escapeHtml(formatQuantity(cum))}</b>${arrow} ${escapeHtml(volumeUnitLabel(detail.unit ?? detail.market, "張"))}</p></section>`;
  }).join("");
  return `<header><span>查價</span><button type="button" data-flow-quote-close aria-label="關閉">✕</button></header><div class="flow-quote-body">${sections}</div>`;
}

// B's decimal ratio as a percent; null (nothing to divide by yet) stays null.
function ratioPct(value) { return value === null || value === undefined ? null : Number(value) * 100; }
// One class's buy/sell split in one period as B computed it (over the volume with a known direction): the larger
// side's share in its colour, a short split bar under it. With no direction yet B sends
// null and the cell says so; it never draws a 50/50.
function ratioCellHtml(item={}) {
  const buyPct=ratioPct(item.buy_ratio), sellPct=ratioPct(item.sell_ratio);
  if (buyPct===null||sellPct===null) return `<td><span class="flow-ratio-none">尚無方向</span><div class="flow-ratio-track"></div></td>`;
  const buyMajor=buyPct>=sellPct;
  return `<td><b class="${buyMajor?"price-up":"price-down"}">${buyMajor?"買":"賣"} ${(buyMajor?buyPct:sellPct).toFixed(1)}%</b>`
    + `<div class="flow-ratio-track"><i class="buy" style="width:${buyPct}%"></i><i class="sell" style="width:${sellPct}%"></i></div></td>`;
}

export function renderUnifiedBigOrderInOut(flow = {}, { displayMode = "cumulative" } = {}) {
  const mode = displayMode === "minute" ? "minute" : "cumulative";
  const cumulative = flow.cumulative || {};
  const unit = volumeUnitLabel(flow.volume_unit ?? flow.market, "張");
  const totals = flow.totals || {};
  const largeShare = ratioPct(totals.large?.class_ratio);
  // 大單控盤: B's large share of the day's volume, one bar with both volumes at its ends.
  const control = `<section class="flow-control"><div class="flow-control-head"><span>大單控盤</span><b>${largeShare === null ? "–" : `${largeShare.toFixed(1)}%`}</b></div>`
    + `<div class="flow-control-track"><i style="width:${(largeShare ?? 0).toFixed(2)}%"></i></div>`
    + `<div class="flow-control-legend"><span class="flow-control-large">大單 ${formatQuantity(Number(totals.large?.total || 0))}</span><span class="flow-control-small">小單 ${formatQuantity(Number(totals.small?.total || 0))}</span></div></section>`;
  const modes = `<div class="pill-switch flow-mode" role="group" aria-label="大單流向圖表模式">`
    + `<button type="button" class="pill-switch-btn${mode === "cumulative" ? " active" : ""}" data-flow-display-mode="cumulative" aria-pressed="${mode === "cumulative"}">累計</button>`
    + `<button type="button" class="pill-switch-btn${mode === "minute" ? " active" : ""}" data-flow-display-mode="minute" aria-pressed="${mode === "minute"}">分時</button></div>`;
  const sections = SIZE_ROWS.map(([size, label], index) => `<section class="flow-chart-section">${renderFlowNetSummary(label, Number(cumulative?.[size]?.net || 0), unit, mode)}`
    + `${flowChartHtml(flow, { size, mode, showXAxis: index === SIZE_ROWS.length - 1 })}</section>`).join("");
  return `<div class="flow-inout-view"><div class="flow-inout-top">${control}${modes}</div><div class="flow-chart-stack">${sections}</div></div>`;
}

export function renderUnifiedBigOrderRatios(flow = {}, { activeWindow = "300s" } = {}) {
  const active=BIG_ORDER_FLOW_WINDOWS.some(([key])=>key===activeWindow)?activeWindow:"300s";
  const activeLabel=BIG_ORDER_FLOW_WINDOWS.find(([key])=>key===active)?.[1]||"近5分";
  const totals=flow.totals||{};
  return `<div class="flow-ratio-summary"><span>累計盤差</span>${renderBigOrderSignedCell(totals.net)}<label>時間區間 <select data-flow-window-select>${BIG_ORDER_FLOW_WINDOWS.map(([key,label])=>`<option value="${key}" ${key===active?"selected":""}>${label}</option>`).join("")}</select></label></div><table class="flow-ratio-table"><thead><tr><th></th><th>開盤迄今</th><th>${escapeHtml(activeLabel)}</th></tr></thead><tbody>${SIZE_ROWS.map(([size,label])=>`<tr><td>${label}</td>${ratioCellHtml(totals[size]||{})}${ratioCellHtml(flow.windows?.[active]?.[size]||{})}</tr>`).join("")}</tbody></table>`;
}

// 分時: large-order share per session bucket, plus the large prints inside the selected bucket. The buckets are
// Rust B's (flow.hourSeries: 開盤迄今, then each traded hour of the session, the first from the open and the last to the
// close), each with its large buy / sell share of the bucket's own volume; this only labels and shows them.
// The axis runs before 0 (a session from the previous day) and past 1440 (a futures night): the clock wraps.
function hhmm(minute) {
  const clock = ((minute % 1440) + 1440) % 1440;
  return `${String(Math.floor(clock / 60)).padStart(2, "0")}:${String(clock % 60).padStart(2, "0")}`;
}

function bucketLabel(row) {
  if (row.key === "all") return "開盤迄今";
  return `${row.opens_session ? "開盤" : hhmm(row.from_minute)}~${row.closes_session ? "收盤" : hhmm(row.to_minute + 1)}`;
}

export function bigOrderFlowBuckets(flow = {}) {
  return (Array.isArray(flow.hourSeries) ? flow.hourSeries : []).map((row) => ({
    key: String(row.key), label: bucketLabel(row), from: Number(row.from_minute), to: Number(row.to_minute),
    buy: Number(row.large?.buy || 0), sell: Number(row.large?.sell || 0), total: Number(row.total || 0),
    buyPct: Number(row.buy_ratio || 0) * 100, sellPct: Number(row.sell_ratio || 0) * 100,
  }));
}

// 單別 of 分時 (全部 / 買 / 賣).
export const BIG_ORDER_SIDE_FILTERS = Object.freeze([["ALL", "全部"], ["BUY", "買"], ["SELL", "賣"]]);

// The flow's newest large prints inside a bucket, each placed by B's `minute` (the session axis the buckets are on,
// never the row's clock text), of the 單別's side.
function flowLargeOrderRows(flow, bucket, sideFilter = "ALL") {
  const rows = Array.isArray(flow.largeOrders) ? flow.largeOrders : [];
  return rows.filter((row) => {
    const minute = rowMinute(row);
    if (minute == null || minute < bucket.from || minute > bucket.to) return false;
    return sideFilter === "ALL" || String(row?.side || "").toUpperCase() === sideFilter;
  });
}

// 時間 / 成交 / 單量; the row's colour is the side it traded on (外盤 up colour, 內盤 down colour).
function largeOrderRowHtml(row) {
  const side = String(row?.side || "").toUpperCase();
  const tone = side === "BUY" ? "price-up" : side === "SELL" ? "price-down" : "";
  const price = Number(row?.price);
  return `<div class="flow-large-order-row ${tone}"><span>${escapeHtml(String(row?.time || "--"))}</span><b>${Number.isFinite(price) ? price.toFixed(2) : "--"}</b><b>${formatQuantity(Number(row?.volume || 0))}</b></div>`;
}

/** The minutes a bucket covers, inclusive on both ends: B's own, as its large-order query takes them. */
export function bigOrderBucketWindow(bucket) {
  if (!bucket) return null;
  return { fromMinute: bucket.from, toMinute: bucket.to };
}

// A bucket's one share: the side the 單別 filter picks, or under 全部 the larger side, said as 買 / 賣 in its colour.
function hourShareHtml(bucket, side) {
  const buy = side === "BUY" || (side !== "SELL" && bucket.buyPct >= bucket.sellPct);
  return `<b class="${buy ? "price-up" : "price-down"}">${buy ? "買" : "賣"} ${(buy ? bucket.buyPct : bucket.sellPct).toFixed(1)}%</b>`;
}

export function renderUnifiedBigOrderMinuteVolume(flow = {}, { scopeLabel = "當日交易時段", sideFilter = "ALL", bucketKey = "all", windowOrders = null } = {}) {
  const side = BIG_ORDER_SIDE_FILTERS.some(([key]) => key === sideFilter) ? sideFilter : "ALL";
  const buckets = bigOrderFlowBuckets(flow);
  const active = buckets.find((bucket) => bucket.key === bucketKey) || buckets[0] || null;
  const filter = `<div class="flow-pv-toolbar"><label class="flow-side-filter">單別 <select data-flow-side-filter>${BIG_ORDER_SIDE_FILTERS.map(([key, label]) => `<option value="${key}" ${key === side ? "selected" : ""}>${label}</option>`).join("")}</select></label></div>`;
  const bucketRows = buckets.length ? buckets.map((bucket) => {
    const buyPct = side === "SELL" ? 0 : bucket.buyPct, sellPct = side === "BUY" ? 0 : bucket.sellPct;
    const other = Math.max(0, 100 - buyPct - sellPct);
    return `<button type="button" class="flow-hour-share-row${bucket === active ? " active" : ""}" data-flow-bucket="${escapeHtml(bucket.key)}"><span class="flow-hour-label">${escapeHtml(bucket.label)}</span><div class="flow-hour-share-track"><i class="buy" style="width:${buyPct}%"></i><i class="other" style="width:${other}%"></i><i class="sell" style="width:${sellPct}%"></i></div>${hourShareHtml(bucket, side)}</button>`;
  }).join("") : `<div class="flow-large-order-empty">${escapeHtml(scopeLabel)}尚無成交</div>`;
  // The bucket's own list from Rust B when it has answered for THIS bucket; otherwise the newest prints the flow
  // carries, with the note saying an older part may be missing.
  // ... and for THIS side: Rust B picks the side before its limit, so another side's answer is not it.
  const answered = Boolean(active && windowOrders?.ok && windowOrders.bucketKey === active.key && (windowOrders.side || "ALL") === side
    && Array.isArray(windowOrders.rows));
  // B's answer is the bucket's list for this side as it is; only the flow's newest prints are placed here.
  const rows = answered ? windowOrders.rows : active ? flowLargeOrderRows(flow, active, side) : [];
  const listed = rows.reduce((sum, row) => sum + Number(row?.volume || 0), 0);
  const expected = active ? (side === "BUY" ? active.buy : side === "SELL" ? active.sell : active.buy + active.sell) : 0;
  const truncated = answered
    ? (windowOrders.truncated ? `<div class="flow-large-order-note">此時段大單較多，僅列出最近 ${formatNumber(windowOrders.rows.length)} 筆</div>` : "")
    : listed < expected ? `<div class="flow-large-order-note">僅列出最近 ${formatNumber((flow.largeOrders || []).length)} 筆大單，此時段較早的大單未列出</div>` : "";
  const empty = `<div class="flow-large-order-empty">${escapeHtml(active?.label || "")} 沒有${side === "BUY" ? "買方" : side === "SELL" ? "賣方" : ""}大單</div>`;
  // The list scrolls one row at a time with the shared scrollbar (trade_flow_component.js mounts both on each render),
  // rows parted by a line like every other list (.lined-rows).
  const list = active ? `<div class="flow-large-order-head"><span>時間</span><span>成交</span><span>單量</span></div><div class="flow-large-order-body"><div class="flow-large-order-list lined-rows" data-flow-large-order-list>${rows.length ? rows.map(largeOrderRowHtml).join("") : empty}</div><aside class="shared-discrete-row-rail flow-large-order-rail" data-flow-large-order-rail aria-label="大單分時捲軸"></aside></div>${truncated}` : "";
  return `<div class="flow-pv-view">${filter}<div class="flow-hour-share-list">${bucketRows}</div>${list}</div>`;
}
