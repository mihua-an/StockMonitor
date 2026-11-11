// A user's saved settings (layout, column widths, display choices) are stored under names that never change: a renamed
// or "V2" key starts every user from the defaults (the 10-16 merge reset the 即時報價 pane layout that way). This list
// is every stored name in use; a name may be added, but none may disappear or be replaced, and a new one carries no
// version number (user decision 10-16: change the code, keep the name).
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const STORED = [
  "accountLedgerMode", "actualAccountDailySortDirection", "actualAccountDailySortKey", "actualAccountDaytradeEntrySortDirection",
  "actualAccountDaytradeEntrySortKey", "actualAccountDaytradeHoldSortDirection", "actualAccountDaytradeHoldSortKey",
  "actualAccountPairSortDirection", "actualAccountPairSortKey", "actualAccountStockSortDirection", "actualAccountStockSortKey",
  "actualHoldingsQuoteColumnsV1", "globalTradeAction", "historyReplayPaneLayout", "historyReplayWorkspaceLayout", "historyTickDetailsColumnWidthsV2",
  "historyTradeRecordsColumnWidthsV1", "marketDiagnostics", "monitorScreenLayouts",
  "monitorQuoteColumnWidthsV2:", "moomooSelectedCodeV1:", "moomooTrendSessionV1", "moomooWatchPageActiveV1",
  "realtimeIndustryIndex", "realtimeProductSides", "realtimeTickDetailsColumnWidthsV3:", "settingsSection", "shioajiActiveWatchPageV1", "shioajiLiveEventWidthsV1",
  "shioajiMarketPanelUiStateV1", "shioajiMonitorQuoteColumnsV1", "shioajiSlotLayoutConfigV9", "shioajiTrendOverlayV1:",
  "stockmonitor.stockTrendEventMarkers.v1", "stockmonitor.trendFooterHorizons.v1", "technicalAnalysisTimeframeV1",
  "tickDetailsMinVolumeV1:", "workspace.members",
];
// Runtime registry symbols (Symbol.for), not storage.
const NOT_STORAGE = new Set(["shioaji.renderer.sharedRowScrollRuntime.v1", "shioaji.renderer.standardDataGridRuntime.v1"]);

const root = new URL("../ui/", import.meta.url);
const files = [];
const walk = (dir) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else if (path.endsWith(".js")) files.push(path); } };
walk(root.pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const source = files.map((path) => readFileSync(path, "utf8")).join("\n");

for (const name of STORED) assert.ok(source.includes(name), `stored setting name "${name}" disappeared: a user's saved value is lost`);
const versioned = [...source.matchAll(/["'`]([a-zA-Z][A-Za-z.]*(?:V\d+|\.v\d+))(:[^"'`]*)?["'`]/g)].map((m) => m[1] + (m[2] !== undefined ? ":" : ""));
const unknown = [...new Set(versioned)].filter((name) => !NOT_STORAGE.has(name) && !STORED.some((known) => known === name || known === `${name}:`));
assert.deepEqual(unknown, [], "a new stored name carries no version number (and an existing one is never replaced by a V+1)");
console.log("renderer user setting keys contract passed");
