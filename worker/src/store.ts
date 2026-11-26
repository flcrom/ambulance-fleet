import { fetchFeed,fetchBusRoutes,ATTRIBUTIONS } from './feeds/index';
import { DurableObject } from 'cloudflare:workers';
import { ApiError, apiErrorResponse, RateLimiter, principalRateKey, requireRegistrationAccess, validateVehicleRegistration, validateVehiclePatch, rejectUnknownKeys, readJson, hashPassword, verifyPassword, DUMMY_RECORD } from './auth/index';
import type { Claims } from './auth/index';
import { validatePing, deriveVehicle, evaluateAlerts, isNewer } from './rules/index';
import type { Vehicle, Ping, PingInput, Alert, FleetSnapshot, Destination, OperationalStatus, Incident } from '../../shared/types';
import { json, type Env } from './index';
import { advance, initialState, positionOnLeg } from './demo/sim';
import type { Router, SimIncident, SimState } from './demo/sim';
import { fetchOsrmRoute, routeCacheKey } from './demo/routing';
const statuses: OperationalStatus[] = ['available','en_route','at_scene','transporting','at_hospital'];
const validId = (v:unknown):v is string => typeof v==='string' && /^[a-zA-Z0-9_-]{1,80}$/.test(v);
const validIncidentId = (v:unknown):v is string => typeof v==='string' && /^[a-f0-9-]{36}$/.test(v);
const toPublicIncident = (i:SimIncident):Incident => ({id:i.id,label:i.label,lat:i.lat,lon:i.lon,priority:i.priority,status:i.status,created_at:i.created_at,assigned_at:i.assigned_at,closed_at:i.closed_at,vehicle_id:i.vehicle_id,hospital_label:i.hospital.label});
export function orderIncidents(list:Incident[]):Incident[] {
 const active=list.filter(i=>i.status!=='closed').sort((a,b)=>a.priority-b.priority||a.created_at.localeCompare(b.created_at));
 const closed=list.filter(i=>i.status==='closed').sort((a,b)=>(b.closed_at??'').localeCompare(a.closed_at??'')).slice(0,5);
 return [...active,...closed];
}
export class FleetStore extends DurableObject<Env> {
 private sockets=new Set<WebSocket>();
 private attachments=new WeakMap<WebSocket,{fleetId:string;expiresAt:number|null}>();
 private heartbeat:ReturnType<typeof setInterval>|undefined;
 private sql: SqlStorage; private feedError:string|undefined; private busRoutes:Set<string>|undefined; private feedLastAttempt=0;
 private routeErrorAt=0;
 private pingLimiter=new RateLimiter(60,1); private readLimiter=new RateLimiter(100,2); private writeLimiter=new RateLimiter(30,.5);
 private loginLimiter=new RateLimiter(10,.05);
 constructor(ctx: DurableObjectState, env: Env) {
  super(ctx,env); this.sql=ctx.storage.sql;
  this.sql.exec(`CREATE TABLE IF NOT EXISTS vehicles(id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS pings(event_id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL, recorded_at TEXT NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS ping_history ON pings(vehicle_id,recorded_at DESC); CREATE TABLE IF NOT EXISTS alerts(id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL, kind TEXT NOT NULL, active INTEGER NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS incidents(id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS routes(key TEXT PRIMARY KEY, data TEXT NOT NULL);`);
 }
 private rows<T>(query:string,...args:(string|number)[]):T[] { return this.sql.exec(query,...args).toArray().map(row=>JSON.parse(row.data as string) as T); }
 private metaGet(key:string):string|undefined{return this.sql.exec('SELECT value FROM meta WHERE key=?',key).toArray()[0]?.value as string|undefined;}
 private metaSet(key:string,value:string){this.sql.exec('INSERT OR REPLACE INTO meta VALUES(?,?)',key,value);}
 private normalizeVehicle(v:Vehicle):Vehicle{if(v.latest_ping&&!v.latest_ping.telemetry_time){v.latest_ping={...v.latest_ping,telemetry_time:'receipt',recorded_at:v.latest_ping.received_at};}return v;}
 private vehicles(){return this.rows<Vehicle>('SELECT data FROM vehicles ORDER BY id').map(v=>this.normalizeVehicle(v));}
 private saveVehicle(vehicle:Vehicle){this.sql.exec('INSERT OR REPLACE INTO vehicles(id,data) VALUES (?,?)',vehicle.id,JSON.stringify(vehicle));}
 private getVehicle(id:string){const v=this.rows<Vehicle>('SELECT data FROM vehicles WHERE id=?',id)[0];return v?this.normalizeVehicle(v):undefined;}
 private async refreshFeed(){
  const now=Date.now();if(now-this.feedLastAttempt<15000)return;this.feedLastAttempt=now;
  try{
   this.busRoutes??=await fetchBusRoutes();const samples=await fetchFeed({provider:'mbta',busRoutes:this.busRoutes});
   if(!samples.length)throw Error('No valid feed positions');
   this.ctx.storage.transactionSync(()=>{for(const sample of samples){const existing=this.getVehicle(sample.vehicle.id);const incoming:Ping={...sample.ping,received_at:new Date(now).toISOString()};const immutable=this.rows<Ping>('SELECT data FROM pings WHERE event_id=?',incoming.event_id)[0];const p=immutable||incoming;const v:Vehicle=existing||{...sample.vehicle,status:'available',destination:null,latest_ping:null,stale:true,eta:null};v.last_seen=new Date(now).toISOString();if(!immutable&&isNewer(v.latest_ping,p))v.latest_ping=p;this.saveVehicle(v);if(!immutable)this.sql.exec('INSERT INTO pings VALUES(?,?,?,?)',p.event_id,p.vehicle_id,p.recorded_at,JSON.stringify(p));}});
   this.feedError=undefined;
  }catch(error){console.error('stand-in feed fetch unavailable',error instanceof Error?error.message:'unknown');this.feedError='Live stand-in feed unavailable; previous positions may be stale';}
 }
 /** Road routes for simulated legs, cached forever; null on provider failure. */
 private demoRouter:Router=async(from,to)=>{
  const key=routeCacheKey(from,to);
  const cached=this.rows<{points:{lat:number;lon:number}[];total_m:number}>('SELECT data FROM routes WHERE key=?',key)[0];
  if(cached)return{points:cached.points,total_m:cached.total_m};
  const result=await fetchOsrmRoute(from,to);
  if(result){this.sql.exec('INSERT OR REPLACE INTO routes VALUES(?,?)',key,JSON.stringify(result));this.routeErrorAt=0;}
  else this.routeErrorAt=Date.now();
  return result;
 };
 /**
  * Server-owned dispatch simulation for the public demo. Replaces the old circle
  * wobble: generated calls, nearest-unit dispatch, road-following legs. One wipe
  * migration clears the v1 demo rows; live fleets are never touched.
  */
 private async advanceDemo(nowMs:number){
  if(this.metaGet('sim_version')!=='2'){
   this.ctx.storage.transactionSync(()=>{
    this.sql.exec('DELETE FROM pings');this.sql.exec('DELETE FROM vehicles');this.sql.exec('DELETE FROM alerts');
    this.sql.exec("DELETE FROM meta WHERE key NOT IN ('fleet_id')");
    this.metaSet('sim_version','2');
   });
  }
  const tick=Math.floor(nowMs/5000);
  const previous=this.metaGet('demo_tick');
  if(previous&&Number(previous)===tick)return;
  const raw=this.metaGet('sim_state');
  const state:SimState=raw?JSON.parse(raw):initialState(nowMs);
  const events=await advance(state,nowMs,this.demoRouter);
  const logHistory=tick%6===0;
  this.ctx.storage.transactionSync(()=>{
   state.units.forEach((unit)=>{
    const incident=unit.incident_id?state.incidents.find(i=>i.id===unit.incident_id):undefined;
    const moving=unit.leg!==null;
    const heading=moving?Math.round(positionOnLeg(unit.leg!,nowMs).heading):null;
    const ping:Ping={event_id:crypto.randomUUID(),vehicle_id:unit.id,recorded_at:new Date(nowMs).toISOString(),received_at:new Date(nowMs).toISOString(),lat:unit.pos.lat,lon:unit.pos.lon,speed_kph:moving?Math.round(unit.leg!.speed_kph*10)/10:0,heading,telemetry_time:'receipt'};
    const destination:Destination|null=unit.leg?unit.leg.to:incident?{label:incident.label,lat:incident.lat,lon:incident.lon}:null;
    const vehicle:Vehicle={id:unit.id,callsign:unit.callsign,type:unit.type,source:'synthetic',status:unit.status,destination,latest_ping:ping,stale:false,eta:null,incident_id:unit.incident_id,...(unit.leg&&unit.leg.road?{route:{arrive_at:new Date(unit.leg.arrive_ms).toISOString()}}:{})};
    this.saveVehicle(vehicle);
    if(logHistory)this.sql.exec('INSERT INTO pings VALUES(?,?,?,?)',ping.event_id,ping.vehicle_id,ping.recorded_at,JSON.stringify(ping));
   });
   for(const event of events){
    if(event.type==='call')continue;
    const message=event.type==='dispatched'?`${event.unit.callsign} dispatched to ${event.incident.label} (simulated)`
     :event.type==='arrived_scene'?`${event.unit.callsign} arrived at ${event.incident.label} (simulated)`
     :event.type==='transporting'?`${event.unit.callsign} transporting to ${event.incident.hospital.label} (simulated)`
     :event.type==='arrived_hospital'?`${event.unit.callsign} arrived at ${event.incident.hospital.label}; call closed (simulated)`
     :null;
    if(!message)continue;
    const alert:Alert={id:crypto.randomUUID(),vehicle_id:event.unit.id,kind:'arrival',created_at:new Date(nowMs).toISOString(),message,acknowledged_at:null};
    this.sql.exec('INSERT INTO alerts VALUES(?,?,?,?,?)',alert.id,alert.vehicle_id,alert.kind,1,JSON.stringify(alert));
   }
   // Simulated ops events double as the demo alert ticker; keep only the latest few.
   this.sql.exec("UPDATE alerts SET active=0 WHERE active=1 AND id NOT IN (SELECT id FROM alerts WHERE active=1 ORDER BY rowid DESC LIMIT 6) AND vehicle_id IN (SELECT id FROM vehicles WHERE json_extract(data,'$.source')='synthetic')");
   this.metaSet('sim_state',JSON.stringify(state));
   this.metaSet('demo_tick',String(tick));
  });
 }
 private refreshAlerts(vehicles:Vehicle[],now:number) {
  for(const v of vehicles){
   if(v.source==='stand_in'){this.sql.exec('UPDATE alerts SET active=0 WHERE vehicle_id=?',v.id);continue;}
   if(!v.stale)this.sql.exec("UPDATE alerts SET active=0 WHERE vehicle_id=? AND kind='stale'",v.id);
   // On timers, previous equals current: no invented arrival transition.
   for(const a of evaluateAlerts(v,v,this.rows<Alert>('SELECT data FROM alerts WHERE vehicle_id=?',v.id),now,()=>crypto.randomUUID()))
    this.sql.exec('INSERT INTO alerts VALUES(?,?,?,?,?)',a.id,v.id,a.kind,1,JSON.stringify(a));
  }
  return this.rows<Alert>("SELECT data FROM alerts WHERE active=1 AND json_extract(data,'$.acknowledged_at') IS NULL ORDER BY rowid DESC LIMIT 100");
 }
 private async snapshot(fleetId:string):Promise<FleetSnapshot> {
  const now=Date.now(); if(fleetId==='demo')await this.advanceDemo(now);
  const vehicles=this.vehicles().map(v=>({...deriveVehicle(v,now),source:v.source}));
  let incidents:Incident[]|undefined;
  if(fleetId==='demo'){const raw=this.metaGet('sim_state');incidents=raw?orderIncidents((JSON.parse(raw) as SimState).incidents.map(toPublicIncident)):[];}
  else if(fleetId!=='demo-standin')incidents=orderIncidents(this.rows<Incident>('SELECT data FROM incidents'));
  const routeError=fleetId==='demo'&&this.routeErrorAt&&now-this.routeErrorAt<600000?'Road routing unavailable; showing straight-line estimates':undefined;
  return {fleet_id:fleetId,mode:fleetId.startsWith('demo')?'demo':'live',server_time:new Date(now).toISOString(),vehicles,alerts:this.refreshAlerts(vehicles,now),...(incidents?{incidents}:{}),...(fleetId==='demo-standin'?{attribution:ATTRIBUTIONS.mbta,feed_error:this.feedError}:{}),...(routeError?{feed_error:routeError}:{})};
 }
 private expireSocket(ws:WebSocket){
  try{ws.send(JSON.stringify({type:'auth_expired'}));}catch{}
  try{ws.close(1008,'Authentication expired');}catch{}
 }
 private async broadcast(fleetId:string){const body=JSON.stringify({type:'snapshot',data:await this.snapshot(fleetId)});for(const ws of Array.from(this.sockets)){try{const attachment=this.attachments.get(ws) as {expiresAt?:number|null};if(attachment.expiresAt!=null&&attachment.expiresAt*1000<=Date.now()){this.expireSocket(ws);continue;}ws.send(body);}catch{ws.close(1011,'Stream unavailable');}}}
 private role(claims:Claims,allowed:string[]){if(!allowed.includes(claims.role))throw new ApiError(403,'ROLE','Role is not allowed');}
 private async body(request:Request){return await readJson(request,4096) as Record<string,unknown>;}
 /** Owner ops actions: one-time password setup and rate-limited, temporarily-locking password verification. Never reveals whether a fleet exists. */
 private async handleOpsAction(action:string,request:Request):Promise<Response>{
  if(action==='logout'){
   // Sign-out revokes every live stream for this fleet immediately; without this
   // a socket upgraded before logout would keep streaming until token expiry.
   this.metaSet('ws_revoked_before',String(Date.now()));
   for(const ws of Array.from(this.sockets))this.expireSocket(ws);
   return json({ok:true});
  }
  const payload=await this.body(request) as {password?:unknown};
  if(typeof payload.password!=='string')throw new ApiError(400,'PASSWORD','Password required');
  const now=Date.now();
  if(action==='setup'){
   if(this.metaGet('owner_hash'))throw new ApiError(404,'NOT_FOUND','Unknown endpoint');
   this.metaSet('owner_hash',await hashPassword(payload.password));
   return json({ok:true});
  }
  if(action!=='login')throw new ApiError(404,'NOT_FOUND','Unknown endpoint');
  this.loginLimiter.enforce('owner-login');
  const lockedUntil=Number(this.metaGet('owner_locked_until')||'0');
  if(lockedUntil>now)throw new ApiError(429,'RATE_LIMITED','Too many attempts',Math.ceil((lockedUntil-now)/1000));
  if(!await verifyPassword(payload.password,this.metaGet('owner_hash')??DUMMY_RECORD)){
   const fails=Number(this.metaGet('owner_fails')||'0')+1;
   if(fails>=5){this.metaSet('owner_locked_until',String(now+900000));this.metaSet('owner_fails','0');}else this.metaSet('owner_fails',String(fails));
   throw new ApiError(401,'INVALID_LOGIN','Invalid fleet or password');
  }
  this.metaSet('owner_fails','0');
  return json({ok:true});
 }
 private saveIncident(incident:Incident){this.sql.exec('INSERT OR REPLACE INTO incidents(id,data) VALUES (?,?)',incident.id,JSON.stringify(incident));}
 async fetch(request:Request):Promise<Response>{
  const url=new URL(request.url);const fleetId=request.headers.get('x-fleet-id')!;
  try{
   if(!validId(fleetId))throw new ApiError(403,'FLEET','Invalid fleet');
   const demo=fleetId==='demo'||fleetId==='demo-standin';
   const opsAction=request.headers.get('x-ops-action');
   if(opsAction){if(demo)throw new ApiError(403,'FLEET','Invalid fleet');return await this.handleOpsAction(opsAction,request);}
   const claims:Claims=demo?{sub:'demo',fleet_id:fleetId,role:'dispatcher',exp:0}:JSON.parse(request.headers.get('x-fleet-context')||'null');
   if(!claims || claims.fleet_id!==fleetId)throw new ApiError(403,'FLEET','Fleet mismatch');
   this.metaSet('fleet_id',fleetId);
   if(!demo){const action=url.pathname==='/api/pings'?'ping':request.method==='GET'?'read':'write';const limiter=action==='ping'?this.pingLimiter:action==='read'?this.readLimiter:this.writeLimiter;limiter.enforce(principalRateKey(claims,action));}
   if(request.method==='GET' && ['/api/fleet','/api/demo/fleet','/api/events','/api/demo/events'].includes(url.pathname)){
    this.role(claims,['dispatcher','bridge']);
    if(fleetId==='demo-standin')await this.refreshFeed();
    const events=url.pathname.endsWith('/events');
    if(events){
     this.role(claims,['dispatcher']);if(Array.from(this.sockets).length>=50)throw new ApiError(429,'CONNECTION_CAP','Stream capacity reached');
     if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')throw new ApiError(426,'UPGRADE','WebSocket upgrade required');
     const pair=new WebSocketPair();pair[1].accept();this.sockets.add(pair[1]);
     pair[1].addEventListener('close',()=>{this.sockets.delete(pair[1]);});
     pair[1].addEventListener('error',()=>{this.sockets.delete(pair[1]);});
     pair[1].addEventListener('message',()=>{pair[1].close(1008,'Read-only stream');});
     this.attachments.set(pair[1],{fleetId,expiresAt:demo?null:claims.exp});
     pair[1].send(JSON.stringify({type:'snapshot',data:await this.snapshot(fleetId)}));
     await this.ctx.storage.setAlarm(Date.now()+5000);
     if(!demo)setTimeout(()=>this.expireSocket(pair[1]),Math.max(1,claims.exp*1000-Date.now()));
     if(!this.heartbeat)this.heartbeat=setInterval(()=>{if(!Array.from(this.sockets).length){clearInterval(this.heartbeat);this.heartbeat=undefined;return;}void this.alarm();},5000);
     // Do not echo the JWT-bearing offered protocol.
     const offered=request.headers.get('Sec-WebSocket-Protocol')?.split(',').map(v=>v.trim())||[];
     return new Response(null,{status:101,webSocket:pair[0],headers:offered.includes('fleet.v1')?{'Sec-WebSocket-Protocol':'fleet.v1'}:{}});
    }
    return json(await this.snapshot(fleetId));
   }
   if(demo)throw new ApiError(405,'READ_ONLY','Demo is read-only');
   if(request.method==='POST' && url.pathname==='/api/vehicles'){
    const b=validateVehicleRegistration(await this.body(request));requireRegistrationAccess(claims,b.source);
    if(!validId(b.id)||typeof b.callsign!=='string'||!b.callsign.trim()||b.callsign.length>60||!['BLS','ALS'].includes(b.type as string)|| (b.source!==undefined && !['device','synthetic','stand_in'].includes(b.source as string)))throw new ApiError(400,'VEHICLE','Invalid vehicle');
    if(this.vehicles().length>=500)throw new ApiError(409,'FLEET_CAP','Pilot fleet limit is 500 vehicles');
    if(this.getVehicle(b.id))throw new ApiError(409,'EXISTS','Vehicle already exists');
    const v:Vehicle={id:b.id,callsign:b.callsign.trim(),type:b.type as Vehicle['type'],source:(b.source as Vehicle['source'])||'device',status:'available',destination:null,latest_ping:null,stale:true,eta:null,incident_id:null};this.saveVehicle(v);await this.broadcast(fleetId);return json(deriveVehicle(v,Date.now()),201);
   }
   if(request.method==='POST'&&url.pathname==='/api/incidents'){
    this.role(claims,['dispatcher']);
    const b=await this.body(request);rejectUnknownKeys(b,['label','lat','lon','priority']);
    const label=typeof b.label==='string'?b.label.trim():'';
    if(!label||label.length>120||typeof b.lat!=='number'||typeof b.lon!=='number'||!Number.isFinite(b.lat)||!Number.isFinite(b.lon)||Math.abs(b.lat)>90||Math.abs(b.lon)>180||![1,2,3].includes(b.priority as number))throw new ApiError(400,'INCIDENT','Invalid incident');
    const incident:Incident={id:crypto.randomUUID(),label,lat:b.lat,lon:b.lon,priority:b.priority as 1|2|3,status:'open',created_at:new Date().toISOString(),assigned_at:null,closed_at:null,vehicle_id:null,hospital_label:null};
    this.saveIncident(incident);await this.broadcast(fleetId);return json(incident,201);
   }
   const incMatch=url.pathname.match(/^\/api\/incidents\/([a-f0-9-]{36})\/(assign|close)$/);
   if(incMatch&&request.method==='POST'){
    this.role(claims,['dispatcher']);
    const incident=this.rows<Incident>('SELECT data FROM incidents WHERE id=?',incMatch[1])[0];
    if(!incident)throw new ApiError(404,'INCIDENT','Incident not found');
    if(incMatch[2]==='close'){
     if(incident.status!=='closed'){
      incident.status='closed';incident.closed_at=new Date().toISOString();
      const unit=incident.vehicle_id?this.getVehicle(incident.vehicle_id):undefined;
      if(unit&&unit.incident_id===incident.id){unit.incident_id=null;unit.status='available';unit.destination=null;this.saveVehicle(unit);}
      this.saveIncident(incident);await this.broadcast(fleetId);
     }
     return json(incident);
    }
    const b=await this.body(request);rejectUnknownKeys(b,['vehicle_id']);
    if(!validId(b.vehicle_id))throw new ApiError(400,'VEHICLE','Invalid vehicle');
    if(incident.status==='closed')throw new ApiError(409,'CLOSED','Incident is closed');
    const unit=this.getVehicle(b.vehicle_id);if(!unit)throw new ApiError(404,'VEHICLE','Vehicle not found');
    if(unit.status!=='available'&&unit.id!==incident.vehicle_id)throw new ApiError(409,'BUSY','Vehicle is not available');
    if(incident.vehicle_id&&incident.vehicle_id!==unit.id){const prev=this.getVehicle(incident.vehicle_id);if(prev&&prev.incident_id===incident.id){prev.incident_id=null;prev.status='available';prev.destination=null;this.saveVehicle(prev);}}
    incident.vehicle_id=unit.id;incident.status='assigned';incident.assigned_at=new Date().toISOString();
    unit.incident_id=incident.id;unit.status='en_route';unit.destination={label:incident.label,lat:incident.lat,lon:incident.lon};
    this.saveVehicle(unit);this.saveIncident(incident);await this.broadcast(fleetId);return json(incident);
   }
   const match=url.pathname.match(/^\/api\/vehicles\/([a-zA-Z0-9_-]{1,80})(\/history)?$/);
   if(match){
    this.role(claims,['dispatcher']);const v=this.getVehicle(match[1]);if(!v)throw new ApiError(404,'VEHICLE','Vehicle not found');
    if(request.method==='GET' && match[2]){const raw=url.searchParams.get('limit')||'100';const limit=Number(raw);if(!/^\d+$/.test(raw)||!Number.isInteger(limit)||limit<1||limit>500)throw new ApiError(400,'LIMIT','Limit must be 1..500');return json({pings:this.rows<Ping>('SELECT data FROM pings WHERE vehicle_id=? ORDER BY recorded_at DESC,rowid DESC LIMIT ?',v.id,limit).map(p=>p.telemetry_time?p:{...p,telemetry_time:'receipt',recorded_at:p.received_at})});}
    if(request.method==='PATCH'&&!match[2]){
     const previous=structuredClone(v);const b=validateVehiclePatch(await this.body(request));if(!Object.keys(b).length||Object.keys(b).some(k=>!['status','destination'].includes(k)))throw new ApiError(400,'PATCH','Invalid fields');
     if(b.status!==undefined){if(!statuses.includes(b.status as OperationalStatus))throw new ApiError(400,'STATUS','Invalid operational status');v.status=b.status as OperationalStatus;}
     if(b.destination!==undefined){if(b.destination===null)v.destination=null;else {const d=b.destination as Destination;if(!d||typeof d.label!=='string'||!d.label.trim()||d.label.length>120||!Number.isFinite(d.lat)||!Number.isFinite(d.lon)||Math.abs(d.lat)>90||Math.abs(d.lon)>180)throw new ApiError(400,'DESTINATION','Invalid destination');v.destination={label:d.label.trim(),lat:d.lat,lon:d.lon};}}
     if(v.incident_id){
      const linked=this.rows<Incident>('SELECT data FROM incidents WHERE id=?',v.incident_id)[0];
      if(linked&&linked.status!=='closed'){
       if(v.status==='at_scene'&&linked.status==='assigned')linked.status='on_scene';
       else if(v.status==='transporting'&&(linked.status==='assigned'||linked.status==='on_scene'))linked.status='transporting';
       else if(v.status==='at_hospital'||v.status==='available'){linked.status='closed';linked.closed_at=new Date().toISOString();v.incident_id=null;}
       this.saveIncident(linked);
      }else if(linked&&linked.status==='closed')v.incident_id=null;
     }
     this.saveVehicle(v);for(const a of (v.source==='stand_in'?[]:evaluateAlerts(v,previous,this.rows<Alert>('SELECT data FROM alerts WHERE vehicle_id=?',v.id),Date.now(),()=>crypto.randomUUID())))this.sql.exec('INSERT INTO alerts VALUES(?,?,?,?,?)',a.id,v.id,a.kind,1,JSON.stringify(a));await this.broadcast(fleetId);return json(deriveVehicle(v,Date.now()));
    }
   }
   if(request.method==='POST'&&url.pathname==='/api/pings'){
    this.role(claims,['crew','bridge']);let p:PingInput;try{const body=await this.body(request);rejectUnknownKeys(body,['event_id','vehicle_id','recorded_at','lat','lon','speed_kph','heading','telemetry_time']);p=validatePing(body);}catch(error){if(error instanceof ApiError)throw error;throw new ApiError(400,'PING','Invalid ping');}
    if(claims.role==='crew'&&claims.vehicle_id!==p.vehicle_id)throw new ApiError(403,'VEHICLE_SCOPE','Vehicle not permitted');
    const v=this.getVehicle(p.vehicle_id);if(!v)throw new ApiError(404,'VEHICLE','Vehicle not found');
    const existing=this.rows<Ping>('SELECT data FROM pings WHERE event_id=?',p.event_id)[0];
    if(existing){const compare=(p:PingInput)=>JSON.stringify([p.event_id,p.vehicle_id,p.telemetry_time==='receipt'?null:p.recorded_at,p.lat,p.lon,p.speed_kph,p.heading,p.telemetry_time||'receipt']);const {received_at,...original}=existing;if(compare(original)!==compare(p))throw new ApiError(409,'EVENT_CONFLICT','Event ID belongs to a different ping');if(v.source==='stand_in'){v.last_seen=new Date().toISOString();this.saveVehicle(v);await this.broadcast(fleetId);}return json({accepted:true,duplicate:true,event_id:p.event_id});}
    const previous=structuredClone(v);
    const stored:Ping={...p,telemetry_time:p.telemetry_time??'receipt',received_at:new Date().toISOString()};if(v.source==='stand_in')v.last_seen=stored.received_at;
    this.ctx.storage.transactionSync(()=>{if(v.source==='stand_in')this.saveVehicle(v);this.sql.exec('INSERT INTO pings VALUES(?,?,?,?)',stored.event_id,stored.vehicle_id,stored.recorded_at,JSON.stringify(stored));if(isNewer(v.latest_ping,stored)){v.latest_ping=stored;this.saveVehicle(v);for(const a of (v.source==='stand_in'?[]:evaluateAlerts(v,previous,this.rows<Alert>('SELECT data FROM alerts'),Date.now(),()=>crypto.randomUUID()))){this.sql.exec('INSERT INTO alerts VALUES(?,?,?,?,?)',a.id,v.id,a.kind,1,JSON.stringify(a));}}});
    await this.broadcast(fleetId);await this.ctx.storage.setAlarm(Date.now()+5000);return json({accepted:true,duplicate:false,event_id:p.event_id},201);
   }
   const ack=url.pathname.match(/^\/api\/alerts\/([a-f0-9-]{36})\/ack$/);
   if(ack&&request.method==='POST'){this.role(claims,['dispatcher']);const a=this.rows<Alert>('SELECT data FROM alerts WHERE id=?',ack[1])[0];if(!a)throw new ApiError(404,'ALERT','Alert not found');a.acknowledged_at??=new Date().toISOString();this.sql.exec('UPDATE alerts SET data=? WHERE id=?',JSON.stringify(a),a.id);await this.broadcast(fleetId);return json({acknowledged:true});}
   throw new ApiError(404,'NOT_FOUND','Unknown endpoint');
  }catch(error){if(error instanceof ApiError)return apiErrorResponse(error);console.error('fleet object request failed');return json({error:{code:'INTERNAL',message:'Request could not be completed'}},500);}
 }
 async alarm(){
  const sockets=Array.from(this.sockets);let fleetId:string|undefined;
  for(const ws of sockets){const a=this.attachments.get(ws) as {fleetId:string;expiresAt:number|null};fleetId=a.fleetId;if(a.expiresAt!==null && (!a.expiresAt || a.expiresAt*1000<=Date.now()))this.expireSocket(ws);}
  if(!fleetId){const row=this.metaGet('fleet_id');fleetId=row;}
  if(fleetId==='demo-standin')await this.refreshFeed();
  if(fleetId)await this.broadcast(fleetId);
  this.sql.exec('DELETE FROM pings WHERE recorded_at<?',new Date(Date.now()-7*86400000).toISOString());
  this.sql.exec("UPDATE alerts SET active=0 WHERE active=1 AND json_extract(data,'$.acknowledged_at') IS NOT NULL");
  if(Array.from(this.sockets).length)await this.ctx.storage.setAlarm(Date.now()+5000);
 }
 webSocketMessage(ws:WebSocket,_message:string|ArrayBuffer){ws.close(1008,'Read-only stream');}
 webSocketClose(ws:WebSocket,code:number){ws.close(code===1005||code===1006||code===1015?1000:code);}
}
