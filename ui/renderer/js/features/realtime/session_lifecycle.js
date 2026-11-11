/** Owns status requests and transport observation, never a market/session store.
 *
 * No timer of its own: the session is Market Runtime's push (subscribeSession: session.current on every connection,
 * the new one with each session.rollover), applied as it comes. A rollover or a reconnect also re-reads the status
 * (market-data availability); readiness changes in between ride on the status the dock already reads
 * (subscribeStatus), so no poll of /api/status delays a rebind. */
export function createRealtimeSessionLifecycle({ getStatus, applyStatus, onDisconnected,
  isVisible = () => true, subscribeConnection, subscribeSession = () => () => {}, applySession = () => {},
  subscribeRollover = () => () => {}, subscribeStatus = () => () => {} }) {
  let active=false, generation=0, flight=null, controller=null;
  let unsubscribe=null, unsubscribeSession=null, unsubscribeRollover=null, unsubscribeStatus=null;
  const sync=()=>{
    if(!active) return Promise.resolve(null);
    if(flight) return flight;
    const token=generation, request=new AbortController();controller=request;
    const task=Promise.resolve().then(()=>getStatus(request.signal)).then(status=>{
      if(!active || token!==generation) return null;
      applyStatus(status); // atomic identity commit before the page resubscribes
      return status;
    }).catch((error) => { console.warn("[realtime session: refreshing the status] failed", error); return null; }).finally(()=>{
      if(flight===task){flight=null;controller=null;}
    });
    flight=task;return task;
  };
  return {
    sync,
    start(){
      if(active)return;active=true;generation++;
      unsubscribe=subscribeConnection(detail=>{
        if(!active)return;
        const state=String(detail?.state||'').toUpperCase();
        if(state==='CONNECTED')void sync();
        else if(state==='DISCONNECTED'||state==='RECONNECTING')onDisconnected();
      });
      // The session is applied visible or not: a hidden page must not come back on the old session.
      unsubscribeSession=subscribeSession(session=>{if(active)applySession(session);});
      unsubscribeRollover=subscribeRollover(()=>{if(active)void sync();});
      // A status read by someone else (the dock) is applied as is; none is requested for it.
      unsubscribeStatus=subscribeStatus(status=>{if(active && !flight && isVisible() && status)applyStatus(status);});
    },
    stop(){
      active=false;generation++;controller?.abort();controller=null;flight=null;
      unsubscribe?.();unsubscribe=null;
      unsubscribeSession?.();unsubscribeSession=null;
      unsubscribeRollover?.();unsubscribeRollover=null;
      unsubscribeStatus?.();unsubscribeStatus=null;
    },
    diagnostics(){return {active,inFlight:Boolean(flight),timer:false,listener:Boolean(unsubscribe),
      sessionListener:Boolean(unsubscribeSession),rolloverListener:Boolean(unsubscribeRollover),statusListener:Boolean(unsubscribeStatus)};},
  };
}
