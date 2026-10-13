import {isPing, type Ping, type Mode} from './types';
export class ApiError extends Error {constructor(public status:number,public code:string,message:string){super(message);}}
export async function api<T>(path:string,token:string|null,init:RequestInit={}):Promise<T>{
 const response=await fetch(path,{...init,cache:'no-store',headers:{...(token?{Authorization:`Bearer ${token}`} :{}),...init.headers}});
 if(!response.ok){const body=await response.json().catch(()=>null);throw new ApiError(response.status,body?.error?.code??'request_failed',body?.error?.message??`Request failed (${response.status})`);}
 return response.json();
}
export async function history(id:string,token:string,signal?:AbortSignal):Promise<Ping[]>{
 const data=await api<{pings:unknown[]}>(`/api/vehicles/${encodeURIComponent(id)}/history?limit=100`,token,{signal});
 if(!Array.isArray(data.pings)||!data.pings.every(isPing))throw new Error('Invalid history response');
 return data.pings.filter(p=>p.vehicle_id===id).sort((a,b)=>Date.parse(a.recorded_at)-Date.parse(b.recorded_at));
}
export const acknowledge=(id:string,token:string)=>api<{acknowledged:true}>(`/api/alerts/${encodeURIComponent(id)}/ack`,token,{method:'POST'});
export const snapshotPath=(mode:Mode,standIn=false)=>mode==='demo'?`/api/demo/fleet${standIn?'?mode=stand_in':''}`:'/api/fleet';
export const eventsPath=(mode:Mode,standIn=false)=>mode==='demo'?`/api/demo/events${standIn?'?mode=stand_in':''}`:'/api/events';
