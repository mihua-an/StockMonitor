import { CleanupBag } from "../cleanup_bag.js";
import { renderPanelTabs } from "../panel_tabs.js";
import { displayInstrumentName, onInstrumentNamesLearned } from "../instrument_names.js";
import { internalTabRegistry } from "../internal_tab_registry.js";
import { escapeHtml, formatPercent, byRole as role } from "../utility.js";
import { eventDisplayTime, eventFeedKey, eventInfoClass, renderEventInfoHtml } from "../event_feed_format.js";
import { applyColumnSchema, destroyColumnTitle, renderColumnGroupHtml, renderColumnHeaderHtml } from "../column_title.js";
import { EVENT_FEED_COLUMNS } from "../column_schemas.js";
import { destroyStandardDataGrid, enableCompleteRowDataGridScroll } from "../data_grid.js";
import { componentUpdated } from "../market_render_trace.js";
import { patchRow, rowFromHtml } from "../table_patch.js";
import { morphInto } from "../dom_morph.js";
import { mountShell } from "../component_shell.js";
import { titleBarMarkup } from "./title_bar.js";
import { rowWashMarkup, washRow } from "../row_wash.js";
import { popoutButtonHtml } from "./popout_button.js";
import { detachedWindowFor } from "../detached_windows.js";

// 3分／5分 上漲・下跌: the columns that show the model predictions an event carries from its trigger.
const MODEL_COLUMNS = EVENT_FEED_COLUMNS.filter((column) => column.slot);
// Rows drawn beyond each edge of the viewport, so a scroll of a few rows lands on rows already drawn.
const OVERSCAN_ROWS = 6;
// Rows drawn before the viewport has been measured (how many it holds is not known yet).
const UNMEASURED_ROWS = 40;

export function filterEventFeedRows(rows, { mode = "live", activeFilterKey = "", tabs = [], selectedSymbol = "" } = {}) {
  const source = Array.isArray(rows) ? rows : [];
  const key = String(activeFilterKey || "");
  if (String(mode) === "replay") {
    return !key || key === "ALL"
      ? source
      : key === "SELECTED"
        ? source.filter((event) => String(event?.code || "") === String(selectedSymbol || ""))
        : source;
  }
  const tab = (Array.isArray(tabs) ? tabs : []).find((item) => String(item?.id || "") === key);
  const codes = Array.isArray(tab?.codes) ? new Set(tab.codes.map(String)) : null;
  return !codes ? source : source.filter((event) => codes.has(String(event?.code || "")));
}

function shell(mode = "live") {
  const title = mode === "replay" ? "歷史事件" : "即時資訊";
  return `<div class="record-panel event-feed mode-${escapeHtml(mode)}">
    ${titleBarMarkup({ title })}
    <div data-role="event-filter-row" class="record-panel-filter-row event-feed-filter-row">
      <div data-role="event-filter-tabs" class="tab-list" role="tablist" aria-label="${escapeHtml(title)}篩選"></div>
      <div data-role="event-date-picker" class="event-feed-date-picker" hidden>
        <button data-role="event-date-button" class="event-feed-date-button" type="button" aria-haspopup="listbox" aria-expanded="false" aria-label="歷史事件日期">
          <span data-role="event-date-label">----</span><span class="event-feed-date-caret" aria-hidden="true">▾</span>
        </button>
        <div data-role="event-date-menu" class="event-feed-date-menu" hidden>
          <div data-role="event-date-list" class="event-feed-date-list" role="listbox" aria-label="歷史事件日期清單"></div>
        </div>
      </div>
    </div>
    <div data-role="event-scroll" class="table-wrap-plain event-feed-table-wrap"${mode === "replay" ? ' data-grid-x="hidden"' : ""}>
      <table data-role="event-table" class="record-table event-feed-table">
        ${renderColumnGroupHtml(EVENT_FEED_COLUMNS)}
        ${renderColumnHeaderHtml(EVENT_FEED_COLUMNS)}
        <tbody data-role="event-body"><tr><td colspan="${EVENT_FEED_COLUMNS.length}" class="empty">尚無事件資料</td></tr></tbody>
      </table>
    </div>
  </div>`;
}

// A portalled menu under (or, when there is no room, above) its button, kept inside the window.
function positionMenuPortal(dateMenu, dateButton) {
  if (!dateMenu || !dateButton || dateMenu.hidden || dateMenu.parentElement !== document.body) return;
  const rect = dateButton.getBoundingClientRect();
  const viewportWidth = Math.max(document.documentElement?.clientWidth || 0, window.innerWidth || 0);
  const viewportHeight = Math.max(document.documentElement?.clientHeight || 0, window.innerHeight || 0);
  const width = Math.max(132, Math.round(rect.width || 0));
  const left = Math.max(4, Math.min(Math.round(rect.right - width), Math.max(4, viewportWidth - width - 4)));
  dateMenu.style.setProperty("--event-feed-date-menu-width", `${width}px`);
  dateMenu.style.setProperty("--event-feed-date-menu-left", `${left}px`);
  dateMenu.style.setProperty("--event-feed-date-menu-top", `${Math.round(rect.bottom + 1)}px`);
  const menuHeight = Math.max(1, Math.ceil(dateMenu.getBoundingClientRect().height || 0));
  const below = Math.max(0, viewportHeight - rect.bottom - 4);
  const above = Math.max(0, rect.top - 4);
  if (menuHeight > below && above > below) {
    dateMenu.style.setProperty("--event-feed-date-menu-top", `${Math.max(4, Math.round(rect.top - menuHeight - 1))}px`);
  }
}

// Every field the same value (arrays and objects the same instance): a producer hands out a new array when its
// content changes. `presentationRevision` numbers the delivery (dashboard_context.js), not what it shows.
function sameViewModel(drawn, next) {
  if (!drawn || !next || drawn === next) return false;
  const keys = Object.keys(next).filter((key) => key !== "presentationRevision");
  return keys.length === Object.keys(drawn).filter((key) => key !== "presentationRevision").length
    && keys.every((key) => Object.is(drawn[key], next[key]));
}

export class EventFeedComponent {
  constructor() {
    this.host = null; this.context = null; this.cleanup = new CleanupBag("event feed"); this.vm = {};
    this.activeFilterKey = "overview"; this.clickTimer = null; this.rowSnap = null;
    // 即時資訊 rows new to the list they are shown in: event key -> when it arrived, until its wash ends or its row
    // leaves the window (成交明細's row wash).
    this.washStartedAt = new Map(); this.streamSignature = null;
    // The filtered list ({ key, event } per row, in order) and its keys; the keys new to it in the update being drawn.
    this.listed = []; this.listedKeys = new Set(); this.freshKeys = new Set(); this.windowFrame = 0;
    // The view model last drawn by update (null before the first).
    this.drawnVm = null;
  }

  // 即時資訊 on a page opens in its own window; a slot's tab names the component, so the button sits in its actions.
  _mountPopout(host, hostType, actionsHost) {
    if (this.context?.mode === "replay" || hostType !== "inline" || detachedWindowFor("eventFeed") === null) return;
    role(host, "event-filter-row").insertAdjacentHTML("beforeend", popoutButtonHtml("event-popout"));
    const button = role(host, "event-popout");
    const open = () => window.desktopAPI?.openDetachedView?.({
      version: 1, componentId: "eventFeed", contextMode: "live", contextId: String(this.context?.id || "live:realtime"), symbolMode: "follow",
    })?.catch?.((error) => console.warn("[event feed: opening the detached window] failed", error));
    button.addEventListener("click", open);
    this.cleanup.push(() => button.removeEventListener("click", open));
    if (actionsHost) actionsHost.replaceChildren(button);
  }

  mount({ host, hostType = "inline", context, hydrate, actionsHost = null }) {
    this.host = host; this.context = context;
    mountShell(host, shell(context?.mode || "live"), { hydrate });
    this._mountPopout(host, hostType, actionsHost);
    // The component owns its columns and their widths: one remembered set for 即時資訊, one for 歷史事件.
    applyColumnSchema(role(host, "event-table"), EVENT_FEED_COLUMNS, {
      schemaId: "eventFeed",
      resize: { storageKey: context?.mode === "replay" ? "historyIntradayColumnWidths" : "shioajiLiveEventWidthsV1",
        defaultMinWidth: 48, floorWidth: 24, fitToAvailable: true },
    });
    if (context?.mode === "replay" && this.activeFilterKey === "overview") this.activeFilterKey = "SELECTED";
    const refresh = () => context?.dataSource?.invalidate("eventFeed", {
      symbol: context?.symbolStore?.getSelectedSymbol?.(), timestamp: context?.currentTimestamp?.get?.(),
    });
    this.cleanup.push(context?.symbolStore?.subscribe?.(refresh) || (() => {}));
    if (context?.mode === "replay") this.cleanup.push(context?.currentTimestamp?.subscribe?.(refresh) || (() => {}));
    this.cleanup.push(context?.dataSource?.subscribe?.("eventFeed", (vm) => this.update(vm)) || (() => {}));
    // A name looked up for a row shown with only its code redraws the rows.
    this.cleanup.push(onInstrumentNamesLearned(() => { if (this.host) this._renderRows(this.vm); }));

    this._bindRowClicks(host);
    this._bindDateMenu(host);
    const grid = enableCompleteRowDataGridScroll(role(host, "event-scroll"), {
      rowHeightVar: "--row-height-event",
      wheelStepRows: 1,
      discreteRail: true,
    });
    this.rowSnap = grid.rowSnap;
    // A scroll or a new viewport size moves the drawn window (once per frame).
    const redrawWindow = () => {
      if (this.windowFrame) return;
      this.windowFrame = requestAnimationFrame(() => { this.windowFrame = 0; this._drawWindow(); });
    };
    grid.viewport?.addEventListener?.("scroll", redrawWindow, { passive: true });
    this.cleanup.push(
      () => grid.viewport?.removeEventListener?.("scroll", redrawWindow),
      this.rowSnap?.onMeasured?.(() => this._drawWindow()) || (() => {}),
      () => { if (this.windowFrame) cancelAnimationFrame(this.windowFrame); this.windowFrame = 0; },
    );
    refresh();
  }

  // A click selects the row's event (crosshair); a double click opens its lookup.
  _bindRowClicks(host) {
    const body = role(host, "event-body");
    const click = (event) => {
      const row = event.target?.closest?.("tr[data-event-key]"); if (!row || !body?.contains?.(row)) return;
      if (this.clickTimer) clearTimeout(this.clickTimer);
      this.clickTimer = setTimeout(() => { this.clickTimer = null; this._activateRow(row, "crosshair"); }, 220);
    };
    const dblclick = (event) => {
      const row = event.target?.closest?.("tr[data-event-key]"); if (!row || !body?.contains?.(row)) return;
      event.preventDefault(); if (this.clickTimer) { clearTimeout(this.clickTimer); this.clickTimer = null; }
      this._activateRow(row, "lookup");
    };
    body?.addEventListener?.("click", click); body?.addEventListener?.("dblclick", dblclick);
    this.cleanup.push(() => body?.removeEventListener?.("click", click), () => body?.removeEventListener?.("dblclick", dblclick));
  }

  // The date picker's menu is portalled to <body> while open, so its nodes are kept here at mount: a query of the
  // host would not find them while the menu is open, and a VM update could not refresh or close it.
  _bindDateMenu(host) {
    const datePicker = role(host, "event-date-picker");
    const dateButton = role(host, "event-date-button");
    const dateMenu = role(host, "event-date-menu");
    const dateList = role(host, "event-date-list");
    const restoreDateMenuHome = () => {
      if (!dateMenu || !datePicker || dateMenu.parentElement === datePicker) return;
      dateMenu.classList.remove("event-feed-date-menu-portal");
      dateMenu.removeAttribute("style");
      datePicker.appendChild(dateMenu);
    };
    const positionDateMenuPortal = () => positionMenuPortal(dateMenu, dateButton);
    const setDateMenuOpen = (open) => {
      const visible = Boolean(open) && !datePicker?.hidden;
      if (visible && dateMenu) {
        /* Portal the menu to <body>.  History cards intentionally use overflow:hidden;
         * keeping the popup inside the Slot would let panel/title stacking contexts clip
         * the newest date rows and make them impossible to click. */
        if (dateMenu.parentElement !== document.body) document.body.appendChild(dateMenu);
        dateMenu.classList.add("event-feed-date-menu-portal");
        dateMenu.hidden = false;
        positionDateMenuPortal();
      } else if (dateMenu) {
        dateMenu.hidden = true;
        restoreDateMenuHome();
      }
      if (dateButton) dateButton.setAttribute("aria-expanded", visible ? "true" : "false");
      datePicker?.classList?.toggle("open", visible);
    };
    const toggleDateMenu = (event) => {
      event.preventDefault();
      event.stopPropagation();
      setDateMenuOpen(Boolean(dateMenu?.hidden));
    };
    const selectDate = (event) => {
      const option = event.target?.closest?.("button[data-event-date]");
      if (!option || !dateList?.contains?.(option)) return;
      const value = String(option.dataset.eventDate || "");
      setDateMenuOpen(false);
      if (value && value !== String(this.vm?.activeDate || "")) this.context?.services?.eventFeed?.onDateSelect?.(value);
    };
    const outsideDateClick = (event) => {
      if (!datePicker?.contains?.(event.target) && !dateMenu?.contains?.(event.target)) setDateMenuOpen(false);
    };
    const repositionDateMenu = () => positionDateMenuPortal();
    this.dateMenu = { picker: datePicker, button: dateButton, label: role(host, "event-date-label"), menu: dateMenu, list: dateList,
      close: () => setDateMenuOpen(false), reposition: () => { if (dateMenu && !dateMenu.hidden) positionDateMenuPortal(); } };
    const dateKeydown = (event) => {
      if (event.key === "Escape") { setDateMenuOpen(false); dateButton?.focus?.(); }
    };
    dateButton?.addEventListener?.("click", toggleDateMenu);
    dateList?.addEventListener?.("click", selectDate);
    document.addEventListener("pointerdown", outsideDateClick, true);
    document.addEventListener("keydown", dateKeydown, true);
    window.addEventListener("resize", repositionDateMenu);
    window.addEventListener("scroll", repositionDateMenu, true);
    this.cleanup.push(
      () => dateButton?.removeEventListener?.("click", toggleDateMenu),
      () => dateList?.removeEventListener?.("click", selectDate),
      () => document.removeEventListener("pointerdown", outsideDateClick, true),
      () => document.removeEventListener("keydown", dateKeydown, true),
      () => window.removeEventListener("resize", repositionDateMenu),
      () => window.removeEventListener("scroll", repositionDateMenu, true),
      () => { if (dateMenu) { dateMenu.hidden = true; restoreDateMenuHome(); } },
      () => { this.dateMenu = null; },
    );
  }

  _activateRow(row, lookupMode) {
    const key = String(row?.dataset?.eventKey || "");
    const item = key ? (Array.isArray(this.vm?.rows) ? this.vm.rows : []).find((event) => eventFeedKey(event) === key) || null : null;
    if (item) this.context?.services?.eventFeed?.onRowSelect?.(item, { lookupMode });
  }

  _tabs(vm) {
    if (this.context?.mode === "replay") {
      return internalTabRegistry.resolve("eventFeed:replay", {
        selectedSymbol: vm?.selectedSymbol || "",
        selectedName: vm?.selectedName || "",
      });
    }
    return internalTabRegistry.resolve("eventFeed:live", { watchPages: vm?.watchPages || [] });
  }

  _renderFilters(vm) {
    const tabsHost = role(this.host, "event-filter-tabs"); if (!tabsHost) return;
    const tabs = this._tabs(vm); const fallback = this.context?.mode === "replay" ? (tabs.some((tab) => tab.id === "SELECTED") ? "SELECTED" : "ALL") : "overview";
    if (!tabs.some((tab) => String(tab.id) === String(this.activeFilterKey))) this.activeFilterKey = fallback;
    // The tabs are rebuilt only when they or the active one change, never on a new event.
    const tabsSignature = JSON.stringify([this.activeFilterKey, tabs.map((tab) => [tab.id, tab.name, tab.title])]);
    if (tabsSignature !== this.tabsSignature) {
      this.tabsSignature = tabsSignature;
      renderPanelTabs(tabsHost, {
        tabs, activeKey: this.activeFilterKey,
        keyOf: (tab) => String(tab.id || ""), labelOf: (tab) => String(tab.name || tab.id || ""),
        titleOf: (tab) => String(tab.title || tab.name || tab.id || ""), closableOf: () => false,
        onSelect: (key) => {
          this.activeFilterKey = String(key || fallback); this._renderFilters(this.vm); this._renderRows(this.vm);
        },
      });
    }
    const { picker, button, label, menu, list, close, reposition } = this.dateMenu || {};
    if (!picker || !button || !label || !menu || !list) return;
    const showDate = this.context?.mode === "replay" && Array.isArray(vm?.dates);
    picker.hidden = !showDate;
    if (!showDate) { close(); return; }
    const values = vm.dates.map(String).filter(Boolean);
    const current = String(vm?.activeDate || "");
    label.textContent = current || values[0] || "----";
    const datesSignature = JSON.stringify([current, values]);
    if (datesSignature === this.datesSignature) return;
    this.datesSignature = datesSignature;
    morphInto(list, values.map((date) => `<button type="button" role="option" data-morph-key="${escapeHtml(date)}" data-event-date="${escapeHtml(date)}" class="event-feed-date-option${date === current ? " active" : ""}" aria-selected="${date === current ? "true" : "false"}">${escapeHtml(date)}</button>`).join(""));
    reposition();
  }

  _filteredRows(vm) {
    return filterEventFeedRows(vm?.rows, {
      mode: this.context?.mode || "live",
      activeFilterKey: this.activeFilterKey,
      tabs: this._tabs(vm),
      selectedSymbol: vm?.selectedSymbol || "",
    });
  }

  // The list is every filtered event; only the rows around the viewport are drawn (_drawWindow). A day's 歷史事件 holds
  // hundreds of rows, and every drawn row was restyled and laid out again each time one was added or removed.
  _renderRows(vm) {
    const body = role(this.host, "event-body"); if (!body) return;
    const rows = this._filteredRows(vm);
    // 即時資訊 washes a row only when it joins the list already on screen: not on the first fill, another tab or
    // another tab's codes (those are a new list), and never in 歷史事件.
    const live = (this.context?.mode || "live") === "live";
    const activeTab = live ? this._tabs(vm).find((tab) => String(tab?.id || "") === String(this.activeFilterKey)) : null;
    const streamSignature = live ? JSON.stringify([this.activeFilterKey, Array.isArray(activeTab?.codes) ? activeTab.codes.map(String) : null]) : null;
    const sameStream = live && Boolean(body._eventRows?.size) && streamSignature === this.streamSignature;
    this.streamSignature = streamSignature;
    if (!sameStream) this.washStartedAt.clear();
    if (!rows.length) {
      const msg = this.context?.mode === "replay"
        ? (this.activeFilterKey === "ALL" ? "此日期尚無歷史盤中資訊" : `${String(vm?.selectedSymbol || "個股")} 當日尚無歷史盤中資訊`)
        : "目前沒有符合此商品頁的即時資訊";
      const html = `<tr><td colspan="${EVENT_FEED_COLUMNS.length}" class="empty">${escapeHtml(vm?.emptyText || msg)}</td></tr>`;
      if (body._emptyMarkup !== html) { body.innerHTML = html; body._emptyMarkup = html; body._eventRows = null; }
      this.listed = []; this.listedKeys = new Set();
      this.rowSnap?.setVirtualWindow?.({ firstRow: 0, logicalRows: 0 });
      if (body.isConnected && body.dataset) componentUpdated("event_feed", { provider: "shioaji", code: `events:${this.context?.mode || "live"}` }, body);
      return 0;
    }
    // A row's identity is its event_id, unique in the list; one without it, or a second row with the same one, is a
    // producer's contract error and is not listed (it could not be selected or patched as itself).
    const listed = []; const keys = new Set();
    let unusable = 0;
    for (const event of rows) {
      const key = eventFeedKey(event);
      if (!key || keys.has(key)) { unusable += 1; continue; }
      keys.add(key); listed.push({ key, event });
    }
    if (unusable) console.warn(`[event feed] ${unusable} row(s) without a unique event_id not drawn`);
    // Events that joined the list on screen wash when drawn now; one drawn later by a scroll is not new to the user.
    this.freshKeys = sameStream ? new Set(listed.filter(({ key }) => !this.listedKeys?.has(key)).map(({ key }) => key)) : new Set();
    this.listed = listed; this.listedKeys = keys;
    this._drawWindow();
    this.freshKeys = new Set();
    if (body.isConnected && body.dataset) componentUpdated("event_feed", { provider: "shioaji", code: `events:${this.context?.mode || "live"}` }, body);
    return listed.length;
  }

  // Draws the listed rows from a little above the viewport's top row to a little below its last. Rows are patched by
  // event key: a row new to the window is added, a changed one patches its cells, the others stay as they are.
  _drawWindow() {
    const body = role(this.host, "event-body");
    const listed = this.listed || [];
    if (!body || !listed.length) return;
    const snap = this.rowSnap;
    const measured = snap?.rowHeight > 0;
    const top = measured ? snap.metrics(listed.length).topRowIndex : 0;
    const visible = measured ? snap.visibleRows : UNMEASURED_ROWS;
    const first = Math.max(0, top - OVERSCAN_ROWS);
    const end = Math.min(listed.length, top + visible + OVERSCAN_ROWS);
    // The empty-state or shell placeholder row goes once events arrive. The event rows are this method's: kept by
    // key on the body (no query of the table per update).
    let existing = body._eventRows;
    if (body._emptyMarkup || !existing || existing.size !== body.children.length) {
      for (const placeholder of body.querySelectorAll("tr:not([data-event-key])")) placeholder.remove();
      existing = new Map([...body.querySelectorAll("tr[data-event-key]")].map((node) => [String(node.dataset.eventKey || ""), node]));
    }
    body._emptyMarkup = "";
    const selectedKey = String(this.vm?.selectedEventKey || "");
    const kept = new Map();
    for (let position = first; position < end; position += 1) {
      const { key, event } = listed[position];
      const index = kept.size;
      const selected = selectedKey && key === selectedKey ? " selected-history-event" : "";
      const name = displayInstrumentName(event?.source || "shioaji", event?.code, event?.name);
      let node = existing.get(key);
      // An event row already drawn from this same event object, selection and name shows the same thing: its markup
      // is not built again (events are replaced, never modified, by the tape that holds them).
      if (node && node._eventSource === event && node._eventSelected === selected && node._eventName === name) {
        const atIndex = body.children[index] || null;
        if (node !== atIndex) body.insertBefore(node, atIndex);
        kept.set(key, node);
        continue;
      }
      if (!node && this.freshKeys?.has(key)) this.washStartedAt.set(key, performance.now());
      // A washing row's markup carries its wash, so patching the row keeps it.
      const wash = rowWashMarkup(node);
      const displayTime = eventDisplayTime(event);
      const html = `<tr class="event-feed-row${selected}${wash.className}"${wash.style} data-event-key="${escapeHtml(key)}" data-event-code="${escapeHtml(event?.code || "")}" data-event-time="${escapeHtml(displayTime)}">
        <td class="event-feed-time">${escapeHtml(displayTime)}</td><td>${escapeHtml(event?.code || "")}</td>
        <td class="event-feed-name">${escapeHtml(name)}</td><td class="event-feed-info ${eventInfoClass(event)}">${renderEventInfoHtml(event)}</td>
        ${MODEL_COLUMNS.map((column) => `<td class="${column.slot.endsWith("_up") ? "prediction-up" : "prediction-down"}">${formatPercent(event?.model_predictions?.[column.slot]?.probability)}</td>`).join("")}</tr>`;
      if (!node) {
        node = rowFromHtml(html);
        const startedAt = this.washStartedAt.get(key);
        if (startedAt != null && !washRow(node, startedAt, () => this.washStartedAt.delete(key))) this.washStartedAt.delete(key);
      } else if (node._eventMarkup !== html) patchRow(node, rowFromHtml(html));
      node._eventMarkup = html;
      node._eventSource = event; node._eventSelected = selected; node._eventName = name;
      kept.set(key, node);
      const atIndex = body.children[index] || null;
      if (node !== atIndex) body.insertBefore(node, atIndex);
    }
    for (const [key, stale] of existing) if (kept.get(key) !== stale) stale.remove();
    body._eventRows = kept;
    snap?.setVirtualWindow?.({ firstRow: first, logicalRows: listed.length });
  }

  update(vm = {}) {
    // A view model naming the same rows, dates and selection as the one drawn shows the same list: 歷史事件 is asked
    // again at every move of the replay time, and redrawing it each time read the list's geometry (a forced layout).
    if (sameViewModel(this.drawnVm, vm)) { this.vm = vm; return; }
    this.vm = vm || {};
    this.drawnVm = this.vm;
    this._renderFilters(this.vm);
    const logicalRows = this._renderRows(this.vm) || 0;
    this.rowSnap?.refreshContent?.({ topologyChanged: false, logicalRows });
  }
  resize() { this.rowSnap?.scheduleMeasure?.(); }
  destroy() {
    destroyColumnTitle(role(this.host, "event-table"));
    destroyStandardDataGrid(role(this.host, "event-scroll"));
    this.rowSnap = null;
    if (this.clickTimer) clearTimeout(this.clickTimer); this.clickTimer = null;
    this.cleanup.release();
    this.host = null; this.context = null; this.vm = {};
  }
}
