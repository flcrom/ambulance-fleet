import {api,ApiError,eventsPath,snapshotPath} from './api';
import {parseSnapshot,type FleetSnapshot,type Mode} from './types';
export type Connection='connecting'|'websocket'|'polling'|'paused'|'error';
export interface Callbacks {snapshot:(s:FleetSnapshot)=>void;connection:(c:Connection)=>void;error:(message:string)=>void;unauthorized:()=>void}
// All tokens remain in memory. No query strings, storage or token logging.
export function connectFleet(mode:Mode,token:string|null,callbacks:Callbacks,standIn=false){
 let stopped=false,terminal=false,ws:WebSocket|null=null,pollTimer:ReturnType<typeof setTimeout>|undefined,retryTimer:ReturnType<typeof setTimeout>|undefined,controller:AbortController|null=null,failures=0,wsFailures=0;
 let lastTime=0, socketFresh=false;
 let watchdog:ReturnType<typeof setTimeout>|undefined;
 const accept=(value:unknown)=>{const v=parseSnapshot(value);if(v.mode!==mode||(mode==='demo'&&v.fleet_id!==(standIn?'demo-standin':'demo')))throw new Error('Invalid fleet snapshot'); const time=Date.parse(v.server_time);if(Math.abs(time-Date.now())>300000)throw new Error('Server time outside allowed skew'); if(time>=lastTime){lastTime=time; callbacks.snapshot(v);}};
 const visible=()=>!stopped&&!terminal&&document.visibilityState!=='hidden';
 const clear=()=>{clearTimeout(pollTimer);clearTimeout(retryTimer);clearTimeout(watchdog);socketFresh=false;pollTimer=undefined;retryTimer=undefined;controller?.abort();controller=null;const current=ws;ws=null;if(current){current.onclose=null;current.onerror=null;current.onmessage=null;current.close();}};
 const poll=async()=>{if(!visible())return;callbacks.connection('polling');const current=new AbortController();controller=current;try{const data=await api(snapshotPath(mode,standIn),token,{signal:current.signal});if(!visible()||current.signal.aborted)return;accept(data);failures=0;callbacks.error('');}catch(e){if(stopped||!visible()||(e as Error).name==='AbortError')return;if(e instanceof ApiError&&(e.status===401||e.status===403)){terminal=true;clear();callbacks.connection('error');callbacks.error(e.message);callbacks.unauthorized();return;}failures++;callbacks.error(e instanceof Error?e.message:'Fleet unavailable');}finally{if(controller===current)controller=null;if(visible()&&!socketFresh)pollTimer=setTimeout(poll,Math.min(30000,5000*2**Math.min(failures,3)));}};
 const open=()=>{if(!visible())return;lastTime=0; const url=new URL(eventsPath(mode,standIn),window.location.href);url.protocol=url.protocol==='https:'?'wss:':'ws:';let candidate:WebSocket;try{candidate=new WebSocket(url.toString(),mode==='live'&&token?['fleet.v1',`fleet-token.${token}`]:['fleet.v1']);}catch{scheduleRetry();return;}ws=candidate;watchdog=setTimeout(()=>candidate.close(),15000);
 candidate.onmessage=(event)=>{try{const message=JSON.parse(event.data);if(message.type!=='snapshot')throw new Error('Unexpected fleet event');accept(message.data);socketFresh=true;clearTimeout(watchdog);watchdog=setTimeout(()=>{socketFresh=false;candidate.close();},15000);wsFailures=0;callbacks.connection('websocket');callbacks.error('');clearTimeout(pollTimer);pollTimer=undefined;controller?.abort();}catch{callbacks.error('Invalid fleet event');candidate.close();}};
 candidate.onclose=(event)=>{if(ws!==candidate)return;if(mode==='live'&&event.code===1008){terminal=true;clear();callbacks.connection('error');callbacks.error('Dispatcher authorization ended');callbacks.unauthorized();return;}ws=null;socketFresh=false;clearTimeout(watchdog);if(visible()){if(!pollTimer&&!controller)void poll();scheduleRetry();}};
 candidate.onerror=()=>candidate.close();
 // A socket can open without ever delivering data. Keep polling until a valid snapshot arrives.
 };
 const scheduleRetry=()=>{clearTimeout(retryTimer);if(visible())retryTimer=setTimeout(open,Math.min(30000,5000*2**Math.min(wsFailures++,3)));};
 const start=()=>{if(!visible())return;lastTime=0;callbacks.connection('connecting');void poll();open();};
 const visibility=()=>{clear();if(visible())start();else callbacks.connection('paused');};
 document.addEventListener('visibilitychange',visibility);if(visible())start();else callbacks.connection('paused');
 return ()=>{stopped=true;clear();document.removeEventListener('visibilitychange',visibility);};
}
