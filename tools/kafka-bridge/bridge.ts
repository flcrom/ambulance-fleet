import {assertPing,stableUuid,type FeedPing} from '../../worker/src/feeds/core';
export interface KafkaRecord {topic:string;partition:number;offset:string;value:string|null}
export async function mapKafkaRecord(record:KafkaRecord,driverMap:Readonly<Record<string,string>>,now=Date.now()):Promise<FeedPing> {
  if(!/^\d+$/.test(record.offset)||!Number.isInteger(record.partition)||record.partition<0||!record.topic)throw new Error('Invalid Kafka coordinates');
  if(record.value===null)throw new Error('Kafka tombstone unsupported');
  const body=JSON.parse(record.value) as Record<string,unknown>;if(!body||typeof body!=='object'||Array.isArray(body))throw new Error('Expected object');
  const event_id=await stableUuid(['kafka',record.topic,record.partition,record.offset]);
  let p:FeedPing;
  if(typeof body.vehicle_id==='string') {
    p={event_id,vehicle_id:body.vehicle_id,recorded_at:body.recorded_at as string,lat:body.lat as number,lon:body.lon as number,speed_kph:body.speed_kph as number,heading:body.heading as number,telemetry_time:body.telemetry_time as 'device'|'receipt'};
  } else {
    const key=String(body.user_id??'');const id=Object.prototype.hasOwnProperty.call(driverMap,key)?driverMap[key]:undefined;if(!id)throw new Error('Unmapped driver');
    p={event_id,vehicle_id:id,recorded_at:new Date(now).toISOString(),lat:body.lat as number,lon:body.lon as number,speed_kph:null,heading:null,telemetry_time:'receipt'};
  }
  assertPing(p,now);return p;
}
export async function processRecord(record:KafkaRecord,map:Readonly<Record<string,string>>,post:(p:FeedPing)=>Promise<void>,commit:(nextOffset:string)=>Promise<void>,now=Date.now()):Promise<void> {
  const ping=await mapKafkaRecord(record,map,now);await post(ping);await commit((BigInt(record.offset)+1n).toString());
}
