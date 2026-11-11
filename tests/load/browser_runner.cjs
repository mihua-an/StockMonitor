const {app,BrowserWindow,session}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),run=process.env.STOCK_MONITOR_CHECK_RUN;
if(!run||!root.startsWith(path.resolve(run)+path.sep)||!path.basename(run).startsWith('stockmonitor-check-'))throw new Error('Only a new isolated temp copy is permitted');
app.setPath('userData',path.join(run,'browser-profile'));
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.whenReady().then(async()=>{
  session.defaultSession.webRequest.onBeforeRequest((details,done)=>done({cancel:!details.url.startsWith('file:')}));
  const html=fs.readFileSync(path.join(root,'ui/renderer/pages/realtime.html'),'utf8');
  fs.writeFileSync(path.join(__dirname,'browser_fixture.html'),`<!doctype html><html><body><div id="pageContainer">${html}</div><script type="module" src="browser_fixture.mjs"></script></body></html>`);
  const win=new BrowserWindow({show:false,width:1600,height:1040,webPreferences:{offscreen:true,backgroundThrottling:false}});
  const log=[];win.webContents.on('console-message',(_event,level,message)=>log.push({level,message}));
  try{
    await win.loadFile(path.join(__dirname,'browser_fixture.html'),{query:{baseline:process.env.STOCK_MONITOR_CHECK_BASELINE||'0'}});
    const result=await win.webContents.executeJavaScript('window.acceptance');
    fs.writeFileSync(path.join(run,'browser-result.json'),JSON.stringify(result,null,2));
    process.exitCode=result?.ok?0:1;
  }catch(error){fs.writeFileSync(path.join(run,'browser-error.txt'),String(error.stack||error));process.exitCode=1;}
  finally{fs.writeFileSync(path.join(run,'browser.log'),JSON.stringify(log,null,2));win.destroy();app.exit(process.exitCode||0);}
});
