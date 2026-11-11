import { CleanupBag } from "../cleanup_bag.js";
import { mountShell, shellElement } from "../component_shell.js";
import { PresentationRevisionGate } from "../display_frame_gate.js";
import { onElementResize } from "../element_size.js";
import { setStockTrendEventMarkersVisible, stockTrendEventMarkersVisible, subscribeStockTrendEventMarkers } from "../event_markers.js";
import { getMarketBreadth, subscribeMarketBreadth } from "../market_breadth_store.js";
import { trendReadView } from "../market_read_model.js";
import { subscribeTrendFooterHorizons } from "../trend_footer_horizons.js";
import { renderTrendSessionControl } from "../trend_session_control.js";
import { preserveTrendSurface, restoreTrendSurface } from "../trend_surface_state.js";
import { byRole as role } from "../utility.js";
import { syncViewLifecycle } from "../view_lifecycle.js";
import { ensureProductQuoteSearch, setProductQuoteSearchable } from "./product_quote_header.js";
import { TrendCanvasController, findCanvas, trendFrames } from "./trend_canvas_frames.js";
import { TrendHeaderPresenter, syncEventMarkerToggle } from "./trend_header_presenter.js";
import { TrendOverlayController } from "./trend_overlay_state.js";
import { trendSurfaceVariant } from "./trend_surface_variant.js";
import {
  controlRowShell, ownBreadth, REPLAY_SECONDARY_ROWS, replayControlRowShell, replayTrendShell, secondaryInfoRowShell, secondaryRowKinds, shell,
  taiwanTrendShell,
} from "./trend_surface_shell.js";

export class TrendChartComponent {
  /**
   * `lineChart: false` keeps the surface -- header, info rows, breadth -- without the line chart: no manager, no
   * point projection, no overlays. 技術分析 draws candles in this surface; no invisible line chart runs behind
   * them.
   */
  constructor({ dataKey = "trendChart", variant = "auto", manual = false, lineChart = true, infoLines = true, overlayToolbar = true, controlRow = true } = {}) {
    this.infoLines = Boolean(infoLines);
    // A host that gives the row's controls a place of its own (the workspace's 盤中事件 switch) draws no control row.
    this.showControlRow = Boolean(controlRow);
    // 個股走勢's own 加權 / 期貨 overlay toolbar; a host whose view models name the benchmark has none.
    this.overlayToolbar = Boolean(overlayToolbar);
    this.lineChart = lineChart !== false;
    this.host = null; this.context = null; this.canvas = null; this.cleanup = new CleanupBag("trend chart");
    this.dataCleanup = null;
    this.lastVm = null; this.dataKey = String(dataKey || "trendChart");
    this.chart = new TrendCanvasController();
    this.variant = String(variant || "auto");
    this.variantSpec = trendSurfaceVariant(this.variant);
    this.header = new TrendHeaderPresenter();
    this.slotId = "";
    this.overlays = new TrendOverlayController(this);
    this.showControls = false; this.showToolbar = false;
    this.manual = Boolean(manual);
    this.displayFrameGate = null;
  }

  // The control row shows in live mode for the kinds that have one; the benchmark toolbar only where the surface draws
  // benchmarks and the host has no switch of its own (overlayToolbar).
  _syncControlFlags() {
    this.showControls = this.context?.mode === "live" && this.variantSpec.liveControls;
    this.showToolbar = this.showControls && this.variantSpec.benchmarks && this.overlayToolbar;
  }

  /** This surface's identity: one slot, one variant. Same scope the overlays' storage key uses. */
  _surfaceKey() { return `${this.slotId || "detached"}:${this.variant}`; }

  /**
   * Make the canvas say exactly which surface it is. The single writer of data-trend-view: a page
   * must never stamp it, because only this component knows which variant it is currently serving.
   */
  _applyCanvasIdentity() {
    if (!this.canvas) return;
    const surfaceKey = this._surfaceKey();
    // Every canvas is this component's: reconfigure() changes which variant it is, so its name is re-stamped.
    this.canvas.id = `trendCanvas-${this.slotId || "detached"}-${this.variant}`;
    // Frame/reference numbers describe frames some OTHER variant drew into these nodes. Left behind,
    // a stock chart's reference and reference-change count read as the futures panel's, and a view
    // that has drawn nothing yet reports the previous view's point count.
    if (this.canvas.dataset.trendSurface && this.canvas.dataset.trendSurface !== surfaceKey) trendFrames.delete(this.canvas);
    this.canvas.dataset.trendSurface = surfaceKey;
    this.canvas.dataset.trendView = this.variant === "auto" ? "market" : this.variant;
    // 個股走勢's crosshair card docks on the 即時報價 order book (realtime.html declares the target, F2); any other
    // surface's card sits beside its canvas.
    if (!this.manual && this.lineChart && this.dataKey === "stockTrend") this.canvas.dataset.trendLookupDock = "realtime-orderbook";
    else delete this.canvas.dataset.trendLookupDock;
  }

  /** The series this surface shows, for the chart's crosshair card (F2): read from this surface's own header. */
  _seriesIdentity() {
    const text = (role, cls) => {
      const value = (this.host?.querySelector?.(`[data-role="${role}"]`) || this.host?.querySelector?.(cls))?.textContent?.trim();
      return value && value !== "--" && value !== "----" ? value : "";
    };
    return { name: text("product-name", ".product-quote-name") || "走勢", code: text("product-code", ".product-quote-code") };
  }

  /**
   * Make the secondary information rows match the VARIANT this surface is currently serving: reconfigure() changes
   * which view a surface IS without remounting it, so the previous variant's rows are replaced by the ones
   * secondaryInfoRowShell() builds for the new variant.
   *
   * A stock surface wants [stock facts, exchange breadth]; an index surface wants [exchange
   * breadth]. Reconciling the whole ordered list, not just the first row, is what lets 個股走勢
   * carry both without either row displacing the other.
   *
   * Keyed on the presence of the Taiwan info-lines block: the replay surface and the manual surfaces have none.
   */
  _syncSecondaryInfoRow() {
    if (this.manual) return;
    const infoLines = this.host?.querySelector?.(".trend-info-lines");
    if (!infoLines) return;
    const wanted = this._secondaryRows();
    const existing = Array.from(infoLines.querySelectorAll?.("[data-secondary-row]") || []);
    const present = existing.map((node) => String(node?.dataset?.secondaryRow || ""));
    if (present.length === wanted.length && present.every((kind, index) => kind === wanted[index])) return;
    for (const stale of existing) stale.remove();
    for (const kind of wanted) infoLines.appendChild(shellElement(secondaryInfoRowShell(kind)));
    // Fresh rows ship "--". reconfigure() swaps rows without re-subscribing, and the breadth store
    // only notifies on change, so 加權走勢 -> 個股走勢 would otherwise show five dashes until the
    // exchange published a different snapshot. The new nodes are painted once from their owner: the store, or for an
    // own-breadth surface the view model it last drew.
    this.header.syncBreadth(ownBreadth(this.variant) ? this.lastVm?.breadth || {} : getMarketBreadth());
  }

  // The rows under the chart. A replay (歷史回放, and its 技術分析) shows one stock's recorded day: the exchange breadth
  // row would show the breadth store's counts, which are today's live ones, so it has none.
  _secondaryRows() {
    if (this._isReplaySurface()) return REPLAY_SECONDARY_ROWS;
    const kinds = secondaryRowKinds(this.variant);
    return this.context?.mode === "replay" ? kinds.filter((kind) => kind !== "market") : kinds;
  }

  mount({ host, context, hydrate, slotId = "", actionsHost = null }) {
    this.host = host; this.context = context; this.slotId = String(slotId || "");
    this.header.attach(host, { manual: this.manual, variant: this.variant });
    // The slot's tab bar (a TabbedComponentHost's actions box): where 個股走勢's controls go.
    this.controlsHost = this.manual ? null : actionsHost || null;
    this.displayFrameGate = new PresentationRevisionGate();
    this._syncControlFlags();
    this._repairSurface(host, context, hydrate);
    this.canvas = findCanvas(host);
    // Without its information rows (a workspace column): a variant of the root.
    if (!this.infoLines) host.querySelector(".trend-chart")?.setAttribute("data-info-lines", "hidden");
    if (this.canvas) {
      // The canvas size is read from the shared observer (element_size.js): reading it on each update forced a
      // layout of the whole page in the middle of a data update. A size change redraws.
      const canvas = this.canvas;
      this.chart.attach(canvas);
      this.cleanup.push(onElementResize(canvas, () => this.chart.resize()));
      const onFrameDrawn = (event) => this.chart.recordFrameDrawn(event?.detail || {});
      this.canvas.addEventListener("trend-frame-drawn", onFrameDrawn);
      this.cleanup.push(() => this.canvas?.removeEventListener("trend-frame-drawn", onFrameDrawn));
    }
    // Every trend surface gets one unique, correct identity here: a slot-scoped id. Code that needs 個股走勢's canvas
    // asks the dashboard for the mounted component (dashboard_runtime.js mountedDashboardComponent), never a document
    // id; data-trend-surface is the identity the parking store keys on.
    this._applyCanvasIdentity();
    this.overlays.load(`shioajiTrendOverlayV1:${this.slotId || "detached"}:${this.variant}`, context?.services?.trendOverlays?.defaultState?.() || {});
    this._syncControlRow();
    this._bindEventMarkerToggle(host);
    this.overlays.bindToolbar();
    this._syncSecondaryInfoRow();
    this._syncFuturesSessionControl();
    // The header's code box: 個股 surfaces query Shioaji, the replay queries the replayed day; a manual surface's
    // page names its own provider.
    // A page may name its own provider (the workspace: the box replaces that column's symbol).
    this.searchProvider = context?.services?.productSearchProvider
      ?? (context?.mode === "replay" ? "history" : (this.manual ? "" : "shioaji"));
    if (this.searchProvider) ensureProductQuoteSearch(this.host.querySelector?.(".product-quote-header"), this.searchProvider);
    this._syncSearchable();

    if (!this.manual) this._subscribeLive(context);
  }

  // 盤中事件 switch (in 個股走勢's control row): the page redraws the markers on the change event. The marker store's
  // subscription is the switch's one writer; a click only changes the store, so a toggle storage refused (logged,
  // nothing announced) leaves the button showing what is stored. A switch this surface had parked or hydrated is
  // painted from the store once here; a control row built later is built from the store (eventMarkerToggleHtml).
  _bindEventMarkerToggle(host) {
    const onMarkerToggle = (event) => {
      const button = event.target?.closest?.('[data-role="event-marker-toggle"]');
      if (!button || button !== this._controlRole("event-marker-toggle")) return;
      setStockTrendEventMarkersVisible(!stockTrendEventMarkersVisible());
    };
    for (const target of [host, this.controlsHost].filter(Boolean)) {
      target.addEventListener("click", onMarkerToggle);
      this.cleanup.push(() => target.removeEventListener("click", onMarkerToggle));
    }
    const paint = (visible) => syncEventMarkerToggle(this.host, visible, this._controlRole("event-marker-toggle"));
    this.cleanup.push(subscribeStockTrendEventMarkers(paint));
    paint(stockTrendEventMarkersVisible());
  }

  // 歷史回放's chart: the generic trend surface in replay mode (技術分析 embeds a "stock" surface of its own).
  _isReplaySurface(context = this.context) {
    return context?.mode === "replay" && this.variant === "auto" && !this.manual;
  }

  // The surface's one shell for its mode and variant. Hydrating keeps nodes the host already holds only when they
  // are that shell (core/component_shell.js); a Taiwan surface parked by its own destroy() (ComponentHost cleared
  // the slot for another tab) comes back as the same bound nodes, under the same check.
  _repairSurface(host, context, hydrate) {
    if (this._isReplaySurface(context)) { mountShell(host, replayTrendShell(), { hydrate }); return; }
    if (this.manual) { mountShell(host, shell(this.variant), { hydrate }); return; }
    const restored = restoreTrendSurface(host, this._surfaceKey());
    mountShell(host, taiwanTrendShell(this.variant, this.showToolbar), { hydrate: hydrate || restored });
  }

  // What the last drawn frame was (points, size, reference), on the canvas for the startup acceptance; a futures
  // reference that moved between frames is counted.
  _subscribeLive(context) {
    // The exchange-wide counts: this subscription is their one writer (the view models carry none). A surface showing
    // its own index's counts ignores them (checked per call: reconfigure() changes the variant without re-subscribing).
    this.cleanup.push(subscribeMarketBreadth((breadth) => { if (!ownBreadth(this.variant)) this.header.syncBreadth(breadth); }));
    const refresh = () => context?.dataSource?.invalidate(this.dataKey, {
      symbol: context?.symbolStore?.getSelectedSymbol?.(), variant: this.variant,
    });
    this.cleanup.push(context?.symbolStore?.subscribe?.(refresh) || (() => {}));
    this.cleanup.push(context?.currentTimestamp?.subscribe?.(refresh) || (() => {}));
    // The footer's two model horizons follow the settings choice at once: a new frame is asked for, and its header
    // commit (update()) writes the prediction cells -- the one writer of those cells.
    this.cleanup.push(subscribeTrendFooterHorizons(refresh));
    this._subscribeData();

    // An overlay source that announces its own data (the workspace benchmarks) redraws the overlays on each arrival.
    this.cleanup.push(context?.services?.trendOverlays?.subscribe?.(() => this.overlays.sync()) || (() => {}));
    if (this.showControls && this.lineChart !== false) {
      for (const overlayDataKey of ["marketTrend", "futuresTrend"]) {
        if (overlayDataKey === this.dataKey) continue;
        this.cleanup.push(context?.dataSource?.subscribe?.(overlayDataKey, () => this.overlays.sync()) || (() => {}));
      }
    }
    refresh();
  }

  /**
   * The row between the header and the chart is the one controlRowShell() builds for the variant this surface is
   * serving: reconfigure() changes the variant without remounting, so a row built for another variant is replaced
   * whole, and a variant without controls has no row.
   */
  _syncControlRow() {
    if (!this.host || this.manual) return;
    const current = this._controlRole("trend-control-row");
    const markup = !this.showControlRow ? "" : this._isReplaySurface() ? replayControlRowShell() : controlRowShell(this.variant, this.showToolbar);
    const wanted = markup ? shellElement(markup) : null;
    let row = current;
    if ((current?.dataset.trendControls || "") !== (wanted?.dataset.trendControls || "")) {
      this.overlays.releaseToolbar();
      current?.remove();
      row = wanted;
    }
    this.controlRow = row;
    // 期貨走勢's header has the buttons between its name and price instead of the contract code (user 10-16); 產業指數
    // shows its name only, never the IX code (user 10-22).
    const code = this.host.querySelector(".product-quote-code");
    if (code) code.hidden = !this.variantSpec.showsCode;
    if (row) this._placeControlRow(row);
  }

  // Where the controls sit: 期貨走勢 -- its header, between the name and the price; with a tab bar -- the tab bar's
  // actions box; otherwise (a workspace column, 技術分析's inner surface) -- their own row above the chart.
  _placeControlRow(row) {
    const header = this.host.querySelector(".product-quote-header");
    const stage = this.host.querySelector(".trend-area");
    const placement = this.variantSpec.controlsInHeader && header ? "header" : this.controlsHost ? "tabs" : "row";
    if (placement === "header") {
      if (row.parentNode !== header) header.insertBefore(row, header.querySelector(".product-quote-center"));
    } else if (placement === "tabs") {
      if (row.parentNode !== this.controlsHost) this.controlsHost.replaceChildren(row);
    } else if (stage && row.parentNode !== stage.parentNode) {
      stage.parentNode.insertBefore(row, stage);
    }
    row.dataset.placement = placement;
  }

  // A control by role: in the surface, or in the tab bar the controls moved to.
  _controlRole(name) {
    return role(this.host, name) || role(this.controlsHost, name);
  }

  // 期貨走勢's 日盤 / 夜盤 / 全日 (the buttons its control row ships with): the active one.
  _syncFuturesSessionControl(activeSession = "") {
    if (this.variant !== "futures") return;
    const control = role(this.host, "txf-session-control");
    if (!control) return;
    // The selected tab is the user's choice (the page's panel state), never the session of the last data drawn: a
    // click re-renders before the new tab's data arrives, and the old vm's session would put the buttons back on 全日.
    // The data's session is only the fallback for a host
    // without that state.
    const chosen = String(this.context?.services?.futuresSession?.selected?.() || "").trim().toLowerCase();
    const requested = ["day", "night", "full"].includes(chosen) ? chosen : String(activeSession || "").trim().toLowerCase();
    const active = ["day", "night", "full"].includes(requested) ? requested : "full";
    if (control.dataset.activeSession === active) return;
    // One character each: they sit in the header between the name and the price.
    renderTrendSessionControl(control, {
      sessions: [{ key: "day", label: "日", title: "日盤" }, { key: "night", label: "夜", title: "夜盤" }, { key: "full", label: "全", title: "全日" }],
      activeKey: active,
      dataAttribute: "txf-session",
    });
    control.dataset.activeSession = active;
  }

  // 個股走勢's 日／夜／全 for 台指期／小台指: shown with the session the view model draws, hidden for anything else.
  _syncStockFuturesSessionControl(control = null) {
    if (this.variant !== "stock") return;
    const host = this._controlRole("stock-futures-session");
    if (!host) return;
    if (!control) { if (!host.hidden) host.hidden = true; return; }
    renderTrendSessionControl(host, {
      sessions: [{ key: "day", label: "日", title: "日盤" }, { key: "night", label: "夜", title: "夜盤" }, { key: "full", label: "全", title: "全日" }],
      activeKey: control.active,
      dataAttribute: "stock-futures-session",
    });
  }

  _subscribeData() {
    this.dataCleanup?.();
    if (this.manual) { this.dataCleanup = null; return; }
    this.dataCleanup = this.context?.dataSource?.subscribe?.(this.dataKey, (vm) => this.update(vm)) || (() => {});
  }

  reconfigure({ dataKey = this.dataKey, variant = this.variant } = {}) {
    const nextDataKey = String(dataKey || "trendChart");
    const nextVariant = String(variant || "auto");
    if (nextDataKey === this.dataKey && nextVariant === this.variant) return this;
    const nextSpec = trendSurfaceVariant(nextVariant);
    this.lastVm = null;
    // The data source numbers its frames per component id: the new source starts its own count, so the gate starts
    // over with it, and what the old source drew is wiped (a new source below the old revision would be refused
    // as stale, and the canvas would keep showing the previous view until it overtook it).
    if (nextDataKey !== this.dataKey) this.displayFrameGate?.reset();
    this.chart.reset();
    this.dataKey = nextDataKey;
    this.variant = nextVariant;
    this.variantSpec = nextSpec;
    this.header.setVariant(nextVariant);
    this._syncControlFlags();
    // Switching 加權走勢 / 期貨走勢 / 個股走勢 inside the "trend-chart" reuse group reconfigures this
    // instance instead of remounting it (core/component_host.js), so this -- not mount() -- is
    // where a surface changes which view it IS. Stamping only the view label left data-trend-surface
    // and the canvas id describing the PREVIOUS variant, and left that variant's frame/reference
    // numbers on the canvas: the parking store then filed the surface under the wrong identity, and
    // an empty new view still reported the old view's point count and reference.
    this._applyCanvasIdentity();
    this.overlays.load(`shioajiTrendOverlayV1:${this.slotId || "detached"}:${this.variant}`, this.context?.services?.trendOverlays?.defaultState?.() || {});
    this._syncControlRow();
    this.overlays.bindToolbar();
    this._syncSecondaryInfoRow();
    this._syncFuturesSessionControl();
    this._subscribeData();
    this.context?.dataSource?.invalidate?.(this.dataKey, {
      symbol: this.context?.symbolStore?.getSelectedSymbol?.(), variant: this.variant,
    });
    return this;
  }

  /** 加權 / 期貨 show their name and code as text; only a 個股 surface has a code to query. */
  _syncSearchable() {
    if (!this.searchProvider || this.searchProvider === "history") return;
    setProductQuoteSearchable(this.host?.querySelector?.(".product-quote-header"), this.variantSpec.searchable);
  }

  update(vm = {}) {
    vm = trendReadView(vm);
    if (!vm) return;
    if (this.displayFrameGate && !this.displayFrameGate.accept(vm)) return;
    syncViewLifecycle(this.host, vm);
    const previousPoints = Array.isArray(this.lastVm?.points) ? this.lastVm.points : [];
    this.lastVm = vm || {};
    this._syncFuturesSessionControl(this.lastVm.session || this.lastVm?.options?.session);
    this._syncStockFuturesSessionControl(this.lastVm.futuresSessionControl);
    this._syncSearchable();
    this.header.commit(this.lastVm);
    if (!this.canvas || this.lineChart === false) return;
    this.chart.draw(vm, {
      previousPoints,
      adapterType: vm?.options?.adapterType || vm?.adapterType || (this.context?.mode === "replay" ? "replay" : "equity"),
      overlayProvider: this.dataKey === "trendChart" ? this.context?.services?.trendOverlayProvider : null,
      accept: (frame) => !this.displayFrameGate || this.displayFrameGate.accept(frame),
      identityResolver: vm?.options?.identityResolver || (() => this._seriesIdentity()),
      // A surface with controls draws its benchmarks itself (the overlay controller), not through the legacy provider.
      ownOverlays: this.showControls,
    });
    // A view model that names its benchmark (即時報價's 個股走勢: the product type's) is followed; a surface with its
    // own switch keeps the user's.
    if (vm.benchmark !== undefined && !this.showToolbar) this.overlays.follow(vm.benchmark);
    this.overlays.sync();
  }


  resize() { this.chart.resize(); }

  /** The surface's chart manager (null before the first draw, and for a surface without a line chart). */
  get manager() { return this.chart.manager; }
  destroy() {
    this.dataCleanup?.(); this.dataCleanup = null;
    this.overlays.releaseToolbar();
    this.cleanup.release();
    this.chart.destroy();
    // The controls moved to the tab bar go back into the surface first: a parked surface is restored only when it is
    // the whole shell (component_shell.js holdsShell), and the tab bar is emptied for the next tab anyway.
    if (!this.manual && this.controlRow && !this.host?.contains?.(this.controlRow)) {
      const stage = this.host?.querySelector?.(".trend-area");
      stage?.parentNode?.insertBefore(this.controlRow, stage);
    }
    this.controlRow = null; this.controlsHost = null;
    // ComponentHost clears the slot before mounting a non-reusable trend page
    // (for example 個股走勢-A). Preserve the complete live trend surface here,
    // before that clear happens, so title/chart/all information rows return as
    // the same bound DOM nodes when any built-in trend page is selected again.
    if (!this.manual) preserveTrendSurface(this.host);
    this.canvas = null; this.host = null; this.context = null;
    this.header.detach();
    this.displayFrameGate?.reset?.();
    this.displayFrameGate = null;
  }
}
