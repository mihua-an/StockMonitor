import { EQUITY_TIME_AXIS, TAIEX_TIME_AXIS, createFuturesTimeAxis } from "./time_axis_policy.js";
import { positiveNumberOrNull } from "../numbers.js";

export class EquityTrendAdapter {
  constructor(config = {}) {
    this.config = config;
    this.id = "equity";
  }

  adapt(vm = {}) {
    const referencePrice = positiveNumberOrNull(vm.prevClose ?? vm.referencePrice);
    return {
      points: Array.isArray(vm.points) ? vm.points : [],
      prevClose: referencePrice,
      openPrice: positiveNumberOrNull(vm.openPrice),
      options: {
        ...(vm.options || {}),
        timeAxisPolicy: vm.options?.timeAxisPolicy || EQUITY_TIME_AXIS,
        adapterType: "equity",
        referenceAvailable: referencePrice != null,
        referenceType: "prev_close",
        referenceSource: vm.options?.referenceSource || vm.referenceSource || null,
      },
      emptyOverlayText: vm.emptyOverlayText || "",
    };
  }
}

// An index quoted on the equity session against its previous close (an 產業指數): its name is the surface's own.
export class IndexTrendAdapter extends EquityTrendAdapter {
  constructor(config = {}) {
    super(config);
    this.id = "index";
  }

  adapt(vm = {}) {
    const model = super.adapt(vm);
    model.options = { ...model.options, timeAxisPolicy: TAIEX_TIME_AXIS, adapterType: "index", referenceType: "index_prev_close" };
    return model;
  }
}

export class TaiexTrendAdapter extends IndexTrendAdapter {
  constructor(config = {}) {
    super(config);
    this.id = "taiex";
  }

  adapt(vm = {}) {
    const model = super.adapt(vm);
    model.options = { ...model.options, adapterType: "taiex", identityResolver: () => ({ name: "加權指數", code: "TAIEX" }) };
    return model;
  }
}

export class FuturesTrendAdapter {
  constructor(config = {}) {
    this.config = config;
    this.id = "futures";
  }

  adapt(vm = {}) {
    const session = String(vm.session || vm.options?.session || "full").toLowerCase();
    const referencePrice = positiveNumberOrNull(vm.referencePrice);
    const contractCode = String(vm.contractCode || vm.contract_code || "TXFR1");
    return {
      points: Array.isArray(vm.points) ? vm.points : [],
      prevClose: referencePrice,
      openPrice: positiveNumberOrNull(vm.openPrice),
      options: {
        ...(vm.options || {}),
        session,
        // One policy object per session: the canvas keeps its cached grid layer across draws.
        timeAxisPolicy: createFuturesTimeAxis(session),
        adapterType: "futures",
        maxConnectGapMinutes: 3,
        referenceAvailable: referencePrice != null,
        referenceType: vm.referenceType || "futures_reference",
        referenceSource: vm.referenceSource || vm.options?.referenceSource || null,
        identityResolver: () => ({ name: "台指期", code: contractCode }),
      },
      emptyOverlayText: vm.emptyOverlayText || "",
    };
  }
}

export class ReplayTrendAdapter extends EquityTrendAdapter {
  constructor(config = {}) {
    super(config);
    this.id = "replay";
  }

  adapt(vm = {}) {
    const model = super.adapt(vm);
    model.options = { ...model.options, adapterType: "replay" };
    return model;
  }
}

export function buildTradeInterval({ entryTime, exitTime, timeAxisPolicy = EQUITY_TIME_AXIS } = {}) {
  const start = timeAxisPolicy?.coordinateForTime?.(entryTime);
  const end = timeAxisPolicy?.coordinateForTime?.(exitTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { startMinute: Math.min(start, end), endMinute: Math.max(start, end) };
}

// The adapter for each chart kind, by its one current name. Any other name is a caller's contract error, refused
// with the names there are -- not drawn as an equity chart.
const TREND_ADAPTERS = Object.freeze({
  equity: EquityTrendAdapter,
  taiex: TaiexTrendAdapter,
  index: IndexTrendAdapter,
  futures: FuturesTrendAdapter,
  replay: ReplayTrendAdapter,
});

export function resolveTrendAdapter(type = "equity") {
  const Adapter = Object.hasOwn(TREND_ADAPTERS, type) ? TREND_ADAPTERS[type] : null;
  if (!Adapter) throw new TypeError(`unknown trend adapter type ${JSON.stringify(type)} (one of ${Object.keys(TREND_ADAPTERS).join(", ")})`);
  return new Adapter();
}
