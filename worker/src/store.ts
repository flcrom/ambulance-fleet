import { fetchFeed,fetchBusRoutes,ATTRIBUTIONS } from './feeds/index';
import { DurableObject } from 'cloudflare:workers';
import { ApiError, apiErrorResponse, RateLimiter, principalRateKey, requireRegistrationAccess, validateVehicleRegistration, validateVehiclePatch, rejectUnknownKeys, readJson } from './auth/index';
import type { Claims } from './auth/index';
import { validatePing, deriveVehicle, arrival, evaluateAlerts, isNewer } from './rules/index';
import type { Vehicle, Ping, PingInput, Alert, FleetSnapshot, Destination, OperationalStatus } from '../../shared/types';
import { json, type Env } from './index';
const statuses: OperationalStatus[] = ['available','en_route','at_scene','transporting','at_hospital'];
const validId = (v:unknown):v is string => typeof v==='string' && /^[a-zA-Z0-9_-]{1,80}$/.test(v);
export class FleetStore extends DurableObject<Env> {
 private sockets=new Set<WebSocket>();
 private attachments=new WeakMap<WebSocket,{fleetId:string;expiresAt:number|null}>();
 private heartbeat:ReturnType<typeof setInterval>|undefined;
 private sql: SqlStorage; private feedError:string|undefined; private busRoutes:Set<string>|undefined; private feedLastAttempt=0;
 private pingLimiter=new RateLimiter(60,1); private readLimiter=new RateLimiter(100,2); private writeLimiter=new RateLimiter(30,.5);
 constructor(ctx: DurableObjectState, env: Env) {
  super(ctx,env); this.sql=ctx.storage.sql;
  this.sql.exec(`CREATE TABLE IF NOT EXISTS vehicles(id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS pings(event_id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL, recorded_at TEXT NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS ping_history ON pings(vehicle_id,recorded_at DESC); CREATE TABLE IF NOT EXISTS alerts(id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL, kind TEXT NOT NULL, active INTEGER NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
 }
 private rows<T>(query:string,...args:(string|number)[]):T[] { return this.sql.exec(query,...args).toArray().map(row=>JSON.parse(row.data as string) as T); }
 private vehicles(){return this.rows<Vehicle>('SELECT data FROM vehicles ORDER BY id');}
 private saveVehicle(vehicle:Vehicle){this.sql.exec('INSERT OR REPLACE INTO vehicles(id,data) VALUES (?,?)',vehicle.id,JSON.stringify(vehicle));}
 private getVehicle(id:string){return this.rows<Vehicle>('SELECT data FROM vehicles WHERE id=?',id)[0];}
 private async refreshFeed(){
  const now=Date.now();if(now-this.feedLastAttempt<15000)return;this.feedLastAttempt=now;
  try{
   this.busRoutes??=await fetchBusRoutes();const samples=await fetchFeed({provider:'mbta',busRoutes:this.busRoutes});
   if(!samples.length)throw Error('No valid feed positions');
   this.ctx.storage.transactionSync(()=>{for(const sample of samples){const existing=this.getVehicle(sample.vehicle.id);const incoming:Ping={...sample.ping,received_at:new Date(now).toISOString()};const immutable=this.rows<Ping>('SELECT data FROM pings WHERE event_id=?',incoming.event_id)[0];const p=immutable||incoming;const v:Vehicle=existing||{...sample.vehicle,status:'available',destination:null,latest_ping:null,stale:true,eta:null};v.last_seen=new Date(now).toISOString();if(!immutable&&isNewer(v.latest_ping,p))v.latest_ping=p;this.saveVehicle(v);if(!immutable)this.sql.exec('INSERT INTO pings VALUES(?,?,?,?)',p.event_id,p.vehicle_id,p.recorded_at,JSON.stringify(p));}});
   this.feedError=undefined;
  }catch(error){console.error('stand-in feed fetch unavailable',error instanceof Error?error.message:'unknown');this.feedError='Live stand-in feed unavailable; previous positions may be stale';}
 }
 private ensureDemo(now:number) {
  const previous = this.sql.exec('SELECT value FROM meta WHERE key=?','demo_tick').toArray()[0];
  const tick=Math.floor(now/5000); if(previous && Number(previous.value)===tick)return;
  const bases=[[12.969,77.591],[12.949,77.606],[12.984,77.615]];
  this.ctx.storage.transactionSync(()=>{
   bases.forEach((base,i)=>{
    const angle=(tick%720)/720*2*Math.PI + i*2;
    const id=`AMB-0${i+1}`;
    const ping:Ping={event_id:crypto.randomUUID(),vehicle_id:id,recorded_at:new Date(tick*5000).toISOString(),received_at:new Date(now).toISOString(),lat:base[0]+Math.sin(angle)*.008,lon:base[1]+Math.cos(angle)*.008,speed_kph:i===1?0:32+i*4,heading:((angle*180/Math.PI)+90)%360,telemetry_time:'receipt'};
    const vehicle:Vehicle={id,callsign:id,type:i===0?'ALS':'BLS',source:'synthetic',status:i===1?'at_scene':i===0?'transporting':'available',destination:i===0?{label:'Receiving hospital (simulated)',lat:12.976,lon:77.599}:null,latest_ping:ping,stale:false,eta:null};
    this.saveVehicle(vehicle); this.sql.exec('INSERT INTO pings VALUES(?,?,?,?)',ping.event_id,id,ping.recorded_at,JSON.stringify(ping));
   });
   this.sql.exec('INSERT OR REPLACE INTO meta VALUES(?,?)','demo_tick',String(tick));
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
 private snapshot(fleetId:string):FleetSnapshot {
  const now=Date.now(); if(fleetId==='demo')this.ensureDemo(now);
  const vehicles=this.vehicles().map(v=>({...deriveVehicle(v,now),source:v.source}));
  return {fleet_id:fleetId,mode:fleetId.startsWith('demo')?'demo':'live',server_time:new Date(now).toISOString(),vehicles,alerts:this.refreshAlerts(vehicles,now),...(fleetId==='demo-standin'?{attribution:ATTRIBUTIONS.mbta,feed_error:this.feedError}: {})};
 }
 private expireSocket(ws:WebSocket){
  try{ws.send(JSON.stringify({type:'auth_expired'}));}catch{}
  try{ws.close(1008,'Authentication expired');}catch{}
 }
 private broadcast(fleetId:string){const body=JSON.stringify({type:'snapshot',data:this.snapshot(fleetId)});for(const ws of Array.from(this.sockets)){try{const attachment=this.attachments.get(ws) as {expiresAt?:number|null};if(attachment.expiresAt!=null&&attachment.expiresAt*1000<=Date.now()){this.expireSocket(ws);continue;}ws.send(body);}catch{ws.close(1011,'Stream unavailable');}}}
 private role(claims:Claims,allowed:string[]){if(!allowed.includes(claims.role))throw new ApiError(403,'ROLE','Role is not allowed');}
 private async body(request:Request){return await readJson(request,4096) as Record<string,unknown>;}
 async fetch(request:Request):Promise<Response>{
  const url=new URL(request.url);const fleetId=request.headers.get('x-fleet-id')!;
  try{
   if(!validId(fleetId))throw new ApiError(403,'FLEET','Invalid fleet');
   const demo=fleetId==='demo'||fleetId==='demo-standin';const claims:Claims=demo?{sub:'demo',fleet_id:fleetId,role:'dispatcher',exp:0}:JSON.parse(request.headers.get('x-fleet-context')||'null');
   if(!claims || claims.fleet_id!==fleetId)throw new ApiError(403,'FLEET','Fleet mismatch');
   this.sql.exec('INSERT OR REPLACE INTO meta VALUES(?,?)','fleet_id',fleetId);
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
     pair[1].send(JSON.stringify({type:'snapshot',data:this.snapshot(fleetId)}));
     await this.ctx.storage.setAlarm(Date.now()+5000);
     if(!demo)setTimeout(()=>this.expireSocket(pair[1]),Math.max(1,claims.exp*1000-Date.now()));
     if(!this.heartbeat)this.heartbeat=setInterval(()=>{if(!Array.from(this.sockets).length){clearInterval(this.heartbeat);this.heartbeat=undefined;return;}void this.alarm();},5000);
     // Do not echo the JWT-bearing offered protocol.
     const offered=request.headers.get('Sec-WebSocket-Protocol')?.split(',').map(v=>v.trim())||[];
     return new Response(null,{status:101,webSocket:pair[0],headers:offered.includes('fleet.v1')?{'Sec-WebSocket-Protocol':'fleet.v1'}:{}});
    }
    return json(this.snapshot(fleetId));
   }
   if(demo)throw new ApiError(405,'READ_ONLY','Demo is read-only');
   if(request.method==='POST' && url.pathname==='/api/vehicles'){
    const b=validateVehicleRegistration(await this.body(request));requireRegistrationAccess(claims,b.source);
    if(!validId(b.id)||typeof b.callsign!=='string'||!b.callsign.trim()||b.callsign.length>60||!['BLS','ALS'].includes(b.type as string)|| (b.source!==undefined && !['device','synthetic','stand_in'].includes(b.source as string)))throw new ApiError(400,'VEHICLE','Invalid vehicle');
    if(this.vehicles().length>=500)throw new ApiError(409,'FLEET_CAP','Pilot fleet limit is 500 vehicles');
    if(this.getVehicle(b.id))throw new ApiError(409,'EXISTS','Vehicle already exists');
    const v:Vehicle={id:b.id,callsign:b.callsign.trim(),type:b.type as Vehicle['type'],source:(b.source as Vehicle['source'])||'device',status:'available',destination:null,latest_ping:null,stale:true,eta:null};this.saveVehicle(v);this.broadcast(fleetId);return json(deriveVehicle(v,Date.now()),201);
   }
   const match=url.pathname.match(/^\/api\/vehicles\/([a-zA-Z0-9_-]{1,80})(\/history)?$/);
   if(match){
    this.role(claims,['dispatcher']);const v=this.getVehicle(match[1]);if(!v)throw new ApiError(404,'VEHICLE','Vehicle not found');
    if(request.method==='GET' && match[2]){const raw=url.searchParams.get('limit')||'100';const limit=Number(raw);if(!/^\d+$/.test(raw)||!Number.isInteger(limit)||limit<1||limit>500)throw new ApiError(400,'LIMIT','Limit must be 1..500');return json({pings:this.rows<Ping>('SELECT data FROM pings WHERE vehicle_id=? ORDER BY recorded_at DESC,rowid DESC LIMIT ?',v.id,limit)});}
    if(request.method==='PATCH'&&!match[2]){
     const previous=structuredClone(v);const b=validateVehiclePatch(await this.body(request));if(!Object.keys(b).length||Object.keys(b).some(k=>!['status','destination'].includes(k)))throw new ApiError(400,'PATCH','Invalid fields');
     if(b.status!==undefined){if(!statuses.includes(b.status as OperationalStatus))throw new ApiError(400,'STATUS','Invalid operational status');v.status=b.status as OperationalStatus;}
     if(b.destination!==undefined){if(b.destination===null)v.destination=null;else {const d=b.destination as Destination;if(!d||typeof d.label!=='string'||!d.label.trim()||d.label.length>120||!Number.isFinite(d.lat)||!Number.isFinite(d.lon)||Math.abs(d.lat)>90||Math.abs(d.lon)>180)throw new ApiError(400,'DESTINATION','Invalid destination');v.destination={label:d.label.trim(),lat:d.lat,lon:d.lon};}}
     this.saveVehicle(v);for(const a of (v.source==='stand_in'?[]:evaluateAlerts(v,previous,this.rows<Alert>('SELECT data FROM alerts WHERE vehicle_id=?',v.id),Date.now(),()=>crypto.randomUUID())))this.sql.exec('INSERT INTO alerts VALUES(?,?,?,?,?)',a.id,v.id,a.kind,1,JSON.stringify(a));this.broadcast(fleetId);return json(deriveVehicle(v,Date.now()));
    }
   }
   if(request.method==='POST'&&url.pathname==='/api/pings'){
    this.role(claims,['crew','bridge']);let p:PingInput;try{const body=await this.body(request);rejectUnknownKeys(body,['event_id','vehicle_id','recorded_at','lat','lon','speed_kph','heading','telemetry_time']);p=validatePing(body);}catch(error){if(error instanceof ApiError)throw error;throw new ApiError(400,'PING','Invalid ping');}
    if(claims.role==='crew'&&claims.vehicle_id!==p.vehicle_id)throw new ApiError(403,'VEHICLE_SCOPE','Vehicle not permitted');
    const v=this.getVehicle(p.vehicle_id);if(!v)throw new ApiError(404,'VEHICLE','Vehicle not found');
    const existing=this.rows<Ping>('SELECT data FROM pings WHERE event_id=?',p.event_id)[0];
    if(existing){const compare=(p:PingInput)=>JSON.stringify([p.event_id,p.vehicle_id,p.telemetry_time==='receipt'?null:p.recorded_at,p.lat,p.lon,p.speed_kph,p.heading,p.telemetry_time||'device']);const {received_at,...original}=existing;if(compare(original)!==compare(p))throw new ApiError(409,'EVENT_CONFLICT','Event ID belongs to a different ping');if(v.source==='stand_in'){v.last_seen=new Date().toISOString();this.saveVehicle(v);this.broadcast(fleetId);}return json({accepted:true,duplicate:true,event_id:p.event_id});}
    const previous=structuredClone(v);
    const stored:Ping={...p,received_at:new Date().toISOString()};if(v.source==='stand_in')v.last_seen=stored.received_at;
    this.ctx.storage.transactionSync(()=>{if(v.source==='stand_in')this.saveVehicle(v);this.sql.exec('INSERT INTO pings VALUES(?,?,?,?)',stored.event_id,stored.vehicle_id,stored.recorded_at,JSON.stringify(stored));if(isNewer(v.latest_ping,stored)){v.latest_ping=stored;this.saveVehicle(v);for(const a of (v.source==='stand_in'?[]:evaluateAlerts(v,previous,this.rows<Alert>('SELECT data FROM alerts'),Date.now(),()=>crypto.randomUUID()))){this.sql.exec('INSERT INTO alerts VALUES(?,?,?,?,?)',a.id,v.id,a.kind,1,JSON.stringify(a));}}});
    this.broadcast(fleetId);await this.ctx.storage.setAlarm(Date.now()+5000);return json({accepted:true,duplicate:false,event_id:p.event_id},201);
   }
   const ack=url.pathname.match(/^\/api\/alerts\/([a-f0-9-]{36})\/ack$/);
   if(ack&&request.method==='POST'){this.role(claims,['dispatcher']);const a=this.rows<Alert>('SELECT data FROM alerts WHERE id=?',ack[1])[0];if(!a)throw new ApiError(404,'ALERT','Alert not found');a.acknowledged_at??=new Date().toISOString();this.sql.exec('UPDATE alerts SET data=? WHERE id=?',JSON.stringify(a),a.id);this.broadcast(fleetId);return json({acknowledged:true});}
   throw new ApiError(404,'NOT_FOUND','Unknown endpoint');
  }catch(error){if(error instanceof ApiError)return apiErrorResponse(error);console.error('fleet object request failed');return json({error:{code:'INTERNAL',message:'Request could not be completed'}},500);}
 }
 async alarm(){
  const sockets=Array.from(this.sockets);let fleetId:string|undefined;
  for(const ws of sockets){const a=this.attachments.get(ws) as {fleetId:string;expiresAt:number|null};fleetId=a.fleetId;if(a.expiresAt!==null && (!a.expiresAt || a.expiresAt*1000<=Date.now()))this.expireSocket(ws);}
  if(!fleetId){const row=this.sql.exec('SELECT value FROM meta WHERE key=?','fleet_id').toArray()[0];fleetId=row?.value as string|undefined;}
  if(fleetId==='demo-standin')await this.refreshFeed();
  if(fleetId)this.broadcast(fleetId);
  this.sql.exec('DELETE FROM pings WHERE recorded_at<?',new Date(Date.now()-7*86400000).toISOString());
  if(Array.from(this.sockets).length)await this.ctx.storage.setAlarm(Date.now()+5000);
 }
 webSocketMessage(ws:WebSocket,_message:string|ArrayBuffer){ws.close(1008,'Read-only stream');}
 webSocketClose(ws:WebSocket,code:number){ws.close(code===1005||code===1006||code===1015?1000:code);}
}
