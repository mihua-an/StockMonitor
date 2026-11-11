import assert from "node:assert/strict";
import { readChannel, orderBookReadView, productQuoteReadView, tradesReadView, trendReadView } from "../ui/renderer/js/core/market_read_model.js";
import { canonicalReadModel, futuReadModel, futuTradeRows, futuTrendPoints, withMarketRead, withProductRead } from "../ui/renderer/js/core/market_read_adapters.js";
import { productReadView } from "../ui/renderer/js/core/market_read_model.js";
import { StockOrderBookAdapter, FutuOrderBookAdapter } from "../ui/renderer/js/core/orderbook_adapters.js";
import { MarketDataGateway } from "../ui/renderer/js/market_data/market_data_gateway.js";
import { syncProductQuoteFailure } from "../ui/renderer/js/core/components/product_quote_header.js";

assert.equal(readChannel(null,{ready:false}).state,"waiting");
assert.equal(readChannel(null).state,"missing");
assert.equal(readChannel([1],{supported:false}).state,"unsupported");
assert.equal(readChannel([1],{subscribed:false}).data,null);
assert.equal(readChannel([1],{enabled:false}).state,"disabled");
const raw = {watermark:12, session_generation:3, stream_id:"TW|2330|DAY|2026-09-04",
  session_key:{logical_code:"2330",market:"TW",trading_date:"2026-09-04",session:"DAY"},
  summary:{current:100,total_volume:0,exchange_ts_ns:"1788487200000000000",arrival_ns:"1788458400000000001"}};
const before=JSON.stringify(raw), tw=canonicalReadModel(raw,{selectionGeneration:8,channels:["quote","trades"]});
assert.equal(tw.channels.quote.data.totalVolume,0);
assert.equal(tw.channels.quote.data.prevClose,null);
assert.equal(tw.channels.orderbook.state,"unsubscribed");
assert.equal(tw.revision.sessionGeneration,3);
assert.equal(tw.revision.selectionGeneration,8);
assert.equal(tw.time.eventTimeKind,"unix_ns");
assert.equal(tw.identity.source,"shioaji");
assert.equal(tw.session.timezone,"Asia/Taipei");
assert.equal(tw.time.receivedTime,"1788458400000000001");
assert.equal(tw.encoding.quantityScale,null);
assert.equal(JSON.stringify(raw),before);
const restoring=canonicalReadModel({...raw,presentation_state:"resyncing",view_status:"RESYNCING",view_error:null},{channels:["trades"]});
assert.equal(restoring.sourceDetails.viewState,"resyncing");
assert.equal(restoring.sourceDetails.viewStatus,"RESYNCING");
const loadingRead=canonicalReadModel({presentation_state:"loading"},{channels:["trades"]});
assert.equal(loadingRead.channels.trades.state,"waiting");

// A Futu trend is one 均價 line: nothing in it marks a break at New York's session times (crypto trades 24 hours).
assert.deepEqual(Object.keys(futuTrendPoints([{time:"2026-11-09 09:31:00",close:1,volume:1}])[0]).sort(),
  ["average_price","minute_turnover","minute_volume","price","time","timestamp","total_volume"]);
const crypto=futuReadModel({code:"CC.BTCUSD",generation:5,bootstrapped:false,cursor:{session_date:"2026-09-04",trade_after_id:99},
  status:{context_generation:"opend-2"},trades:[{price:123.45678901,volume:0.00000001,quantity_scale:100000000,exchange_ts_ns:"1788458400000000000"}]});
assert.equal(crypto.identity.source,"futu");
// The CC market clock: New York's day, like the US stocks it is compared with (the day its cache is cleared on);
// exchange_ts_ns is absolute.
assert.equal(crypto.session.timezone,"America/New_York");
assert.equal(crypto.session.name,null); // No inferred DAY/ALL from wall clock
assert.equal(crypto.time.eventTimeKind,"unix_ns");
assert.equal(crypto.encoding.quantityPrecision,8);
assert.equal(crypto.channels.tradeflow.state,"unsupported");
assert.equal(crypto.channels.orderbook.state,"waiting");
assert.equal(crypto.revision.sequence,null); // database cursor is not wire sequence
assert.equal(crypto.revision.sessionGeneration,null); // context != session generation
assert.equal(crypto.revision.contextGeneration,"opend-2");
assert.equal(futuReadModel({code:"US.AAPL",trades:[{trade_timestamp:"2026-11-01T01:30:00-04:00"}]}).time.eventTimeKind,"iso8601_offset");
assert.equal(tradesReadView({marketRead:crypto}).rows[0].volume,0.00000001);
assert.equal(futuTradeRows([{price:1}])[0].sequence,null);
const pending=futuReadModel({code:"US.AAPL",status:{lane_freshness:[
  {code:"US.AAPL",lane:"ORDER_BOOK",desired:false,confirmed:false,state:"NOT_DESIRED",expected_active:false},
]}});
assert.equal(pending.channels.orderbook.state,"unsubscribed");
assert.equal(pending.channels.orderbook.freshness.expectedActive,false);
assert.equal(pending.channels.trades.freshness.eventAgeSeconds,null);
const awaiting=futuReadModel({code:"US.AAPL",status:{lane_freshness:[
  {code:"US.AAPL",lane:"TICKER",desired:true,confirmed:true,state:"CONFIRMED_AWAITING_EVENT",expected_active:true},
]}});
assert.equal(awaiting.channels.trades.state,"waiting");
for (const source of ["shioaji","futu"]) {
  const product=productReadView(withProductRead({code:"TEST",name:"Example",current:100,prev_close:90,total_volume:0},source));
  assert.equal(product.current,100);
  assert.equal(product.total_volume,0);
  assert.equal(product.day_high,null);
}
const latestBook=StockOrderBookAdapter.build({code:"2330",signal:{current:100},aggregate:{currentPrice:101},
  book:{bid_prices:[100],bid_volumes:[1]},readModel:canonicalReadModel(raw,{code:"2330",market:"STK"})});
// The canonical summary owns the one current every stock surface shows (header parity with 個股走勢); the price
// ladder's own last price (Rust B) is never 現價 -- it lagged and froze the header.
assert.equal(orderBookReadView(latestBook).lastPrice,100);
const ladderOnly=StockOrderBookAdapter.build({code:"2330",signal:{},aggregate:{currentPrice:101},book:{bid_prices:[100],bid_volumes:[1]}});
assert.equal(orderBookReadView(ladderOnly).lastPrice,null);
const sharedHeaderRead = canonicalReadModel({session_key:{logical_code:"2330"},summary:{name:"台積電",current:100,prev_close:90}},{code:"2330",market:"STK"});
for (const projected of [
  trendReadView(withMarketRead({},sharedHeaderRead)),
  orderBookReadView(withMarketRead({availability:"UNAVAILABLE"},sharedHeaderRead)),
  productQuoteReadView(withMarketRead({},sharedHeaderRead)),
]) {
  assert.equal(projected.displayName,"台積電");
  assert.equal(projected.displayCode,"2330");
  assert.equal(projected.currentPrice,100);
  assert.equal(projected.prevClose,90);
}
// The boundary settles the view's quote once (its explicit scalars win: a 試撮 price, a closed session's close); the
// read views then read only the model, so a flat field changed after the boundary is not what a component draws.
{
  const atBoundary=withMarketRead({currentPrice:101,stockInfo:{high:105},points:[{price:1}]},sharedHeaderRead);
  assert.equal(atBoundary.marketRead.channels.quote.data.lastPrice,101);
  assert.equal(atBoundary.marketRead.channels.quote.data.dayHigh,105);
  assert.equal(atBoundary.marketRead.channels.quote.data.prevClose,90,"the model fills what the view lacks");
  const read=trendReadView({...atBoundary,currentPrice:999,prevClose:1,points:[{price:2}]});
  assert.equal(read.currentPrice,101);
  assert.equal(read.prevClose,90);
  assert.equal(read.stockInfo.high,105);
  assert.deepEqual(read.points,[],"trend points come from the model's channel only");
  // A view no store projected gets a model built from its own channels.
  const own=withMarketRead({code:"2330",points:[{price:3}],rows:[{price:4}],prevClose:5});
  assert.deepEqual(trendReadView(own).points,[{price:3}]);
  assert.deepEqual(tradesReadView(own).rows,[{price:4}]);
  assert.equal(trendReadView(own).prevClose,5);
  assert.equal(own.displayCode,"2330");
  assert.equal(withMarketRead({code:"US.AAPL"},null,{source:"futu"}).marketRead.identity.source,"futu");
}
// A view model without a read model is refused and logged: the component keeps what it showed.
{
  const logged=[];
  const originalError=console.error;
  console.error=(...args)=>logged.push(args.map(String).join(" "));
  try {
    for (const [view,consumer] of [[trendReadView,"trend"],[orderBookReadView,"order book"],[tradesReadView,"trade details"],
      [productQuoteReadView,"product quote"],[productReadView,"product row"]]) {
      assert.equal(view({currentPrice:100,points:[],rows:[]}),null,`${consumer} refuses a flat view model`);
      assert.match(logged.at(-1),new RegExp(`${consumer} refused a view model without marketRead`));
    }
    assert.equal(trendReadView(null),null);
  } finally { console.error=originalError; }
  assert.equal(logged.length,6);
}
const header = {dataset:{}};
const center = {hidden:true,className:"product-quote-center",title:"",textContent:"",closest:()=>header,replaceChildren(){this.textContent="";}};
assert.equal(syncProductQuoteFailure(center,{viewError:"timeout"}),true);
assert.equal(center.textContent,"載入失敗");
assert.equal(center.hidden,false);
assert.equal(header.dataset.centerActive,"true");
assert.equal(syncProductQuoteFailure(center,{loading:true}),false);
assert.equal(center.textContent,"");
assert.equal(center.hidden,true);
assert.equal(syncProductQuoteFailure(center,{presentationState:"ready",viewError:"late failure"}),true);
assert.equal(center.textContent,"載入失敗");

for (const vm of [StockOrderBookAdapter.build({code:"2330",book:{bid_prices:[100],bid_volumes:[1]}}),
  FutuOrderBookAdapter.build({code:"US.AAPL",book:{Bid:[{price:100,volume:1}],Ask:[]}})]) {
  const read=orderBookReadView(vm);
  assert.equal(read.readState,"available");
  assert.equal(read.bidLevels[0].price,100);
  assert.equal(read.askLevels[0]?.volume??null,null);
}
const disabled=futuReadModel({code:"US.AAPL",book:{Bid:[{price:100,volume:1}]}},{enabled:false});
assert.equal(disabled.channels.orderbook.state,"disabled");
assert.equal(disabled.channels.orderbook.data,null);
const disabledBook=FutuOrderBookAdapter.build({code:"US.AAPL",book:{Bid:[{price:100,volume:1}]},readModel:disabled});
assert.equal(orderBookReadView(disabledBook).availability,"UNAVAILABLE");
assert.equal(orderBookReadView(disabledBook).bidLevels.length,0);
let current=raw;
const gateway=new MarketDataGateway({getSnapshot:()=>current});
assert.equal(gateway.readSnapshot({code:"2330",market:"STK"}).revision.sequence,12);
current={...raw,watermark:13,session_generation:4};
assert.equal(gateway.readSnapshot({code:"2330",market:"STK"}).revision.sequence,13);
assert.equal(gateway.readSnapshot({code:"2330",market:"STK"}).revision.sessionGeneration,4);
let deliver;
const subscribedGateway=new MarketDataGateway({getSnapshot:()=>current,subscribeView:(_spec,listener)=>{deliver=listener;return()=>{};}});
const unsubscribe=subscribedGateway.subscribe({code:"2330",market:"STK"},()=>{});
deliver({type:"delta",sequence:13,delta:{sequence:13,delta_type:"summary.updated",payload:{current:100}}});
assert.deepEqual(subscribedGateway.readSnapshot({code:"2330",market:"STK"}).revision.lastWire,
  {kind:"delta",protocolVersion:null,sequence:13,sequenceDomain:"canonical_stream",deltaType:"summary.updated"});
unsubscribe();
// 總量 cell drawn by the product table itself, with the row's own quantity scale.
globalThis.localStorage ??= { getItem: () => null, setItem() {} };
globalThis.document ??= { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
const { realtimeRowCells } = await import("../ui/renderer/js/features/realtime/components/realtime_quote_table.js");
const { renderedCells } = await import("./lib/rendered_cells.mjs");
const volumeCell=(value,quantityScale=null)=>renderedCells(realtimeRowCells(withProductRead({code:"2330",total_volume:value,quantity_scale:quantityScale},"shioaji"),["total_volume"]));
assert.equal(volumeCell(null),'<td class="">--</td>');
assert.equal(volumeCell(0),'<td class="">0</td>');
assert.equal(volumeCell(0.00000001,100000000),'<td class="">0.00000001</td>');
assert.equal(volumeCell(1000),'<td class="">1,000</td>');
// A Futu snapshot read through the canonical model keeps its own source, zone and depth, and the
// runtime's summary time (price_exchange_ts_ns) is the quote's event time.
const levels = (n, base) => Array.from({ length: n }, (_, i) => base + i);
const us = canonicalReadModel({source:"futu",market:"US",
  session_key:{logical_code:"US.AAPL",market:"US",trading_date:"2026-10-01",session:"FULL"},
  summary:{current:250,price_exchange_ts_ns:"1790870400000000000"},
  orderbook:{bid_prices:levels(10,240),bid_volumes:levels(10,1),ask_prices:levels(10,251),ask_volumes:levels(10,1)}},
  {code:"US.AAPL",channels:["orderbook"]});
assert.equal(us.identity.source,"futu");
assert.equal(us.session.timezone,"America/New_York");
assert.equal(us.channels.orderbook.data.bids.length,10);
assert.equal(us.time.eventTime,"1790870400000000000");
assert.equal(us.time.eventTimeKind,"unix_ns");
console.log("renderer market read contract passed");
