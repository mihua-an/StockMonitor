const { sourceDisabledResponse } = require("./source_disabled_response");
const { withTimeout } = require("../../service/platform/js/fetch_timeout");

function createProductOperations({ fetch, urlFor, productCatalogStore, sourceEnabled }) {
  async function postBackendJson(pathname, timeoutMs = 35000) {
    return withTimeout(Math.max(100, Number(timeoutMs) || 35000), async (signal) => {
      const response = await fetch(urlFor(pathname), { method: "POST", cache: "no-store", signal });
      // A failure answers with its status and the same {ok:false, ...} body: the body is the answer; only an
      // unreadable one is thrown.
      const body = await response.json().catch(() => /* not an error: an unreadable body is thrown as HTTP <status> on the next line */ null);
      if (body && typeof body === "object") return body;
      throw new Error(`HTTP ${response.status}`);
    });
  }

  async function loadProductCatalogIndex() {
    return productCatalogStore.bootstrap({ timeoutMs: 10000 });
  }

  // Only Futu's master is asked for at the start: Shioaji's is written by the provider's login (before it the broker's
  // contracts are not there), and the catalog this copy follows rebuilds on that write's notice.
  async function refreshFutuProductCatalog() {
    if (!sourceEnabled("futu")) return sourceDisabledResponse("futu");
    return postBackendJson("/api/futu/security-master/ensure", 40000);
  }

  return { loadProductCatalogIndex, refreshFutuProductCatalog };
}
module.exports = { createProductOperations };
