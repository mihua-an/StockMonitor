import assert from 'node:assert/strict';
import {createHistoryQueries} from '../ui/renderer/js/features/history/queries.js';
import {createHistoryQueries as original} from './fixtures/history_queries_phase3_reference.mjs';
async function scenario(create){
  const calls=[],pending=[];let now=Date.now();const realNow=Date.now;
  Date.now=()=>now;
  try{
    const query=create({apiGet:url=>{calls.push(url);return new Promise((resolve,reject)=>pending.push({resolve,reject}));}});
    const a=query.getHistoryMarketSessionCached('2026-09-04'),b=query.getHistoryMarketSessionCached('2026-09-04');
    await Promise.resolve();assert.equal(calls.length,1);pending[0].resolve({ok:true,price:0});
    assert.strictEqual(await a,await b);
    assert.equal((await query.getHistoryMarketSessionCached('2026-09-04')).price,0);
    const c=query.getHistoryStocksCached('2026-09-03');await Promise.resolve();pending.at(-1).reject(new Error('offline failure'));
    await assert.rejects(c);assert.equal(query.diagnostics().pending.stocks,0);
    const retry=query.getHistoryStocksCached('2026-09-03');await Promise.resolve();pending.at(-1).resolve([]);await retry;
    for(let i=0;i<15;i++)query.putTrade(String(i),{price:i});
    assert.equal(query.getTrade('0'),null);assert.equal(query.diagnostics().tradePages,12);
    query.putMarkers('zero',{count:0});assert.equal(query.getMarkers('zero').count,0);
    now+=10001;assert.equal(query.getTrade('14'),null);assert.equal(query.getMarkers('zero'),null);
    return {calls,diagnostics:query.diagnostics()};
  }finally{Date.now=realNow;}
}
const current=await scenario(createHistoryQueries),baseline=await scenario(original);
delete current.diagnostics.cached.stockIndexes;
delete current.diagnostics.pending.stockIndexes;
assert.deepEqual(current,baseline);

const indexCalls=[];let resolveIndex;
const indexQueries=createHistoryQueries({apiGet:url=>{indexCalls.push(url);return new Promise(resolve=>{resolveIndex=resolve;});}});
const indexA=indexQueries.getHistoryStockIndexCached('2026-09-04');
const indexB=indexQueries.getHistoryStockIndexCached('2026-09-04');
await Promise.resolve();
assert.deepEqual(indexCalls,['/api/history/stocks?date=2026-09-04&summary=false']);
resolveIndex({ok:true,count:1,stocks:[{code:'2330'}]});
assert.strictEqual(await indexA,await indexB);
assert.equal(indexQueries.diagnostics().cached.stockIndexes,1);
assert.equal(indexQueries.diagnostics().pending.stockIndexes,0);

console.log('history queries: original single-flight/cache behavior contract passed');
