import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RealtimeViewStore } from '../../ui/renderer/js/market_data/realtime_view_store.js';
import { realtimeRenderScheduler as scheduler } from '../../ui/renderer/js/features/realtime/realtime_render_scheduler.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const distribution = values => {
  const sorted = [...values].sort((a,b)=>a-b);
  return {count: sorted.length, ...Object.fromEntries([['p50',.5],['p95',.95],['p99',.99],['max',1]].map(([k,p]) =>
    [k, sorted.length ? Number(sorted[Math.floor((sorted.length-1)*p)].toFixed(3)) : null]))};
};
async function workload(slow) {
  const report = {scenario:slow?'slow-consumer-resync':'multi-symbol', offered:0, accepted:0, processed:0, rejected:0, queueHigh:0, reconnects:0};
  const waits=[], freshness=[], intervals=[], subscriptions=[], releases=[], authority=new Map();
  const updates=new Map(), queue=[], ids=new Map();
  let closed=false, resyncs=0;
  const store=new RealtimeViewStore({send:message=>{
    if(message.type==='view.resync') {
      resyncs++;
      const spec=ids.get(message.payload.subscription_id);
      if(spec) queueMicrotask(()=>snapshot(spec));
    }
    return true;
  }});
  function snapshot(spec) {
    const state=authority.get(spec.code), entry=store.describe(spec);
    if(!entry) return;
    store.handleSnapshot({request_id:entry.request_id,subscription_id:spec.id,stream_id:spec.stream,
      session_generation:1,watermark:state.sequence,summary:{current:state.price,_created:state.created},
      trades:Array.from({length:Math.min(100,state.sequence)},(_,index)=>{
        const sequence=state.sequence-Math.min(100,state.sequence)+index+1;
        return {code:spec.code,price:100+sequence/100,volume:sequence%3,sequence,_created:state.created};
      }),trend:[]});
  }
  for(let i=0;i<12;i++) {
    const spec={market:'STK',code:String(2330+i),session:'DAY',trading_date:'2026-09-04',channels:['trades','summary']};
    spec.id=`sub-${i}`;spec.stream=`STK|${spec.code}|DAY|2026-09-04`;subscriptions.push(spec);ids.set(spec.id,spec);
    authority.set(spec.code,{sequence:0,price:0,created:performance.now()});
    for(const component of ['trades','book','trend','product']) releases.push(store.subscribe(spec,(event)=>{
      const key=`load:${spec.code}:${component}`, state=store.snapshot(spec);
      const created=Number(state?.trades?.at(-1)?._created ?? state?.summary?._created ?? performance.now());
      scheduler.schedule(key,()=>{
        assert.equal(closed,false,'paint after destroy');
        const now=performance.now(),previous=updates.get(key);
        if(previous!=null)intervals.push(now-previous);
        updates.set(key,now);freshness.push(now-created);
      },{delayMs:slow?25:5});
    }));
  }
  function connect() {
    store.onConnected();
    for(const spec of subscriptions) {
      const entry=store.describe(spec);
      store.handleAccepted({request_id:entry.request_id,subscription_id:spec.id,stream_id:spec.stream,watermark:authority.get(spec.code).sequence});
      snapshot(spec);
    }
  }
  connect();
  const start=performance.now();
  const consume=setInterval(()=>{
    for(let n=0;n<(slow?8:256)&&queue.length;n++) {
      const event=queue.shift();waits.push(performance.now()-event.at);
      if(store.handleDelta(event.delta))report.processed++;
      else report.rejected++;
    }
  },slow?15:1);
  for(let step=1;step<=180;step++) {
    for(const spec of subscriptions) {
      const created=performance.now();authority.set(spec.code,{sequence:step,price:100+step/100,created});report.offered++;
      const event={at:created,delta:{subscription_id:spec.id,stream_id:spec.stream,session_generation:1,sequence:step,
        delta_type:'trade.append',payload:{code:spec.code,price:100+step/100,volume:step%3,sequence:step,_created:created}}};
      if(queue.length<64){queue.push(event);report.accepted++;report.queueHigh=Math.max(report.queueHigh,queue.length);}
    }
    if(step===90){store.onDisconnected();connect();report.reconnects++;}
    await sleep(2);
  }
  const inputEnded=performance.now();
  while(queue.length) await sleep(5);
  clearInterval(consume);
  for(const spec of subscriptions)snapshot(spec);
  await sleep(40);
  for(const spec of subscriptions){
    const state=store.snapshot(spec);
    assert.equal(store.describe(spec).last_sequence,180);
    assert.equal(state.summary.current,101.8);
    assert.equal(state.trades.length,100);
    assert.equal(state.trades.at(-1).price,101.8);
    assert.equal(state.trades.at(-1).volume,0);
  }
  const stats=store.stats();
  assert.equal(updates.size,48,'every symbol/component must receive updates');
  assert.equal(report.accepted,report.processed+report.rejected);
  if(slow)assert.ok(resyncs>0);
  releases.forEach(fn=>fn());
  for(const spec of subscriptions)for(const component of ['trades','book','trend','product'])scheduler.cancel(`load:${spec.code}:${component}`);
  closed=true;
  for(const spec of subscriptions)store.handleDelta({subscription_id:spec.id,sequence:181,stream_id:spec.stream,delta_type:'trade.append',payload:{price:999}});
  await sleep(30);
  assert.equal(scheduler.pendingCount(),0);assert.equal(store.stats().client_subscription_count,0);
  return {...report,queueDropped:report.offered-report.accepted,resyncs,queueWaitMs:distribution(waits),
    componentUpdateIntervalMs:distribution(intervals),producerToCallbackFreshnessMs:distribution(freshness),
    inputMs:Number((inputEnded-start).toFixed(3)),totalMs:Number((performance.now()-start).toFixed(3)),
    componentKeys:updates.size,store:stats,shutdown:{pending:0,subscriptions:0,lateDataIgnored:true},
    reconciliation:{finalSnapshots:12,watermark:180,tailRowsPerSymbol:100,finalZeroVolume:0},
    scope:'TW canonical renderer store + shared scheduler callbacks; synthetic bounded consumer queue; no DOM/GPU/SDK/native/network'};
}
const reports=[];
for(const slow of [false,true])reports.push(await workload(slow));
const result={node:process.version,platform:process.platform,workloads:reports};
fs.writeFileSync(path.join(process.env.STOCK_MONITOR_CHECK_RUN,'renderer-load.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(reports.map(({store,...report})=>report),null,2));
