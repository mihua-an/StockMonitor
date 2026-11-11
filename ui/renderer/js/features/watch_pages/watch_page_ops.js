// What a 商品頁設定 window changed, as the operations of POST /api/subscriptions/ops
// (service/market/reference/subscription_ops.py): the difference between the pages it loaded (`base`) and its draft,
// never the whole list -- applied on the server to the list as it is then, so another window's changes stay.
// An item travels as its code: its name and type are the product catalog's, never written with the pages.

function byId(pages) {
  return new Map(pages.map((page) => [String(page.id), page]));
}

function alertOf(item) {
  return [String(item?.lower_alert ?? ""), String(item?.upper_alert ?? "")];
}

/** The members of `ids` also in `others`, in `ids` order. */
function common(ids, others) {
  const set = new Set(others);
  return ids.filter((id) => set.has(id));
}

function sameOrder(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function itemOps(pageId, baseItems, draftItems) {
  const ops = [];
  const baseCodes = baseItems.map((item) => item.code);
  const draftCodes = draftItems.map((item) => item.code);
  const baseByCode = new Map(baseItems.map((item) => [item.code, item]));
  for (const code of baseCodes) if (!draftCodes.includes(code)) ops.push({ op: "item.remove", page_id: pageId, code });
  draftItems.forEach((item, index) => {
    if (baseByCode.has(item.code)) return;
    ops.push({ op: "item.add", page_id: pageId, code: item.code, after_code: index ? draftItems[index - 1].code : "" });
  });
  const kept = common(baseCodes, draftCodes);
  if (!sameOrder(kept, common(draftCodes, baseCodes))) ops.push({ op: "item.order", page_id: pageId, codes: draftCodes });
  for (const item of draftItems) {
    const [lower, upper] = alertOf(item);
    const [baseLower, baseUpper] = alertOf(baseByCode.get(item.code));
    if (lower !== baseLower || upper !== baseUpper) ops.push({ op: "item.alert", page_id: pageId, code: item.code, lower, upper });
  }
  return ops;
}

/** The operations that turn `base` into `draft` (both normalized pages, watch_page_draft.js). */
export function draftOps(base, draft) {
  const ops = [];
  const baseMap = byId(base);
  const draftMap = byId(draft);
  for (const page of base) if (!draftMap.has(String(page.id))) ops.push({ op: "page.remove", page_id: String(page.id) });
  draft.forEach((page, index) => {
    const id = String(page.id);
    const before = baseMap.get(id);
    if (!before) {
      ops.push({ op: "page.add", page_id: id, name: page.name, source: page.source, after: index ? String(draft[index - 1].id) : "" });
      ops.push(...itemOps(id, [], page.items));
      return;
    }
    if (before.name !== page.name) ops.push({ op: "page.rename", page_id: id, name: page.name });
    ops.push(...itemOps(id, before.items, page.items));
  });
  const baseIds = base.map((page) => String(page.id));
  const draftIds = draft.map((page) => String(page.id));
  if (!sameOrder(common(baseIds, draftIds), common(draftIds, baseIds))) ops.push({ op: "page.order", page_ids: draftIds });
  return ops;
}

/** `current` with the members also in `wanted` in `wanted`'s order, in the places they held (subscription_ops.reorder). */
function reorderBy(current, wanted, key) {
  const present = new Set(current.map(key));
  const order = [...new Set(wanted)].filter((w) => present.has(w));
  const rank = new Set(order);
  const byKey = new Map(current.map((x) => [key(x), x]));
  let next = 0;
  return current.map((x) => (rank.has(key(x)) ? byKey.get(order[next++]) : x));
}

function insertAfter(rows, row, after, key) {
  const at = rows.findIndex((r) => key(r) === after);
  return at < 0 ? [...rows, row] : [...rows.slice(0, at + 1), row, ...rows.slice(at + 1)];
}

/** The page operations applied to `pages` as settings_api applies them (subscription_ops.apply_ops, the same cases
 *  in tests/renderer_watch_page_ops_contract.mjs): a window shows another window's saved pages under its own
 *  unsaved changes. Returns new pages; the input is not changed. `shown(pageId, code)`: what this window shows of an
 *  item it added and has not saved (the catalog's name and type from its search), for its own display only. */
export function applyPageOps(pages, ops, shown = () => ({})) {
  let out = pages.map((page) => ({ ...page, items: [...(page.items || [])] }));
  const find = (id) => out.find((page) => String(page.id) === id);
  const pageId = (page) => String(page.id);
  const code = (item) => String(item.code || "").toUpperCase();
  for (const op of ops) {
    if (op.op === "page.add") {
      if (!find(op.page_id)) out = insertAfter(out, { id: op.page_id, name: op.name, source: op.source, items: [] }, op.after || "", pageId);
    } else if (op.op === "page.remove") out = out.filter((page) => pageId(page) !== op.page_id);
    else if (op.op === "page.rename") { const page = find(op.page_id); if (page) page.name = op.name; }
    else if (op.op === "page.order") out = reorderBy(out, op.page_ids, pageId);
    else {
      const page = find(op.page_id);
      if (!page) continue;
      if (op.op === "item.order") page.items = reorderBy(page.items, op.codes, code);
      else if (op.op === "item.add") {
        if (!page.items.some((item) => code(item) === op.code)) {
          page.items = insertAfter(page.items, { ...shown(op.page_id, op.code), code: op.code, source: page.source }, op.after_code || "", code);
        }
      } else if (op.op === "item.remove") page.items = page.items.filter((item) => code(item) !== op.code);
      else if (op.op === "item.alert") {
        page.items = page.items.map((item) => (code(item) === op.code ? { ...item, lower_alert: op.lower, upper_alert: op.upper } : item));
      }
    }
  }
  return out;
}

/** One batch: a new id each time it is built, so a batch re-sent after a lost reply is applied once. */
export function opsBatch(ops, client = "watch_pages_window") {
  return { batch_id: globalThis.crypto.randomUUID(), client, ops };
}
