// A secondary window (工作區, a detached panel) opens its own live transport; when the window goes away the transport
// is ended explicitly: the window's own release runs first (it may still send on the socket, synchronously), then the
// stream stops -- pending requests settled, the reconnect remediation abandoned, the socket closed with 1000.
import { stopRealtimeStream } from "./realtime.js";

/**
 * `release()`: what the window gives up before its socket closes (its components, its workspace set). Answers the
 * uninstall function (for a window that ends its stream some other way).
 */
export function installSecondaryWindowRealtime({ release = () => {}, reason = "window_closed", target = globalThis.window } = {}) {
  let done = false;
  const end = () => {
    if (done) return;
    done = true;
    try {
      release();
    } catch (error) {
      console.error("[secondary window: releasing before the socket closes] failed", error);
    }
    stopRealtimeStream(reason);
  };
  target?.addEventListener?.("pagehide", end, { once: true });
  return () => target?.removeEventListener?.("pagehide", end);
}
