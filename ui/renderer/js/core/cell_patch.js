// Table rows built from data, not markup. A cell is what it shows (`text`), how (`className`) and, when the
// text sits in one styled inline element, that element's class (`span`). A row is built once; an update writes only
// the text or class that differs from what the cell last showed -- no HTML string, no parse, no DOM read. No hover
// title: data is never hidden in one (user 10-20).
//
// A cell may also carry a `picker` after its text: { options: [[key, label], ...], current, hint? } -- the shared
// expand picker (core/components/expand_picker.js): only the current option shows, the others open beside it on
// hover. A click on one is the table's to handle (its button carries data-pick).

import { buildExpandPicker } from "./components/expand_picker.js";

export function cell(text, className = "", { span = "", picker = null } = {}) {
  return { text: text === null || text === undefined ? "" : String(text), className: className || "", span: span || "", picker };
}

const pickerSignature = (picker) => (picker ? `${picker.current}|${picker.options.map(([key, label]) => `${key}:${label}`).join(",")}|${picker.hint ? picker.hint.join(":") : ""}` : "");

function fillCell(td, model) {
  td.className = model.className;
  const doc = td.ownerDocument;
  if (model.span || model.picker) {
    // With a picker the text is always its own element, the picker the one after it.
    const span = doc.createElement("span");
    if (model.span) span.className = model.span;
    span.textContent = model.text;
    if (model.picker) td.replaceChildren(span, buildExpandPicker(doc, model.picker));
    else td.replaceChildren(span);
  } else {
    td.textContent = model.text;
  }
  td._cell = model;
}

function patchCell(td, model) {
  const last = td._cell;
  if (!last || last.span !== model.span || pickerSignature(last.picker) !== pickerSignature(model.picker)) { fillCell(td, model); return true; }
  let changed = false;
  if (last.className !== model.className) { td.className = model.className; changed = true; }
  if (last.text !== model.text) {
    if (model.picker) {
      // The text is the cell's first element, the picker after it.
      td.firstChild.textContent = model.text;
    } else {
      const target = model.span ? td.firstChild : td;
      const text = target?.firstChild;
      if (text && text.nodeType === 3 && !text.nextSibling) text.data = model.text;
      else target.textContent = model.text;
    }
    changed = true;
  }
  td._cell = model;
  return changed;
}

/** A new <tr> for `cells`. `attributes` are set once (identity attributes such as the row's code). */
export function buildCellRow(cells, { className = "", attributes = null, document: doc = globalThis.document } = {}) {
  const tr = doc.createElement("tr");
  if (className) tr.className = className;
  if (attributes) for (const [name, value] of Object.entries(attributes)) tr.setAttribute(name, String(value));
  for (const model of cells) {
    const td = doc.createElement("td");
    fillCell(td, model);
    tr.appendChild(td);
  }
  return tr;
}

/** Bring an existing row to `cells`. Returns whether anything was written. */
export function patchCellRow(tr, cells) {
  if (tr.cells.length !== cells.length) {
    const doc = tr.ownerDocument;
    tr.replaceChildren(...cells.map((model) => { const td = doc.createElement("td"); fillCell(td, model); return td; }));
    return true;
  }
  let changed = false;
  for (let index = 0; index < cells.length; index += 1) {
    if (patchCell(tr.cells[index], cells[index])) changed = true;
  }
  return changed;
}

/**
 * A table body of rows kept by key: `cellsOf(item)` gives a row's cells (above), `keyOf(item)` its identity. Rows are
 * built once and patched; a key that left the list takes its row with it. With no items the body shows one
 * `emptyText` row across `columnCount` columns. The body's rows are this function's alone.
 */
export function patchKeyedRows(body, items, { keyOf, cellsOf, emptyText = "", columnCount = 1, keyAttribute = "data-row-key" } = {}) {
  const doc = body.ownerDocument;
  if (!items.length) {
    if (body._keyedEmpty !== emptyText || body.children.length !== 1 || body._keyedRows?.size) {
      const tr = doc.createElement("tr");
      const td = doc.createElement("td");
      td.colSpan = Math.max(1, Number(columnCount) || 1);
      td.className = "empty";
      td.textContent = emptyText;
      tr.appendChild(td);
      body.replaceChildren(tr);
      body._keyedEmpty = emptyText;
      body._keyedRows = new Map();
    }
    return;
  }
  body._keyedEmpty = null;
  let rows = body._keyedRows;
  if (!rows || rows.size !== body.children.length) { body.replaceChildren(); rows = new Map(); }
  // Rows that leave go first: left in place until after the placing, each one would put every row below it one slot
  // off, and each of those would be taken out and put back.
  const wanted = new Set(items.map((item) => String(keyOf(item))));
  for (const [key, tr] of rows) if (!wanted.has(key)) tr.remove();
  const next = new Map();
  items.forEach((item, index) => {
    const key = String(keyOf(item));
    let tr = next.has(key) ? null : rows.get(key);
    if (tr) patchCellRow(tr, cellsOf(item));
    else tr = buildCellRow(cellsOf(item), { attributes: { [keyAttribute]: key }, document: doc });
    if (body.children[index] !== tr) body.insertBefore(tr, body.children[index] || null);
    next.set(next.has(key) ? `${key}\u0000${index}` : key, tr);
  });
  for (const [key, tr] of rows) if (next.get(key) !== tr) tr.remove();
  body._keyedRows = next;
}

/** What a cell shows, for tests and diagnostics. */
export function cellText(model) { return model?.text ?? ""; }
