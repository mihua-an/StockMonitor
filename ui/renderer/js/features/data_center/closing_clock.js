// 資料中心 收盤整理's figures beside the steps (下次物化・時間・倒數, and the running close's 進度・預估剩餘): the one
// writer of that node. The page's poll only hands it the latest answer; it draws that answer at once and again on its
// own 1 s tick, so the countdown moves with the clock between answers. Morphed: a second with nothing new writes
// nothing.
import { morphInto } from "../../core/dom_morph.js";
import { renderClosingNext } from "./closing_progress_view.js";

/** Own `node` until dispose(); `now` and `timers` are the clock (a test passes its own). */
export function createClosingClock(node, { now = () => Date.now(), timers = window } = {}) {
  let input = null;
  const draw = () => {
    if (node && input) morphInto(node, renderClosingNext(input, now()));
  };
  let tick = timers.setInterval(draw, 1000);
  return {
    /** The latest 收盤整理 answer (GET /api/data-center/closing): drawn now and on every tick after. */
    setInput(payload) {
      if (tick === null) return;
      input = payload;
      draw();
    },
    dispose() {
      if (tick !== null) timers.clearInterval(tick);
      tick = null;
      input = null;
    },
  };
}
