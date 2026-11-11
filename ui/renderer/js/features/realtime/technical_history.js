// 技術分析's earlier days of the product on screen: the pages history_api has answered so far, and the candles of a
// timeframe built from them. A page is asked for when the chart comes near its oldest bar; a day this machine does not
// hold is simply not there. A minute timeframe reaches back as far as its own retention (`horizons`) and no further.
import { historyDayBars, markDayStart, periodBars, timeframeResolution } from "./technical_series.js";

// One download's reach: the page reads what it wrote back in one go.
const DOWNLOAD_PAGE_DAYS = 20;
const emptyLane = () => ({ before: "", done: false, failed: false, loading: false });

export class TechnicalHistory {
  /** `load({ code, resolution, before })` answers one page. */
  constructor(load) {
    this.load = load;
    this.reset("", "");
  }

  /** The product and session the chart shows: pages of any other are forgotten, and an answer still on its way dropped. */
  reset(code, date) {
    this.code = code; this.date = date;
    this.generation = (this.generation || 0) + 1;
    this.version = (this.version || 0) + 1;
    this.lanes = { minute: emptyLane(), day: emptyLane() };
    this.days = [];         // minute pages, oldest day first, each at the timeframe it is held
    this.daily = [];        // daily bars, oldest first
    this.segments = [];     // the session's trading intervals
    this.horizons = {};     // minute timeframe -> the oldest date its retention keeps
    this.built = new Map(); // timeframe -> candles of the pages held
  }

  /** Asks for the next older page of what `timeframe` reads, once at a time. True when a page added something. */
  async loadOlder(timeframe) {
    const resolution = timeframeResolution(timeframe);
    const lane = this.lanes[resolution];
    if (!this.load || !this.code || !this.date || lane.loading || lane.done || lane.failed) return false;
    const generation = this.generation;
    lane.loading = true;
    let page;
    try {
      page = await this.load({ code: this.code, resolution, before: lane.before || this.date });
    } catch (error) {
      if (generation === this.generation) { lane.failed = true; lane.loading = false; }
      console.warn(`[technical analysis: reading the ${resolution} history of ${this.code}] failed`, error);
      return false;
    }
    if (generation !== this.generation) return false;
    lane.loading = false;
    lane.before = page?.next_before || "";
    lane.done = !lane.before;
    if (page?.horizons) this.horizons = page.horizons;
    const added = resolution === "minute" ? (page?.days || []) : (page?.bars || []);
    if (!added.length) return false;
    if (resolution === "minute") {
      this.segments = page.segments;
      this.days = [...added, ...this.days];
    } else {
      this.daily = [...added, ...this.daily];
    }
    this.built.clear();
    this.version += 1;
    return true;
  }

  /** Whether every local page of what `timeframe` reads has been read. */
  localExhausted(timeframe) { return this.lanes[timeframeResolution(timeframe)].done; }

  /** The oldest date `timeframe` shows: the session date when no earlier one is held. */
  oldestDate(timeframe) {
    if (timeframeResolution(timeframe) === "day") return this.daily[0]?.trading_date || this.date;
    return this.#showable(timeframe)[0]?.trading_date || this.date;
  }

  /** Whether a minute timeframe has come to the end of its own retention at `date`: daily bars have none. */
  reachedHorizon(timeframe, date) {
    const horizon = timeframeResolution(timeframe) === "minute" ? this.horizons[timeframe] : "";
    return Boolean(horizon) && date <= horizon;
  }

  // The held days a minute timeframe can show: inside its retention, at a timeframe that divides it.
  #showable(timeframe) {
    const horizon = this.horizons[timeframe] || "";
    return this.days.filter((day) => day.trading_date >= horizon && Number(timeframe) % day.timeframe === 0);
  }

  /** Reads back both lanes through `endDate` (a download just wrote them), joined to what is held by date. */
  async mergeThrough(endDate) {
    const generation = this.generation;
    const next = new Date(`${endDate}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const before = next.toISOString().slice(0, 10);
    const [minute, day] = await Promise.all([this.load({ code: this.code, resolution: "minute", before, limit: DOWNLOAD_PAGE_DAYS }),
      this.load({ code: this.code, resolution: "day", before, limit: DOWNLOAD_PAGE_DAYS })]);
    if (generation !== this.generation) return false;
    const join = (held, page) => {
      const dates = new Set(held.map((row) => row.trading_date));
      const fresh = (page || []).filter((row) => !dates.has(row.trading_date));
      return [fresh, [...fresh, ...held].sort((a, b) => a.trading_date.localeCompare(b.trading_date))];
    };
    const [newDays, days] = join(this.days, minute?.days);
    const [newBars, daily] = join(this.daily, day?.bars);
    if (minute?.horizons) this.horizons = minute.horizons;
    if (minute?.segments) this.segments = minute.segments;
    this.days = days; this.daily = daily;
    if (!newDays.length && !newBars.length) return false;
    this.built.clear();
    this.version += 1;
    return true;
  }

  /** The history candles of a minute timeframe: one array per version of the pages. */
  intradayBars(timeframe) {
    let bars = this.built.get(timeframe);
    if (!bars) {
      bars = this.#showable(timeframe).flatMap((day) => {
        const [first, ...rest] = historyDayBars(day, timeframe, this.segments);
        return first ? [markDayStart(first, day.trading_date), ...rest] : [];
      });
      this.built.set(timeframe, bars);
    }
    return bars;
  }

  /** The whole series of a timeframe: the history candles and today's after them. */
  series(timeframe, today) {
    if (timeframeResolution(timeframe) === "day") return periodBars([...this.daily, ...today], timeframe);
    const earlier = this.intradayBars(timeframe);
    if (!earlier.length) return today;
    const [first, ...rest] = today;
    return first ? [...earlier, markDayStart(first, this.date), ...rest] : earlier;
  }
}
