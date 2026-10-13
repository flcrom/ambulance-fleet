import {describe,it,expect} from 'vitest';
import {validatePing,straightLineEta,deriveVehicle,arrival} from './index';
import type {Vehicle} from './types';
const now=Date.now();const p={event_id:'00000000-0000-4000-8000-000000000001',vehicle_id:'null-motion',recorded_at:new Date(now).toISOString(),lat:42.3,lon:-71.1,speed_kph:null,heading:null};
const vehicle:Vehicle={id:p.vehicle_id,callsign:'unknown motion',type:'BLS',source:'stand_in',status:'available',destination:{label:'test',lat:p.lat,lon:p.lon},latest_ping:{...p,received_at:p.recorded_at},stale:false,eta:null};
describe('missing provider motion',()=>{
 it('preserves explicit nulls',()=>expect(validatePing(p,now)).toMatchObject({speed_kph:null,heading:null}));
 it('accepts null independently',()=>{expect(validatePing({...p,heading:90},now).speed_kph).toBeNull();expect(validatePing({...p,speed_kph:50},now).heading).toBeNull();});
 it('rejects absent values rather than inventing zero',()=>{expect(()=>validatePing({...p,speed_kph:undefined},now)).toThrow();expect(()=>validatePing({...p,heading:undefined},now)).toThrow();});
 it('unknown speed yields no ETA',()=>{expect(straightLineEta(vehicle)).toBeNull();expect(deriveVehicle(vehicle,now).eta).toBeNull();});
 it('measured zero stays zero',()=>expect(validatePing({...p,speed_kph:0,heading:0},now)).toMatchObject({speed_kph:0,heading:0}));
 it('arrival remains position-only',()=>expect(arrival(vehicle)).toBe(true));
});
describe('stand-in provider heartbeat',()=>{
 const old=new Date(now-60000).toISOString();
 const stationary={...vehicle,latest_ping:{...vehicle.latest_ping!,recorded_at:old,received_at:old},last_seen:new Date(now).toISOString()};
 it('same old immutable stand-in event remains fresh when observed again',()=>expect(deriveVehicle(stationary,now).stale).toBe(false));
 it('observation does not mutate event timestamps',()=>{deriveVehicle(stationary,now);expect(stationary.latest_ping.recorded_at).toBe(old);});
 it('device replay cannot revive stale telemetry',()=>expect(deriveVehicle({...stationary,source:'device'},now).stale).toBe(true));
 it('provider heartbeat itself goes stale',()=>expect(deriveVehicle(stationary,now+31000).stale).toBe(true));
});
it('near-antipodal triangle precision regression',async()=>{
 const {distanceMeters}=await import('./geo');const a={lat:0,lon:179.99999790869023},b={lat:6.037091348628667e-7,lon:0},c={lat:0,lon:0};
 expect(distanceMeters(a,c)).toBeLessThanOrEqual(distanceMeters(a,b)+distanceMeters(b,c)+1e-6);
});
