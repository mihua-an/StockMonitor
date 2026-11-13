// Which Futu product page a product found by the code box goes to, and the page operations that put it there
// (POST /api/subscriptions/ops, service/market/reference/subscription_ops.py). Kept apart so it is testable in Node.

const NEW_PAGE_NAME = "美股";

/**
 * @param {{id:string,name?:string,source?:string,items?:{code:string}[],codes?:string[]}[]} pages every product page
 * @param {string} activePageId the page the Futu list shows ("overview" or a holdings page are not watch pages)
 * @param {string} code the full Futu code (US.NVDA)
 * @param {string} newPageId the id a new page gets when there is no Futu page
 * @returns {{pageName:string, ops:object[]}} ops empty when the code is on that page already
 */
export function pickFutuPage(pages, activePageId, code, newPageId) {
  const futu = (Array.isArray(pages) ? pages : []).filter((page) => String(page?.source || "").toLowerCase() === "futu");
  const page = futu.find((candidate) => String(candidate.id) === String(activePageId)) || futu[0] || null;
  if (!page) {
    const last = pages?.length ? String(pages[pages.length - 1].id) : "";
    return { pageName: NEW_PAGE_NAME, ops: [
      { op: "page.add", page_id: newPageId, name: NEW_PAGE_NAME, source: "futu", after: last },
      { op: "item.add", page_id: newPageId, code, after_code: "" },
    ] };
  }
  const codes = (Array.isArray(page.items) ? page.items.map((item) => item?.code) : page.codes || [])
    .map((value) => String(value || "").toUpperCase());
  const pageName = String(page.name || "");
  if (codes.includes(code)) return { pageName, ops: [] };
  return { pageName, ops: [{ op: "item.add", page_id: String(page.id), code, after_code: codes[codes.length - 1] || "" }] };
}
