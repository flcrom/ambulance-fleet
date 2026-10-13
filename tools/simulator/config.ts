export function feedConfig(env:NodeJS.ProcessEnv=process.env){
 const numeric=(name:string,fallback?:number)=>{if(env[name]===undefined)return fallback;const raw=env[name]!.trim();const n=Number(raw);if(!raw||!Number.isFinite(n))throw new Error(`Invalid ${name}`);return n;};
 const interval=numeric('FEED_INTERVAL_MS',15000)!;if(interval<10000||interval>15000)throw new Error('FEED_INTERVAL_MS must be 10000..15000');
 const lat=numeric('FEED_CENTRE_LAT'),lon=numeric('FEED_CENTRE_LON');if((lat===undefined)!==(lon===undefined))throw new Error('Both centre coordinates required');
 if(lat!==undefined&&(Math.abs(lat)>90||Math.abs(lon!)>180))throw new Error('Invalid centre');
 const radiusKm=numeric('FEED_RADIUS_KM');if(radiusKm!==undefined&&radiusKm<=0)throw new Error('Invalid radius');
 const maxVehicles=numeric('FEED_MAX_VEHICLES',100)!;if(!Number.isInteger(maxVehicles)||maxVehicles<1||maxVehicles>100)throw new Error('Invalid cap');
 return {interval,centre:lat===undefined?undefined:{lat,lon:lon!},radiusKm,maxVehicles};
}
