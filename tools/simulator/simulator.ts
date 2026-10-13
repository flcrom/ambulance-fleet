import {stableUuid,type FeedPing} from '../../worker/src/feeds/core';
export const SYNTHETIC_VEHICLES=[{id:'sim-1',callsign:'Synthetic 1',type:'BLS',source:'synthetic'},{id:'sim-2',callsign:'Synthetic 2',type:'ALS',source:'synthetic'},{id:'sim-3',callsign:'Synthetic 3',type:'BLS',source:'synthetic'}] as const;
/** Seeded bounded loops, not road routing. Stable at each UTC second across restarts. */
export async function syntheticPings(nowMs=Date.now(),seed=47):Promise<FeedPing[]> {
  const second=Math.floor(nowMs/1000),time=new Date(second*1000).toISOString();
  return Promise.all(SYNTHETIC_VEHICLES.map(async(v,i)=>{
    const phase=((second%(120+i*30))/(120+i*30))*2*Math.PI+(seed+i)*0.618;
    const lat=42.36+i*0.004+Math.sin(phase)*0.001,lon=-71.06+i*0.004+Math.cos(phase)*0.001,next=phase+2*Math.PI/(120+i*30);
    const north=(Math.sin(next)-Math.sin(phase))*0.001*111195,east=(Math.cos(next)-Math.cos(phase))*0.001*111195*Math.cos(lat*Math.PI/180);
    return {event_id:await stableUuid(['synthetic',seed,v.id,second]),vehicle_id:v.id,recorded_at:time,lat:42.36+i*0.004+Math.sin(phase)*0.001,lon:-71.06+i*0.004+Math.cos(phase)*0.001,speed_kph:Math.hypot(north,east)*3.6,heading:(Math.atan2(east,north)*180/Math.PI+360)%360,telemetry_time:'receipt' as const};
  }));
}
