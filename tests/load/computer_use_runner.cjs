const {app,BrowserWindow,session}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),run=path.dirname(root);
if(!path.basename(run).startsWith('stockmonitor-cua-'))throw new Error('New isolated temp copy required');
app.setPath('userData',path.join(run,'profile'));
app.whenReady().then(async()=>{
  session.defaultSession.webRequest.onBeforeRequest((details,done)=>done({cancel:!details.url.startsWith('file:')}));
  const html=fs.readFileSync(path.join(root,'ui/renderer/pages/realtime.html'),'utf8');
  fs.writeFileSync(path.join(__dirname,'computer_use.html'),`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>StockMonitor 離線操作自檢</title><link rel="stylesheet" href="../../ui/renderer/styles/index.css"></head><body><header style="height:58px;display:flex;align-items:center;gap:8px;padding:8px;background:#e4edfa;color:#172238"><b>離線自檢・合成資料</b><button id="inject" class="btn">下一筆行情</button><button id="disconnect" class="btn">斷線</button><button id="reconnect" class="btn">重新連線</button><button id="hide" class="btn">離開即時頁</button><button id="resume" class="btn">返回即時頁</button><span id="testStatus"></span></header><main class="main" style="height:calc(100vh - 58px);padding:4px"><section id="pageContainer" class="page-container">${html}</section></main><script type="module" src="computer_use_fixture.mjs"></script></body></html>`);
  const win=new BrowserWindow({show:true,width:1560,height:1000,title:'StockMonitor 離線操作自檢',webPreferences:{backgroundThrottling:false}});
  const logs=[];win.webContents.on('console-message',(_e,level,message)=>logs.push({level,message}));
  await win.loadFile(path.join(__dirname,'computer_use.html'));
  const timer=setInterval(async()=>{if(win.isDestroyed())return;try{const state=await win.webContents.executeJavaScript('window.cuaReport?.()');if(state)fs.writeFileSync(path.join(run,'ui-report.json'),JSON.stringify(state,null,2));fs.writeFileSync(path.join(run,'renderer.log'),JSON.stringify(logs,null,2));}catch{}},1000);
  win.on('closed',()=>{clearInterval(timer);app.quit();});
  setTimeout(()=>{if(!win.isDestroyed())win.close();},30*60*1000).unref();
});
