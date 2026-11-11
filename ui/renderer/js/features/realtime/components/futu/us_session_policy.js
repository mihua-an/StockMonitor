// Futu's US session policy: which New York session it is now (Rust A's), and the trend tabs' time axes over those sessions.
import { TimeAxisPolicy } from "../../../../core/trend/index.js";
import { usMarketSession } from "../../futu_us_market_session.js";

export const isCryptoCode=(code)=>String(code||"").trim().toUpperCase().startsWith("CC.");
// The New York session trading now, as Rust A says (futu_us_market_session.js): pre / regular / after /
// overnight, or closed (a weekend, a holiday, a half day after 17:00); "closed" also before A has said.
export function currentUsSession(us=usMarketSession()){
  return String(us?.phase||"closed");
}
export const US_DAY_PART_TEXT=Object.freeze({pre:"盤前",regular:"盤中",after:"盤後"});
// The small text on the 日盤 button (user 11-10): the part of the day trading now; 休市 on a day the market does not
// open (a weekend, a holiday -- 日盤 then shows the trading day before it); 收盤 after a trading day's last session
// (a half day's 17:00, an evening with no overnight session); nothing in the overnight session.
export function usDayNote(us=usMarketSession()){
  const phase=currentUsSession(us);
  if(US_DAY_PART_TEXT[phase])return US_DAY_PART_TEXT[phase];
  if(phase!=="closed"||!us)return"";
  return us.market_day==="closed"?"休市":"收盤";
}
// The tab a US session belongs to: 盤前 / 盤中 / 盤後 are 日盤; 夜盤 and 全日 are their own.
export function usTrendTab(session){
  const key=String(session||"");
  if(key==="pre"||key==="regular"||key==="after")return"day";
  return US_TIME_AXES[key]?key:"full";
}

export const CRYPTO_TIME_AXIS=new TimeAxisPolicy({id:"futu-crypto-24h",segments:[{start:"00:00",end:"23:59"}]});

// Futu 個股走勢's tabs: 日盤 is 盤前 + 盤中 + 盤後 (all tradable), 夜盤, 全日.
export const US_TIME_AXES=Object.freeze({
  day:new TimeAxisPolicy({id:"us-day",segments:[
    {start:"04:00",end:"09:30",name:"pre"},
    {start:"09:30",end:"16:00",name:"regular"},
    {start:"16:00",end:"20:00",name:"after"},
  ]}),
  overnight:new TimeAxisPolicy({id:"us-overnight",segments:[{start:"20:00",end:"04:00"}]}),
  full:new TimeAxisPolicy({id:"us-full",segments:[
    {start:"20:00",end:"04:00",name:"overnight"},
    {start:"04:00",end:"09:30",name:"pre"},
    {start:"09:30",end:"16:00",name:"regular"},
    {start:"16:00",end:"20:00",name:"after"},
  ]}),
});
