import { CleanupBag } from "../cleanup_bag.js";
import { componentUpdated } from "../market_render_trace.js";
import { tradesReadView } from "../market_read_model.js";
import { escapeHtml, byRole as role, syncText, volumeUnitLabel } from "../utility.js";
import { applyColumnSchema, destroyColumnTitle, renderColumnHeaderHtml } from "../column_title.js";
import { TICK_DETAILS_COLUMNS_CHANGED, tickDetailsColumnProfile, tickDetailsVisibleColumns } from "../tick_details_columns.js";
import { columnSettingsButtonHtml, openColumnSettings, retainColumnSettingsEditor } from "./column_settings_editor.js";
import { PageRailController } from "../page_rail.js";
import { buildTradeRow, emptyTradeRow, patchTradeRow, tradeRowModel } from "../trade_rows.js";
import { destroyStandardDataGrid, enableCompleteRowDataGridScroll } from "../data_grid.js";
import { PresentationRevisionGate } from "../display_frame_gate.js";
import { syncViewLifecycle } from "../view_lifecycle.js";
import { mountShell } from "../component_shell.js";
import { titleBarMarkup } from "./title_bar.js";
import { ROW_WASH_MS, washRow } from "../row_wash.js";


function shell(mode = "live", columns = []) {
  return `<div class="tick-details mode-${escapeHtml(mode)} paged-row-list-root">
    ${titleBarMarkup({ title: "成交明細", actions: `<span class="tick-details-actions" data-role="tick-actions">${minVolumeFilterMarkup()}${columnSettingsButtonMarkup()}</span>` })}
    <div class="paged-list-layout">
      <div class="table-wrap-plain tick-table-wrap" data-role="tick-scroll">
        <table data-role="tick-table" class="tick-table lined-rows">${renderColumnHeaderHtml(columns)}<tbody data-role="tick-body"><tr><td colspan="${columns.length}" class="empty">尚無成交資料</td></tr></tbody></table>
        <aside class="page-rail-compact" data-page-rail-overlay="1" data-role="tick-page-rail" aria-label="成交明細捲動與分頁"></aside>
      </div>
    </div>
  </div>`;
}

// 過濾: trades below N (張 for Taiwan stocks, 股 for US stocks -- the instrument's own unit) are not shown. A view
// filter over the page on screen: the pages themselves are the server's (Market Runtime's trade index pages by
// count), so a page keeps its place. A plain text box (no spinner); anything but digits reads as 0.
function minVolumeFilterMarkup() {
  return `<label class="tick-details-filter"><span>≥</span>`
    + `<input type="text" inputmode="numeric" autocomplete="off" spellcheck="false" class="tick-details-filter-input" data-role="tick-min-volume" value="0" aria-label="最小單量">`
    + `<span data-role="tick-min-volume-unit">張</span></label>`;
}

// ⚙: which columns the list shows and in what order (tick_details_columns.js), in the shared column settings panel.
function columnSettingsButtonMarkup() {
  return columnSettingsButtonHtml({ label: "設定成交明細欄位", attributes: 'data-role="tick-column-settings"' });
}

// Per list (Shioaji / Futu) and per viewer: a convenience kept in this browser only.
function readMinVolume(key) {
  try { return Math.max(0, Number(localStorage.getItem(key)) || 0); }
  catch (error) { console.warn("[tick details: reading the volume filter] failed", error); return 0; }
}
function writeMinVolume(key, value) {
  try { if (value > 0) localStorage.setItem(key, String(value)); else localStorage.removeItem(key); }
  catch (error) { console.warn("[tick details: saving the volume filter] failed", error); }
}

function effectiveTradeTotalPages(vm = {}, pageSize = 100) {
  const safePageSize = Math.max(1, Number(pageSize) || 100);
  const apiPages = Math.max(1, Number(vm?.totalPages) || 1);
  const totalCount = Math.max(0, Number(vm?.totalCount) || 0);
  const countPages = Math.max(1, Math.ceil(totalCount / safePageSize));
  return Math.max(apiPages, countPages);
}

// A row is its print's durable sequence (as tradeRowKey in trade_row_order.js). `sequence` is not one number space (the
// live view's state version, a stored row's producer sequence), so prints sharing it were one row: every redraw built
// the second one anew and washed it again.
function tradeRowIdentity(tick = {}) {
  const durable = Number(tick?.ingestSequence ?? tick?.ingest_sequence);
  if (Number.isFinite(durable) && durable > 0) return `seq:${durable}`;
  return [tick?.datetime ?? tick?.timestamp ?? tick?.time ?? "", tick?.price ?? "", tick?.volume ?? "", tick?.tradeSide ?? tick?.trade_side ?? tick?.side ?? ""].join("|");
}

// Which trade stream a ViewModel shows: the product plus its session identity (not the sequence).
function tradeStreamIdentity(vm = {}) {
  const revision = vm?.marketRead?.revision || {};
  return [String(vm?.logicalCode || vm?.code || "").trim().toUpperCase(), String(revision.daemonInstanceId || ""),
    Number(revision.sessionGeneration ?? vm?.sessionGeneration ?? 0) || 0,
    String(vm?.marketRead?.session?.tradingDate || "").slice(0, 10)].join("|");
}

export class TickDetailsComponent {
  // widthScope: which list's column widths these are (Shioaji / Futu keep their own).
  constructor({ manual = false, widthScope = "shioaji" } = {}) {
    this.manual = Boolean(manual);
    this.widthScope = String(widthScope || "shioaji");
    this.host = null;
    this.context = null;
    this.cleanup = new CleanupBag("tick details");
    this.rowSnap = null;
    this.ownsRowSnap = false;
    this.pageRail = null;
    this.vm = {};
    this.renderedPage = 0;
    this.pendingLiveVm = null;
    this.renderedLogicalCode = "";
    this.renderedStreamIdentity = "";
    this.renderedRowIds = new Set();
    // identity -> <tr> of the rows on screen; this component is their only writer.
    this.rowNodes = new Map();
    this.renderKey = "";
    this.body = null;
    this.viewport = null;
    this.highlightStartedAt = new Map();
    this.highlightDurationMs = ROW_WASH_MS;
    this.displayFrameGate = null;
    this.minVolume = 0;
  }

  _minVolumeKey() { return `tickDetailsMinVolumeV1:${this.widthScope}`; }

  // V3: per list (Shioaji / Futu), and a fresh start -- the V2 record held widths that no longer fit.
  _widthsKey(context) {
    return context?.mode === "replay" ? "historyTickDetailsColumnWidthsV2" : `realtimeTickDetailsColumnWidthsV3:${this.widthScope}`;
  }

  mount({ host, context, hydrate, actionsHost = null }) {
    this.host = host;
    this.context = context;
    this.displayFrameGate = new PresentationRevisionGate();
    mountShell(host, shell(context?.mode || "live", this._columns()), { hydrate });
    this._applyColumns();

    const refresh = () => context?.dataSource?.invalidate("tickDetails", {
      symbol: context?.symbolStore?.getSelectedSymbol?.(),
      timestamp: context?.currentTimestamp?.get?.(),
    });
    if (!this.manual) {
      this.cleanup.push(context?.symbolStore?.subscribe?.(refresh) || (() => {}));
      if (context?.mode === "replay") this.cleanup.push(context?.currentTimestamp?.subscribe?.(refresh) || (() => {}));
      this.cleanup.push(context?.dataSource?.subscribe?.("tickDetails", (vm) => this.update(vm)) || (() => {}));
    }

    // The controls are found once, then (in a slot, whose own tab names this list) moved into the slot's actions box.
    const actions = role(host, "tick-actions");
    this.actionNodes = {
      minVolume: role(host, "tick-min-volume"), unit: role(host, "tick-min-volume-unit"),
    };
    const { scroll, grid } = this._mountGrid(host);
    this.body = role(host, "tick-body");
    this.viewport = grid?.bodyScroll || scroll;
    this.pageRail = new PageRailController({
      host: role(host, "tick-page-rail"),
      viewport: grid?.bodyScroll || scroll,
      onPageRequest: (page) => this._requestPage(page),
    }).mount();
    this._anchorPageRail(scroll, grid);
    this._bindPendingFlush(grid?.bodyScroll || scroll);
    this._bindMinVolumeFilter(host);
    this._bindColumnSettings();
    if (actionsHost && actions) actionsHost.replaceChildren(actions);

    if (!this.manual) {
      refresh();
      Promise.resolve(context?.services?.tickDetails?.bootstrap?.())
        .catch((error) => console.warn("[TICK DETAILS] bootstrap failed", error));
    }
  }

  // The columns this list's user shows, in their order (Futu's keeps 單量 wide enough for 8 decimals of crypto).
  _columns() { return tickDetailsVisibleColumns(this.widthScope); }

  // The ⚙ opens this list's column profile; a saved profile redraws the header and the page's rows as a new set.
  _bindColumnSettings() {
    this.cleanup.push(retainColumnSettingsEditor());
    const button = role(this.host, "tick-column-settings");
    const open = (event) => { event.stopPropagation(); openColumnSettings(tickDetailsColumnProfile(this.widthScope), this.host); };
    button?.addEventListener("click", open);
    const changed = (event) => {
      if (event?.detail?.scope !== this.widthScope || !this.host) return;
      destroyColumnTitle(role(this.host, "tick-table"));
      this._applyColumns();
      this.rowNodes.clear();
      this.renderedRowIds = new Set();
      this.renderKey = "";
      if (this.vm && Object.keys(this.vm).length) this.update(this.vm);
      else this.body?.replaceChildren(emptyTradeRow(this.body.ownerDocument, "尚無成交資料", this._columns().length));
      this.rowSnap?.scheduleMeasure?.();
    };
    window.addEventListener(TICK_DETAILS_COLUMNS_CHANGED, changed);
    this.cleanup.push(() => { button?.removeEventListener("click", open); window.removeEventListener(TICK_DETAILS_COLUMNS_CHANGED, changed); });
  }

  _applyColumns() {
    applyColumnSchema(role(this.host, "tick-table"), this._columns(), {
      schemaId: "tickDetails",
      resize: { storageKey: this._widthsKey(this.context), defaultMinWidth: 48, floorWidth: 36, fitToAvailable: true },
    });
  }

  _mountGrid(host) {
    const scroll = role(host, "tick-scroll");
    if (scroll) {
      scroll.dataset.scrollbarLaneMin = "0";
      // The visible scrollbar is PageRailController. Keep the native DataGrid
      // scrollbar only as the scrolling engine, but move its painted lane
      // outside the clipped wrapper so no second grey rail can appear beside
      // the last column. DataGrid also uses this flag to suppress its header cap.
      scroll.dataset.standardGridOverlayScrollbar = "1";
      scroll.dataset.standardGridStableColumns = "1";
    }
    const completeRowScroll = enableCompleteRowDataGridScroll(scroll, {
      rowHeightVar: "--row-height-trade-detail",
      wheelStepRows: 1,
      gridOptions: { x: "hidden" },
    });
    this.rowSnap = completeRowScroll.rowSnap;
    this.ownsRowSnap = false;
    // Refit after DataGrid has created the split header/body shell.
    // TickDetails' custom rail is a true overlay INSIDE the visible data-body
    // rectangle. Do NOT reserve a second header/body lane for it: reserving 8px
    // makes the rail look like an extra column outside the data fields.
    this._applyColumns();
    return { scroll, grid: completeRowScroll.grid };
  }

  // Anchor the custom rail to the ACTUAL data rectangle, not to the outer
  // component edge. DataGrid can leave a scrollbar-cap / rounding gap at the
  // far right; aligning to wrapper.right therefore makes the rail look like
  // an external extra column. Measure the canonical body + last Title cell
  // and overlay the final 8px *inside* the last column instead.
  _anchorPageRail(scroll, grid) {
    const syncRailGeometry = () => {
      if (!scroll || !grid?.bodyScroll) return;
      const wrapperRect = scroll.getBoundingClientRect();
      const bodyRect = grid.bodyScroll.getBoundingClientRect();
      const headerCells = grid.headerTable?.querySelectorAll?.(":scope > thead > tr:last-child > th, :scope > thead > tr:last-child > td");
      const lastHeader = headerCells?.length ? headerCells[headerCells.length - 1] : null;
      const lastRect = lastHeader?.getBoundingClientRect?.();
      // The body viewport is intentionally widened by one native-scrollbar
      // lane and clipped by the wrapper. Never anchor against that off-screen
      // extension; the visible right edge is the canonical last column /
      // wrapper edge. This keeps the custom 8px rail inside the final column.
      const lastRight = (lastRect?.right && Number.isFinite(lastRect.right))
        ? lastRect.right
        : wrapperRect.right;
      const dataRight = Math.min(wrapperRect.right, lastRight);
      const top = Math.max(0, Math.round(bodyRect.top - wrapperRect.top));
      const bottom = Math.max(0, Math.round(wrapperRect.bottom - bodyRect.bottom));
      const right = Math.max(0, Math.round(wrapperRect.right - dataRight));
      scroll.style.setProperty("--tick-details-rail-top", `${top}px`);
      scroll.style.setProperty("--tick-details-rail-bottom", `${bottom}px`);
      scroll.style.setProperty("--tick-details-rail-right", `${right}px`);
    };
    syncRailGeometry();
    requestAnimationFrame(syncRailGeometry);
    if (typeof ResizeObserver === "undefined" || !scroll) return;
    const railGeometryObserver = new ResizeObserver(syncRailGeometry);
    if (grid?.headerBand) railGeometryObserver.observe(grid.headerBand);
    if (grid?.bodyScroll) railGeometryObserver.observe(grid.bodyScroll);
    if (grid?.headerTable) railGeometryObserver.observe(grid.headerTable);
    railGeometryObserver.observe(scroll);
    this.cleanup.push(() => railGeometryObserver.disconnect?.());
  }

  // Whether the user has scrolled the tape away from its top. Kept by the scroll listener below: reading
  // scrollTop on each update forced a layout in the middle of the data update.
  _scrolledAway(viewport) {
    if (this.scrollAway === undefined || viewport !== this.viewport) return viewport?.scrollTop > 0.5;
    return this.scrollAway;
  }

  // Live rows held while the user reads older ones are shown once the list is back at the top.
  _bindPendingFlush(viewport) {
    let flushFrame = 0;
    this.scrollAway = false;
    const trackScroll = () => { this.scrollAway = viewport.scrollTop > 0.5; };
    viewport?.addEventListener?.("scroll", trackScroll, { passive: true });
    this.cleanup.push(() => viewport?.removeEventListener?.("scroll", trackScroll));
    const flushPendingAtTop = () => {
      if (!viewport || viewport.scrollTop > 0.5 || !this.pendingLiveVm || flushFrame) return;
      flushFrame = requestAnimationFrame(() => {
        flushFrame = 0;
        if (!this.pendingLiveVm || viewport.scrollTop > 0.5) return;
        const pending = this.pendingLiveVm;
        this.pendingLiveVm = null;
        this.update(pending);
      });
    };
    viewport?.addEventListener?.("scroll", flushPendingAtTop, { passive: true });
    this.cleanup.push(() => {
      if (flushFrame) cancelAnimationFrame(flushFrame);
      viewport?.removeEventListener?.("scroll", flushPendingAtTop);
    });
  }

  _bindMinVolumeFilter() {
    const input = this.actionNodes?.minVolume;
    if (!input) return;
    this.minVolume = readMinVolume(this._minVolumeKey());
    input.value = String(this.minVolume);
    // Digits only: anything else in the box turns it into 0 (an empty box while typing counts as 0 too).
    const apply = () => {
      const text = String(input.value || "").trim();
      if (!/^\d*$/.test(text)) input.value = "0";
      const value = /^\d+$/.test(text) ? Number(text) : 0;
      if (value === this.minVolume) return;
      this.minVolume = value;
      writeMinVolume(this._minVolumeKey(), value);
      // The page on screen is drawn again under the new filter, as a new set of rows (no new-row wash).
      this.renderedRowIds = new Set();
      this.rowNodes.clear();
      if (this.vm && Object.keys(this.vm).length) this.update(this.vm);
    };
    const settle = () => { apply(); input.value = String(this.minVolume); };
    input.addEventListener("change", settle);
    input.addEventListener("input", apply);
    this.cleanup.push(() => { input.removeEventListener("change", settle); input.removeEventListener("input", apply); });
  }

  // The rows of `page` the filter keeps, and how many it hides.
  _filterRows(rows) {
    if (!(this.minVolume > 0)) return { rows, hidden: 0 };
    const kept = rows.filter((tick) => !(Number(tick?.volume) < this.minVolume));
    return { rows: kept, hidden: rows.length - kept.length };
  }

  _syncFilterUnit(vm) {
    syncText(this.actionNodes?.unit, volumeUnitLabel(vm?.marketRead?.identity?.market ?? vm?.market, "張"));
  }

  _requestPage(page, options = {}) {
    const service = this.context?.services?.tickDetails;
    if (typeof service?.onPageRequest === "function") {
      Promise.resolve(service.onPageRequest({ page: Math.max(1, Number(page) || 1), latest: Boolean(options.latest), snapshotWatermark: this.vm?.snapshotWatermark || 0 })).catch((error) => console.warn("[TICK PAGE] request failed", error));
    }
  }

  update(vm = {}) {
    vm = tradesReadView(vm);
    if (!vm) return;
    if (this.displayFrameGate && !this.displayFrameGate.accept(vm)) return;
    syncViewLifecycle(this.host, vm);
    this.vm = { ...(vm || {}) };
    const body = this.body || role(this.host, "tick-body");
    if (!body) return;
    const page = Math.max(1, Number(vm?.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(vm?.pageSize) || 100));
    const filtered = this._filterRows(Array.isArray(vm?.rows) ? vm.rows.slice(0, pageSize) : []);
    const rows = filtered.rows;
    this._syncFilterUnit(vm);
    const viewport = this.viewport || role(this.host, "tick-scroll")?.querySelector?.(":scope > .standard-data-grid-body-scroll") || role(this.host, "tick-scroll");
    // Frozen only while the rows shown are the SAME stream (product, daemon instance, session, trading date): a
    // switch of product or session renders at once, never keeps the previous product's rows.
    const streamIdentity = tradeStreamIdentity(vm);
    const canFreezeLiveRows = this.context?.mode === "live"
      && page === 1
      && this.renderedPage === 1
      && streamIdentity === this.renderedStreamIdentity
      && this._scrolledAway(viewport)
      && this.rowNodes.size > 0;
    if (canFreezeLiveRows) {
      this._holdLiveRows(vm, page, pageSize);
      return;
    }
    this.pendingLiveVm = null;
    const logicalCode = String(vm?.logicalCode || vm?.code || "").trim().toUpperCase();
    // Replay uses the same shared component. Treat successive replay cursor
    // updates as one stream too, so newly revealed rows receive the same
    // short highlight as newly arrived live Futu trades.
    const sameStream = page === 1
      && this.renderedPage === 1
      && this.renderedLogicalCode === logicalCode
      && this.renderedRowIds.size > 0;
    const now = performance.now();
    const identities = rows.map(tradeRowIdentity);
    this._trackHighlights(identities, sameStream, now);
    this.renderedPage = page;
    this.renderedLogicalCode = logicalCode;
    this.renderedStreamIdentity = streamIdentity;
    this.renderedRowIds = new Set(identities);
    // Canonical deltas, REST bootstrap and metadata reconciliation can all invalidate this component for the same
    // page: rows are compared field by field and only what changed is written, so an unchanged page writes nothing.
    const shown = filtered.hidden && !rows.length ? { ...vm, emptyText: `此頁沒有 ≥ ${this.minVolume} 的成交` } : vm;
    this._renderRows(body, shown, rows, identities, sameStream);
    const totalPages = effectiveTradeTotalPages(vm, pageSize);
    this.pageRail?.update?.({ page, totalPages, loading: Boolean(vm?.loading), rowCount: rows.length, pageSize });
    this.rowSnap?.refreshContent?.({ topologyChanged: false, logicalRows: rows.length });
    componentUpdated("trades",vm,this.host);
  }

  // The user is reading older rows of the live page: the DOM stays as it is and the newest view model is held until
  // the list is back at the top.
  _holdLiveRows(vm, page, pageSize) {
    this.pendingLiveVm = { ...(vm || {}) };
    this.pageRail?.update?.({
      page, totalPages: effectiveTradeTotalPages(vm, pageSize), loading: Boolean(vm?.loading),
      // DOM is intentionally frozen while the user is reading older rows.
      // Reuse the cached logical count instead of scanning tbody on every Tick.
      rowCount: Math.max(0, Number(this.pageRail?.vm?.rowCount) || 0),
      pageSize,
    });
  }

  // Rows new to the same stream get a short highlight; it ends after highlightDurationMs or when the row leaves.
  _trackHighlights(identities, sameStream, now) {
    if (!sameStream) this.highlightStartedAt.clear();
    else {
      for (const identity of identities) {
        if (!this.renderedRowIds.has(identity) && !this.highlightStartedAt.has(identity)) this.highlightStartedAt.set(identity, now);
      }
    }
    if (!this.highlightStartedAt.size) return;
    const nextIds = new Set(identities);
    for (const [identity, startedAt] of this.highlightStartedAt) {
      if (now - startedAt >= this.highlightDurationMs || !nextIds.has(identity)) this.highlightStartedAt.delete(identity);
    }
  }

  // A row new to the stream washes from when it was first seen (a row built again continues its wash where it is).
  _markNew(tr, identity) {
    const startedAt = this.highlightStartedAt.get(identity);
    if (startedAt != null) washRow(tr, startedAt);
  }

  _renderRows(body, vm, rows, identities, sameStream) {
    const loadingEmpty = Boolean(vm?.loading && !rows.length);
    if (!rows.length) {
      const text = loadingEmpty ? "成交明細載入中…"
        : String(vm?.emptyText || (this.context?.mode === "replay" ? "尚無歷史成交" : "等待即時成交"));
      const key = `empty\u001f${text}`;
      if (this.renderKey !== key || this.rowNodes.size || body.children.length !== 1) {
        body.replaceChildren(emptyTradeRow(body.ownerDocument, text, this._columns().length));
        this.rowNodes.clear();
        this.renderKey = key;
      }
      return;
    }
    this.renderKey = "rows";
    const doc = body.ownerDocument;
    const columns = this._columns().map((column) => column.id);
    if (!sameStream || !this.rowNodes.size) {
      // Another product, session or page: a new set of rows, built once.
      this.rowNodes.clear();
      body.replaceChildren(...rows.map((tick, index) => {
        const tr = buildTradeRow(doc, tradeRowModel(tick, vm, identities[index]), { columns });
        this._markNew(tr, identities[index]);
        this.rowNodes.set(identities[index], tr);
        return tr;
      }));
      return;
    }
    // The same stream: rows keep their elements (scroll and paint state stay) and move by trade identity. Rows that
    // leave go first: one left in place until after the placing would put every row below it one slot off, and each
    // of those would be taken out and put back (a row out of a 100-row page moved the rest, every trade).
    const wanted = new Set(identities);
    for (const [identity, node] of this.rowNodes) if (!wanted.has(identity)) node.remove();
    const kept = new Map();
    rows.forEach((tick, index) => {
      const identity = identities[index];
      const model = tradeRowModel(tick, vm, identity);
      let node = kept.has(identity) ? null : this.rowNodes.get(identity);
      if (!node) {
        node = buildTradeRow(doc, model, { columns });
        this._markNew(node, identity);
      } else {
        patchTradeRow(node, model);
      }
      const atIndex = body.children[index] || null;
      if (node !== atIndex) body.insertBefore(node, atIndex);
      kept.set(kept.has(identity) ? `${identity}\u0000${index}` : identity, node);
    });
    for (const [identity, node] of this.rowNodes) if (kept.get(identity) !== node) node.remove();
    while (body.children.length > rows.length) body.lastElementChild.remove();
    this.rowNodes = kept;
  }

  resize() { this.rowSnap?.scheduleMeasure?.(); }

  destroy() {
    const table = role(this.host, "tick-table");
    const wrapper = role(this.host, "tick-scroll");
    destroyColumnTitle(table);
    destroyStandardDataGrid(wrapper);
    if (this.ownsRowSnap) this.rowSnap?.destroy?.();
    this.rowSnap = null;
    this.ownsRowSnap = false;
    this.pageRail?.destroy?.();
    this.pageRail = null;
    this.cleanup.release();
    this.host = null;
    this.context = null;
    this.renderKey = "";
    this.rowNodes = new Map();
    this.body = null;
    this.viewport = null;
    this.scrollAway = undefined;
    this.displayFrameGate?.reset?.();
    this.displayFrameGate = null;
  }
}
