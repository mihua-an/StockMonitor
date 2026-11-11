import { getRealtimeQuoteColumnConfig, HOLDINGS_COLUMN_PROFILE } from "../../market/quote_presentation.js";
import { limitPriceClass } from "../../../core/components/orderbook_depth_table.js";
import { realtimeQuoteColumnsFor } from "../../../core/column_schemas.js";
import { measureColumnContent } from "../../../core/column_content_width.js";
import { ensureColumnSchema, setColumnContentMinimums } from "../../../core/column_title.js";
import { formatQuantity, volumeChangePctParts } from "../../../core/utility.js";
import { cell } from "../../../core/cell_patch.js";
import { productReadView } from "../../../core/market_read_model.js";
import { renderProductListRows } from "../product_list.js";
import { MarketPriceColorPolicy, signedValueClass } from "../../../core/market_color_policy.js";
import { displayQuote, priceText } from "../../../core/auction_price.js";
import { numberOrNull } from "../../../core/numbers.js";
import { markPriceFromSummary, positionUnrealizedPnl } from "../../account/live_position_marks.js";

// Broker-neutral product/quote table. Both 商品列表 (Shioaji/TW) and
// 商品列表-A (Futu/US) share the same Title schema, sort state, splitter
// widths, cells and row rendering here. realtime_presentation.js (Shioaji adapter) and
// futu/product_list_components.js (Futu adapter) both consume renderExternalRealtimeQuoteTable;
// neither broker adapter reaches into the other's page module.

// Column widths are kept per product list (Shioaji / Futu) and per column set (the 實際庫存 page shows other columns
// than the product pages). One shared key let adjusting one list re-shape the other, and switching to a page with
// a different column set re-spread every width.
function realtimeColumnWidthsKey(table, columns) {
  const provider = String(table?.dataset?.provider || "shioaji").toLowerCase();
  return `monitorQuoteColumnWidthsV2:${provider}:${columns.map((column) => String(column.id || column.key || "")).join(",")}`;
}

// 即時持倉: on the 實際庫存 page the adapter passes the ledger's positions and the table uses that page's
// own column profile (its own list in the column settings). 損益 is the 庫存 page's net 未實現 (live_position_marks.js)
// at the row's own WS price; a row without a price shows "--", never 0.
const HOLDING_COLUMN_KEYS = ["position_qty", "position_avg_cost", "position_cost_amount", "position_pnl", "position_pnl_pct"];

function columnKeys(holdings) {
  return holdings ? getRealtimeQuoteColumnConfig(HOLDINGS_COLUMN_PROFILE) : getRealtimeQuoteColumnConfig();
}

/** code -> position; null when the page shows no positions. Accepts the page's items or a Map. */
function holdingsByCode(holdings) {
  if (!holdings) return null;
  if (holdings instanceof Map) return holdings;
  if (!Array.isArray(holdings)) return null;
  return new Map(holdings.map((item) => [String(item?.code || "").trim().toUpperCase(), item]));
}

// Every figure is read through the renderer's one numeric reading: a missing value is null (shown "--"), never 0.
const finiteOrNull = numberOrNull;

function holdingOf(item, holdings) {
  const position = holdings?.get(String(item?.code || "").trim().toUpperCase());
  if (!position) return null;
  const qty = finiteOrNull(position.position_qty ?? position.qty);
  return { qty, avgCost: position.avg_cost, costAmount: finiteOrNull(position.cost_amount),
    ...positionUnrealizedPnl(position, markPriceFromSummary(item)) };
}

// Money in whole NT dollars for a Taiwan stock; a US holding (USD, few shares) keeps cents.
function moneyDigits(item) {
  return /^[0-9]{4,6}[A-Z]?$/.test(String(item?.code || "").trim().toUpperCase()) ? 0 : 2;
}

// One formatter per digit count, built once: toLocaleString with options builds a new one on every call.
const moneyFormatters = new Map();
function moneyFormatter(fractionDigits) {
  if (!moneyFormatters.has(fractionDigits)) {
    moneyFormatters.set(fractionDigits, new Intl.NumberFormat("en-US", { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }));
  }
  return moneyFormatters.get(fractionDigits);
}

function formatMoney(value, fractionDigits) {
  const scale = 10 ** fractionDigits;
  const number = Math.round(Number(value) * scale) / scale;
  return { number, text: moneyFormatter(fractionDigits).format(number) };
}

const EMPTY_CELL = cell("--");

function renderSignedMoneyCell(value, fractionDigits = 0) {
  if (finiteOrNull(value) === null) return EMPTY_CELL;
  const { number, text } = formatMoney(value, fractionDigits);
  return cell(text, signedValueClass(number));
}

function holdingColumnCell(item, key, holdings) {
  const holding = holdingOf(item, holdings);
  if (!holding) return EMPTY_CELL;
  if (key === "position_qty") return cell(formatQuantity(holding.qty));
  if (key === "position_avg_cost") return cell(priceText(holding.avgCost));
  if (key === "position_cost_amount") {
    return holding.costAmount === null ? EMPTY_CELL : cell(formatMoney(holding.costAmount, moneyDigits(item)).text);
  }
  if (key === "position_pnl") return renderSignedMoneyCell(holding.unrealized_pnl, moneyDigits(item));
  return renderSignedPercentCell(holding.unrealized_pnl_pct);
}

// 損益%: the size only, the direction is the colour, as everywhere else.
function renderSignedPercentCell(value) {
  const number = finiteOrNull(value);
  if (number === null) return EMPTY_CELL;
  const text = `${Math.abs(number).toFixed(2)}%`;
  return cell(text, signedValueClass(number));
}

function holdingSortValue(item, key, holdings) {
  const holding = holdingOf(item, holdings);
  if (!holding) return null;
  if (key === "position_qty") return holding.qty;
  if (key === "position_avg_cost") return finiteOrNull(holding.avgCost);
  if (key === "position_cost_amount") return holding.costAmount;
  if (key === "position_pnl") return holding.unrealized_pnl;
  return holding.unrealized_pnl_pct;
}

function productListTable(root = document) {
  return root?.querySelector?.('[data-role="product-list-table"]') || null;
}

function productListBody(root = document) {
  return root?.querySelector?.('[data-role="product-list-body"]') || null;
}

// Each mounted product list (keyed by its tbody) owns its sort state and the last input its adapter gave it, so
// sorting one list never re-orders another, and a header click re-renders that same list from that input.
const tableStates = new WeakMap();
let realtimeQuoteSortDelegationReady = false;

function tableStateOf(body) {
  let state = tableStates.get(body);
  if (!state) {
    state = { sort: { columnId: "", direction: "" }, lastRender: null };
    tableStates.set(body, state);
  }
  return state;
}

function sortStateOf(body) {
  return body ? tableStateOf(body).sort : { columnId: "", direction: "" };
}

function renderRealtimeOpenPriceCell(value, prevClose) {
  return cell(priceText(value), MarketPriceColorPolicy.cssClass(value, prevClose));
}

function renderMinuteChangeCell(value) {
  if (value === null || value === undefined || value === "") {
    return EMPTY_CELL;
  }

  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return EMPTY_CELL;
  }

  const className = signedValueClass(numberValue);

  const displayValue = numberValue === 0
    ? "0%"
    : `${Math.abs(numberValue).toFixed(2)}%`;

  return cell(displayValue, className);
}

function renderRealtimePriceCell(value, prevClose, limitUp, limitDown, { indicative = false } = {}) {
  const limitClass = limitPriceClass(value, limitUp, limitDown);
  const moveClass = MarketPriceColorPolicy.cssClass(value, prevClose);
  // 試撮 (盤前 / 緩漲緩跌 / 尾盤): the indicative price in 現價's place, marked "#".
  return cell(priceText(value, { indicative }), `${moveClass} ${limitClass}`);
}

export function resolveRealtimeVolumeChangePct(item) {
  // 量變 has ONE producer: AnalysisSignalProducer compares the completed clock minute with its
  // baseline and ships the percentage on the row, over REST and the live lane alike. It is not
  // recomputed here -- the old fallback divided the day's total_volume by a one-minute baseline,
  // and a stale baseline_volume from a first paint would outvote every fresher pushed percentage.
  // Number(null) 是 0：沒有量能基準必須保持 null（顯示 --），不能畫成 0.0%。
  return finiteOrNull(item?.volume_change_pct_vs_baseline);
}

function renderRealtimeQuoteHeader(root, body, keys, { holdings = false } = {}) {
  const table = productListTable(root);
  if (!table) return;
  const columns = realtimeQuoteColumnsFor(keys, { holdings });
  const sortState = sortStateOf(body);
  const schemaSignature = `${holdings ? "holdings:" : ""}${columns.map((column) => column.id || column.key || "").join("|")}:${sortState.columnId}:${sortState.direction}`;
  const mountedColumnIds = [...table.querySelectorAll(":scope > thead > tr:last-child > th")]
    .map((cell) => String(cell.dataset.columnId || cell.dataset.realtimeColumnKey || ""));
  const expectedColumnIds = columns.map((column) => String(column.id || column.key || ""));
  // A retained/hidden ComponentHost can keep an old header signature while its
  // DataGrid title has a different column set. Never allow one provider to
  // display a stale all-columns header while the other uses current settings.
  if (table.dataset.realtimeHeaderSignature === schemaSignature
      && mountedColumnIds.length === expectedColumnIds.length
      && mountedColumnIds.every((id, index) => id === expectedColumnIds[index])) return;
  ensureColumnSchema(table, columns, {
    schemaId: "realtimeQuote",
    resize: {
      storageKey: realtimeColumnWidthsKey(table, columns),
      // Each column's minimum is what its title and values need now (renderExternalRealtimeQuoteTable).
      defaultMinWidth: 32,
      floorWidth: 32,
      fitToAvailable: true,
      // A value never narrower than it needs: too many columns scroll sideways.
      keepMinimums: true,
      // The defaults are the columns' minimums, the room left over shared by flex (column_schemas.js): a title-only
      // header's automatic layout says nothing about the values (it gave 股名 190 px in a wide pane).
      defaultsFromSchema: true,
    },
    sortState,
    onSort: (payload) => applyRealtimeQuoteSort(payload, body),
  });
  [...table.querySelectorAll("thead th")].forEach((th) => { th.dataset.realtimeColumnKey = th.dataset.columnId || ""; });
  table.dataset.realtimeHeaderSignature = schemaSignature;
  ensureRealtimeQuoteSortDelegation();
}

function ensureRealtimeQuoteSortDelegation() {
  if (realtimeQuoteSortDelegationReady) return;
  realtimeQuoteSortDelegationReady = true;
  // DataGrid 會把 Title 搬到獨立的 header table；用文件層 capture 綁定，
  // 讓搬移/重建後的 Title 仍維持唯一且可靠的排序入口。
  document.addEventListener("click", (event) => {
    const cell = event.target?.closest?.('[data-role="product-list-table"] thead th[data-column-sortable="1"]');
    if (!cell || event.target?.closest?.("[data-column-boundary]")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const sortKey = String(cell.dataset.columnId || cell.dataset.realtimeColumnKey || "");
    if (!sortKey) return;
    // The list whose header was clicked: its shell (productListShellMarkup) holds both the header and the body.
    const body = productListBody(cell.closest?.(".product-list"));
    if (!body) {
      console.error("[product-list] sort click outside a product list shell", { sortKey });
      return;
    }
    const sort = sortStateOf(body);
    const direction = sort.columnId === sortKey && sort.direction === "asc" ? "desc" : "asc";
    applyRealtimeQuoteSort({ sortKey, direction }, body);
  }, true);
}

function realtimeAmplitude(item) {
  return numberOrNull(item.amplitude);
}

// 漲幅: Market Runtime's (displayQuote, 試撮 included), as on the 個股走勢 / 買賣報價 headers.
function realtimeDayChangePct(item) {
  return displayQuote(item).changePct;
}

function realtimeAveragePrice(item) {
  const direct = numberOrNull(item.avg_price ?? item.average_price);
  if (direct !== null && direct > 0) return direct;
  const derived = numberOrNull(item.derived_vwap);
  if (String(item.average_price_source || "").toUpperCase() === "DERIVED_VWAP" && derived !== null && derived > 0) return derived;
  return null;
}

// 參考價: Market Runtime's comparison price (its reference, else 昨收; futures the settlement), the column and the
// baseline every price on the row is compared with.
function prevCloseOf(item) {
  return displayQuote(item).reference;
}

// 現價 as shown: 試撮 (盤前 / 緩漲緩跌 / 尾盤) puts the indicative price in its place, and the column sorts by it too.
function displayedCurrent(item) {
  return displayQuote(item).current;
}

function renderCurrentPriceCell(item) {
  // 漲停/跌停: Market Runtime's (the contract's official ones), or none -- never derived from 昨收.
  return renderRealtimePriceCell(displayedCurrent(item), prevCloseOf(item), item.limit_up ?? null, item.limit_down ?? null,
    { indicative: displayQuote(item).indicative });
}

function renderNeutralPercentCell(value) {
  const n = numberOrNull(value);
  return n === null ? EMPTY_CELL : cell(`${n.toFixed(2)}%`);
}

function renderVolumeChangeCell(value) {
  const { text, className } = volumeChangePctParts(value);
  return cell(text, "", { span: className });
}

const textValue = (read) => (item) => String(read(item) || "");
const numberValue = (read) => (item) => numberOrNull(read(item));
// 總量 is the row's total_volume alone (A's summary total; the Futu rows name theirs the same way).
const totalVolumeOf = (item) => item.total_volume;

// The one reading of every column: `value` is what the column sorts by and `cell` draws that same figure, so a column
// cannot sort by one field while showing another (現價 showed the 試撮 price but sorted by the trade price).
const QUOTE_COLUMN_MODEL = Object.freeze({
  name: { value: textValue((item) => item.name), cell: (item) => cell(item.name || "") },
  code: { value: textValue((item) => item.code), cell: (item) => cell(String(item.display_code ?? item.code ?? "")) },
  volume_change: { value: resolveRealtimeVolumeChangePct, cell: (item) => renderVolumeChangeCell(resolveRealtimeVolumeChangePct(item)) },
  prev_close: { value: numberValue(prevCloseOf), cell: (item) => cell(priceText(prevCloseOf(item))) },
  open: { value: numberValue((item) => item.open), cell: (item) => renderRealtimeOpenPriceCell(item.open, prevCloseOf(item)) },
  current: { value: numberValue(displayedCurrent), cell: renderCurrentPriceCell },
  best_bid_price: { value: numberValue((item) => item.best_bid_price), cell: (item) => renderRealtimePriceCell(item.best_bid_price, prevCloseOf(item)) },
  best_ask_price: { value: numberValue((item) => item.best_ask_price), cell: (item) => renderRealtimePriceCell(item.best_ask_price, prevCloseOf(item)) },
  // 1m..1h: Rust B's recent windows; 1mK..5mK: the adapter's k_* figures. One field name each.
  ...Object.fromEntries(["chg_1m", "chg_3m", "chg_5m", "chg_15m", "chg_30m", "chg_1h", "k_1m", "k_3m", "k_5m"].map((key) => [key, {
    value: numberValue((item) => item[key]), cell: (item) => renderMinuteChangeCell(item[key]),
  }])),
  amplitude: { value: realtimeAmplitude, cell: (item) => renderNeutralPercentCell(realtimeAmplitude(item)) },
  day_change_pct: { value: realtimeDayChangePct, cell: (item) => renderMinuteChangeCell(realtimeDayChangePct(item)) },
  total_volume: {
    value: numberValue(totalVolumeOf),
    cell: (item) => cell(formatQuantity(totalVolumeOf(item), { quantityScale: item.marketRead?.encoding.quantityScale })),
  },
  high: { value: numberValue((item) => item.day_high ?? item.high), cell: (item) => cell(priceText(item.day_high ?? item.high)) },
  low: { value: numberValue((item) => item.day_low ?? item.low), cell: (item) => cell(priceText(item.day_low ?? item.low)) },
  avg_price: { value: realtimeAveragePrice, cell: (item) => cell(priceText(realtimeAveragePrice(item))) },
  ...Object.fromEntries(HOLDING_COLUMN_KEYS.map((key) => [key, {
    value: (item, holdings) => holdingSortValue(item, key, holdings),
    cell: (item, holdings) => holdingColumnCell(item, key, holdings),
  }])),
});

function realtimeQuoteSortValue(item, key, holdings = null) {
  // A row refused by its read view (logged there) sorts with the missing values.
  return item ? QUOTE_COLUMN_MODEL[key]?.value(item, holdings) ?? null : null;
}

function realtimeColumnCell(item, key, holdings = null) {
  return QUOTE_COLUMN_MODEL[key]?.cell(item, holdings) ?? EMPTY_CELL;
}

const productSortOrders = new WeakMap();
// A sorted table keeps its order for this long, and for as long as the pointer is over it (rows must not jump
// under the cursor); after that the next update sorts by the current values. Keeping the order until the
// product list itself changed would freeze ranks at the moment the header was clicked (user's choice).
export const REALTIME_RESORT_MS = 5000;
function sortedRealtimeQuoteRows(rows, body, now = Date.now(), holdings = null) {
  const sort = sortStateOf(body);
  const key = String(sort.columnId || "");
  const direction = sort.direction === "desc" ? -1 : 1;
  if (!key || !Array.isArray(rows)) return rows;
  const membership = rows.map(item=>String(item.code)).join('|');
  const signature = `${key}:${direction}:${membership}`;
  const previous = body && productSortOrders.get(body);
  const pointerOver = Boolean(body?.matches?.(":hover"));
  if (previous?.signature === signature && (pointerOver || now - previous.at < REALTIME_RESORT_MS)) {
    const byCode = new Map(rows.map(item=>[String(item.code),item]));
    return previous.order.map(code=>byCode.get(code));
  }
  // Sorted by the same read view the cells are drawn from (realtimeRowCells).
  const sorted = rows.map((item, index) => ({ item, index, value: realtimeQuoteSortValue(productReadView(item), key, holdings) }))
    .sort((left, right) => {
      const a = left.value;
      const b = right.value;
      const aMissing = a === null || a === undefined || a === "" || (typeof a === "number" && !Number.isFinite(a));
      const bMissing = b === null || b === undefined || b === "" || (typeof b === "number" && !Number.isFinite(b));
      if (aMissing !== bMissing) return aMissing ? 1 : -1;
      if (aMissing) return left.index - right.index;
      const compared = typeof a === "string" || typeof b === "string"
        ? String(a).localeCompare(String(b), "zh-Hant", { numeric: true, sensitivity: "base" })
        : Number(a) - Number(b);
      return compared ? compared * direction : left.index - right.index;
    }).map((entry) => entry.item);
  if (body) productSortOrders.set(body,{signature,order:sorted.map(item=>String(item.code)),at:now});
  return sorted;
}

/** Sort one product list (its tbody) and redraw it from the last input its adapter gave it. */
function applyRealtimeQuoteSort({ sortKey, direction } = {}, body) {
  if (!body) throw new Error("applyRealtimeQuoteSort needs the product list's body");
  const state = tableStateOf(body);
  state.sort = {
    columnId: String(sortKey || ""),
    direction: direction === "desc" ? "desc" : "asc",
  };
  productSortOrders.delete(body);
  if (state.lastRender) renderExternalRealtimeQuoteTable(state.lastRender);
}

/** The row's cells as data (core/cell_patch.js), one per column key. A row with a side picker (a product with
 *  futures: 現／月份, product_sides.js) draws it after its 股名, or after its 股號 when 股名 is not shown -- the
 *  column settings keep one of the two. */
function realtimeRowCells(item, keys = getRealtimeQuoteColumnConfig(), holdings = null) {
  const picker = item?.side_picker || null;
  item = productReadView(item);
  // A row refused by its read view (logged there) draws no market values.
  if (!item) return keys.map(() => cell("--"));
  const cells = keys.map((key) => realtimeColumnCell(item, key, holdings));
  const host = picker ? keys.indexOf(keys.includes("name") ? "name" : "code") : -1;
  if (host >= 0) {
    const model = cells[host];
    cells[host] = cell(model.text, `${model.className} has-picker`.trim(), { span: model.span, picker });
  }
  return cells;
}

function ensureRealtimeRowDelegation(body) {
  if (!body || body.dataset.rowDelegation === "1") return;
  body.dataset.rowDelegation = "1";
  body.addEventListener("click", (event) => {
    const row = event.target?.closest?.("tr[data-realtime-code]");
    if (!row) return;
    // The row's side picker: the product's 現／月份 changes, and the adapter selects it.
    const pick = event.target?.closest?.("[data-pick]");
    if (pick) {
      const onPick = tableStateOf(body).lastRender?.onPick;
      if (typeof onPick === "function") onPick(row.dataset.realtimeCode || "", pick.dataset.pick || "");
      else console.error("[product-list] side picked on a list whose adapter gave no onPick", { code: row.dataset.realtimeCode });
      return;
    }
    const onSelect = tableStateOf(body).lastRender?.onSelect;
    if (typeof onSelect !== "function") {
      console.error("[product-list] row clicked on a list whose adapter gave no onSelect", { code: row.dataset.realtimeCode });
      return;
    }
    onSelect(row.dataset.realtimeCode || "");
  });
}

/**
 * Broker-neutral product table renderer. Both 商品列表 and 商品列表-A use the same Title schema, splitter widths,
 * cells and row rendering; each mounted list keeps its own sort state. Only the rows and selection callback belong
 * to the broker adapter.
 */
export function renderExternalRealtimeQuoteTable(input = {}) {
  const {
    rows = [], selectedCode = "", emptyText = "尚無商品", market = "external", root = document,
    changedCodes = null, topologyChanged = false, trace = null, holdings = null,
  } = input;
  const body = productListBody(root);
  if (!body) return;
  // A header click redraws the list from this input with every row able to move, not only the changed codes.
  tableStateOf(body).lastRender = { ...input, changedCodes: null, topologyChanged: true, trace: null };
  body.dataset.productMarket = String(market || "external");
  const positions = holdingsByCode(holdings);
  const keys = columnKeys(positions);
  renderRealtimeQuoteHeader(root, body, keys, { holdings: Boolean(positions) });
  ensureRealtimeRowDelegation(body);
  const sortedRows = sortedRealtimeQuoteRows(Array.isArray(rows) ? rows : [], body, Date.now(), positions);
  // Switching to or from the 實際庫存 page changes the columns, and a new trade changes a row's 持股／成本 without
  // any price moving: either way every row is redrawn, not only the ones whose price changed.
  const positionSignature = positions
    ? [...positions].map(([code, p]) => `${code}:${p?.position_qty ?? p?.qty}:${p?.avg_cost}:${p?.cost_amount}`).join(",")
    : "";
  const columnSignature = `${keys.join("|")}#${positionSignature}`;
  const columnsChanged = body.dataset.realtimeRowColumns !== columnSignature;
  body.dataset.realtimeRowColumns = columnSignature;
  const writtenRows = renderProductListRows({
    body,
    rows: sortedRows,
    columnCount: keys.length,
    emptyText,
    codeOf: (item) => item?.code,
    classOf: (item) => String(item?.code || "") === String(selectedCode || "") ? "product-list-selected-row" : "",
    cellsOf: (item) => realtimeRowCells(item, keys, positions),
    codeAttribute: "data-realtime-code",
    changedCodes: columnsChanged ? null : changedCodes,
    topologyChanged: topologyChanged || columnsChanged,
    trace,
    provider: String(market || "").toLowerCase() === "us" ? "futu" : "shioaji",
  });
  // The columns' minimums follow the values drawn: a longer value widens its column at once, a column narrows only
  // when the rows themselves change (another page, columns, a product added or removed) -- never while prices tick.
  // A Tick measures only the rows it wrote.
  const table = productListTable(root);
  if (table) {
    const columns = realtimeQuoteColumnsFor(keys, { holdings: Boolean(positions) });
    setColumnContentMinimums(table, measureColumnContent(table, body, columns, { rows: writtenRows }), { shrink: topologyChanged || columnsChanged });
  }
}

export { renderRealtimeOpenPriceCell, renderRealtimePriceCell, renderMinuteChangeCell, sortedRealtimeQuoteRows, applyRealtimeQuoteSort, realtimeRowCells };
