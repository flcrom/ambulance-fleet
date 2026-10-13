import {feedConfig} from './config';
import {setTimeout as delay} from 'node:timers/promises';
import {IngestClient} from '../../worker/src/feeds/core';
import {fetchBusRoutes,fetchFeed,ATTRIBUTIONS} from '../../worker/src/feeds/gtfs';
const client=new IngestClient(process.env.FLEET_API_URL??'',process.env.FLEET_TOKEN??'');
const {interval,centre,radiusKm,maxVehicles}=feedConfig();
const registered=new Set<string>();let routes:Set<string>|undefined,routeAt=0,stop=false;
for(const s of ['SIGINT','SIGTERM'] as const)process.on(s,()=>{stop=true;});
console.log(ATTRIBUTIONS.mbta.label);
do {
  const started=Date.now();let samples;
  try{if(!routes||Date.now()-routeAt>86400000){routes=await fetchBusRoutes();routeAt=Date.now();}samples=await fetchFeed({provider:'mbta',busRoutes:routes,centre,radiusKm,maxVehicles});}
  catch(e){if(process.env.DIGITRAFFIC_FALLBACK!=='true')throw e;console.warn('MBTA unavailable; switching to Digitraffic trains, not ambulances');console.log(ATTRIBUTIONS.digitraffic);samples=await fetchFeed({provider:'digitraffic',maxVehicles});}
  for(const s of samples){if(!registered.has(s.vehicle.id)){await client.register(s.vehicle);registered.add(s.vehicle.id);}await client.post(s.ping);}
  console.log(JSON.stringify({provider:samples[0]?.vehicle.id.split('-')[0],accepted:samples.length,at:new Date().toISOString()}));
  if(process.env.ONCE==='true')break;await delay(Math.max(interval,interval-(Date.now()-started)));
}while(!stop);
