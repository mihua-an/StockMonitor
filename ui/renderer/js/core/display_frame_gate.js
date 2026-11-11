/**
 * The last fence before a ViewModel mutates visible DOM/canvas state.
 *
 * The data source (dashboard_context.js ScopedDataAdapter) stamps every ViewModel it delivers with a per-component
 * `presentationRevision`, in the order it resolved them. A component paints a revision at or above the last one it
 * painted and refuses an older one -- that is all ordering a component decides. The transport's order (selection
 * generation, daemon instance, session generation, trading date, view sequence) is RealtimeViewStore's, not re-derived
 * in every panel; and since the page reads the store's current
 * state when it resolves a ViewModel, a resolved frame is always the current selection's and session's.
 * A re-render of the frame already shown (resize, hover) carries the same revision and paints.
 */
export class PresentationRevisionGate {
  constructor() {
    this.rejections = {};
    this.reset();
  }

  accept(vm = {}) {
    const revision = Number(vm?.presentationRevision);
    if (!Number.isFinite(revision)) return true;
    if (revision < this.revision) {
      this.lastRejectReason = "STALE_PRESENTATION_REVISION";
      this.rejections.STALE_PRESENTATION_REVISION = (this.rejections.STALE_PRESENTATION_REVISION || 0) + 1;
      return false;
    }
    this.revision = revision;
    this.lastRejectReason = "";
    return true;
  }

  reset() {
    this.revision = 0;
    this.lastRejectReason = "";
  }
}
