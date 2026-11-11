import { viewErrorOf } from "./market_read_model.js";

const STATES = new Set(["loading", "ready", "stale", "resyncing", "empty", "error"]);

export function viewLifecycleState(vm = {}) {
  const direct = String(vm?.presentationState || vm?.presentation_state || "").trim().toLowerCase();
  if (viewErrorOf(vm)) return "error";
  if (STATES.has(direct)) return direct;
  if (vm?.resyncing) return "resyncing";
  if (vm?.stale) return "stale";
  if (vm?.loading) return "loading";
  return "ready";
}

// The view's state on the component's root (data-view-lifecycle) and whether it is busy (aria-busy). No component
// shows it as a badge.
export function syncViewLifecycle(host, vm = {}) {
  const state = viewLifecycleState(vm);
  const root = host?.firstElementChild || host;
  if (root?.dataset) root.dataset.viewLifecycle = state;
  if (root?.setAttribute) root.setAttribute("aria-busy", state === "loading" || state === "resyncing" ? "true" : "false");
  return state;
}
