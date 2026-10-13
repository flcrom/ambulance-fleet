import {useEffect,useRef} from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type {Ping,Vehicle} from './types';
export function FleetMap({vehicles,selectedId,onSelect,replay}:{vehicles:Vehicle[];selectedId:string|null;onSelect:(id:string)=>void;replay:Ping[]|null}){
 const element=useRef<HTMLDivElement>(null),map=useRef<L.Map|null>(null),layer=useRef<L.LayerGroup|null>(null),initialized=useRef(false),bounds=useRef<L.LatLngBounds|null>(null);
 useEffect(()=>{if(!element.current)return;const instance=L.map(element.current,{zoomControl:false,attributionControl:true,zoomAnimation:false,fadeAnimation:false,markerZoomAnimation:false}).setView([42.355,-71.065],13);map.current=instance;L.control.zoom({position:'bottomright'}).addTo(instance);L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).addTo(instance);layer.current=L.layerGroup().addTo(instance);const observer=new ResizeObserver(()=>{if(map.current===instance){instance.invalidateSize({animate:false});if(bounds.current)instance.fitBounds(bounds.current,{maxZoom:14,animate:false});}});observer.observe(element.current);return()=>{observer.disconnect();map.current=null;instance.stop();instance.remove();initialized.current=false;};},[]);
 useEffect(()=>{if(!map.current||!layer.current)return;layer.current.clearLayers();const points:L.LatLngExpression[]=[];
 if(replay?.length){L.polyline(replay.map(p=>[p.lat,p.lon]),{color:'#111',weight:2,dashArray:'4 5'}).addTo(layer.current);}
 for(const vehicle of vehicles){const ping=vehicle.id===selectedId&&replay?.length?replay[replay.length-1]:vehicle.latest_ping;if(!ping)continue;const point:L.LatLngExpression=[ping.lat,ping.lon];points.push(point);const active=vehicle.id===selectedId;const marker=L.circleMarker(point,{radius:active?10:6,color:'#111',weight:active?2:1,fillColor:vehicle.stale?'#fff':'#111',fillOpacity:1}).addTo(layer.current);const label=document.createElement('span');label.textContent=vehicle.callsign;marker.bindTooltip(label,{permanent:active,direction:'top',className:'vehicle-tooltip'});marker.on('click',()=>onSelect(vehicle.id));}
 if(points.length){bounds.current=L.latLngBounds(points).pad(.3);if(!initialized.current){map.current.fitBounds(bounds.current,{maxZoom:14,animate:false});initialized.current=true;}}
 },[vehicles,selectedId,onSelect,replay]);
 return <div className="map" role="region" aria-label="Vehicle positions on OpenStreetMap" ref={element}/>;
}
