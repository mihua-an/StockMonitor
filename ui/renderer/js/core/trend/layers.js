export class OverlayLayerManager {
  constructor() { this.layers = new Map(); }
  addOverlay(id, series) { if (id) this.layers.set(String(id), { ...(series || {}), id: String(id), visible: series?.visible !== false }); return this; }
  removeOverlay(id) { this.layers.delete(String(id)); return this; }
  updateOverlay(id, patch) { const key=String(id); if(this.layers.has(key)) this.layers.set(key,{...this.layers.get(key),...(patch||{})}); return this; }
  clearOverlay() { this.layers.clear(); return this; }
  setOverlayVisibility(id, visible) { return this.updateOverlay(id,{visible:Boolean(visible)}); }
  series() { return [...this.layers.values()].filter((item)=>item.visible!==false); }
}

export class EventMarkerLayer {
  normalize(markers = []) {
    return (Array.isArray(markers) ? markers : []).map((marker, index) => ({
      id: String(marker?.id ?? `event-${index}`),
      timestamp: marker?.timestamp ?? marker?.datetime ?? marker?.time,
      time: marker?.time ?? marker?.timestamp ?? marker?.datetime,
      type: String(marker?.type || "event"),
      label: String(marker?.label || marker?.title || marker?.type || "事件"),
      price: Number(marker?.price),
      priority: Number(marker?.priority || 0),
      metadata: marker?.metadata || null,
      ...marker,
    })).filter((marker) => Number.isFinite(marker.price));
  }
}
