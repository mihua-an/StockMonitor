// 版型編輯 (the window 設定 opens): 即時報價's real components and data on the screens being arranged. It is the live
// page's own assembly (pages/realtime.js) on this page's workspace; the main window follows every change.
import { morphInto } from "../core/dom_morph.js";
import { escapeHtml } from "../core/utility.js";
import { screenLayouts } from "../features/layouts/screen_layouts.js";
import { initRealtimePage, resizeRealtimePage, setLiveSurface } from "./realtime.js";

let toolbar = null;
let editing = null;     // what the toolbar's inline editor is doing: { kind: "add" | "rename" | "remove", id? }
let started = null;     // the live page's mount

function editorMarkup(screens) {
  if (!editing) return "";
  if (editing.kind === "remove") {
    const name = screens.list().find((item) => item.id === editing.id)?.name || "";
    return `<span class="layouts-prompt">刪除「${escapeHtml(name)}」？無法復原</span>
      <button type="button" class="layouts-action" data-action="confirm-remove">刪除</button>
      <button type="button" class="layouts-action" data-action="cancel">取消</button>`;
  }
  const value = editing.kind === "rename" ? screens.list().find((item) => item.id === editing.id)?.name || "" : "";
  const buttons = editing.kind === "add"
    ? `<button type="button" class="layouts-action" data-action="create-copy">複製目前畫面</button>
       <button type="button" class="layouts-action" data-action="create-empty">空白畫面</button>`
    : `<button type="button" class="layouts-action" data-action="save-name">儲存</button>`;
  return `<input class="layouts-name-input" data-role="layouts-name" maxlength="20" placeholder="畫面名稱" aria-label="畫面名稱" value="${escapeHtml(value)}">
    ${buttons}<button type="button" class="layouts-action" data-action="cancel">取消</button>`;
}

function drawToolbar() {
  if (!toolbar) return;
  const screens = screenLayouts();
  const active = screens.active();
  const items = screens.list();
  const tabs = items.map((item) => `<button type="button" class="layouts-tab${item.id === active.id ? " active" : ""}" data-morph-key="${escapeHtml(item.id)}" data-screen="${escapeHtml(item.id)}" aria-pressed="${item.id === active.id}">${escapeHtml(item.name)}</button>`).join("");
  const isBuiltIn = items.find((item) => item.id === active.id)?.builtIn;
  const actions = editing ? editorMarkup(screens) : `
    <button type="button" class="layouts-action" data-action="add">＋ 新增畫面</button>
    <button type="button" class="layouts-action" data-action="rename">改名</button>
    ${isBuiltIn ? '<button type="button" class="layouts-action" data-action="reset">還原</button>' : ""}
    ${items.length > 1 ? '<button type="button" class="layouts-action" data-action="remove">刪除</button>' : ""}`;
  morphInto(toolbar, `<div class="layouts-tabs" data-morph-key="tabs" role="group" aria-label="畫面">${tabs}</div><div class="layouts-actions" data-morph-key="actions-${editing?.kind || "idle"}">${actions}</div>`);
  if (editing && editing.kind !== "remove") toolbar.querySelector('[data-role="layouts-name"]')?.focus();
}

function typedName(fallback) {
  return String(toolbar.querySelector('[data-role="layouts-name"]')?.value || "").trim() || fallback;
}

function stopEditing() {
  editing = null;
  drawToolbar();
}

function onToolbarClick(event) {
  const screens = screenLayouts();
  const screenId = event.target?.closest?.("[data-screen]")?.dataset?.screen;
  if (screenId) { screens.select(screenId); return; }
  const action = event.target?.closest?.("[data-action]")?.dataset?.action;
  if (!action) return;
  const activeId = screens.active().id;
  if (action === "add") { editing = { kind: "add" }; drawToolbar(); }
  else if (action === "rename") { editing = { kind: "rename", id: activeId }; drawToolbar(); }
  else if (action === "remove") { editing = { kind: "remove", id: activeId }; drawToolbar(); }
  else if (action === "cancel") stopEditing();
  else if (action === "create-copy" || action === "create-empty") {
    const name = typedName(`畫面 ${screens.list().length + 1}`);
    editing = null;
    screens.add({ name, copy: action === "create-copy" });
  } else if (action === "save-name") {
    const { id } = editing;
    const name = typedName(screens.active().name);
    editing = null;
    screens.rename(id, name);
  } else if (action === "confirm-remove") {
    const { id } = editing;
    editing = null;
    screens.remove(id);
  } else if (action === "reset") screens.reset(activeId);
}

function onToolbarKey(event) {
  if (!event.target?.matches?.('[data-role="layouts-name"]')) return;
  if (event.key === "Escape") stopEditing();
  if (event.key === "Enter" && editing?.kind === "rename") toolbar.querySelector('[data-action="save-name"]')?.click();
  if (event.key === "Enter" && editing?.kind === "add") toolbar.querySelector('[data-action="create-copy"]')?.click();
}

export function initLayoutsPage() {
  toolbar = document.querySelector('[data-role="layouts-toolbar"]');
  toolbar.addEventListener("click", onToolbarClick);
  toolbar.addEventListener("keydown", onToolbarKey);
  screenLayouts().subscribe(drawToolbar);
  drawToolbar();
  setLiveSurface(".layouts-workspace");
  started = initRealtimePage();
}

export function layoutsPageStarted() {
  return started;
}

export function resizeLayoutsPage() {
  resizeRealtimePage();
}
