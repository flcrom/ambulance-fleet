import {useEffect,useRef,useState} from 'react';
import {Activity,MapPin,Play,Square} from 'lucide-react';
import {postPing} from './api';
import './style.css';

type LogLine={at:string;text:string;error?:boolean};
const INTERVAL_MS=10_000;

/**
 * Crew page: a phone with a crew token shares this device's GPS position as one
 * vehicle of its fleet while sharing is explicitly on. The token and positions
 * stay in page memory; nothing is sent before "Start sharing" and the browser
 * asks for location permission first. Crew tokens are minted by the fleet
 * operator, bound to one vehicle, and expire within 15 minutes.
 */
export default function Crew(){
 const [token,setToken]=useState(''),[vehicleId,setVehicleId]=useState(''),[sharing,setSharing]=useState(false),[log,setLog]=useState<LogLine[]>([]),[sent,setSent]=useState(0);
 const watchRef=useRef<number|null>(null),timerRef=useRef<ReturnType<typeof setInterval>|null>(null),positionRef=useRef<GeolocationPosition|null>(null);
 const say=(text:string,error=false)=>setLog(previous=>[{at:new Date().toLocaleTimeString(),text,error},...previous].slice(0,6));
 const stop=(note?:string)=>{
  if(watchRef.current!==null){navigator.geolocation.clearWatch(watchRef.current);watchRef.current=null;}
  if(timerRef.current!==null){clearInterval(timerRef.current);timerRef.current=null;}
  positionRef.current=null;setSharing(false);if(note)say(note);
 };
 useEffect(()=>()=>stop(),[]);
 const post=async()=>{
  const position=positionRef.current;if(!position)return;
  const {latitude,longitude,speed,heading}=position.coords;
  try{
   const result=await postPing({event_id:crypto.randomUUID(),vehicle_id:vehicleId.trim(),recorded_at:new Date(position.timestamp).toISOString(),lat:latitude,lon:longitude,speed_kph:speed!=null&&!Number.isNaN(speed)?Math.round(speed*3.6*10)/10:null,heading:heading!=null&&!Number.isNaN(heading)?((Math.round(heading)%360)+360)%360:null,telemetry_time:'device'},token.trim());
   if(result.accepted!==true||result.event_id==='')throw new Error('Unexpected response');
   setSent(n=>n+1);say(`Position accepted (${Math.round(position.coords.accuracy)} m accuracy)`);
  }catch(e){
   const message=e instanceof Error?e.message:'Send failed';
   if(/401|403|auth|permitted/i.test(message))stop(`Stopped: ${message}`);
   else say(message,true);
  }
 };
 const start=()=>{
  if(!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token.trim())){say('Invalid token format',true);return;}
  if(!vehicleId.trim()){say('Vehicle ID is required',true);return;}
  if(!('geolocation' in navigator)){say('This browser has no geolocation',true);return;}
  setSharing(true);setSent(0);say('Waiting for GPS…');
  watchRef.current=navigator.geolocation.watchPosition(position=>{positionRef.current=position;},error=>stop(`Location unavailable: ${error.message}`),{enableHighAccuracy:true,maximumAge:5000,timeout:20000});
  timerRef.current=setInterval(post,INTERVAL_MS);
 };
 return <main className="crew">
 <header><a className="brand" href="/" aria-label="Siren dispatch home"><Activity size={21}/><span>Siren<span className="slash"> / </span><span className="brand-sub">crew</span></span></a></header>
 <section className="crew-card" aria-label="Crew location sharing">
  <h1>Vehicle crew</h1>
  <p className="crew-note"><MapPin size={13}/> Shares this phone's GPS as one vehicle while sharing is on. Your fleet dispatcher sees the live position; history is kept 7 days. Stop any time.</p>
  <label htmlFor="crew-token">Crew token</label>
  <input id="crew-token" type="password" autoComplete="off" value={token} onChange={e=>setToken(e.target.value)} disabled={sharing}/>
  <label htmlFor="crew-vehicle">Vehicle ID</label>
  <input id="crew-vehicle" autoComplete="off" placeholder="e.g. SIR-01" value={vehicleId} onChange={e=>setVehicleId(e.target.value)} disabled={sharing}/>
  {sharing
   ?<button className="primary" onClick={()=>stop('Sharing stopped')}><Square size={15}/>Stop sharing · {sent} sent</button>
   :<button className="primary" onClick={start}><Play size={15}/>Start sharing</button>}
  {log.length>0&&<div className="crew-log" aria-label="Sharing activity">{log.map((line,i)=><p key={i} className={line.error?'crew-error':''}><time>{line.at}</time>{line.text}</p>)}</div>}
 </section>
 </main>;
}
