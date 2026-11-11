export class RenderScheduler {
  constructor(render) { this.render = render; this.token = 0; this.pending = null; this.destroyed = false; }
  request(model) {
    if (this.destroyed) return;
    this.pending = model;
    if (this.token) return;
    this.token = window.requestAnimationFrame(() => {
      this.token = 0;
      const next = this.pending;
      this.pending = null;
      if (!this.destroyed && next) this.render(next);
    });
  }
  flush(model = this.pending) {
    if (this.destroyed || !model) return;
    if (this.token) { window.cancelAnimationFrame(this.token); this.token = 0; }
    this.pending = null;
    this.render(model);
  }
  destroy() {
    this.destroyed = true;
    this.pending = null;
    if (this.token) window.cancelAnimationFrame(this.token);
    this.token = 0;
  }
}
