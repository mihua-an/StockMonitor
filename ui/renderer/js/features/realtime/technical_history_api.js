// history_api's page of 技術分析's earlier days: the live and the replay service ask the same way.
import { apiGetOk, apiJsonPost } from "../../core/api.js";

const MINUTE_PAGE_DAYS = 5;
const DAY_PAGE_BARS = 260;

export function loadTechnicalHistory({ code, market, session, resolution, before, limit = null }) {
  const count = limit ?? (resolution === "minute" ? MINUTE_PAGE_DAYS : DAY_PAGE_BARS);
  const query = new URLSearchParams({ code, market, session, resolution, before, limit: String(count) });
  return apiGetOk(`/api/history/kline?${query.toString()}`);
}

/** Earlier bars from the broker: `request` starts or joins the download, `status` tells where it stands. */
export function olderBarsApi() {
  return {
    request: (code, before) => apiJsonPost("/api/history/kline/older", { code, before }),
    status: (code) => apiGetOk(`/api/history/kline/older?code=${encodeURIComponent(code)}`),
  };
}
