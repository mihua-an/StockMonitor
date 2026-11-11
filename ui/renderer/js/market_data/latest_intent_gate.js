export class LatestIntentGate {
  constructor() {
    this.generation = 0;
    this.activeValue = "";
    this.staleIgnored = 0;
  }

  issue(value = "") {
    this.generation += 1;
    this.activeValue = String(value || "").trim().toUpperCase();
    return { generation: this.generation, value: this.activeValue };
  }

  isCurrent(generation, value = null) {
    if (Number(generation) !== Number(this.generation)) return false;
    if (value == null) return true;
    return String(value || "").trim().toUpperCase() === this.activeValue;
  }

  acceptOrStale(generation, value = null) {
    const current = this.isCurrent(generation, value);
    if (!current) this.staleIgnored += 1;
    return current;
  }

  snapshot() {
    return {
      generation: this.generation,
      activeValue: this.activeValue,
      staleIgnored: this.staleIgnored,
    };
  }
}
