// load-state (styles/components/load-state.css): what a card or section shows in place of its data while that data
// is not there -- still loading, failed, unavailable, or an answer with nothing in it -- on every page that reads on
// demand (帳務's day reads, 模型中心's cards). Pure HTML; the caller morphs the real content over it when it arrives.
import { escapeHtml } from "./utility.js";

const TEXT = { loading: "載入中…", failed: "讀取失敗", unavailable: "暫不可用" };

/** `state`: loading / failed / unavailable (anything else reads as loading); `detail`: why, after the state's text. */
export function loadStateHtml(state = "loading", detail = "") {
  const { known, text } = loadStateText(state, detail);
  return `<div class="load-state" data-state="${known}" role="status">${text}</div>`;
}

function loadStateText(state, detail) {
  const known = Object.hasOwn(TEXT, state) ? state : "loading";
  return { known, text: detail ? `${TEXT[known]}：${escapeHtml(detail)}` : TEXT[known] };
}

/** The same state as a table's only row, across its `colspan` columns (base.css .empty, a table's empty-row look). */
export function loadStateRowHtml(colspan, state = "loading", detail = "") {
  const { known, text } = loadStateText(state, detail);
  return `<tr><td colspan="${colspan}" class="empty" data-state="${known}" role="status">${text}</td></tr>`;
}

/** An answer that holds nothing, said in the section's own words. */
export function emptyStateHtml(text) {
  return `<div class="load-state" data-state="empty">${escapeHtml(text)}</div>`;
}

/** A table with nothing in it, as its only row. */
export function emptyStateRowHtml(colspan, text) {
  return `<tr><td colspan="${colspan}" class="empty" data-state="empty">${escapeHtml(text)}</td></tr>`;
}
