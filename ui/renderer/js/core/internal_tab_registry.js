export class InternalTabRegistry {
  constructor() {
    this.providers = new Map();
  }

  register(panelId, provider) {
    const id = String(panelId || "").trim();
    if (!id) throw new Error("internal tab panel id is required");
    if (typeof provider !== "function") throw new Error(`internal tab provider ${id} must be a function`);
    this.providers.set(id, provider);
    return () => this.providers.delete(id);
  }

  resolve(panelId, context = {}) {
    const provider = this.providers.get(String(panelId || ""));
    if (!provider) return [];
    const tabs = provider(context);
    return Array.isArray(tabs) ? tabs : [];
  }

  has(panelId) {
    return this.providers.has(String(panelId || ""));
  }
}

export const internalTabRegistry = new InternalTabRegistry();

internalTabRegistry.register("eventFeed:live", ({ watchPages = [] } = {}) => [
  { id: "overview", name: "總覽", codes: null, closable: false },
  ...(Array.isArray(watchPages) ? watchPages : []).map((page) => ({
    id: String(page?.id || ""),
    name: String(page?.name || page?.id || ""),
    codes: Array.isArray(page?.codes) ? page.codes.map(String) : [],
    closable: false,
  })).filter((tab) => tab.id),
]);

internalTabRegistry.register("eventFeed:replay", ({ selectedSymbol = "", selectedName = "" } = {}) => {
  const symbol = String(selectedSymbol || "").trim();
  const name = String(selectedName || "").trim();
  return [
    { id: "ALL", name: "總覽", title: "當日所有歷史事件", closable: false },
    ...(symbol ? [{ id: "SELECTED", name: symbol, title: `${symbol}${name ? ` ${name}` : ""}－當日歷史事件`, closable: false }] : []),
  ];
});
