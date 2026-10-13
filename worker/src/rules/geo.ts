import type {LatLon} from './types';
const R=6371008.8;
const rad=(v:number)=>v*Math.PI/180;
/** Stable spherical central angle via atan2(cross,dot), including antipodes. */
export function distanceMeters(a:LatLon,b:LatLon):number{
 const p=rad(a.lat),q=rad(b.lat),d=rad(b.lon-a.lon);
 const x=Math.cos(q)*Math.sin(d);
 const y=Math.cos(p)*Math.sin(q)-Math.sin(p)*Math.cos(q)*Math.cos(d);
 const dot=Math.sin(p)*Math.sin(q)+Math.cos(p)*Math.cos(q)*Math.cos(d);
 return R*Math.atan2(Math.hypot(x,y),dot);
}
