import {assertPing,stableUuid,type FeedSample} from './core';
import {fields,scan,sub,text,number,float} from './protobuf';
export const MBTA_URL='https://cdn.mbta.com/realtime/VehiclePositions.pb';
export const MBTA_BUS_ROUTES_URL='https://api-v3.mbta.com/routes?filter%5Btype%5D=3';
export const DIGITRAFFIC_URL='https://rata.digitraffic.fi/api/v1/trains/gtfs-rt-locations';
export const ATTRIBUTIONS={mbta:{label:'live stand-in vehicles (MBTA buses), not ambulances',source:'MBTA / MassDOT',url:'https://www.mbta.com/developers/gtfs-realtime'},digitraffic:{label:'live stand-in vehicles (Digitraffic trains), not ambulances',source:'Fintraffic / digitraffic.fi',license:'CC BY 4.0',url:'https://www.digitraffic.fi/en/terms-of-service/',licenseUrl:'https://creativecommons.org/licenses/by/4.0/',changes:'Locations mapped to fleet ping schema; no clinical meaning.'}};
export const BOSTON_CENTRE={lat:42.3601,lon:-71.0589};
export interface PositionState {signature:string;eventId:string;transition:number;seenAt:number}
export type PositionTracker=Map<string,PositionState>;
const defaultTracker:PositionTracker=new Map();
export interface FeedStats {busPositions:number;missingMotion:number;selected:number}
export interface FeedOptions {provider:'mbta'|'digitraffic'; nowMs?:number; maxVehicles?:number; busRoutes?:ReadonlySet<string>; centre?:{lat:number;lon:number};radiusKm?:number;stats?:FeedStats;tracker?:PositionTracker}
export function distanceKm(a:{lat:number;lon:number},b:{lat:number;lon:number}):number {const rad=Math.PI/180,dlat=(b.lat-a.lat)*rad,dlon=(b.lon-a.lon)*rad;const h=Math.sin(dlat/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dlon/2)**2;return 6371*2*Math.atan2(Math.sqrt(h),Math.sqrt(Math.max(0,1-h)));}
export async function parseVehiclePositions(bytes:Uint8Array, options:FeedOptions):Promise<FeedSample[]> {
  if (bytes.length>8*1024*1024) throw new Error('Feed too large');
  if(options.provider==='mbta'&&!options.busRoutes?.size) throw new Error('MBTA bus route allowlist required to exclude rail');
  const max=options.maxVehicles??100;if(!Number.isInteger(max)||max<1||max>100)throw new Error('maxVehicles must be 1..100');
  const centre=options.centre??(options.provider==='mbta'?BOSTON_CENTRE:undefined),radius=options.radiusKm??(options.provider==='mbta'?25:Infinity);
  if(centre&&(!Number.isFinite(centre.lat)||!Number.isFinite(centre.lon)||Math.abs(centre.lat)>90||Math.abs(centre.lon)>180))throw new Error('Invalid centre');
  if(!(radius>0)||(!Number.isFinite(radius)&&radius!==Infinity))throw new Error('Invalid radius');
  const now=options.nowMs??Date.now(),budget={remaining:30000};
  let headerTime:number|undefined,version='';
  for(const f of scan(bytes,budget,new Set([1]))){if(f.wire!==2)continue;const h=fields(f.value as Uint8Array,budget,new Set([1,3]));version=text(h,1)||version;headerTime=number(h,3)??headerTime;}
  if(!['1.0','2.0'].includes(version)||headerTime===undefined||!Number.isSafeInteger(headerTime)||headerTime*1000>now+60000||headerTime*1000<now-60000)throw new Error('Missing, invalid or stale feed header');
  const rows:FeedSample[]=[],ids=new Set<string>();if(options.stats)Object.assign(options.stats,{busPositions:0,missingMotion:0,selected:0});
  for(const field of scan(bytes,budget,new Set([2]))) {
    if(field.wire!==2)continue;
    const entity=fields(field.value as Uint8Array,budget,new Set([1,2,4]));if(!text(entity,1))throw new Error('Missing entity id');if(number(entity,2)===1)continue;
    const vehicle=sub(entity,4,budget,new Set([1,2,5,8])),pos=sub(vehicle,2,budget,new Set([1,2,3,5]));if(!pos.length)continue;
    if(options.provider==='mbta'&&!options.busRoutes!.has(text(sub(vehicle,1,budget,new Set([5])),5)))continue;
    if(options.stats)options.stats.busPositions++;
    const rawId=text(sub(vehicle,8,budget,new Set([1])),1)||text(entity,1);if(!rawId)continue;
    const id=`${options.provider}-${encodeURIComponent(rawId)}`;if(ids.has(id))continue;
    const stamp=number(vehicle,5),hasDevice=stamp!==undefined&&stamp>0;
    if(hasDevice && (!Number.isSafeInteger(stamp)||stamp!*1000>now+60000||stamp!*1000<now-86400000))continue;
    if(float(pos,3)===undefined||float(pos,5)===undefined){if(options.stats)options.stats.missingMotion++;}
    const tracker=options.tracker??defaultTracker,key=`${options.provider}:${rawId}`;
    const signature=JSON.stringify([float(pos,1),float(pos,2),float(pos,3),float(pos,5)]),previous=tracker.get(key);
    const sourceTime=(hasDevice?stamp!:headerTime!)*1000;
    const transition=previous?.signature===signature?previous.transition:Math.max(sourceTime,(previous?.transition??0)+1);
    const eventId=previous?.signature===signature?previous.eventId:await stableUuid(['gtfs-transition-v3',options.provider,rawId,signature,hasDevice?stamp:headerTime,transition]);
    const p={event_id:eventId,vehicle_id:id,recorded_at:new Date(hasDevice?stamp!*1000:now).toISOString(),lat:float(pos,1)??NaN,lon:float(pos,2)??NaN,speed_kph:float(pos,5)===undefined?null:float(pos,5)!*3.6,heading:float(pos,3)??null,telemetry_time:hasDevice?'device' as const:'receipt' as const};
    try{assertPing(p,now);}catch{continue;}
    if(centre&&distanceKm(centre,p)>radius)continue;
    tracker.set(key,{signature,eventId,transition,seenAt:now});
    if(tracker.size>2000){for(const [id,state]of tracker){if(now-state.seenAt>86400000||tracker.size>2000)tracker.delete(id);}}
    rows.push({vehicle:{id,callsign:`${options.provider==='mbta'?'MBTA bus':'Digitraffic train'} ${rawId}`,type:'BLS',source:'stand_in'},ping:p});ids.add(id);
  }
  if(options.stats)options.stats.selected=Math.min(rows.length,max);
  return rows.sort((a,b)=>(centre?distanceKm(centre,a.ping)-distanceKm(centre,b.ping):0)||a.vehicle.id.localeCompare(b.vehicle.id)).slice(0,max);
}
export async function fetchBusRoutes(fetcher:typeof fetch=fetch):Promise<Set<string>> {
  const r=await fetcher(MBTA_BUS_ROUTES_URL,{signal:AbortSignal.timeout(10000),redirect:'manual'});if(!r.ok)throw new Error(`MBTA routes ${r.status}`);
  const b=await r.json() as {data?:{id:string;attributes:{type:number}}[]};
  const ids=new Set(b.data?.filter(x=>x.attributes?.type===3).map(x=>x.id));if(!ids.size)throw new Error('Empty bus route list');return ids;
}
export async function fetchFeed(options:FeedOptions,fetcher:typeof fetch=fetch):Promise<FeedSample[]> {
  const r=await fetcher(options.provider==='mbta'?MBTA_URL:DIGITRAFFIC_URL,{signal:AbortSignal.timeout(10000),redirect:'manual',headers:options.provider==='digitraffic'?{'Digitraffic-User':'ambulance-fleet-demo/1'}:{}});
  if(!r.ok)throw new Error(`Feed ${options.provider} ${r.status}`);
  if(Number(r.headers.get('content-length'))>8*1024*1024)throw new Error('Feed too large');
  if(!r.body)throw new Error('Empty feed');const reader=r.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8*1024*1024){await reader.cancel();throw new Error('Feed too large');}chunks.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return parseVehiclePositions(bytes,options);
}
