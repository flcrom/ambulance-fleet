import {isPing, type Ping, type Mode} from './types';
export class ApiError extends Error {constructor(public status:number,public code:string,message:string){super(message);}}
export const COOKIE='cookie-session';
export async function api<T>(path:string,token:string|null,init:RequestInit={}):Promise<T>{
 const response=await fetch(path,{...init,cache:'no-store',headers:{...(token&&token!==COOKIE?{Authorization:`Bearer ${token}`} :{}),...init.headers}});
 if(!response.ok){const body=await response.json().catch(()=>null);throw new ApiError(response.status,body?.error?.code??'request_failed',body?.error?.message??`Request failed (${response.status})`);}
 return response.json();
}
export async function history(id:string,token:string,signal?:AbortSignal):Promise<Ping[]>{
 const data=await api<{pings:unknown[]}>(`/api/vehicles/${encodeURIComponent(id)}/history?limit=100`,token,{signal});
 if(!Array.isArray(data.pings)||!data.pings.every(isPing))throw new Error('Invalid history response');
 return data.pings.filter(p=>p.vehicle_id===id).sort((a,b)=>Date.parse(a.recorded_at)-Date.parse(b.recorded_at));
}
export const acknowledge=(id:string,token:string)=>api<{acknowledged:true}>(`/api/alerts/${encodeURIComponent(id)}/ack`,token,{method:'POST'});
export const createIncident=(input:{label:string;lat:number;lon:number;priority:number},token:string)=>api<import('./types').Incident>('/api/incidents',token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
export const assignIncident=(id:string,vehicleId:string,token:string)=>api<import('./types').Incident>(`/api/incidents/${encodeURIComponent(id)}/assign`,token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({vehicle_id:vehicleId})});
export const closeIncident=(id:string,token:string)=>api<import('./types').Incident>(`/api/incidents/${encodeURIComponent(id)}/close`,token,{method:'POST'});
export const patchVehicle=(id:string,patch:{status?:string;destination?:{label:string;lat:number;lon:number}|null},token:string)=>api<import('./types').Vehicle>(`/api/vehicles/${encodeURIComponent(id)}`,token,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)});
export const postPing=(ping:import('./types').PingInput,token:string)=>api<{accepted:boolean;duplicate:boolean;event_id:string}>('/api/pings',token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(ping)});
export const snapshotPath=(mode:Mode,standIn=false)=>mode==='demo'?`/api/demo/fleet${standIn?'?mode=stand_in':''}`:'/api/fleet';
export const eventsPath=(mode:Mode,standIn=false)=>mode==='demo'?`/api/demo/events${standIn?'?mode=stand_in':''}`:'/api/events';
export const opsLogin=(fleet_id:string,password:string)=>api<{ok:true;fleet_id:string;role:string;exp:number}>('/api/ops/login',null,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fleet_id,password})});
export const opsSetup=(fleet_id:string,key:string,password:string)=>api<{ok:true}>('/api/ops/setup',null,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fleet_id,key,password})});
export const opsSession=()=>api<{ok:true;fleet_id:string;role:string;exp:number}>('/api/ops/session',null);
export const opsLogout=()=>api<{ok:true}>('/api/ops/logout',null,{method:'POST'});
