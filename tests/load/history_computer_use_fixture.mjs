const requests=[];
window.desktopAPI={sourceSettings:{enabled_sources:[],offline_ui:true,sources:{shioaji:{api_prefixes:['/api/history']},futu:{api_prefixes:['/api/futu']}}}};
const stock={code:'2330',name:'台積電（隔離測試）',rows:3,open:100,high:102,low:100,close:101,prev_close:99,change:2,change_pct:2.0202020202,cached:true,has_tick:true,has_trade_detail:true,has_bidask:true,sessions:['DAY'],volume:6,total_volume:6};
const ticks=[
  {datetime:'2026-09-04T09:00:01',time:'09:00:01',price:100,open:100,high:100,low:100,prev_close:99,volume:2,total_volume:2,ingest_sequence:1},
  {datetime:'2026-09-04T09:00:03',time:'09:00:03',price:102,open:100,high:102,low:100,prev_close:99,volume:3,total_volume:5,ingest_sequence:3},
  {datetime:'2026-09-04T09:00:05',time:'09:00:05',price:101,open:100,high:102,low:100,prev_close:99,volume:1,total_volume:6,ingest_sequence:5},
];
const points=ticks.map(row=>({time:row.time,datetime:row.datetime,price:row.price,volume:row.total_volume,minute_volume:row.volume}));
window.fetch=async(url,options={})=>{
  const target=new URL(url,location.href),p=target.pathname;requests.push(p+target.search);
  let payload={ok:true,items:[],rows:[],events:[],points:[],dates:[]};
  if(p==='/api/history/dates')payload={ok:true,dates:['2026-09-04']};
  else if(p==='/api/history/stocks')payload={ok:true,date:'2026-09-04',count:1,stocks:[stock],timing:{product_list_total_ms:1}};
  else if(p==='/api/history/kline')payload={ok:true,code:'2330',resolution:'day',bars:[{trading_date:'2026-09-04',open:100,high:102,low:100,close:101,volume:6}],next_before:null};
  else if(p.includes('taiex-session')||p.includes('txf-session'))payload={ok:true,count:0,points:[]};
  else if(p.includes('trade-detail'))payload={ok:true,rows:ticks,total_rows:3,total_pages:1,snapshot_watermark:5};
  return {ok:true,status:200,json:async()=>payload};
};
const page=await import('../../ui/renderer/js/pages/history.js');
page.bindHistoryEvents();
await page.refreshHistoryPage();
window.historyCuaReport=()=>({requests,sidebar:document.getElementById('historyStockList')?.innerText||'',productStatus:document.getElementById('historyProductLoadStatus')?.innerText||'',price:document.getElementById('historyQuotePrice')?.innerText||'',change:document.getElementById('historyQuoteChange')?.innerText||'',selected:document.getElementById('historyQuoteCode')?.innerText||'',trendCanvas:Boolean(document.getElementById('historyTrendCanvas')),klineRequested:requests.some(value=>value.startsWith('/api/history/kline?'))});
