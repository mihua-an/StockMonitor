import { escapeHtml } from "./utility.js";

const selectHandlers = new WeakMap();

/** Shared single-select session rail used by futures and US-equity trends.
 *
 * The buttons are built once per session list; a later call with the same list only moves the active mark and
 * rewrites each button's note, so a data update never rebuilds the rail. A list of one session (crypto's 24H) is no
 * choice: the rail is hidden. A session may carry a `title` (the hover text of a short label) and a `note`: the part
 * of it trading now (Futu 日盤's 盤前 / 盤中 / 盤後), written small on its button. */
export function renderTrendSessionControl(host, {
  sessions = [], activeKey = "", dataAttribute = "trend-session", onSelect = null,
} = {}) {
  if (!host) return;
  // Called on every data frame: each class, attribute and text below is written only when it changes.
  if (!host.classList.contains("pill-switch")) host.classList.add("pill-switch");
  if (!host.classList.contains("trend-session-control")) host.classList.add("trend-session-control");
  const datasetKey = dataAttribute.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
  const signature = JSON.stringify([dataAttribute, sessions.map((session) => [String(session?.key || ""), String(session?.label || ""),
    String(session?.title || ""), "note" in (session || {})])]);
  if (host.dataset.sessionList !== signature) {
    host.innerHTML = sessions.map((session) => {
      const key = String(session?.key || "");
      const note = "note" in (session || {}) ? '<small class="trend-session-note" data-role="session-note" hidden></small>' : "";
      return `<button type="button" class="pill-switch-btn" data-${dataAttribute}="${escapeHtml(key)}">${escapeHtml(session?.label || key)}${note}</button>`;
    }).join("");
    host.dataset.sessionList = signature;
  }
  if (host.hidden !== (sessions.length <= 1)) host.hidden = sessions.length <= 1;
  const notes = new Map(sessions.map((session) => [String(session?.key || ""), String(session?.note || "")]));
  for (const button of host.querySelectorAll(`[data-${dataAttribute}]`)) {
    const key = String(button.dataset[datasetKey] || "");
    const active = key === String(activeKey);
    if (button.classList.contains("active") !== active) button.classList.toggle("active", active);
    const pressed = active ? "true" : "false";
    if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
    const noteNode = button.querySelector?.('[data-role="session-note"]');
    if (noteNode) {
      const note = notes.get(key) || "";
      if (noteNode.textContent !== note) noteNode.textContent = note;
      if (noteNode.hidden !== !note) noteNode.hidden = !note;
    }
  }
  if (!selectHandlers.has(host)) {
    host.addEventListener("click", (event) => {
      const entry = selectHandlers.get(host);
      const button = event.target?.closest?.(`[data-${entry?.dataAttribute}]`);
      if (!button || !host.contains(button)) return;
      entry?.onSelect?.(String(button.dataset[entry.datasetKey] || ""));
    });
  }
  selectHandlers.set(host, { onSelect, dataAttribute, datasetKey });
}
