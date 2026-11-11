const {app,BrowserWindow,session}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),run=path.dirname(root);
if(!path.basename(run).startsWith('stockmonitor-cua-'))throw new Error('New isolated temp copy required');
app.setPath('userData',path.join(run,'history-profile'));
app.whenReady().then(async()=>{
  session.defaultSession.webRequest.onBeforeRequest((details,done)=>done({cancel:!details.url.startsWith('file:')}));
  const html=fs.readFileSync(path.join(root,'ui/renderer/pages/history.html'),'utf8');
  fs.writeFileSync(path.join(__dirname,'history_computer_use.html'),`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>StockMonitor 歷史回放離線自檢</title><link rel="stylesheet" href="../../ui/renderer/styles/index.css"></head><body><main class="main" style="height:100vh;padding:4px"><section id="pageContainer" class="page-container">${html}</section></main><script type="module" src="history_computer_use_fixture.mjs"></script></body></html>`);
  const win=new BrowserWindow({show:true,width:1560,height:1000,title:'StockMonitor 歷史回放離線自檢',webPreferences:{backgroundThrottling:false}});
  await win.loadFile(path.join(__dirname,'history_computer_use.html'));
  const timer=setInterval(async()=>{if(win.isDestroyed())return;try{const state=await win.webContents.executeJavaScript('window.historyCuaReport?.()');if(state)fs.writeFileSync(path.join(run,'history-ui-report.json'),JSON.stringify(state,null,2));}catch{}},500);
  win.on('closed',()=>{clearInterval(timer);app.quit();});
  setTimeout(()=>{if(!win.isDestroyed())win.close();},30*60*1000).unref();
});
