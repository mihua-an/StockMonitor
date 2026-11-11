import { $ } from "../../core/utility.js";
import { createExpandMotion } from "../../core/expand_motion.js";

/**
 * The account page's scrolling around blocks that open under a row (a day, a pair day, a stock, a band, a weekday, a
 * pair replay): the shared expand motion grows the block, and the block comes into view only when it does not fit,
 * only as far as it needs (core/reveal_scroll.js). What this page adds is the band its content scroll keeps clear at
 * the top -- 當沖分析's 總覽 / 多單 / 空單 tabs are sticky there -- and the replay panel's motion (one replay is open
 * at a time).
 */
export function createAccountScrollController() {
  function syncStickyMetrics() {
    const page = document.querySelector(".account-page");
    const header = document.querySelector(".account-page-header");
    if (!page || !header) return;
    const headerHeight = Math.max(54, Math.ceil(header.getBoundingClientRect().height || 0));
    page.style.setProperty("--actual-account-sticky-header-height", `${headerHeight}px`);
  }

  /** The band at the top of `scroller` that rows pass under, for a block inside `element`'s view. */
  function insetTop(scroller, element) {
    if (scroller !== $("actualAccountContentScroll")) return 0;
    const daytradePanel = element?.closest?.('[data-account-view-panel="daytrade"]');
    const tabs = daytradePanel && !daytradePanel.hidden ? daytradePanel.querySelector(".account-daytrade-tabs") : null;
    return tabs && !tabs.hidden ? Math.ceil(tabs.getBoundingClientRect().height || 0) + 8 : 0;
  }

  /** `reveal` for createExpandMotion: from the row the block opened under (`rowFor(key)`) through the block. */
  function revealFrom(rowFor) {
    return (key, node) => {
      const row = rowFor(key);
      return row ? { first: row, last: node.closest("tr") || node, insetTop: (scroller) => insetTop(scroller, row) } : null;
    };
  }

  let replaySource = null;
  const replayMotion = createExpandMotion({
    find: () => document.querySelector("[data-pair-replay-panel]"),
    redraw: () => {},
    reveal: revealFrom(() => replaySource),
  });

  /** A pair replay was just drawn under `sourceSelector`'s row: open it with the motion and bring it into view. */
  function openReplay(sourceSelector) {
    replaySource = typeof sourceSelector === "string" ? document.querySelector(sourceSelector) : sourceSelector;
    if (!replayMotion.start("replay", true)) return;
    replayMotion.play();
  }

  function cancel() {
    const scroll = $("actualAccountContentScroll");
    if (!scroll) return;
    // A scroll at the position it is at ends a smooth scroll still moving toward an outdated target.
    scroll.scrollTo({ top: scroll.scrollTop, behavior: "auto" });
  }

  return { syncStickyMetrics, revealFrom, openReplay, cancel };
}
