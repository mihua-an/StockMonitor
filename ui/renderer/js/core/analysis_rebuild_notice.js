// analysis-rebuild (styles/components/analysis-rebuild.css): 分析資料重建中 over a pane whose data is Rust B's
// (價量, the trends, 技術分析, 大單流向) while B rebuilds from the durable stream or catches up to it. One shared
// component: ComponentHost lays it over every component registered `analysisSourced`, in a context that has the
// `analysisState` service (a live window: Market Runtime's `analysis.state`, market_data/realtime.js). It shows only
// what Market Runtime says -- the state and its progress -- and goes away by itself when B is LIVE.

import { morphInto } from "./dom_morph.js";

const PERCENT = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 });

/** The notice's markup for an `analysis.state` payload; "" when there is nothing to show (B LIVE, OFFLINE, unknown). */
export function analysisRebuildHtml(state) {
  if (state?.state !== "CATCHING_UP") return "";
  const progress = Number.isFinite(state.progress) ? Math.min(1, Math.max(0, state.progress)) : null;
  // Without a measured span (a B that does not report where it started) only the words are shown; no bar is guessed.
  const percent = progress === null ? "" : `${PERCENT.format(Math.floor(progress * 100))}%`;
  const bar = progress === null ? ""
    : `<div class="analysis-rebuild-bar" aria-hidden="true"><div class="analysis-rebuild-fill" style="width:${(progress * 100).toFixed(1)}%"></div></div>`;
  return `<div class="analysis-rebuild-card" role="status"><div class="analysis-rebuild-text">分析資料重建中`
    + `${percent ? `<span class="analysis-rebuild-percent">${percent}</span>` : ""}</div>${bar}</div>`;
}

/**
 * Lay the notice over `host` (the pane's component host) and keep it to `subscribe`'s states. The overlay element is
 * the host's last child, there for as long as the component is; only its content changes (morphInto). Returns the
 * function that removes it.
 */
export function attachAnalysisRebuildNotice(host, subscribe) {
  const doc = host.ownerDocument;
  const overlay = doc.createElement("div");
  overlay.className = "analysis-rebuild";
  overlay.dataset.role = "analysis-rebuild";
  overlay.hidden = true;
  host.dataset.analysisSourced = "1";
  host.appendChild(overlay);
  const unsubscribe = subscribe((state) => {
    const html = analysisRebuildHtml(state);
    morphInto(overlay, html);
    overlay.hidden = html === "";
  });
  return () => {
    unsubscribe?.();
    overlay.remove();
    delete host.dataset.analysisSourced;
  };
}
