// 執行紀錄 under a row of its own (job-status): the row opens and closes the log with the shared expand motion
// (expand_motion.js). The user opens and closes it; a page may also open or close it by itself (資料中心 opens the log
// while a close is being materialized and closes it when done, user 11-01) with `setOpen`. A click while the log is
// still moving is ignored, as every expanding block does.
import { createExpandMotion } from "./expand_motion.js";

export function createJobLogToggle(toggle, pane) {
  let open = Boolean(toggle && pane && !pane.hidden);
  const motion = createExpandMotion({ find: () => pane, redraw: () => { pane.hidden = !open; } });

  function setOpen(next) {
    if (!toggle || !pane || next === open || !motion.start("log", next)) return;
    open = next;
    toggle.setAttribute("aria-expanded", String(open));
    if (open) pane.hidden = false;
    motion.play();
  }

  const onClick = () => setOpen(!open);
  toggle?.addEventListener("click", onClick);
  return {
    setOpen,
    isOpen: () => open,
    dispose: () => toggle?.removeEventListener("click", onClick),
  };
}
