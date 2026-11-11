// Only the transport/API boundary is simulated. The page, stores, scheduler,
// dashboard components and CSS below are production modules from the temp copy.
const errors=[],requests=[],wire=[],actions=[];
const codes=['2330','2344'],names={'2330':'台積電（測試）','2344':'華邦電（測試）',TAIEX:'加權指數（測試）',TXFR1:'台指期（測試）'};
let step=1,online=true,sockets=[],page,rt,appState;
const price=code=>(code==='2330'?1000:code==='2344'?30:22000)+step;
const summary=code=>({code,name:names[code]||code,current:price(code),last_price:price(code),prev_close:price(code)-5,reference_price:price(code)-5,open:price(code)-2,high:price(code)+3,low:price(code)-3,total_volume:1000+step,volume:0,trading_date:'2026-09-04',coverage_state:'AVAILABLE',datetime:'2026-09-04 09:30:00',limit_up:price(code)+90,limit_down:price(code)-90});
const points=code=>Array.from({length:30},(_,i)=>({time:`09:${String(i).padStart(2,'0')}:00`,datetime:`2026-09-04 09:${String(i).padStart(2,'0')}:00`,price:price(code)+(i%5)-4,volume:i+1}));
const trade=code=>({code,price:price(code),volume:step%3,sequence:step,ingest_sequence:step,time:`09:30:${String(step%60).padStart(2,'0')}`,datetime:`2026-09-04 09:30:${String(step%60).padStart(2,'0')}`,trade_side:'BUY'});
const book=code=>({bid_prices:Array.from({length:5},(_,i)=>price(code)-i),ask_prices:Array.from({length:5},(_,i)=>price(code)+i+1),bid_volumes:[10,20,30,40,50],ask_volumes:[15,25,35,45,55],datetime:'2026-09-04 09:30:00'});
window.addEventListener('error',e=>errors.push(String(e.error||e.message)));
window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
window.desktopAPI={sourceSettings:{enabled_sources:['shioaji'],sources:{shioaji:{api_prefixes:[]},futu:{api_prefixes:['/api/futu']}}},onWatchPagesChanged:()=>()=>{}};
window.fetch=async(url,options={})=>{
  const target=new URL(url,location.href),p=target.pathname;requests.push({url:String(url),method:options.method||'GET'});
  let payload={ok:true,items:[],pages:[],signals:[],events:[],points:[],rows:[],total_rows:0,total_pages:1,snapshot_watermark:step};
  if(p==='/api/status')payload={ok:true,broker_status:{authority:'persistent_market_daemon',daemon_reachable:online,shioaji_connected:online}};
  if(p.includes('watch-pages'))payload={ok:true,pages:[{id:'test',name:'自檢商品',codes}]};
  if(p.includes('product-summaries'))payload={ok:true,items:codes.map(summary)};
  const code=target.searchParams.get('code')||target.searchParams.get('logical_code')||target.searchParams.get('symbol')||codes.find(c=>p.includes(c))||(p.includes('txf')?'TXFR1':'TAIEX');
  if(p.includes('context'))payload={ok:true,code,trade_flow:{sample_count:0}};
  if(p.includes('trend')||p.includes('chart')||p.includes('taiex'))payload={ok:true,...summary(code),points:points(code)};
  if(p.includes('trade-detail')||p.includes('ticks'))payload={ok:true,code,rows:[trade(code)],items:[trade(code)],total_rows:1,total_pages:1,snapshot_watermark:step};
  return {ok:true,status:200,json:async()=>payload};
};
class Socket {
  static OPEN=1;static CONNECTING=0;readyState=0;listeners=new Map();subs=new Map();
  constructor(url){this.url=url;sockets.push(this);setTimeout(()=>{if(!online)return;this.readyState=1;this.emit('open');this.message('system.connected',{renderer_protocol_version:2,realtime_protocol_version:1,backend_runtime_version:'fastapi-realtime-v4-closed-session-repair',connection_id:new URL(url).searchParams.get('connection_id')});},30);}
  addEventListener(type,fn){this.listeners.set(type,fn);}
  emit(type,event={}){this.listeners.get(type)?.(event);}
  message(type,payload){wire.push({direction:'in',type,sequence:payload.sequence,code:payload.session_key?.logical_code});this.emit('message',{data:JSON.stringify({type,payload})});}
  send(raw){const {type,payload}=JSON.parse(raw);wire.push({direction:'out',type,payload});
    if(type==='client.heartbeat')queueMicrotask(()=>this.message('system.heartbeat',{at:Date.now()}));
    if(type==='view.subscribe') {const id={request_id:payload.request_id,subscription_id:payload.request_id,stream_id:`${payload.market}|${payload.code}|${payload.session}|${payload.trading_date}`,watermark:step};this.subs.set(id.subscription_id,{spec:payload,id});queueMicrotask(()=>{this.message('view.subscription.accepted',id);this.snapshot(this.subs.get(id.subscription_id));});}
    if(type==='view.unsubscribe')this.subs.delete(payload.subscription_id||payload.request_id);
    if(type==='view.resync')this.snapshot(this.subs.get(payload.subscription_id));
  }
  snapshot(sub){if(!sub)return;const {spec,id}=sub,code=spec.code;this.message('view.snapshot',{...id,watermark:step,session_generation:1,session_key:{market:spec.market,logical_code:code,trading_date:spec.trading_date,session:spec.session},summary:summary(code),trades:[trade(code)],trend:points(code),orderbook:book(code)});}
  close(){this.readyState=3;this.subs.clear();this.emit('close');}
}
window.WebSocket=Socket;
page=await import('../../ui/renderer/js/pages/realtime.js');
rt=await import('../../ui/renderer/js/market_data/realtime.js');
({appState}=await import('../../ui/renderer/js/core/state.js'));
await import('../../ui/renderer/js/dashboard_components.js');
const {getDashboardDiagnostics}=await import('../../ui/renderer/js/core/dashboard_runtime.js');
const {realtimeRenderScheduler}=await import('../../ui/renderer/js/features/realtime/realtime_render_scheduler.js');
const {realtimeContext}=await import('../../ui/renderer/js/core/dashboard_context.js');
appState.currentPage='realtime';appState.realtimeCodes=codes;appState.signalsByCode=new Map(codes.map(c=>[c,summary(c)]));appState.productMarketSummaries=Object.fromEntries(codes.map(c=>[c,summary(c)]));
rt.startRealtimeStream();
await page.initRealtimePage();
function status(action){actions.push({action,step,at:new Date().toISOString()});document.getElementById('testStatus').textContent=`序號 ${step}｜2330 ${price('2330')}｜2344 ${price('2344')}｜${online?'連線':'斷線'}`;}
document.getElementById('inject').onclick=()=>{step++;for(const socket of sockets.filter(s=>s.readyState===1))for(const sub of socket.subs.values()){socket.message('view.delta',{...sub.id,session_generation:1,sequence:step*2-1,delta_type:'trade.frame',payload:{trade:trade(sub.spec.code),trend:{action:'append',point:points(sub.spec.code).at(-1)}}});
    socket.message('view.delta',{...sub.id,session_generation:1,sequence:step*2,delta_type:'quote.frame',payload:{summary:summary(sub.spec.code)}});}
  status('inject');};
document.getElementById('disconnect').onclick=()=>{online=false;sockets.forEach(s=>{if(s.readyState<2)s.close();});status('disconnect');};
document.getElementById('reconnect').onclick=()=>{online=true;for(const s of sockets)if(s.readyState===0)s.close();rt.requestRealtimeReconnect();status('reconnect');};
document.getElementById('hide').onclick=()=>{page.setRealtimePageVisible(false);document.getElementById('pageContainer').hidden=true;status('hide');};
document.getElementById('resume').onclick=()=>{document.getElementById('pageContainer').hidden=false;page.resumeRealtimePage();status('resume');};
window.cuaReport=()=>({errors,requests,wire,actions,step,online,connection:rt.getRealtimeConnectionState(),store:rt.getRealtimeViewStats(),page:page.getLiveMarketDataDiagnostics(),dashboard:getDashboardDiagnostics('realtime'),dataListeners:realtimeContext.dataSource.listenerCount(),pending:realtimeRenderScheduler.pendingCount(),rows:document.getElementById('realtimeQuoteTableBody')?.innerText,detail:document.querySelector('[data-role="tick-body"]')?.innerText});
status('ready');
