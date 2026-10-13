// UI-local mirror of the Fleet v1 interface. No imported upstream implementation.
export interface PingInput {event_id:string;vehicle_id:string;recorded_at:string;lat:number;lon:number;speed_kph:number|null;heading:number|null;telemetry_time:'device'|'receipt'}
export interface Ping extends PingInput {received_at:string}
export type Status='available'|'en_route'|'at_scene'|'transporting'|'at_hospital'|'offline';
export interface Vehicle {id:string;callsign:string;type:'BLS'|'ALS';status:Status;destination:{label:string;lat:number;lon:number}|null;latest_ping:Ping|null;stale:boolean;eta:{minutes:number;method:'straight_line';approximate:true}|null;source:'device'|'synthetic'|'stand_in'}
export interface Alert {id:string;vehicle_id:string;kind:'stale'|'arrival';created_at:string;message:string;acknowledged_at:string|null}
export interface FleetSnapshot {fleet_id:string;mode:'demo'|'live';server_time:string;vehicles:Vehicle[];alerts:Alert[];attribution?:{label:string;source:string;url:string};feed_error?:string}
export type Mode='demo'|'live';
const obj=(v:unknown):v is Record<string,unknown>=>!!v && typeof v==='object';
const iso=(v:unknown)=>typeof v==='string' && Number.isFinite(Date.parse(v));
const coordinate=(v:unknown,min:number,max:number)=>typeof v==='number' && Number.isFinite(v) && v>=min && v<=max;
export function isPing(v:unknown):v is Ping {return obj(v)&&typeof v.event_id==='string'&&typeof v.vehicle_id==='string'&&iso(v.recorded_at)&&iso(v.received_at)&&coordinate(v.lat,-90,90)&&coordinate(v.lon,-180,180)&&(v.speed_kph===null||coordinate(v.speed_kph,0,200))&&(v.heading===null||coordinate(v.heading,0,359.999999999))&&['device','receipt'].includes(String(v.telemetry_time));}
export function isSnapshot(v:unknown):v is FleetSnapshot {
 if(!obj(v)||typeof v.fleet_id!=='string'||!['demo','live'].includes(String(v.mode))||!iso(v.server_time)||!Array.isArray(v.vehicles)||!Array.isArray(v.alerts))return false;
 return v.vehicles.every(x=>obj(x)&&typeof x.id==='string'&&typeof x.callsign==='string'&&['BLS','ALS'].includes(String(x.type))&&['available','en_route','at_scene','transporting','at_hospital','offline'].includes(String(x.status))&&typeof x.stale==='boolean'&&(x.latest_ping===null||isPing(x.latest_ping))&&(x.destination===null||(obj(x.destination)&&typeof x.destination.label==='string'&&coordinate(x.destination.lat,-90,90)&&coordinate(x.destination.lon,-180,180)))&&(x.eta===null||(obj(x.eta)&&coordinate(x.eta.minutes,0,Number.MAX_VALUE)&&x.eta.method==='straight_line'&&x.eta.approximate===true))&&(['device','synthetic','stand_in'].includes(String(x.source))))&&v.alerts.every(x=>obj(x)&&typeof x.id==='string'&&typeof x.vehicle_id==='string'&&['stale','arrival'].includes(String(x.kind))&&iso(x.created_at)&&typeof x.message==='string'&&(x.acknowledged_at===null||iso(x.acknowledged_at)));
}
export const statusLabel=(status:Status)=>status.replaceAll('_',' ');
export function sourceLabel(vehicle:Vehicle,mode:Mode){return vehicle.source==='stand_in'?'Live stand-in (MBTA bus)':vehicle.source==='synthetic'||mode==='demo'?'Synthetic': 'Live vehicle';}

// Validate the envelope while isolating invalid vehicle records. Never manufacture telemetry.
export function parseSnapshot(value:unknown):FleetSnapshot {
 if(!obj(value)||!Array.isArray(value.vehicles))throw new Error('Invalid fleet snapshot');
 const vehicles=value.vehicles.filter(vehicle=>isSnapshot({...value,vehicles:[vehicle],alerts:[]}));
 const result={...value,vehicles};
 if(!isSnapshot(result))throw new Error('Invalid fleet snapshot');
 return result;
}
export function vehicleIsStale(vehicle:Vehicle,snapshot:FleetSnapshot,elapsedMs:number):boolean {
 return vehicle.stale||!vehicle.latest_ping||Date.parse(snapshot.server_time)-Date.parse(vehicle.latest_ping.recorded_at)+Math.max(0,elapsedMs)>30000;
}
