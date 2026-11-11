// 「Shioaji產業指數」 (BACKLOG 1v): the industry indexes, 上市 then 上櫃, for the user to pick; a pick makes it the current
// industry index (industry_index_store.js), which 「產業指數」 shows. The current one is marked whichever way it was chosen
// (here, or by a stock picked on the Shioaji product list). The shell is built once; every change morphs the line and the
// list (dom_morph), the rows keyed by index code. Names only: the IX codes are not shown.
import { escapeHtml } from "../../../core/utility.js";
import { morphInto } from "../../../core/dom_morph.js";
import { mountShell } from "../../../core/component_shell.js";
import { industryIndexStore } from "../industry_index_store.js";

const GROUPS = Object.freeze([["tse", "上市"], ["otc", "上櫃"]]);

function shell() {
  return `<div class="industry-index-list">
    <div class="industry-index-list-current" data-role="industry-index-current"></div>
    <div class="industry-index-list-body" data-role="industry-index-body"></div>
  </div>`;
}

/** The line above the list: what is current, and why. */
export function currentLineHtml(current = {}) {
  const stock = escapeHtml(current.stock || "");
  if (current.status === "index") {
    const by = current.origin === "stock" && stock ? `<span class="industry-index-list-origin">${stock} 所屬</span>` : "";
    return `目前 <b class="industry-index-list-current-name">${escapeHtml(current.index.name)}</b>${by}`;
  }
  if (current.status === "unmapped") return `目前 <b class="industry-index-list-current-name">${stock}</b> 無對應產業指數`;
  if (current.status === "failed") return `讀取 ${stock} 的產業指數失敗`;
  return "";
}

/** The two groups of indexes; the current one carries `current`. */
export function listHtml(catalog = {}, current = {}) {
  const items = Array.isArray(catalog.items) ? catalog.items : [];
  if (!items.length) {
    const text = catalog.error ? `讀取產業指數清單失敗：${catalog.error}` : "讀取產業指數清單中…";
    return `<div class="industry-index-list-empty${catalog.error ? " error" : ""}" data-morph-key="empty">${escapeHtml(text)}</div>`;
  }
  const currentCode = current.status === "index" ? current.index.code : "";
  return GROUPS.map(([market, label]) => {
    const rows = items.filter((item) => item.market === market);
    if (!rows.length) return "";
    return `<section class="industry-index-list-group" data-morph-key="group-${market}">
      <div class="industry-index-list-group-title">${label}</div>
      <div class="industry-index-list-grid">${rows.map((item) => `<button type="button" class="industry-index-list-item${item.code === currentCode ? " current" : ""}"
        data-morph-key="${escapeHtml(item.code)}" data-industry-index="${escapeHtml(item.code)}" aria-pressed="${item.code === currentCode}">
        <span class="industry-index-list-name">${escapeHtml(item.name)}</span>
      </button>`).join("")}</div>
    </section>`;
  }).join("");
}

export class IndustryIndexListComponent {
  constructor({ store = industryIndexStore } = {}) {
    this.store = store;
    this.host = null; this.cleanup = [];
  }

  mount({ host, hydrate }) {
    this.host = host;
    mountShell(host, shell(), { hydrate });
    this.root = host.querySelector(".industry-index-list");
    this.currentNode = this.root.querySelector('[data-role="industry-index-current"]');
    this.body = this.root.querySelector('[data-role="industry-index-body"]');
    const onClick = (event) => {
      const button = event.target.closest?.("[data-industry-index]");
      if (!button || !this.root.contains(button)) return;
      const item = this.store.catalog().items.find((entry) => entry.code === button.dataset.industryIndex);
      if (item) this.store.selectIndex(item);
    };
    this.root.addEventListener("click", onClick);
    this.cleanup.push(() => this.root?.removeEventListener("click", onClick));
    this.cleanup.push(this.store.subscribe(() => this.render()));
    this.render();
    void this.store.loadCatalog();
  }

  render() {
    if (!this.root) return;
    const current = this.store.snapshot();
    morphInto(this.currentNode, currentLineHtml(current));
    morphInto(this.body, listHtml(this.store.catalog(), current));
  }

  resize() {}

  destroy() {
    for (const cleanup of this.cleanup.splice(0)) {
      try { cleanup(); } catch (error) { console.warn("[industry index list: cleanup] failed", error); }
    }
    this.host = null; this.root = null; this.currentNode = null; this.body = null;
  }
}
