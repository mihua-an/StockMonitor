// Where a 買賣報價 price clicked on 即時報價 opens a 模擬 order (docs/system-architecture/11 §3, user 10-27): a 模擬帳務
// on the page (any pane, any tab) comes to the front and opens its 下單 panel at that price; without one, the popover
// opens beside the 買賣報價. Only 台股 stocks (the paper desk's market).

export function createPaperOrderEntry({ selectComponent, mountedComponent, popover }) {
  return {
    open({ code, name = "", price = null, market = "", anchor = null, vm = null } = {}) {
      const stock = String(code || "").trim().toUpperCase();
      if (!stock || String(market || "").toUpperCase() !== "STK" || !(Number(price) > 0)) return false;
      let ledger = mountedComponent("paperLedger");
      if (!ledger) {
        selectComponent("paperLedger");
        ledger = mountedComponent("paperLedger");
      }
      if (ledger?.openOrderAt) {
        popover?.close();
        ledger.openOrderAt({ code: stock, name, price: Number(price) });
        return true;
      }
      popover?.open({ code: stock, name, price: Number(price), anchor, vm });
      return true;
    },
  };
}
