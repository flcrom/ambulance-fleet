import http from 'node:http';
import {WebSocketServer} from 'ws';
import {randomUUID} from 'node:crypto';
// TEST FIXTURES ONLY. This server does not implement authentication or fetch public feeds.
const now0=()=>new Date().toISOString();
const ping=(id,i,stale)=>({event_id:randomUUID(),vehicle_id:id,recorded_at:stale?new Date(Date.now()-45000).toISOString():now0(),received_at:now0(),lat:42.35+i*.01,lon:-71.075+i*.012,speed_kph:i===2?null:i===1?0:26+i*5,heading:i===2?null:110,telemetry_time:'receipt'});
function demoVehicles(){
 return Array.from({length:3},(_,i)=>({id:`unit-${i+1}`,callsign:i===2?'MBTA fixture 312':'Unit '+String(i+1).padStart(2,'0'),type:i===1?'ALS':'BLS',source:i===2?'stand_in':'synthetic',status:i===1?'offline':i===0?'en_route':'available',destination:i===0?{label:'Demo destination',lat:42.366,lon:-71.08}:null,latest_ping:ping(`unit-${i+1}`,i,i===1),stale:i===1,eta:i===0?{minutes:4.2,method:'straight_line',approximate:true}:null}));
}
const demoIncidents=()=>[
 {id:'call-open-1',label:'MG Road',lat:42.355,lon:-71.06,priority:1,status:'open',created_at:now0(),assigned_at:null,closed_at:null,vehicle_id:null,hospital_label:'Simulated hospital A'},
 {id:'call-assigned-2',label:'Demo destination',lat:42.366,lon:-71.08,priority:2,status:'assigned',created_at:now0(),assigned_at:now0(),closed_at:null,vehicle_id:'unit-1',hospital_label:'Simulated hospital A'},
];
// Mutable live-fleet state for the operator workflow.
const live={vehicles:null,incidents:[]};
function liveVehicles(){
 if(!live.vehicles)live.vehicles=Array.from({length:3},(_,i)=>({id:`unit-${i+1}`,callsign:'Unit '+String(i+1).padStart(2,'0'),type:i===1?'ALS':'BLS',source:'device',status:i===1?'offline':'available',destination:null,latest_ping:ping(`unit-${i+1}`,i,i===1),stale:i===1,eta:null,incident_id:null}));
 return live.vehicles;
}
function snapshot(mode,standIn){
 const demo=mode==='demo';
 const vehicles=demo?demoVehicles():liveVehicles();
 const alerts=[{id:'stale-2',vehicle_id:'unit-2',kind:'stale',created_at:now0(),message:'No position received in the last 30 seconds.',acknowledged_at:!demo&&acknowledged.has('stale-2')?now0():null}];
 const s={fleet_id:demo?(standIn?'demo-standin':'demo'):'test-fleet',mode,server_time:now0(),vehicles:demo?vehicles.filter(v=>standIn?v.source==='stand_in':v.source==='synthetic'):vehicles,alerts:[]};
 s.alerts=alerts.filter(a=>s.vehicles.some(v=>v.id===a.vehicle_id));
 if(demo&&!standIn)s.incidents=demoIncidents();
 if(!demo)s.incidents=live.incidents;
 if(standIn)s.attribution={label:'live stand-in vehicles (MBTA buses), not ambulances',source:'MBTA / MassDOT (mock fixture only)',url:'https://www.mbta.com/developers/gtfs-realtime'};
 return s;
}
const acknowledged=new Set();
const readBody=req=>new Promise(resolve=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{try{resolve(JSON.parse(b||'{}'));}catch{resolve(null);}});});
const server=http.createServer(async(req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');
 const url=new URL(req.url,'http://localhost');const mode=url.pathname.includes('/demo/')?'demo':'live';const standIn=url.searchParams.get('mode')==='stand_in';
 const cookieAuth=(req.headers.cookie||'').includes('siren_ops=mock.dispatcher.token');
 if(url.pathname==='/api/ops/login'&&req.method==='POST'){
  const b=await readBody(req);
  if(b?.fleet_id==='test-fleet'&&b?.password==='mock-password'){res.setHeader('Set-Cookie','siren_ops=mock.dispatcher.token; Path=/; HttpOnly; SameSite=Strict');res.end(JSON.stringify({ok:true,fleet_id:'test-fleet',role:'dispatcher',exp:Math.floor(Date.now()/1000)+3600}));return;}
  res.writeHead(401);res.end(JSON.stringify({error:{code:'INVALID_LOGIN',message:'Invalid fleet or password'}}));return;
 }
 if(url.pathname==='/api/ops/session'){if(!cookieAuth){res.writeHead(401);res.end(JSON.stringify({error:{code:'UNAUTHORIZED',message:'Authentication required'}}));return;}res.end(JSON.stringify({ok:true,fleet_id:'test-fleet',role:'dispatcher',sub:'owner',exp:Math.floor(Date.now()/1000)+3600}));return;}
 if(url.pathname==='/api/ops/logout'&&req.method==='POST'){res.setHeader('Set-Cookie','siren_ops=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict');res.end(JSON.stringify({ok:true}));return;}
 const crewMint=url.pathname.match(/^\/api\/vehicles\/([A-Za-z0-9_-]+)\/crew-token$/);
 if(crewMint&&req.method==='POST'){if(!cookieAuth){res.writeHead(401);res.end(JSON.stringify({error:{code:'UNAUTHORIZED',message:'Authentication required'}}));return;}res.end(JSON.stringify({ok:true,token:'mock.crew.token',vehicle_id:crewMint[1],exp:Math.floor(Date.now()/1000)+900}));return;}
 if(mode==='live'&&req.headers.authorization!=='Bearer mock.dispatcher.token'&&!cookieAuth){res.writeHead(401);res.end(JSON.stringify({error:{code:'unauthorized',message:'Mock dispatcher token required'}}));return;}
 if(['/api/demo/fleet','/api/fleet'].includes(url.pathname)){res.end(JSON.stringify(snapshot(mode,standIn)));return;}
 if(req.method==='POST'&&url.pathname==='/api/alerts/stale-2/ack'){acknowledged.add('stale-2');res.end(JSON.stringify({acknowledged:true}));return;}
 if(req.method==='POST'&&url.pathname==='/api/incidents'){
  const b=await readBody(req);
  if(!b||typeof b.label!=='string'||!b.label.trim()||typeof b.lat!=='number'||typeof b.lon!=='number'||![1,2,3].includes(b.priority)){res.writeHead(400);res.end(JSON.stringify({error:{code:'INCIDENT',message:'Invalid incident'}}));return;}
  const incident={id:randomUUID(),label:b.label.trim(),lat:b.lat,lon:b.lon,priority:b.priority,status:'open',created_at:now0(),assigned_at:null,closed_at:null,vehicle_id:null,hospital_label:null};
  live.incidents.unshift(incident);res.writeHead(201);res.end(JSON.stringify(incident));return;
 }
 const inc=url.pathname.match(/^\/api\/incidents\/([a-f0-9-]{36}|call-[a-z0-9-]+)\/(assign|close)$/);
 if(req.method==='POST'&&inc){
  const incident=live.incidents.find(i=>i.id===inc[1]);
  if(!incident){res.writeHead(404);res.end(JSON.stringify({error:{code:'INCIDENT',message:'Incident not found'}}));return;}
  if(inc[2]==='close'){if(incident.status!=='closed'){incident.status='closed';incident.closed_at=now0();const unit=liveVehicles().find(v=>v.id===incident.vehicle_id);if(unit){unit.incident_id=null;unit.status='available';unit.destination=null;}}res.end(JSON.stringify(incident));return;}
  const b=await readBody(req);const unit=liveVehicles().find(v=>v.id===b?.vehicle_id);
  if(!unit){res.writeHead(404);res.end(JSON.stringify({error:{code:'VEHICLE',message:'Vehicle not found'}}));return;}
  if(unit.status!=='available'){res.writeHead(409);res.end(JSON.stringify({error:{code:'BUSY',message:'Vehicle is not available'}}));return;}
  incident.vehicle_id=unit.id;incident.status='assigned';incident.assigned_at=now0();
  unit.incident_id=incident.id;unit.status='en_route';unit.destination={label:incident.label,lat:incident.lat,lon:incident.lon};
  res.end(JSON.stringify(incident));return;
 }
 const patch=url.pathname.match(/^\/api\/vehicles\/([^/]+)$/);
 if(req.method==='PATCH'&&patch){
  const unit=liveVehicles().find(v=>v.id===decodeURIComponent(patch[1]));
  if(!unit){res.writeHead(404);res.end(JSON.stringify({error:{code:'VEHICLE',message:'Vehicle not found'}}));return;}
  const b=await readBody(req);
  if(b.status){unit.status=b.status;
   if(unit.incident_id){const linked=live.incidents.find(i=>i.id===unit.incident_id);
    if(linked&&linked.status!=='closed'){if(b.status==='at_scene')linked.status='on_scene';else if(b.status==='transporting')linked.status='transporting';else if(b.status==='at_hospital'||b.status==='available'){linked.status='closed';linked.closed_at=now0();unit.incident_id=null;}}}}
  res.end(JSON.stringify(unit));return;
 }
 if(req.method==='POST'&&url.pathname==='/api/pings'){
  const b=await readBody(req);
  if(!b||typeof b.vehicle_id!=='string'||!b.vehicle_id||typeof b.lat!=='number'||typeof b.lon!=='number'){res.writeHead(400);res.end(JSON.stringify({error:{code:'PING',message:'Invalid ping'}}));return;}
  if(!liveVehicles().some(v=>v.id===b.vehicle_id)){res.writeHead(404);res.end(JSON.stringify({error:{code:'VEHICLE',message:'Vehicle not found'}}));return;}
  res.writeHead(201);res.end(JSON.stringify({accepted:true,duplicate:false,event_id:b.event_id}));return;
 }
 const match=url.pathname.match(/^\/api\/vehicles\/(.+)\/history$/);if(match){const id=decodeURIComponent(match[1]);const p=fixture_ping(id);if(!p){res.writeHead(404);res.end(JSON.stringify({error:{code:'not_found',message:'Vehicle not found'}}));return;}res.end(JSON.stringify({pings:Array.from({length:12},(_,i)=>({...p,event_id:randomUUID(),recorded_at:new Date(Date.now()-i*5000).toISOString(),lat:p.lat-i*.001,lon:p.lon+i*.001}))}));return;}
 res.writeHead(404);res.end(JSON.stringify({error:{code:'not_found',message:'Unknown mock endpoint'}}));
});
function fixture_ping(id){return [...demoVehicles(),...liveVehicles()].find(v=>v.id===id)?.latest_ping;}
const wss=new WebSocketServer({noServer:true,handleProtocols:protocols=>protocols.has('fleet.v1')?'fleet.v1':false});
server.on('upgrade',(req,socket,head)=>{const url=new URL(req.url,'http://localhost');const path=url.pathname;if(!['/api/demo/events','/api/events'].includes(path)||process.env.MOCK_NO_WS==='1'){socket.destroy();return;}const mode=path==='/api/demo/events'?'demo':'live';const standIn=url.searchParams.get('mode')==='stand_in';const wsCookie=(req.headers.cookie||'').includes('siren_ops=mock.dispatcher.token');if(mode==='live'&&!wsCookie&&!req.headers['sec-websocket-protocol']?.split(',').map(x=>x.trim()).includes('fleet-token.mock.dispatcher.token')){socket.destroy();return;}wss.handleUpgrade(req,socket,head,ws=>{const send=()=>ws.send(JSON.stringify({type:'snapshot',data:snapshot(mode,standIn)}));send();const timer=setInterval(send,2500);ws.on('close',()=>clearInterval(timer));});});
server.listen(8788,'127.0.0.1',()=>console.log('TEST ONLY mock API http://127.0.0.1:8788'));
