import { escapeHtml } from "./utility.js";
import { attachAnalysisRebuildNotice } from "./analysis_rebuild_notice.js";

// The message carries a component id (from the saved layout) and an exception's text: always escaped, never markup.
function unavailableHtml(message) {
  return `<div class="dashboard-slot-state"><div class="empty">${escapeHtml(String(message || "Component unavailable"))}</div></div>`;
}

export class ComponentHost {
  // actionsHost: where a host whose own tab names the component (a dashboard slot) shows the component's title-bar
  // controls; the component puts them there and the box is emptied when the component goes.
  constructor({ host, hostId, hostType = "inline", pageId, slotId, context, registry, hydrate = true, actionsHost = null }) {
    if (!host) throw new Error("ComponentHost requires host element");
    this.host = host;
    this.hostId = String(hostId || `${pageId || "page"}:${slotId || "slot"}`);
    this.hostType = String(hostType || "inline");
    this.pageId = String(pageId || "");
    this.slotId = String(slotId || "");
    this.context = context;
    this.registry = registry;
    this.hydrate = Boolean(hydrate);
    this.actionsHost = actionsHost || null;
    this.component = null;
    this.componentId = "";
    this.definition = null;
    this.destroyed = false;
    // The 分析資料重建中 overlay of the component shown, when its data is Rust B's (removed with the component).
    this.detachRebuildNotice = null;
  }

  // A component whose data is Rust B's, in a context that hears B's state (a live window), gets the shared notice.
  _attachRebuildNotice(definition) {
    const subscribe = this.context?.services?.analysisState?.subscribe;
    if (!definition?.analysisSourced || typeof subscribe !== "function" || this.detachRebuildNotice) return;
    this.detachRebuildNotice = attachAnalysisRebuildNotice(this.host, subscribe);
  }

  _detachRebuildNotice() {
    this.detachRebuildNotice?.();
    this.detachRebuildNotice = null;
  }

  _capabilityError(definition) {
    const mode = String(this.context?.mode || "");
    const required = [
      ...(definition.requiredCapabilities || []),
      ...(definition.requiredCapabilitiesByMode?.[mode] || []),
    ];
    for (const capability of required) {
      if (!this.context?.supports?.(capability)) return `缺少資料能力：${capability}`;
    }
    return "";
  }

  mount(componentId) { return this.switchComponent(componentId, { initial: true }); }

  switchComponent(componentId, { initial = false } = {}) {
    if (this.destroyed) throw new Error(`host ${this.hostId} is destroyed`);
    const nextId = String(componentId || "");
    if (this.componentId === nextId && this.component) return this.component;

    const definition = this.registry?.get?.(nextId);
    if (!definition || !this.registry.supports(nextId, { mode: this.context?.mode, slotId: this.slotId, hostType: this.hostType })) {
      this._destroyCurrent();
      this.host.innerHTML = unavailableHtml(`Component ${nextId || "--"} 不支援此 Slot`);
      this.componentId = nextId;
      return null;
    }
    const capabilityError = this._capabilityError(definition);
    if (capabilityError) {
      this._destroyCurrent();
      this.host.innerHTML = unavailableHtml(capabilityError);
      this.componentId = nextId;
      return null;
    }

    const canReuse = Boolean(
      this.component
      && this.definition?.reuseGroup
      && this.definition.reuseGroup === definition.reuseGroup
      && typeof this.component.reconfigure === "function"
    );
    if (canReuse) {
      try {
        this.component.reconfigure({
          componentId: nextId,
          dataKey: definition.dataKey || nextId,
          variant: definition.variant || "auto",
          definition,
        });
      } catch (error) {
        // A reconfigure that threw may have applied part of the new definition: the instance is neither the old
        // component nor the new one, so it is destroyed and the slot says the component is unavailable.
        console.error("[ComponentHost] reconfigure failed", {
          fromComponentId: this.componentId, componentId: nextId, hostId: this.hostId, contextId: this.context?.id, error,
        });
        this._destroyCurrent();
        this.host.innerHTML = unavailableHtml(`Component failed：${error?.message || error}`);
        this.componentId = nextId;
        this.definition = definition;
        return null;
      }
      this.componentId = nextId;
      this.definition = definition;
      this.host.dataset.componentId = nextId;
      this.host.dataset.componentContext = String(this.context?.id || "");
      this.host.dataset.componentReuseGroup = String(definition.reuseGroup || "");
      this.host.dataset.componentSwitchMode = "reuse";
      if (!definition.analysisSourced) this._detachRebuildNotice();
      this._attachRebuildNotice(definition);
      return this.component;
    }

    this._destroyCurrent();

    if (!initial || !this.hydrate) this.host.replaceChildren();
    let instance = null;
    try {
      instance = definition.create();
      instance.mount({
        host: this.host,
        hostId: this.hostId,
        hostType: this.hostType,
        pageId: this.pageId,
        slotId: this.slotId,
        context: this.context,
        hydrate: initial && this.hydrate,
        definition,
        actionsHost: this.actionsHost,
      });
      this.component = instance;
      this.componentId = nextId;
      this.definition = definition;
      this.host.dataset.componentId = nextId;
      this.host.dataset.componentContext = String(this.context?.id || "");
      this.host.dataset.componentReuseGroup = String(definition.reuseGroup || "");
      this.host.dataset.componentSwitchMode = initial ? "hydrate" : "replace";
      this._attachRebuildNotice(definition);
      return instance;
    } catch (error) {
      console.error("[ComponentHost] mount failed", { componentId: nextId, hostId: this.hostId, contextId: this.context?.id, error });
      // A mount that failed after acquiring something (a data subscription, an observer) left it behind: the
      // instance was never stored, so nothing could destroy it again (N01). It is destroyed here, partially
      // initialized as it is.
      if (instance) {
        try { instance.destroy?.(); }
        catch (destroyError) { console.error("[ComponentHost] destroy after failed mount failed", { componentId: nextId, hostId: this.hostId, error: destroyError }); }
      }
      this.actionsHost?.replaceChildren();
      this.host.innerHTML = unavailableHtml(`Component failed：${error?.message || error}`);
      this.component = null;
      this.componentId = nextId;
      this.definition = definition;
      return null;
    }
  }

  _destroyCurrent() {
    // The slot's actions box holds only the current component's controls: emptied whenever it goes, even when it
    // never mounted (a failed mount may already have moved its controls there).
    this.actionsHost?.replaceChildren();
    this._detachRebuildNotice();
    if (!this.component) return;
    try { this.component.destroy?.(); }
    catch (error) { console.error("[ComponentHost] destroy failed", { componentId: this.componentId, hostId: this.hostId, error }); }
    this.component = null;
    this.componentId = "";
    this.definition = null;
  }

  // `html` is TRUSTED markup only: a literal written in this code base, never data (a component id, a layout value,
  // an error message, anything from a file or the network). Show data through textContent or escapeHtml instead.
  clear({ html = "" } = {}) {
    if (this.destroyed) return false;
    this._destroyCurrent();
    this.host.innerHTML = String(html || "");
    delete this.host.dataset.componentId;
    delete this.host.dataset.componentReuseGroup;
    this.host.dataset.componentSwitchMode = "empty";
    return true;
  }

  resize() {
    try { this.component?.resize?.(); }
    catch (error) { console.warn("[ComponentHost] resize failed", error); }
  }

  destroy() {
    if (this.destroyed) return;
    this._destroyCurrent();
    this.destroyed = true;
  }
}
