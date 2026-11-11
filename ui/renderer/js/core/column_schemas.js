// Canonical column definitions.
// Every Renderer data-column Title, including DataGrid consumers, resolves through these schemas.

import { ensureColumnSchema, defineColumnSchema } from "./column_title.js";

function withCapabilities(columns, capabilities = {}) {
  return (Array.isArray(columns) ? columns : []).map((column) => ({ ...capabilities, ...column }));
}


export const EVENT_FEED_COLUMNS = defineColumnSchema(withCapabilities([
  { id: "time", title: "時間", width: 78, minWidth: 78, hardMinWidth: 78, flex: 1.1, className: "event-feed-col-time", colClassName: "event-feed-col-time" },
  { id: "code", title: "股號", width: 58, minWidth: 50, flex: 0.8, className: "event-feed-col-code", colClassName: "event-feed-col-code" },
  { id: "name", title: "股名", width: 82, minWidth: 60, flex: 1.0, className: "event-feed-col-name", colClassName: "event-feed-col-name" },
  { id: "info", title: "資訊", minWidth: 82, flex: 3.5, align: "center", className: "event-feed-col-info", colClassName: "event-feed-col-info" },
  // The model's predictions when the event triggered (Rust B writes them into the event: model_predictions[slot]).
  // Shown as the minutes and a trend icon in the user's 漲跌 colours; the full title is the tooltip.
  { id: "model_3m_up", slot: "3m_up", title: "3分上漲", shortTitle: "3", icon: "trend-up", width: 64, minWidth: 54, flex: 1, className: "event-feed-col-up", colClassName: "event-feed-col-up" },
  { id: "model_3m_down", slot: "3m_down", title: "3分下跌", shortTitle: "3", icon: "trend-down", width: 64, minWidth: 54, flex: 1, className: "event-feed-col-down", colClassName: "event-feed-col-down" },
  { id: "model_5m_up", slot: "5m_up", title: "5分上漲", shortTitle: "5", icon: "trend-up", width: 64, minWidth: 54, flex: 1, className: "event-feed-col-up", colClassName: "event-feed-col-up" },
  { id: "model_5m_down", slot: "5m_down", title: "5分下跌", shortTitle: "5", icon: "trend-down", width: 64, minWidth: 54, flex: 1, className: "event-feed-col-down", colClassName: "event-feed-col-down" },
], { divider: false, sortable: false, resizable: true }), { id: "eventFeed" });

const tickDetailsColumns = (volume) => defineColumnSchema(withCapabilities([
  // 成交 holds the price box and the 大單 badge's slot (17 px), so a narrow column never lets the badge cover the next
  // column; the others need only their text.
  { id: "time", title: "時間", minWidth: 60, flex: 0.9 },
  { id: "trade", title: "成交", minWidth: 84, flex: 1.3 },
  { id: "change", title: "漲跌", minWidth: 44, flex: 0.8 },
  { id: "change_pct", title: "漲跌幅", minWidth: 48, flex: 0.9 },
  { id: "volume", title: "單量", minWidth: 52, flex: 1, ...volume },
  { id: "total_volume", title: "總量", minWidth: 52, flex: 1 },
], { divider: false, sortable: false, resizable: true }), { id: "tickDetails" });

export const TICK_DETAILS_COLUMNS = tickDetailsColumns();
// Futu's list also shows crypto, whose quantity has 8 decimals (0.00030513): 單量 keeps the width that number needs
// (its text and the cell's padding beside the scrollbar), taken from the other columns when the pane is narrow.
export const FUTU_TICK_DETAILS_COLUMNS = tickDetailsColumns({ minWidth: 80, hardMinWidth: 80 });

export const TRADE_DETAILS_COLUMNS = defineColumnSchema(withCapabilities([
  { id: "date", title: "日期", width: 82, minWidth: 70, flex: 1.2 },
  { id: "code", title: "股號", width: 58, minWidth: 48, flex: 0.9 },
  { id: "name", title: "股名", width: 72, minWidth: 58, flex: 1.15 },
  { id: "direction", title: "方向", width: 54, minWidth: 42, flex: 0.7 },
  { id: "entry", title: "進場", width: 62, minWidth: 52, flex: 0.9 },
  { id: "exit", title: "出場", width: 62, minWidth: 52, flex: 0.9 },
  { id: "buy", title: "買進", width: 66, minWidth: 54, flex: 0.9 },
  { id: "sell", title: "賣出", width: 66, minWidth: 54, flex: 0.9 },
  { id: "profit", title: "損益", width: 74, minWidth: 60, flex: 1.0 },
], { divider: false, sortable: false, resizable: true }), { id: "tradeDetails" });

export const ACCOUNT_STOCK_NORMAL_TRADE_COLUMNS = defineColumnSchema(withCapabilities([
  { id: "date", title: "日期" }, { id: "qty", title: "股數" }, { id: "entry", title: "進場" },
  { id: "exit", title: "出場" }, { id: "hold", title: "持有" }, { id: "buy", title: "買進" },
  { id: "sell", title: "賣出" }, { id: "profit", title: "損益" }, { id: "roi", title: "收益%" },
  { id: "fee", title: "手續費" }, { id: "tax", title: "交易稅" },
], { divider: false, sortable: false, resizable: false }), { id: "accountStockNormalTrade" });

export const ACCOUNT_STOCK_DAYTRADE_COLUMNS = defineColumnSchema(withCapabilities([
  { id: "date", title: "日期" }, { id: "direction", title: "方向" }, { id: "qty", title: "股數" },
  { id: "entry", title: "進場" }, { id: "exit", title: "出場" }, { id: "hold", title: "持有" },
  { id: "buy", title: "買進" }, { id: "sell", title: "賣出" }, { id: "profit", title: "損益" },
  { id: "roi", title: "收益%" }, { id: "fee", title: "手續費" }, { id: "tax", title: "交易稅" },
  { id: "action", title: "" },
], { divider: false, sortable: false, resizable: false }), { id: "accountStockDaytrade" });

// 模擬帳務 (paper_ledger_component.js): fixed shares of the pane's width, so a vertical scrollbar never makes a row
// scroll sideways; an opened row's lines sit under the same columns.
export const PAPER_LEDGER_ORDER_COLUMNS = defineColumnSchema(withCapabilities([
  { id: "name", title: "股名", align: "left", width: "20%" }, { id: "price", title: "價格", width: "15%" },
  { id: "qty", title: "數量", width: "24%" }, { id: "state", title: "狀態／時間", width: "25%" }, { id: "op", title: "", width: "16%" },
], { divider: false, sortable: false, resizable: false }), { id: "paperLedgerOrders" });

// 模擬帳務 委託紀錄 (paper_order_history_view.js): 歷史委託, whose first cell holds a row's expand caret, and 歷史成交.
export const PAPER_HISTORY_ORDER_COLUMNS = defineColumnSchema(withCapabilities([
  { id: "time", title: "時間" }, { id: "name", title: "股名" }, { id: "price", title: "價格" }, { id: "qty", title: "委託" },
  { id: "filled", title: "成交" }, { id: "avg", title: "均價" }, { id: "tif", title: "條件" }, { id: "kind", title: "類型" },
  { id: "state", title: "狀態" }, { id: "reason", title: "原因" },
], { divider: false, sortable: false, resizable: false }), { id: "paperHistoryOrders" });

export const PAPER_HISTORY_FILL_COLUMNS = defineColumnSchema(withCapabilities([
  { id: "time", title: "時間" }, { id: "name", title: "股名" }, { id: "price", title: "價格" }, { id: "qty", title: "股數" },
  { id: "gross", title: "價金" }, { id: "fee", title: "手續費" }, { id: "tax", title: "稅" }, { id: "cash", title: "應收付" },
  { id: "kind", title: "類型" }, { id: "origin", title: "來源" },
], { divider: false, sortable: false, resizable: false }), { id: "paperHistoryFills" });

export const PAPER_LEDGER_REALIZED_COLUMNS = defineColumnSchema(withCapabilities([
  { id: "name", title: "股名", align: "left", width: "27%" }, { id: "qty", title: "股數", width: "14%" },
  { id: "buy", title: "買價", width: "17%" }, { id: "sell", title: "賣價", width: "23%" }, { id: "profit", title: "損益", width: "19%" },
], { divider: false, sortable: false, resizable: false }), { id: "paperLedgerRealized" });

export const PAPER_LEDGER_POSITION_COLUMNS = defineColumnSchema(withCapabilities([
  { id: "name", title: "股名", align: "left", width: "40%" }, { id: "qty", title: "股數", width: "28%" }, { id: "pnl", title: "總損益", width: "32%" },
], { divider: false, sortable: false, resizable: false }), { id: "paperLedgerPositions" });

export const ACCOUNT_DAYTRADE_DETAIL_COLUMNS = defineColumnSchema(withCapabilities([
  { id: "date", title: "日期" }, { id: "code", title: "股號" }, { id: "name", title: "股名" },
  { id: "direction", title: "方向" }, { id: "entry", title: "進場" }, { id: "exit", title: "出場" },
  { id: "hold", title: "持有" }, { id: "profit", title: "損益" }, { id: "roi", title: "收益%" },
  { id: "buy", title: "買進" }, { id: "sell", title: "賣出" }, { id: "trend", title: "走勢" },
], { divider: false, sortable: false, resizable: false }), { id: "accountDaytradeDetail" });

// No column declares a minimum: each one's is what its title and the values in its rows need now, measured as they
// are drawn (realtime_quote_table.js, core/column_content_width.js). A fixed minimum sized for the widest value a
// column could ever hold (損益 +123,456.78, 量變 +9999.9%) gave short numbers far more room than they needed
// (使用者 10-20). A list with more columns than its pane scrolls sideways.
export const REALTIME_QUOTE_COLUMNS = defineColumnSchema(withCapabilities([
  // 股名 is as wide as the names need, at most five characters and then "…" (元大台灣50正2), and takes none of a wide
  // pane's room left over (使用者 10-20); a drag makes it wider.
  { id: "name", title: "股名", flex: 0, contentMaxChars: 5 },
  { id: "code", title: "股號", flex: 0.9 },
  { id: "volume_change", title: "量變" },
  { id: "prev_close", title: "昨收" },
  { id: "open", title: "開盤" },
  { id: "current", title: "現價" },
  { id: "best_bid_price", title: "買價" },
  { id: "best_ask_price", title: "賣一" },
  { id: "chg_1m", title: "1m" },
  { id: "chg_3m", title: "3m" },
  { id: "chg_5m", title: "5m" },
  { id: "chg_15m", title: "15m" },
  { id: "chg_30m", title: "30m" },
  { id: "chg_1h", title: "1h" },
  { id: "amplitude", title: "振幅" },
  { id: "day_change_pct", title: "漲幅" },
  { id: "k_1m", title: "1mK" },
  { id: "k_3m", title: "3mK" },
  { id: "k_5m", title: "5mK" },
  { id: "total_volume", title: "成交量" },
  { id: "high", title: "最高" },
  { id: "low", title: "最低" },
  { id: "avg_price", title: "均價" },
], { divider: false, sortable: true, resizable: true }), { id: "realtimeQuote" });

// 即時持倉: the 實際庫存 page's own columns. They are offered only in that page's column list (its own
// profile, quote_presentation.js), never in the ordinary product pages'. The position is the ledger's; the P&L is
// computed on the screen from the row's live price.
export const REALTIME_HOLDING_COLUMNS = defineColumnSchema(withCapabilities([
  { id: "position_qty", title: "股數" },
  { id: "position_pnl", title: "損益" },
  { id: "position_pnl_pct", title: "損益%" },
  { id: "position_avg_cost", title: "成本/股" },
  { id: "position_cost_amount", title: "成本" },
], { divider: false, sortable: true, resizable: true }), { id: "realtimeHolding" });

// The 實際庫存 / 模擬庫存 pages' own layout (使用者 10-20; the other product pages keep theirs): 股號 takes little of
// the room left over, a code never needs more than its six characters.
const HOLDINGS_PAGE_QUOTE_COLUMNS = defineColumnSchema(REALTIME_QUOTE_COLUMNS.map((column) => ({
  ...column,
  ...({ code: { flex: 0.2 } })[column.id],
})), { id: "realtimeQuote" });

export function realtimeQuoteColumnsFor(keys = [], { holdings = false } = {}) {
  const wanted = new Set((Array.isArray(keys) ? keys : []).map(String));
  const quote = holdings ? HOLDINGS_PAGE_QUOTE_COLUMNS : REALTIME_QUOTE_COLUMNS;
  const byId = new Map([...quote, ...REALTIME_HOLDING_COLUMNS].map((column) => [column.id, column]));
  return [...wanted].map((id) => byId.get(id)).filter(Boolean);
}

export const ACCOUNT_HOLDINGS_COLUMNS = defineColumnSchema(withCapabilities([
  { id: "code", title: "股號" },
  { id: "name", title: "股名" },
  { id: "qty", title: "庫存" },
  { id: "avg_cost", title: "平均成本" },
  { id: "cost_amount", title: "成本總額" },
  { id: "unrealized_pnl", title: "未實現損益" },
  { id: "unrealized_pnl_pct", title: "未實現損益%" },
], { divider: false, sortable: false, resizable: false }), { id: "accountHoldings" });

export const ACCOUNT_STOCK_STATS_COLUMNS = defineColumnSchema(withCapabilities([
  { id: "code", title: "股號", sortKey: "code", colClassName: "stock-col-code" },
  { id: "name", title: "股名", sortKey: "name", colClassName: "stock-col-name" },
  { id: "holding_qty", title: "庫存", sortKey: "holding_qty", colClassName: "stock-col-qty" },
  { id: "holding_cost", title: "庫存成本", sortKey: "holding_cost", colClassName: "stock-col-money" },
  { id: "total_profit", title: "淨損益", sortKey: "total_profit", colClassName: "stock-col-money" },
  { id: "daytrade_profit", title: "當沖淨損益", sortKey: "daytrade_profit", colClassName: "stock-col-money" },
  { id: "daytrade_win_rate", title: "當沖勝率", sortKey: "daytrade_win_rate", colClassName: "stock-col-rate" },
  { id: "long_profit", title: "多單收益", sortKey: "long_profit", colClassName: "stock-col-money" },
  { id: "short_profit", title: "空單收益", sortKey: "short_profit", colClassName: "stock-col-money" },
  { id: "daytrade_profit_loss_ratio", title: "當沖盈虧比", sortKey: "daytrade_profit_loss_ratio", colClassName: "stock-col-ratio" },
  { id: "long_profit_loss_ratio", title: "多單盈虧比", sortKey: "long_profit_loss_ratio", colClassName: "stock-col-ratio" },
  { id: "short_profit_loss_ratio", title: "空單盈虧比", sortKey: "short_profit_loss_ratio", colClassName: "stock-col-ratio" },
].map((column) => ({ ...column, sortable: Boolean(column.sortKey) })), { divider: false, resizable: false }), { id: "accountStockStats" });

export const ACCOUNT_DAILY_COLUMNS = defineColumnSchema(withCapabilities([
  { id: "date", title: "日期", sortKey: "date" },
  { id: "settlement", title: "交割款", sortKey: "settlement" },
  { id: "today_realized", title: "交易實現", sortKey: "today_realized" },
  { id: "normal_profit", title: "現股實現", sortKey: "normal_profit" },
  { id: "daytrade_profit", title: "當沖實現", sortKey: "daytrade_profit" },
  { id: "daytrade_profit_loss_ratio", title: "當沖盈虧比", sortKey: "daytrade_profit_loss_ratio" },
  { id: "normal_trade_diff", title: "現股買賣", sortKey: "normal_trade_diff" },
  { id: "long_profit", title: "多單收益", sortKey: "long_profit" },
  { id: "short_profit", title: "空單收益", sortKey: "short_profit" },
  { id: "cumulative_normal_profit", title: "現股累積實現", sortKey: "cumulative_normal_profit" },
  { id: "cumulative_daytrade_profit", title: "當沖累積實現", sortKey: "cumulative_daytrade_profit" },
].map((column) => ({ ...column, sortable: Boolean(column.sortKey) })), { divider: false, resizable: false }), { id: "accountDaily" });

export const ACCOUNT_RANKING_COLUMNS = defineColumnSchema(withCapabilities([
  { id: "date", title: "日期" }, { id: "code", title: "股號" }, { id: "direction", title: "方向" },
  { id: "entry", title: "進場" }, { id: "exit", title: "出場" }, { id: "hold", title: "持有" },
  { id: "profit", title: "損益" }, { id: "roi", title: "收益%" }, { id: "trend", title: "走勢" },
], { divider: false, sortable: false, resizable: false }), { id: "accountRanking" });

export const ACCOUNT_DIRECTION_REPORT_COLUMNS = defineColumnSchema(withCapabilities([
  { id: "date", title: "日期" }, { id: "code", title: "股號" }, { id: "name", title: "股名" },
  { id: "entry", title: "進場" }, { id: "exit", title: "出場" }, { id: "hold", title: "持有" },
  { id: "direction", title: "方向" }, { id: "buy", title: "買進" }, { id: "sell", title: "賣出" },
  { id: "profit", title: "損益" }, { id: "roi", title: "收益%", headerId: "actualDirectionReportCount" },
], { divider: false, sortable: false, resizable: false }), { id: "accountDirectionReport" });

export const ACCOUNT_RAW_TRADES_COLUMNS = defineColumnSchema(withCapabilities([
  { id: "date", title: "日期" }, { id: "time", title: "時間" }, { id: "code", title: "股號" },
  { id: "name", title: "股名" }, { id: "action", title: "買賣" }, { id: "qty", title: "股數" },
  { id: "price", title: "單價" }, { id: "avg_price", title: "均價" }, { id: "fee", title: "手續費" },
  { id: "tax", title: "交易稅" },
], { divider: false, sortable: false, resizable: false }), { id: "accountRawTrades" });

export const ACCOUNT_PAIR_COLUMNS = defineColumnSchema(withCapabilities([
  { id: "date", title: "日期", sortKey: "date" },
  { id: "total_profit", title: "總損益", sortKey: "total_profit" },
  { id: "daytrade_profit", title: "當沖收益", sortKey: "daytrade_profit" },
  { id: "normal_profit", title: "一般收益", sortKey: "normal_profit" },
  { id: "long_profit", title: "多單收益", sortKey: "long_profit" },
  { id: "short_profit", title: "空單收益", sortKey: "short_profit" },
  { id: "cumulative_normal_profit", title: "現股累積實現", sortKey: "cumulative_normal_profit" },
  { id: "cumulative_daytrade_profit", title: "當沖累積實現", sortKey: "cumulative_daytrade_profit" },
].map((column) => ({ ...column, sortable: Boolean(column.sortKey) })), { divider: false, resizable: false }), { id: "accountPairs" });



// Model Center/DataGrid headers are not static HTML. They use
// the same Title engine; DataGrid remains only the scrolling/row shell.
export const TRAINING_TOURNAMENT_COLUMNS = defineColumnSchema([
  ["model","Model"],["status","Status"],["val_log_loss","Val LogLoss"],["val_auc","Val AUC"],["val_brier","Val Brier"],
  ["test_log_loss","Test LogLoss"],["test_auc","Test AUC"],["samples","Train / Val / Test"],["export_diff","ONNX Δ"],
].map(([id,title]) => ({ id, title })), { id: "trainingTournament" });
export const TRAINING_DATASET_HEALTH_COLUMNS = defineColumnSchema([
  ["date","日期"],["rows","Rows"],["shard","Shard"],["status","Status"],["problems","排除的分區"],
].map(([id,title]) => ({ id, title })), { id: "trainingDatasetHealth" });
export const TRAINING_LABEL_SET_COLUMNS = defineColumnSchema([
  ["label","Label"],["samples","Samples"],["valid","Valid"],["missing","Missing"],["distribution","Distribution"],
].map(([id,title]) => ({ id, title })), { id: "trainingLabelSet" });
export const TRAINING_MODEL_REGISTRY_COLUMNS = defineColumnSchema([
  ["target","Target"],["model_id","Champion"],["model","Model"],["val_auc","Val AUC"],["dataset","Dataset"],["feature","Feature Spec"],["status","Status"],["reason","Reason"],
].map(([id,title])=>({id,title})), { id: "trainingModelRegistry" });

export const COLUMN_SCHEMA_REGISTRY = Object.freeze(new Map([
  EVENT_FEED_COLUMNS, TICK_DETAILS_COLUMNS, TRADE_DETAILS_COLUMNS, 
  ACCOUNT_STOCK_NORMAL_TRADE_COLUMNS, ACCOUNT_STOCK_DAYTRADE_COLUMNS, ACCOUNT_DAYTRADE_DETAIL_COLUMNS, REALTIME_QUOTE_COLUMNS, REALTIME_HOLDING_COLUMNS,
  ACCOUNT_HOLDINGS_COLUMNS, ACCOUNT_STOCK_STATS_COLUMNS, ACCOUNT_DAILY_COLUMNS, ACCOUNT_RANKING_COLUMNS,
  ACCOUNT_DIRECTION_REPORT_COLUMNS, ACCOUNT_RAW_TRADES_COLUMNS, ACCOUNT_PAIR_COLUMNS,
  PAPER_LEDGER_ORDER_COLUMNS, PAPER_LEDGER_REALIZED_COLUMNS, PAPER_LEDGER_POSITION_COLUMNS,
  TRAINING_TOURNAMENT_COLUMNS, TRAINING_DATASET_HEALTH_COLUMNS, TRAINING_LABEL_SET_COLUMNS, TRAINING_MODEL_REGISTRY_COLUMNS,
].map((schema) => [schema.schemaId, schema])));

export function resolveColumnSchema(schemaId) { return COLUMN_SCHEMA_REGISTRY.get(String(schemaId || "")) || null; }

export function hydrateCanonicalColumnTitles(root = document) {
  const scope = root?.querySelectorAll ? root : document;
  scope.querySelectorAll("thead[data-column-schema]").forEach((thead) => {
    const schema = resolveColumnSchema(thead.dataset.columnSchema);
    const table = thead.closest("table");
    if (!schema || !table) return;
    // Hydration happens before DataGrid shell creation. Host-specific sort/resize
    // callbacks are mounted later; this pass only guarantees one canonical Title DOM.
    ensureColumnSchema(table, schema, { schemaId: schema.schemaId, interactions: false });
  });
}
