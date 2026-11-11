// The expand picker: a pill group that shows only its current option and opens the others beside it on hover
// (decisions.md 商品的現貨／期貨與月份: 商品列表's 現／月份, 技術分析's K 棒週期). One component, one stylesheet
// (components/expand-picker.css); a click on an option is its owner's (each button carries data-pick).
// A `hint` [key, label] is one more button shown only while the picker is closed and hidden once it opens: 商品列表's
// 「期」 beside 「現」, so a product on its spot side still shows it has futures (user 11-08).

const ROOT = "expand-picker";

/** The picker's markup, for a component drawn from a string (morphInto). `attrs` go on the group. */
// `corner`: at the top right of its positioned owner, opening over it (components/expand-picker.css).
export function expandPickerHtml({ options = [], current = "", hint = null, corner = false } = {}, attrs = "") {
  const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return `<span class="${ROOT}${corner ? " expand-picker-corner" : ""}" role="group"${attrs ? ` ${attrs}` : ""}>${options.map(([key, label]) => {
    const on = String(key) === String(current);
    return `<button type="button" class="${on ? "is-active" : ""}" data-pick="${escape(key)}" aria-pressed="${on}">${escape(label)}</button>`;
  }).join("")}${hint ? `<button type="button" class="is-hint" data-pick="${escape(hint[0])}" aria-pressed="false">${escape(hint[1])}</button>` : ""}</span>`;
}

/** The picker as elements, for a table cell built from data (core/cell_patch.js). */
export function buildExpandPicker(doc, { options = [], current = "", hint = null } = {}) {
  const group = doc.createElement("span");
  group.className = ROOT;
  group.setAttribute("role", "group");
  for (const [key, label] of options) {
    const on = String(key) === String(current);
    const button = doc.createElement("button");
    button.type = "button";
    if (on) button.className = "is-active";
    button.dataset.pick = String(key);
    button.setAttribute("aria-pressed", String(on));
    button.textContent = String(label);
    group.appendChild(button);
  }
  if (hint) {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "is-hint";
    button.dataset.pick = String(hint[0]);
    button.setAttribute("aria-pressed", "false");
    button.textContent = String(hint[1]);
    group.appendChild(button);
  }
  return group;
}
