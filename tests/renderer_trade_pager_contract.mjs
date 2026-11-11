import assert from 'node:assert/strict';
import { createLiveTradePager } from '../ui/renderer/js/market_data/live_trade_pager.js';
let next=1;const timers=new Map(),frames=new Map();
globalThis.setTimeout=(fn,delay)=>{const id=next++;timers.set(id,{fn,delay});return id;};
globalThis.clearTimeout=id=>timers.delete(id);
globalThis.requestAnimationFrame=fn=>{const id=next++;frames.set(id,fn);return id;};
globalThis.cancelAnimationFrame=id=>frames.delete(id);
const pending=[],effects=[];
let query={target:'2330',market:'STK',session:'DAY',tradingDate:'2026-09-04',actualContract:'2330',requestIdentityKey:'STK|2330|2026-09-04|DAY|2330'};
const pager=createLiveTradePager({apiGet:(url,options)=>new Promise((resolve,reject)=>pending.push({url,options,resolve,reject})),
  getQuery:()=>query,getEquityDate:()=>query.tradingDate,futuresIdentityMatches:identity=>identity.trading_date===query.tradingDate,
  invalidateDetails:()=>effects.push('details'),applyBook:()=>effects.push('book'),applyTrend:()=>effects.push('trend'),invalidateTrend:()=>effects.push('invalidate')});
const response=(extra={})=>({ok:true,page:1,total_rows:201,total_pages:3,snapshot_watermark:201,rows:[{price:100,volume:0,sequence:201,time:'2026-09-04 09:01:00'}],...extra});
let load=pager.load({latest:true});await load;
// Page 1 is the WS's: it opens without a page read, with ONE count read -- never a timer.
assert.equal(pending.length,1);assert.equal(new URL(pending[0].url,'http://offline').searchParams.get('metadata_only'),'true');
assert.equal(pager.state.page,1);assert.equal(pager.state.bootstrapReady,true);
const noPoll=()=>assert.equal([...timers.values()].filter(t=>t.delay===15000).length,0,'no 15-second metadata poll');
noPoll();pending.shift().resolve(response());await Promise.resolve();await Promise.resolve();
await pager.load({latest:true});assert.equal(pending.length,0,'the count is read once per symbol, not per page-1 open');
// The count read froze the paging cut: older pages are read below that watermark, not shifted by new trades.
load=pager.load({page:2});assert.equal(new URL(pending.at(-1).url,'http://offline').searchParams.get('snapshot_watermark'),'201');
pending.at(-1).resolve(response({page:2,snapshot_watermark:201}));await load;
const old=pager.load({page:3});const oldRequest=pending.at(-1);
query={...query,target:'2344',actualContract:'2344',requestIdentityKey:'STK|2344|2026-09-04|DAY|2344'};
const current=pager.load({latest:true});
assert.equal(oldRequest.options.signal.aborted,true);
await current;
oldRequest.reject(new Error('late old failure'));await old;
assert.equal(pager.state.target,'2344');assert.equal(pager.state.lastError,null);
assert.equal(pager.state.totalCount,0);assert.equal(pager.state.latencyMs,0);
pager.hydrateClosed('2344',[{price:99}],{total_rows:0,snapshot_watermark:0});assert.equal(pager.state.totalCount,0);
// Metadata must not replace the explicit page or supersede its generation.
load=pager.load({page:2});pending.at(-1).resolve(response({page:2}));await load;
const metadata=pager.load({metadataRefresh:true});const metaRequest=pending.at(-1);
const page=pager.load({page:3});pending.at(-1).resolve(response({page:3}));await page;
metaRequest.resolve(response({total_rows:999}));await metadata;assert.equal(pager.state.page,3);assert.equal(pager.state.totalCount,201);
load=pager.load({latest:true});await load;
noPoll();assert.equal(pager.scheduleMetadata,undefined,'the metadata poll entry point is gone');
const late=pager.load({page:2}),lateRequest=pending.at(-1);
pager.dispose();const effectCount=effects.length;lateRequest.resolve(response({latest_orderbook:{Bid:[[1,1]]},trend_points:[{price:1}]}));await late;
assert.equal(effects.length,effectCount);assert.equal(timers.size,0);assert.equal(frames.size,0);
assert.deepEqual(pager.diagnostics(),{active:false,requests:0,frames:0,countedKeys:0});
await pager.load();assert.equal(pending.at(-1),lateRequest);
pager.activate();query={...query,market:'FUT',target:'TXFR1',actualContract:'TXFI6',requestIdentityKey:'FUT|DAY|2026-09-04|TXFI6'};
const rollover=pager.load({page:2});const rolloverRequest=pending.at(-1);
query={...query,tradingDate:'2026-09-07',requestIdentityKey:'FUT|DAY|2026-09-07|TXFI6'};
rolloverRequest.resolve(response({identity:{trading_date:'2026-09-04'}}));await rollover;
assert.equal(pager.state.loaded,false);pager.dispose();
// Hundreds of A/B/A intents with out-of-order completions cannot resurrect old rows.
pager.activate();query={...query,market:'STK',tradingDate:'2026-09-04'};
const stress=[];
for(let n=0;n<200;n++){
  const code=String(2330+n%12);query={...query,target:code,actualContract:code,requestIdentityKey:`STK|${code}|DAY|2026-09-04`};
  const promise=pager.load({page:2});stress.push({promise,request:pending.at(-1),n});
}
for(const {promise,request,n} of stress.reverse()){
  request.resolve(response({rows:[{price:n,volume:1,sequence:n}],total_rows:n}));await promise;
}
assert.equal(pager.state.rows[0].price,199);assert.equal(pager.state.totalCount,199);
// Returning to page one is always a synchronous hot-cache operation and must
// never enqueue a durable HTTP request.
const requestCountBeforePageOne=pending.length;await pager.load({page:1});
assert.equal(pending.length,requestCountBeforePageOne);assert.equal(pager.state.page,1);
pager.dispose();assert.equal(timers.size,0);assert.equal(frames.size,0);
// A hung old count read cannot block the remounted pager's single-flight.
pager.activate();await pager.load({latest:true});const oldMetadata=pending.at(-1);
pager.reset(query.target);await pager.load({latest:true});const newMetadata=pending.at(-1);noPoll();
assert.notEqual(oldMetadata,newMetadata);oldMetadata.resolve(response());await Promise.resolve();await Promise.resolve();
newMetadata.resolve(response());await Promise.resolve();await Promise.resolve();pager.dispose();
console.log('trade pager: watermark, zero, stale success/failure, metadata, rollover, catchup and dispose passed');

// Market Runtime answers from a trade index that is complete whenever it serves: every answer -- an ended session
// not materialized yet (PENDING), a page with a record it could not read back (WAL_PARTIAL) -- is applied once and
// never asked again; no read asks the server to wait.
pager.activate();query={...query,target:'3481',actualContract:'3481',requestIdentityKey:'STK|3481|2026-09-04|DAY|3481'};
await pager.load({latest:true});const partial=pending.at(-1);
assert.equal(new URL(partial.url,'http://offline').searchParams.get('index_wait'),null,'no read waits for an index');
assert.equal(partial.options.timeoutMs,undefined,'the common deadline');
partial.resolve(response({coverage:'WAL_PARTIAL',total_rows:40}));for(let i=0;i<4;i++)await Promise.resolve();
assert.equal(pager.state.totalCount,40);assert.equal(pending.at(-1),partial,'a partial page is not asked again');
assert.equal('indexing' in pager.state,false,'no indexing state');
pager.dispose();
pager.activate();query={...query,target:'2317',actualContract:'2317',requestIdentityKey:'STK|2317|2026-09-04|DAY|2317'};
await pager.load({latest:true});const ended=pending.at(-1);
ended.resolve(response({coverage:'PENDING',wal_coverage:'WAL',total_rows:900,total_pages:9}));for(let i=0;i<4;i++)await Promise.resolve();
assert.equal(pager.state.totalCount,900);assert.equal(pending.at(-1),ended);assert.equal(timers.size,0,'no polling timer');
pager.dispose();
console.log('renderer trade pager contract passed');
