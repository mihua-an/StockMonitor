// Which components a dashboard can mount (core and feature components alike). Composition, not core: core/ never
// imports a feature; each entry point imports this once.
import { componentRegistry } from "./core/component_registry.js";
import { EventFeedComponent } from "./core/components/event_feed_component.js";
import { OrderBookComponent } from "./core/components/orderbook_component.js";
import { TickDetailsComponent } from "./core/components/tick_details_component.js";
import { TradeDetailsComponent } from "./core/components/trade_details_component.js";
import { TradeFlowComponent } from "./core/components/trade_flow_component.js";
import { PriceFlowComponent } from "./core/components/price_flow_component.js";
import { TrendChartComponent } from "./core/components/trend_chart_component.js";
import { TechnicalAnalysisComponent } from "./features/realtime/components/technical_analysis_component.js";
import { TechnicalWindowComponent } from "./features/realtime/components/technical_window_component.js";
import { PaperLedgerComponent } from "./features/realtime/components/paper_ledger_component.js";
import { IndustryIndexListComponent } from "./features/realtime/components/industry_index_list_component.js";
import { UnifiedProductListComponent, MoomooProductListComponent, MoomooTrendComponent, MoomooTradesComponent, MoomooOrderBookComponent } from "./features/realtime/components/moomoo_components.js";

let registered = false;

const CONFIGURABLE_SLOTS = [
  "productList",
  "liveInfo",
  "topAuxiliary",
  "analysisPrimary",
  "analysisQuaternary",
  "analysisSecondary",
  "analysisTertiary",
  "auxiliary",
  "analysisQuinary",
  "workspacePane",
  "replayPrimary",
  "replayEvent",
  "replayTradeDetails",
  "replayTertiary",
  "replaySecondary",
  "replayAuxiliary",
  "replayPriceFlow",
  "replayTechnical",
  "detached",
];

export function registerDashboardComponents() {
  if (registered) return componentRegistry;
  registered = true;

  componentRegistry.register({
    id: "technicalAnalysis", title: "技術分析", supportedHosts: ["inline"],
    analysisSourced: true, chooser: { row: 4, order: 1 },
    supportedSlots: CONFIGURABLE_SLOTS, supportedModes: ["live", "replay"], requiredCapabilities: ["trend"],
    create: () => new TechnicalAnalysisComponent(),
  });

  componentRegistry.register({
    id: "technicalWindow", title: "技術分析", supportedHosts: ["detached"], availableInSlotEditor: false,
    supportedSlots: ["detached"], supportedModes: ["live"],
    create: () => new TechnicalWindowComponent(),
  });

  componentRegistry.register({
    id: "productList", title: "Shioaji 商品列表", supportedHosts: ["inline"], chooser: { row: 0, order: 0 },
    supportedSlots: CONFIGURABLE_SLOTS, supportedModes: ["live"], create: () => new UnifiedProductListComponent(),
  });
  componentRegistry.register({
    id: "productListA", provider: "futu", title: "Futu 商品列表", supportedHosts: ["inline"], chooser: { row: 0, order: 0 },
    supportedSlots: CONFIGURABLE_SLOTS, supportedModes: ["live"], create: () => new MoomooProductListComponent(),
  });
  componentRegistry.register({
    id: "stockTrendA", provider: "futu", title: "Futu 個股走勢", tabTitle: "個股走勢", supportedHosts: ["inline"],
    analysisSourced: true,
    chooser: { row: 4, order: 0 },
    supportedSlots: CONFIGURABLE_SLOTS, supportedModes: ["live"], create: () => new MoomooTrendComponent(),
  });
  componentRegistry.register({
    id: "tickDetailsA", provider: "futu", title: "Futu 成交明細", tabTitle: "成交明細", supportedHosts: ["inline"],
    chooser: { row: 6, order: 0 },
    supportedSlots: CONFIGURABLE_SLOTS, supportedModes: ["live"],
    create: () => new MoomooTradesComponent(),
  });
  componentRegistry.register({
    id: "orderbookA", provider: "futu", title: "Futu 買賣報價", tabTitle: "買賣報價", supportedHosts: ["inline"],
    chooser: { row: 5, order: 0 },
    supportedSlots: CONFIGURABLE_SLOTS, supportedModes: ["live"], create: () => new MoomooOrderBookComponent(),
  });

  componentRegistry.register({
    id: "orderbook",
    title: "買賣報價",
    supportedHosts: ["inline", "detached"],
    chooser: { row: 5, order: 0 },
    supportedSlots: CONFIGURABLE_SLOTS,
    supportedModes: ["live", "replay"],
    requiredCapabilitiesByMode: { live: ["bidask"], replay: ["historical_bidask"] },
    create: () => new OrderBookComponent(),
  });

  // The workspace's 買賣報價: the same component without the 逐價內外盤 bar (by request).
  componentRegistry.register({
    id: "workspaceOrderbook",
    title: "買賣報價",
    supportedHosts: ["detached"],
    supportedSlots: CONFIGURABLE_SLOTS,
    supportedModes: ["live"],
    requiredCapabilitiesByMode: { live: ["bidask"] },
    availableInSlotEditor: false,
    create: () => new OrderBookComponent({ showPriceVolume: false, productHeader: false }),
  });

  componentRegistry.register({
    id: "trendChart",
    analysisSourced: true,
    title: "走勢圖",
    supportedHosts: ["inline", "detached"],
    supportedSlots: CONFIGURABLE_SLOTS,
    supportedModes: ["live", "replay"],
    requiredCapabilities: ["trend"],
    reuseGroup: "trend-chart",
    dataKey: "trendChart",
    variant: "auto",
    availableInSlotEditor: false,
    create: () => new TrendChartComponent(),
  });

  // 歷史回放's 個股走勢: the trend surface in replay mode, in the page's top-left slot under its own 個股走勢 tab (its
  // controls in that tab bar, as 即時報價's 個股走勢).
  componentRegistry.register({
    id: "replayTrend",
    title: "個股走勢",
    supportedHosts: ["inline"],
    supportedSlots: ["replayPrimary"],
    supportedModes: ["replay"],
    requiredCapabilities: ["trend"],
    dataKey: "trendChart",
    variant: "auto",
    create: () => new TrendChartComponent(),
  });

  // The multi-symbol workspace needs a "stock" variant TrendChartComponent
  // (so benchmark overlay activates) mountable in a "detached"-type host,
  // unlike stockTrend below (inline-only) and trendChart above (variant
  // "auto", overlay never enabled). Reuses the exact same class/data flow --
  // only the fixed constructor variant and host support differ.
  componentRegistry.register({
    id: "workspaceTrendChart",
    analysisSourced: true,
    title: "個股走勢",
    supportedHosts: ["detached"],
    supportedSlots: CONFIGURABLE_SLOTS,
    supportedModes: ["live"],
    requiredCapabilities: ["trend"],
    dataKey: "trendChart",
    variant: "stock",
    availableInSlotEditor: false,
    // A column's benchmark is its product type's (the view model's `benchmark`); its 盤中事件 switch is the window's.
    create: () => new TrendChartComponent({ dataKey: "trendChart", variant: "stock", infoLines: false, overlayToolbar: false, controlRow: false }),
  });

  for (const [id, title, variant, chooser] of [
    ["marketTrend", "加權走勢", "market", { row: 1, order: 0 }],
    ["futuresTrend", "期貨走勢", "futures", { row: 1, order: 1 }],
    ["stockTrend", "個股走勢", "stock", { row: 4, order: 0 }],
  ]) {
    componentRegistry.register({
      id,
      analysisSourced: true,
      title,
      supportedHosts: ["inline"],
      chooser,
      supportedSlots: CONFIGURABLE_SLOTS,
      supportedModes: ["live"],
      requiredCapabilities: ["trend"],
      reuseGroup: "trend-chart",
      dataKey: id,
      variant,
      // No 加權／期貨 overlay switch: 個股走勢's benchmark is its product type's (the view model's `benchmark`).
      create: () => new TrendChartComponent({ dataKey: id, variant, overlayToolbar: false }),
    });
  }

  // 產業指數 (BACKLOG 1v): the current industry index (features/realtime/industry_index_store.js) on the shared trend
  // surface with its own constituents' breadth, and the list that picks it. Not in the trend reuse group: its breadth row
  // is its own index's, so a surface is never reconfigured between it and the exchange-wide trends.
  componentRegistry.register({
    id: "industryIndexTrend",
    analysisSourced: true,
    title: "產業指數",
    supportedHosts: ["inline"],
    chooser: { row: 2, order: 0 },
    supportedSlots: CONFIGURABLE_SLOTS,
    supportedModes: ["live"],
    requiredCapabilities: ["trend"],
    dataKey: "industryIndexTrend",
    variant: "sector",
    create: () => new TrendChartComponent({ dataKey: "industryIndexTrend", variant: "sector" }),
  });
  componentRegistry.register({
    id: "industryIndexList",
    title: "Shioaji產業指數",
    supportedHosts: ["inline"],
    chooser: { row: 2, order: 1 },
    supportedSlots: CONFIGURABLE_SLOTS,
    supportedModes: ["live"],
    create: () => new IndustryIndexListComponent(),
  });

  componentRegistry.register({
    id: "tradeFlow",
    analysisSourced: true,
    title: "大單流向",
    supportedHosts: ["inline", "detached"],
    chooser: { row: 7, order: 0 },
    supportedSlots: CONFIGURABLE_SLOTS,
    supportedModes: ["live", "replay"],
    requiredCapabilities: ["tradeflow"],
    create: () => new TradeFlowComponent(),
  });

  // 價量: per traded price, 大單／小單 買賣量 (Rust B's ladder flow).
  componentRegistry.register({
    id: "priceFlow",
    analysisSourced: true,
    title: "價量",
    supportedHosts: ["inline"],
    chooser: { row: 7, order: 1 },
    supportedSlots: CONFIGURABLE_SLOTS,
    supportedModes: ["live", "replay"],
    requiredCapabilities: ["tradeflow"],
    create: () => new PriceFlowComponent(),
  });

  componentRegistry.register({
    id: "eventFeed",
    title: "事件資訊",
    titleByMode: { live: "即時資訊", replay: "歷史事件" },
    supportedHosts: ["inline", "detached"],
    chooser: { row: 3, order: 0 },
    supportedSlots: CONFIGURABLE_SLOTS,
    supportedModes: ["live", "replay"],
    requiredCapabilitiesByMode: { live: ["monitor_events"], replay: ["historical_events"] },
    create: () => new EventFeedComponent(),
  });

  // 模擬帳務 (docs/system-architecture/11 §11): the paper ledger after the orders -- 委託, 成交, 未實現, 刪改. Live only:
  // a replay's orders never reach the ledger.
  componentRegistry.register({
    id: "paperLedger",
    title: "模擬帳務",
    supportedHosts: ["inline"],
    chooser: { row: 8, order: 0 },
    supportedSlots: CONFIGURABLE_SLOTS,
    supportedModes: ["live"],
    create: () => new PaperLedgerComponent(),
  });

  componentRegistry.register({
    id: "tickDetails",
    title: "成交明細",
    supportedHosts: ["inline"],
    chooser: { row: 6, order: 0 },
    supportedSlots: CONFIGURABLE_SLOTS,
    supportedModes: ["live", "replay"],
    requiredCapabilitiesByMode: { live: ["tick"], replay: ["historical_tick"] },
    create: () => new TickDetailsComponent(),
  });

  // The current canonical trade-details dataset is realized day-trade history.
  // Do not expose a fake Live implementation until a genuine live/open-trade
  // adapter exists.
  componentRegistry.register({
    id: "tradeDetails",
    title: "交易明細",
    supportedHosts: ["inline", "detached"],
    supportedSlots: CONFIGURABLE_SLOTS,
    supportedModes: ["replay"],
    requiredCapabilities: ["actual_trades"],
    create: () => new TradeDetailsComponent(),
  });

  return componentRegistry;
}

registerDashboardComponents();
