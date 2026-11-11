// 實際帳務 → 手機卡片: every phone widget is drawn from the published package, and the day-dependent picks follow
// integrations/gas_web_app/Mobile.gs (historyTrade newest weekday first; entry-time weekdays by today).
import assert from "node:assert/strict";
import { chooseMobileCardOption, mobileCardsMarkup } from "../ui/renderer/js/features/account/mobile_cards_view.js";

const band = (label) => ({ timeRange: label, range: label, totalProfit: 1200, winRate: 0.5, longWinRate: 0.75, shortWinRate: "-", longProfit: 1500, shortProfit: -300 });
const entries = {
  summary: { holdingCost: 250000, stockProfit: 12345.5, daytradingProfit: -800, dayTarget: 0, weekTarget: 800, monthTarget: 0 },
  holdings: { activeHoldings: [{ code: "2330", name: "台積電", shares: 1000, costPerShare: 950, valH: 950000 }] },
  dayTradeWeekSummary: { items: [{ weekday: "一", ...band("") }], dayTradeWinRate: 0.6, dayTradeLongWinRate: 0.7, dayTradeShortWinRate: 0.4 },
  dayTradePriceSummary: { items: [band("0~50")] },
  "historyTrade:2026/10/07": { date: "2026/10/07", totalSettlement: -95000, dayTrade: { profit: 500, items: [{ code: "2317", name: "鴻海", direction: "多", volume: 1000, buyPrice: 200, sellPrice: 201, buyTime: "09:01", sellTime: "10:00", profit: 500 }] },
    normalTrade: { profit: 0, items: [] }, usTrade: { profit: 0, items: [] } },
  "historyTrade:2026/10/06": { date: "2026/10/06", totalSettlement: 0, dayTrade: { profit: 0, items: [] }, normalTrade: { profit: 0, items: [] }, usTrade: { profit: 0, items: [] } },
  "dayTradeEntryTime:3": { weekdayLabel: "週三", summary: { longWinRate: 0.5, shortWinRate: 0.25 }, items: [band("09:00~09:30")] },
  "dayTradeEntryTime:4": { weekdayLabel: "週四", summary: { longWinRate: 1, shortWinRate: "-" }, items: [] },
  "dayTradeEntryTime:week": { weekdayLabel: "整週", summary: {}, items: [] },
  "rank:spot:profit": { data: [{ code: "2330", name: "台積電", profit: 9000, rate: 0.1234 }] },
  "rank:spot:loss": { data: [{ code: "2603", name: "長榮", profit: -4000, rate: -0.05 }] },
  "realizedReport:day": { items: [{ date: "10/07", spotRealized: 0, dayTradeRealized: 500, stockRealized: 500, spotAccumulated: 1, dayTradeAccumulated: 2, recentDayTradeAccumulated: 500 }] },
  "realizedReport:month": { items: [{ date: "26/10", spotRealized: 7, dayTradeRealized: 8, stockRealized: 15, spotAccumulated: 1, dayTradeAccumulated: 2, recentDayTradeAccumulated: 8 }] },
};
const profitClass = (v) => (Number(v) > 0 ? "up" : Number(v) < 0 ? "down" : "flat");
const wednesday = new Date("2026-10-07T12:00:00");
const markup = () => mobileCardsMarkup({ entries }, { profitClass, today: wednesday });
const html = markup();

for (const title of ["交易總覽", "庫存總覽", "交易明細", "當沖週結明細", "當沖價格勝率表", "當沖時間勝率", "現股排名", "當沖排名", "美股排名", "日實現報表"]) {
  assert.ok(html.includes(title), `card ${title} is drawn`);
}
assert.ok(html.includes("12,345.5") && html.includes('class="down">-800'), "amounts are formatted and coloured by sign");
assert.ok(html.includes("今日 10/07 週三") && html.includes("鴻海"), "the newest weekday is today's detail");
assert.ok(html.includes("週三 當沖時間勝率") && html.includes("50.0%") && html.includes(">-<"), "Wednesday shows Wednesday first; '-' stays '-'");
assert.ok(html.includes("12.34%"), "rank rate is a fraction shown in percent");

assert.ok(html.includes('class="settings-seg"') && html.includes('class="settings-seg-btn is-active"') && !html.includes("mobile-card-tabs"),
  "the tabs are the shared segmented control");

chooseMobileCardOption("entryTime", "second");
assert.ok(markup().includes("週四 當沖時間勝率"), "the second tab is the next weekday");
chooseMobileCardOption("rank:spot", "loss");
assert.ok(markup().includes("長榮") && !markup().includes("9,000"), "賠錢 switches the 現股 ranking");
chooseMobileCardOption("period", "month");
assert.ok(markup().includes("月實現報表") && markup().includes("26/10"));
chooseMobileCardOption("historyDate", "2026/10/06");
assert.ok(markup().includes("沒有當沖") && !markup().includes("鴻海"), "picking another date shows that day");

console.log("renderer mobile cards contract passed");
