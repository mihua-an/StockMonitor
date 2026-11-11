import { TrendChartManager } from "./trend_chart_manager.js";
export { TrendChartManager } from "./trend_chart_manager.js";
export { TimeAxisPolicy, EQUITY_TIME_AXIS, TAIEX_TIME_AXIS, createFuturesTimeAxis } from "./time_axis_policy.js";
export { PriceScalePolicy } from "./price_scale_policy.js";
export { ReferenceLinePolicy } from "./reference_line_policy.js";
export { GridPolicy } from "./grid_policy.js";
export { TimeLabelPolicy, DEFAULT_TIME_LABEL_POLICY } from "./time_label_policy.js";
export { CoordinateTransform } from "./coordinate_transform.js";
export { ReplayStylePolicy, SEGMENT_STYLE } from "./replay_style_policy.js";
export { OverlayLayerManager, EventMarkerLayer } from "./layers.js";
export { EquityTrendAdapter, TaiexTrendAdapter, FuturesTrendAdapter, ReplayTrendAdapter, resolveTrendAdapter } from "./adapters.js";
export { destroyTrendLookup, pinTrendLookupAtTime, showTrendCrosshairAtTime } from "./interaction_controller.js";

const MANAGERS=new WeakMap();
export function getTrendChartManager(canvas,{adapterType="equity"}={}){if(!canvas)return null;let manager=MANAGERS.get(canvas);if(!manager){manager=new TrendChartManager({canvas,adapterType,overlayProvider:null});MANAGERS.set(canvas,manager);}else{manager.setContext({adapterType,overlayProvider:null});}return manager;}
export function renderTrendChart(canvas,rawPoints,prevClose,openPrice=null,options={}){const adapterType=options?.adapterType||"equity";const manager=getTrendChartManager(canvas,{adapterType});if(!manager)return;manager.renderNow({points:rawPoints,prevClose,openPrice,session:options?.session,emptyOverlayText:options?.emptyOverlayText||"",options});}
export function destroyTrendChart(canvas){const manager=canvas?MANAGERS.get(canvas):null;if(manager){manager.destroy();MANAGERS.delete(canvas);}}
