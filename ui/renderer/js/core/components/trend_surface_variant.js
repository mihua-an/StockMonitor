// Every kind of trend surface TrendChartComponent can be, and what each one does -- declared once here instead of
// `variant === "stock"` tests spread through the component. A name not in the table is refused where the surface is
// made or reconfigured.
//   liveControls:  the control row (加權 / 期貨 / 個股 switch, 期貨 sessions) in live mode
//   benchmarks:    the 加權 / 期貨 benchmark overlays (and their toolbar, unless the host has its own switch)
//   searchable:    the header's code box queries a product
//   showsCode:     the header shows a code (期貨走勢 has its session buttons there; 產業指數 its name only)
//   controlsInHeader: the control row sits in the header, between the name and the price
const VARIANTS = {
  auto: {},
  market: { liveControls: true },
  futures: { liveControls: true, showsCode: false, controlsInHeader: true },
  stock: { liveControls: true, benchmarks: true, searchable: true },
  sector: { showsCode: false },
  taiex: {},
  "us-stock": {},
};

const DEFAULTS = { liveControls: false, benchmarks: false, searchable: false, showsCode: true, controlsInHeader: false };

export const TREND_SURFACE_VARIANTS = Object.freeze(Object.fromEntries(Object.entries(VARIANTS)
  .map(([name, spec]) => [name, Object.freeze({ name, ...DEFAULTS, ...spec })])));

export function trendSurfaceVariant(name = "auto") {
  const key = String(name || "auto");
  const spec = Object.hasOwn(TREND_SURFACE_VARIANTS, key) ? TREND_SURFACE_VARIANTS[key] : null;
  if (!spec) throw new TypeError(`TrendChartComponent: unknown variant ${JSON.stringify(key)} (one of ${Object.keys(TREND_SURFACE_VARIANTS).join(", ")})`);
  return spec;
}
