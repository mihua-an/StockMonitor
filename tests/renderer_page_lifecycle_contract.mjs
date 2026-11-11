import assert from 'node:assert/strict';
import {startRealtimePage} from './support/realtime_page_harness.mjs';
import {createRealtimeSessionLifecycle} from '../ui/renderer/js/features/realtime/session_lifecycle.js';
import {createViewResources} from '../ui/renderer/js/market_data/view_resources.js';
const timers=new Map(),frames=new Map();let id=1;
const clock={setTimeout(fn){const key=id++;timers.set(key,fn);return key;},clearTimeout:key=>timers.delete(key),
  setInterval(fn){const key=id++;timers.set(key,fn);return key;},clearInterval:key=>timers.delete(key),
  requestAnimationFrame(fn){const key=id++;frames.set(key,fn);return key;},cancelAnimationFrame:key=>frames.delete(key)};
const pending=[],commits=[];let listener=null,releases=0,rollover=null,statusFeed=null;
const lifecycle=createRealtimeSessionLifecycle({clock,getStatus:signal=>new Promise(resolve=>pending.push({signal,resolve})),
  applyStatus:status=>commits.push(status),onDisconnected:()=>commits.push('disconnected'),isVisible:()=>true,
  subscribeConnection:fn=>{listener=fn;return()=>{listener=null;releases++;};},
  subscribeRollover:fn=>{rollover=fn;return()=>{rollover=null;};},
  subscribeStatus:fn=>{statusFeed=fn;return()=>{statusFeed=null;};}});
// No timer of its own; a session change arrives as Market Runtime's rollover notice.
lifecycle.start();lifecycle.start();assert.equal(timers.size,0);
const first=lifecycle.sync();assert.equal(first,lifecycle.sync());await Promise.resolve();
lifecycle.stop();assert.equal(pending[0].signal.aborted,true);
lifecycle.start();const second=lifecycle.sync();await Promise.resolve();
pending[0].resolve('stale');await first;assert.deepEqual(commits,[]);
pending[1].resolve('current');await second;assert.deepEqual(commits,['current']);
listener({state:'RECONNECTING'});listener({state:'CONNECTED'});await Promise.resolve();
pending[2].resolve('snapshot-ready');await lifecycle.sync();assert.deepEqual(commits,['current','disconnected','snapshot-ready']);
statusFeed('dock-read');assert.deepEqual(commits.at(-1),'dock-read','the dock status read is applied without a request of its own');
assert.equal(pending.length,3);
rollover({rolled:{}});await Promise.resolve();assert.equal(pending.length,4,'a rollover re-reads the session');
pending[3].resolve('rolled');await lifecycle.sync();assert.equal(commits.at(-1),'rolled');
lifecycle.stop();lifecycle.stop();assert.equal(releases,2);assert.equal(timers.size,0);
assert.equal(rollover,null);assert.equal(statusFeed,null);
const scope=createViewResources(clock),target=new EventTarget();target.dataset={};let called=0;
for(let iteration=0;iteration<20;iteration++){
  scope.activate();scope.mark(target,'bound');scope.listen(target,'update',()=>called++);
  target.dispatchEvent(new Event('update'));const token=scope.token();
  scope.timeout(()=>assert.fail('timer after dispose'),1);scope.frame(()=>assert.fail('frame after dispose'));
  scope.dispose();scope.dispose();assert.equal(scope.current(token),false);
  assert.equal(target.dataset.bound,undefined);target.dispatchEvent(new Event('update'));
  assert.equal(scope.diagnostics().disposables,0);assert.equal(timers.size,0);assert.equal(frames.size,0);
}
assert.equal(called,20);
scope.activate();
const cancelledDelay=scope.delay(1000);let released=0;
const release=scope.own(()=>released++);release();release();
scope.dispose();assert.equal(await cancelledDelay,false);assert.equal(released,1);
scope.own(()=>released++);assert.equal(released,2);assert.equal(scope.diagnostics().disposables,0);
// The real page commits Market Runtime's session (session.current, pushed on the connection) before anything
// subscribes: the readiness listeners hear the new date, and every view the owner binds on it already carries that
// date (commit-before-subscribe). The status read (/api/status) carries only market-data availability.
const statusRequests=[];
globalThis.fetch=async(url)=>{statusRequests.push(String(url));
  return new Response(JSON.stringify({}),{status:200,headers:{'content-type':'application/json'}});};
const page=await startRealtimePage({displayContext:{equity:{trading_date:'2026-09-03'}}});
const {startRealtimeSessionSync}=await import('../ui/renderer/js/features/realtime/session_controller.js');
const observations=[];
page.sessionState.equityDateListeners.add(date=>observations.push('listener:'+date));
page.showProducts(['2330']);
const subscribedBefore=page.socket.sentOfType('view.subscribe').length;
startRealtimeSessionSync();
page.socket.frame({type:'session.current',payload:{equity:{trading_date:'2026-09-04',phase:'PREOPEN'},futures:{}}});
await page.live.settle(()=>observations.length>0);
assert.deepEqual(observations,['listener:2026-09-04']);
const rebound=page.socket.sentOfType('view.subscribe').slice(subscribedBefore).filter(message=>message.payload.market==='STK');
assert.deepEqual(rebound.map(message=>[message.payload.code,message.payload.trading_date]),[['2330','2026-09-04']],
  'the product view is bound on the committed date, never on the previous one');
console.log('page lifecycle: repeated mount/dispose, pending status, reconnect and commit-before-subscribe passed');
