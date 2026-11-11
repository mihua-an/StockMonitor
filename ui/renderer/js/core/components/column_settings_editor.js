import { escapeHtml } from "../utility.js";
import { columnProfile, isLastRequired } from "../column_profiles.js";
import { createViewResources } from "../../market_data/view_resources.js";

/**
 * The column settings panel: one per window, shared by every table with a ⚙ (商品列表, 實際庫存, 成交明細). It edits
 * the column profile (core/column_profiles.js) named by the window event `open-column-settings` (`detail.profile`):
 * which columns are shown and their order, kept as an uncommitted draft until 完成.
 *
 * Whoever shows a ⚙ holds the panel (retainColumnSettingsEditor): the first holder binds it, the last release
 * unbinds it, so a page and the components on it can each hold it without binding it twice.
 */
const OPEN_EVENT = "open-column-settings";
let holders = 0;
let viewResources = null;
let draft = null;
let draggingKey = "";

// The ⚙ that opens the panel: one button for every table that has one (商品列表's tools, 成交明細's title bar).
// `attributes` are the host's own data-* attributes (its role, its provider), already escaped.
export function columnSettingsButtonHtml({ label = "欄位設定", attributes = "" } = {}) {
  return `<button type="button" class="product-list-tool-btn" ${attributes} aria-label="${escapeHtml(label)}">⚙</button>`;
}

// `anchor`: the component the ⚙ belongs to (its whole card); the panel opens beside it.
export function openColumnSettings(profile, anchor = null) {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { profile: String(profile || ""), anchor } }));
}

const GAP = 8;
// Beside the component: on its right when the panel fits there, else on its left, else over its right edge kept
// inside the window; top-aligned with it and moved up when it would run past the window's bottom.
function placeBeside(panel, anchor) {
  const view = { width: window.innerWidth, height: window.innerHeight };
  const box = anchor?.getBoundingClientRect?.();
  const { width, height } = panel.getBoundingClientRect();
  let left, top;
  if (!box || !(box.width > 0)) {
    left = view.width - width - GAP;
    top = GAP;
  } else if (box.right + GAP + width <= view.width - GAP) left = box.right + GAP;
  else if (box.left - GAP - width >= GAP) left = box.left - GAP - width;
  else left = Math.min(box.right, view.width - GAP) - width;
  top = top ?? box.top;
  left = Math.max(GAP, Math.min(left, view.width - width - GAP));
  top = Math.max(GAP, Math.min(top, view.height - height - GAP));
  panel.style.setProperty("--column-settings-left", `${Math.round(left)}px`);
  panel.style.setProperty("--column-settings-top", `${Math.round(top)}px`);
}

function overlayNode() { return document.getElementById("quoteColumnSettingsOverlay"); }

function ensurePanel() {
  let overlay = overlayNode();
  if (overlay) return overlay;
  overlay = document.createElement("div");
  overlay.id = "quoteColumnSettingsOverlay";
  overlay.className = "product-list-column-settings-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="product-list-column-settings-panel" role="dialog" aria-modal="false" aria-label="欄位設定">
      <div class="product-list-column-settings-head">
        <span class="product-list-column-settings-icon" aria-hidden="true">⚙</span>
        <b>欄位設定</b>
        <button type="button" class="product-list-column-settings-close" data-column-settings-close aria-label="取消">✕</button>
      </div>
      <div id="quoteColumnSettingsList" class="product-list-column-settings-list"></div>
      <div class="product-list-column-settings-actions">
        <button id="quoteColumnCancelBtn" class="product-list-column-settings-cancel" type="button">取消</button>
        <button id="quoteColumnDoneBtn" class="product-list-column-settings-done" type="button">完成</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  return overlay;
}

function createDraft(name) {
  const profile = columnProfile(name);
  if (!profile) return null;
  const settings = profile.read();
  return {
    name, profile,
    order: [...settings.order],
    selected: new Set(settings.order.filter((key) => settings.visible[key] === true)),
  };
}

const CHECK_SVG = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.8 5.2 4.1 7.4 8.3 2.8"/></svg>';
const GRIP_SVG = '<svg viewBox="0 0 10 14" aria-hidden="true"><circle cx="2.5" cy="2.5" r="1.3"/><circle cx="7.5" cy="2.5" r="1.3"/>'
  + '<circle cx="2.5" cy="7" r="1.3"/><circle cx="7.5" cy="7" r="1.3"/><circle cx="2.5" cy="11.5" r="1.3"/><circle cx="7.5" cy="11.5" r="1.3"/></svg>';

// One row per column: the whole row is its tick (a round mark over the real checkbox), the grip on the right drags
// it. A shown column's row is tinted; a column its source has no figure for reads 無資料 and cannot be ticked; the
// last shown required column cannot be unticked.
function renderList() {
  const host = ensurePanel().querySelector("#quoteColumnSettingsList");
  if (!host || !draft) return;
  const map = new Map(draft.profile.options().map((item) => [item.key, item]));
  const { order, selected, profile } = draft;
  host.innerHTML = order.map((key, index) => {
    const item = map.get(key);
    if (!item) return "";
    const unavailable = item.unavailable === true;
    const shown = !unavailable && selected.has(key);
    const last = !unavailable && isLastRequired(profile, key, selected);
    const state = `${shown ? " selected" : ""}${unavailable ? " disabled" : ""}`;
    return `<label class="product-list-column-setting-row${state}" data-column-key="${escapeHtml(key)}" data-column-index="${index}"${last ? ' data-column-locked="1"' : ""}>
      <input type="checkbox" class="product-list-column-check-input" data-column-toggle="${escapeHtml(key)}" ${shown ? "checked" : ""} ${unavailable || last ? "disabled" : ""}>
      <span class="product-list-column-check">${CHECK_SVG}</span>
      <span class="product-list-column-label">${escapeHtml(item.label)}</span>
      ${unavailable ? '<span class="product-list-column-tag">無資料</span>' : ""}
      <button type="button" class="product-list-column-drag" draggable="true" data-column-drag="${escapeHtml(key)}" aria-label="拖曳排序">${GRIP_SVG}</button>
    </label>`;
  }).join("");
}

function bindList(host) {
  // Delegation keeps one set of listeners on the retained host. Replacing rows
  // cannot retain detached nodes or let their events edit a newer draft.
  const targetFor = (event, selector) => {
    if (!draft || overlayNode().hidden) return null;
    const target = event.target?.closest?.(selector);
    return target && host.contains(target) ? target : null;
  };
  viewResources.listen(host, "change", (event) => {
    const input = targetFor(event, "[data-column-toggle]");
    if (!input) return;
    const key = String(input.dataset.columnToggle || "");
    if (input.checked) draft.selected.add(key);
    else draft.selected.delete(key);
    // The row's tint follows its tick, and the required keys lock and unlock with each other.
    renderList();
  });
  // The grip sits inside the row's label: pressing it drags, never ticks.
  viewResources.listen(host, "click", (event) => {
    if (targetFor(event, "[data-column-drag]")) event.preventDefault();
  });
  viewResources.listen(host, "dragstart", (event) => {
    const button = targetFor(event, "[data-column-drag]");
    if (!button) return;
    draggingKey = String(button.dataset.columnDrag || "");
    button.closest(".product-list-column-setting-row")?.classList.add("dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", draggingKey);
    }
  });
  viewResources.listen(host, "dragend", () => {
    draggingKey = "";
    host.querySelectorAll(".product-list-column-setting-row").forEach((item) => item.classList.remove("dragging", "is-drag-over"));
  });
  viewResources.listen(host, "dragover", (event) => {
    const row = targetFor(event, ".product-list-column-setting-row");
    if (!row || !draggingKey) return;
    event.preventDefault();
    host.querySelectorAll(".product-list-column-setting-row").forEach((item) => item.classList.remove("is-drag-over"));
    row.classList.add("is-drag-over");
  });
  viewResources.listen(host, "drop", (event) => {
    const row = targetFor(event, ".product-list-column-setting-row");
    if (!row || !draggingKey) return;
    event.preventDefault();
    const from = draft.order.indexOf(draggingKey);
    const targetKey = String(row.dataset.columnKey || "");
    let to = draft.order.indexOf(targetKey);
    if (from < 0 || to < 0 || from === to) return;
    const rect = row.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    const [moved] = draft.order.splice(from, 1);
    to = draft.order.indexOf(targetKey);
    draft.order.splice(after ? to + 1 : to, 0, moved);
    draggingKey = "";
    renderList();
  });
}

function close() {
  const overlay = overlayNode();
  if (overlay) overlay.hidden = true;
  draggingKey = "";
  draft = null;
}

function save() {
  if (!draft) return close();
  const { profile, order, selected } = draft;
  const visible = Object.fromEntries(profile.options().map((item) => [item.key, item.unavailable !== true && selected.has(item.key)]));
  profile.write({ order, visible });
  close();
}

function toggle(event) {
  event?.stopPropagation?.();
  const overlay = ensurePanel();
  if (!overlay.hidden) {
    close();
    return;
  }
  const next = createDraft(event?.detail?.profile);
  if (!next) {
    console.warn("[column settings: opening] failed", `no column profile named ${JSON.stringify(event?.detail?.profile)}`);
    return;
  }
  draft = next;
  const title = overlay.querySelector(".product-list-column-settings-head b");
  if (title) title.textContent = draft.profile.title;
  const panel = overlay.querySelector?.('[role="dialog"]');
  panel?.setAttribute?.("aria-label", `${draft.profile.title}設定`);
  renderList();
  overlay.hidden = false;
  // Measured once shown: the panel's height is its list's.
  if (panel) placeBeside(panel, event?.detail?.anchor);
}

function bind() {
  viewResources = createViewResources();
  viewResources.activate();
  const overlay = ensurePanel();
  bindList(overlay.querySelector("#quoteColumnSettingsList"));
  viewResources.listen(window, OPEN_EVENT, toggle);
  viewResources.listen(overlay.querySelector("[data-column-settings-close]"), "click", () => close());
  viewResources.listen(overlay.querySelector("#quoteColumnCancelBtn"), "click", () => close());
  viewResources.listen(overlay.querySelector("#quoteColumnDoneBtn"), "click", save);
  viewResources.listen(overlay, "pointerdown", (event) => {
    if (event.target === overlay) close();
  });
  viewResources.listen(document, "keydown", (event) => {
    if (event.key === "Escape" && !overlay.hidden) close();
  });
}

function unbind() {
  close();
  viewResources?.dispose();
  viewResources = null;
}

/** Holds the panel for as long as the returned release is not called (idempotent). */
export function retainColumnSettingsEditor() {
  holders += 1;
  if (holders === 1) bind();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders === 0) unbind();
  };
}

export function columnSettingsEditorDiagnostics() {
  return { holders, ...(viewResources ? viewResources.diagnostics() : { disposables: 0 }) };
}
