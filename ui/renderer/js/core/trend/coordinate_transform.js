export class CoordinateTransform {
  constructor({ plotLeft = 0, plotTop = 0, plotWidth = 1, plotHeight = 1, domainSpan = 1, yTop = 1, yBottom = 0 } = {}) {
    this.plotLeft = Number(plotLeft) || 0;
    this.plotTop = Number(plotTop) || 0;
    this.plotWidth = Math.max(1, Number(plotWidth) || 1);
    this.plotHeight = Math.max(1, Number(plotHeight) || 1);
    this.domainSpan = Math.max(1e-9, Number(domainSpan) || 1);
    this.yTop = Number(yTop);
    this.yBottom = Number(yBottom);
  }
  xFromCoordinate(coordinate) { return this.plotLeft + (Number(coordinate) / this.domainSpan) * this.plotWidth; }
  coordinateFromX(x) { return ((Number(x) - this.plotLeft) / this.plotWidth) * this.domainSpan; }
  yFromPrice(price) {
    if (this.yTop === this.yBottom) return this.plotTop + this.plotHeight / 2;
    return this.plotTop + ((this.yTop - Number(price)) / (this.yTop - this.yBottom)) * this.plotHeight;
  }
  priceFromY(y) {
    if (this.plotHeight <= 0) return this.yBottom;
    return this.yTop - ((Number(y) - this.plotTop) / this.plotHeight) * (this.yTop - this.yBottom);
  }
}
