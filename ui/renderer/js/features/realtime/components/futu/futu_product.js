// A Futu product row as the screens read it: the catalog row joined with the live view's fields, projected once
// (product()) so every derived field -- 振幅, 漲幅, the REGULAR-session strip -- comes from one place.
import { numberOrNull } from "../../../../core/numbers.js";
import { displayInstrumentName } from "../../../../core/instrument_names.js";
import { selectRealtimeView } from "../../../../market_data/realtime.js";
import { formatMoomooDisplaySymbol, futuCanonicalViewSpec } from "../../../../market_data/moomoo_symbol.js";
import { moomooQuoteStore } from "../../moomoo_quote_store.js";
import { viewStateToMoomooProductFields } from "../../moomoo_view_adapter.js";
import { currentUsSession, isCryptoCode } from "./us_session_policy.js";

const first=(row,keys)=>{for(const key of keys){if(row?.[key]!==undefined&&row?.[key]!==null&&row?.[key]!=="")return row[key];}return null;};
// A Futu product's name is the product catalog's (SpaceX for US.SPCX, 台積電 for US.TSM), the one name source
// (core/instrument_names.js); its ticker until the catalog answers, never the market-qualified code.
export function futuName(code){return displayInstrumentName("futu",code,formatMoomooDisplaySymbol(code));}
export function product(row){
  const code=String(row?.code||""),crypto=isCryptoCode(code),session=crypto?"full":currentUsSession();
  const name=futuName(code);
  const prev=numberOrNull(first(row,["prev_close_price","prev_close"]));
  if(!crypto){
    // Every Futu US information strip is a REGULAR-session projection. The
    // selected chart tab never changes these facts.
    const current=numberOrNull(row?.regular_current),open=numberOrNull(row?.regular_open),high=numberOrNull(row?.regular_high),low=numberOrNull(row?.regular_low);
    const volume=numberOrNull(row?.regular_volume);
    return{raw:row,session,market:"us",code,name,current,prev,high,low,open,volume,
      avg:numberOrNull(row?.regular_avg_price),
      amplitude:numberOrNull(row?.amplitude),
      // 漲跌 / 漲幅: Market Runtime's (moomoo_view_adapter.js), never derived here.
      change:numberOrNull(row?.change),changePct:numberOrNull(row?.change_pct),
      // 量變: Rust B's comparison with the previous session's same minute (Futu US baselines),
      // arriving on the signals channel; never synthesized here.
      volumeChange:numberOrNull(row?.volume_change_pct_vs_baseline),
      chg1:numberOrNull(row.chg_1m),chg3:numberOrNull(row.chg_3m),chg5:numberOrNull(row.chg_5m),k1:numberOrNull(row.k_1m),k3:numberOrNull(row.k_3m),k5:numberOrNull(row.k_5m)};
  }
  const current=numberOrNull(first(row,["last_price","current_price","price"]));
  const high=numberOrNull(first(row,["high_price","high"])),low=numberOrNull(first(row,["low_price","low"])),open=numberOrNull(first(row,["open_price","open"]));
  const volume=numberOrNull(first(row,["volume","total_volume"]));
  return{raw:row,session,market:"cc",code,name,current,prev,high,low,open,volume,
    avg:numberOrNull(row.avg_price),amplitude:numberOrNull(row?.amplitude),
    change:numberOrNull(row?.change),changePct:numberOrNull(row?.change_pct),
    // 量變: B computes none for CC (no previous-session baseline), so a CC row has no 量變.
    volumeChange:null,chg1:numberOrNull(row.chg_1m),chg3:numberOrNull(row.chg_3m),chg5:numberOrNull(row.chg_5m),k1:numberOrNull(row.k_1m),k3:numberOrNull(row.k_3m),k5:numberOrNull(row.k_5m)};
}

export function focusedProduct(code){
  const target=String(code||"").toUpperCase();
  if(!target)return null;
  const spec=futuCanonicalViewSpec(target);
  // select(), not snapshot(): this runs several times per focused render, and snapshot() deep-copied
  // the whole view (minute trend + trade window) each time only to read a handful of scalars.
  const fields=selectRealtimeView(spec,(state)=>({fields:viewStateToMoomooProductFields(state)}))?.fields||{};
  const base=moomooQuoteStore.products.find((row)=>String(row?.code||"").toUpperCase()===target)||{};
  // Overlay Market Runtime's snapshot on the catalog row and run the result through product() once, so every field
  // product() derives (振幅 among them) is present; a row built from `summary` alone would lack them.
  return product({...base,...fields,code:target});
}
