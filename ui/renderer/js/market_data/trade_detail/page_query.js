export const TRADE_DETAIL_PAGE_SIZE = 100;

// One read of /api/trade-detail/page, as every 成交明細 pager asks it: a page of the product's session frozen at
// `watermark` (0: as of now), or only its count (metadataOnly).
export function tradePageQuery({ market, code, session, tradingDate, actualContract, page, watermark = 0, metadataOnly = false }) {
  const params = new URLSearchParams({ market, logical_code: code, ...(session ? { session } : {}), page: String(page),
    page_size: String(TRADE_DETAIL_PAGE_SIZE), snapshot_watermark: String(watermark || 0) });
  if (metadataOnly) params.set("metadata_only", "true");
  if (tradingDate) params.set("trading_date", tradingDate);
  if (actualContract) params.set("actual_contract", actualContract);
  return params;
}
