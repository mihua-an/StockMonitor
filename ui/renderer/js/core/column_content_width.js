// The width each column of a data table needs for what it shows now: its title (with room for the sort mark) and the
// widest value in its rows, each in the style its cell has. 商品列表 minimums were the widest value a column could ever
// hold (使用者 10-20: 損益 sized for +123,456.78 while the rows held +1,234), so the numbers had far more room than
// they needed.
//
// No layout is read: the rows' cells are data (core/cell_patch.js td._cell), text is measured with a canvas in the
// cell's font, and a cell's font and padding are read once per style (column, row class, cell class, span class) --
// a computed-style read, done again only when a new style appears.

// table -> { parent, styles: Map(style key -> { font, letterSpacing, minWidth, extra }) }. Kept while the table stays
// where it is: moved (DataGrid puts the title in a header viewport of its own), rules matching on its place change.
const STYLE_CACHE = new WeakMap();
const CELL_WIDTHS = new WeakMap();   // td -> { model, rowClass, width }: a cell not written since is not measured again
const TEXT_WIDTHS = new Map();       // `${font}\u0000${text}` -> px
const TEXT_WIDTHS_LIMIT = 20000;
let context = null;

function measureContext() {
  if (!context) context = globalThis.document.createElement("canvas").getContext("2d");
  return context;
}

function px(value) { return Number.parseFloat(value) || 0; }

function styleOf(table, key, element, box = element) {
  let entry = STYLE_CACHE.get(table);
  if (!entry || entry.parent !== table.parentElement) {
    entry = { parent: table.parentElement, styles: new Map() };
    STYLE_CACHE.set(table, entry);
  }
  const cache = entry.styles;
  let style = cache.get(key);
  if (!style) {
    const text = getComputedStyle(element);
    const outer = box === element ? text : getComputedStyle(box);
    style = {
      font: text.font || `${text.fontWeight} ${text.fontSize} ${text.fontFamily}`,
      letterSpacing: text.letterSpacing === "normal" ? "0px" : text.letterSpacing,
      minWidth: px(text.minWidth),   // an inline-block's (the sort mark's) floor
      // What the box adds around its text: padding, borders and margins.
      extra: px(outer.paddingLeft) + px(outer.paddingRight) + px(outer.borderLeftWidth) + px(outer.borderRightWidth)
        + (box === element ? px(outer.marginLeft) + px(outer.marginRight) : 0),
    };
    cache.set(key, style);
  }
  return style;
}

function textWidth(style, text) {
  if (!text) return 0;
  const key = `${style.font}\u0000${style.letterSpacing}\u0000${text}`;
  let width = TEXT_WIDTHS.get(key);
  if (width === undefined) {
    const ctx = measureContext();
    ctx.font = style.font;
    ctx.letterSpacing = style.letterSpacing;
    width = ctx.measureText(text).width;
    if (TEXT_WIDTHS.size >= TEXT_WIDTHS_LIMIT) TEXT_WIDTHS.clear();
    TEXT_WIDTHS.set(key, width);
  }
  return width;
}

// The title cell: its label, and the sort mark's room whether or not the column is sorted now (sorting must not
// move the columns).
function titleWidth(headerTable, th, place) {
  const label = th.querySelector(":scope > .canonical-title-label");
  if (!label) return 0;
  const labelStyle = styleOf(headerTable, `title|${place}|${th.className}`, label, th);
  let width = textWidth(labelStyle, label.textContent || "") + labelStyle.extra;
  const mark = th.querySelector(":scope > .canonical-sort-mark");
  if (mark) {
    const markStyle = styleOf(headerTable, `mark|${place}|${th.className}`, mark);
    width += Math.max(markStyle.minWidth, textWidth(markStyle, "▲")) + markStyle.extra;
  }
  return width;
}

// The text a cell needs room for: a column with `contentMaxChars` makes room for that many characters and the
// ellipsis the cell draws after them (the table's text-overflow), not for its whole text.
function shownText(text, maxChars) {
  if (!maxChars) return text;
  const chars = Array.from(text);
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join("")}…` : text;
}

// body -> { columns: header count, widths: widest cell of each column }: the cells' part of the last measure, so a
// measure of a few rows (the ones a Tick wrote) widens it instead of walking every row again.
const BODY_WIDTHS = new WeakMap();

/**
 * The px each of the header's columns needs: the widest of its title and of its cells in `body`. `columns` are the
 * header's columns in order (for `contentMaxChars`). A body showing a placeholder (one cell across the columns) adds
 * nothing beyond the titles.
 *
 * `rows`: the <tr>s written since the last measure of this body. Only they are measured, against the widest cells
 * that measure found -- so a column never narrows this way (a value that got shorter keeps its room until the next
 * full measure), which is what a table that does not shrink while prices tick needs. Without `rows`, or when the
 * columns changed since, every row is measured.
 */
export function measureColumnContent(headerTable, body, columns = [], { rows = null } = {}) {
  const headers = [...headerTable.querySelectorAll(":scope > thead > tr:last-child > th")];
  // A style is known by the cell's place too (a last column has its own padding) and the column count.
  const place = (index) => `${index}/${headers.length}`;
  const known = body ? BODY_WIDTHS.get(body) : null;
  const partial = Array.isArray(rows) && known?.columns === headers.length;
  const cells = partial ? known.widths : headers.map(() => 0);
  measureRows(headerTable, partial ? rows : body?.rows || [], headers.length, columns, place, cells);
  if (body) BODY_WIDTHS.set(body, { columns: headers.length, widths: cells });
  const widths = headers.map((th, index) => Math.max(titleWidth(headerTable, th, place(index)), cells[index]));
  // Rounded up, and one px for the sub-pixel the canvas and the table may round differently.
  return widths.map((width) => Math.ceil(width) + 1);
}

function measureRows(headerTable, rows, count, columns, place, widths) {
  for (const tr of rows) {
    if (tr.cells.length !== count) continue;
    const rowClass = tr.className;
    for (let index = 0; index < count; index += 1) {
      const td = tr.cells[index];
      const model = td._cell;
      let known = model ? CELL_WIDTHS.get(td) : null;
      if (!known || known.model !== model || known.rowClass !== rowClass) {
        const text = shownText(model ? model.text : td.textContent, columns[index]?.contentMaxChars);
        let width = 0;
        if (text) {
          const span = model?.span ? td.firstElementChild : null;
          const style = styleOf(headerTable, `cell|${place(index)}|${rowClass}|${td.className}|${model?.span || ""}`, span || td, td);
          width = textWidth(style, text) + style.extra;
        }
        known = { model, rowClass, width };
        if (model) CELL_WIDTHS.set(td, known);
      }
      if (known.width > widths[index]) widths[index] = known.width;
    }
  }
}
