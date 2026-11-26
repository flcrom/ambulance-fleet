import {useEffect,useRef} from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type {Incident,Ping,Vehicle} from './types';

const ACTIVE:Incident['status'][]=['open','assigned','on_scene','transporting'];

export function FleetMap({vehicles,selectedId,onSelect,replay,theme,incidents,picking,onPick}:{vehicles:Vehicle[];selectedId:string|null;onSelect:(id:string)=>void;replay:Ping[]|null;theme:'dark'|'light';incidents?:Incident[];picking?:boolean;onPick?:(lat:number,lon:number)=>void}){
 const element=useRef<HTMLDivElement>(null),map=useRef<L.Map|null>(null),layer=useRef<L.LayerGroup|null>(null),initialized=useRef(false),bounds=useRef<L.LatLngBounds|null>(null);
 const pickRef=useRef(onPick);pickRef.current=onPick;
 useEffect(()=>{if(!element.current)return;const instance=L.map(element.current,{zoomControl:false,attributionControl:true,zoomAnimation:false,fadeAnimation:false,markerZoomAnimation:false}).setView([12.9716,77.5946],12);map.current=instance;L.control.zoom({position:'bottomright'}).addTo(instance);L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).addTo(instance);layer.current=L.layerGroup().addTo(instance);
  instance.on('click',(event:L.LeafletMouseEvent)=>{if(pickRef.current)pickRef.current(event.latlng.lat,event.latlng.lng);});
  const observer=new ResizeObserver(()=>{if(map.current===instance){instance.invalidateSize({animate:false});if(bounds.current)instance.fitBounds(bounds.current,{maxZoom:14,animate:false});}});observer.observe(element.current);return()=>{observer.disconnect();map.current=null;instance.stop();instance.remove();initialized.current=false;};},[]);
 useEffect(()=>{if(!map.current||!layer.current)return;layer.current.clearLayers();const points:L.LatLngExpression[]=[];
 const css=getComputedStyle(document.documentElement),ink=css.getPropertyValue('--ink').trim()||'#111',paper=css.getPropertyValue('--paper').trim()||'#fff';
 if(replay?.length){L.polyline(replay.map(p=>[p.lat,p.lon]),{color:ink,weight:2,dashArray:'4 5'}).addTo(layer.current);}
 const activeIncidents=(incidents??[]).filter(i=>ACTIVE.includes(i.status));
 for(const incident of activeIncidents){const point:L.LatLngExpression=[incident.lat,incident.lon];points.push(point);
  const marker=L.circleMarker(point,{radius:incident.priority===1?8:6,color:ink,weight:2,fillColor:incident.status==='open'?paper:ink,fillOpacity:1,dashArray:incident.status==='open'?'2 3':undefined}).addTo(layer.current);
  marker.bindTooltip(`${incident.label} · P${incident.priority}`,{permanent:incident.priority===1&&incident.status==='open',direction:'top',className:'vehicle-tooltip incident-tooltip'});}
 for(const vehicle of vehicles){const ping=vehicle.id===selectedId&&replay?.length?replay[replay.length-1]:vehicle.latest_ping;if(!ping)continue;const point:L.LatLngExpression=[ping.lat,ping.lon];points.push(point);const active=vehicle.id===selectedId;const marker=L.circleMarker(point,{radius:active?10:6,color:ink,weight:active?2:1,fillColor:vehicle.stale?paper:ink,fillOpacity:1}).addTo(layer.current);const label=document.createElement('span');label.textContent=vehicle.callsign;marker.bindTooltip(label,{permanent:active,direction:'top',className:'vehicle-tooltip'});marker.on('click',()=>onSelect(vehicle.id));
  if(active&&vehicle.destination){L.polyline([point,[vehicle.destination.lat,vehicle.destination.lon]],{color:ink,weight:1.5,dashArray:'6 6',opacity:.7}).addTo(layer.current);}}
 if(points.length){bounds.current=L.latLngBounds(points).pad(.3);if(!initialized.current){map.current.fitBounds(bounds.current,{maxZoom:14,animate:false});initialized.current=true;}}
 },[vehicles,selectedId,onSelect,replay,theme,incidents]);
 return <div className={`map${picking?' picking':''}`} role="region" aria-label="Vehicle positions on OpenStreetMap" ref={element}/>;
}
