import {createServer} from 'node:http';
import {fetchBusRoutes,fetchFeed} from '../../worker/src/feeds/gtfs';
import {IngestClient} from '../../worker/src/feeds/core';
const routes=await fetchBusRoutes();const samples=await fetchFeed({provider:'mbta',busRoutes:routes,maxVehicles:5});
if(!samples.length)throw new Error('No current bus positions; live test not passed');
const seen=new Set<string>();let posts=0;
const s=createServer(async(req,res)=>{if(req.headers.authorization!=='Bearer test-only'){res.writeHead(401).end();return;}let raw='';for await(const c of req)raw+=c;const b=JSON.parse(raw);if(req.url==='/api/vehicles'){if(b.source!=='stand_in')throw new Error('Wrong source');res.writeHead(201,{'Content-Type':'application/json'}).end(raw);return;}if(req.url==='/api/pings'){const duplicate=seen.has(b.event_id);seen.add(b.event_id);posts++;res.writeHead(duplicate?200:201,{'Content-Type':'application/json'}).end(JSON.stringify({accepted:true,duplicate,event_id:b.event_id}));return;}res.writeHead(404).end();});
await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));
try{const address=s.address() as {port:number};const client=new IngestClient(`http://127.0.0.1:${address.port}`,'test-only');for(const sample of samples){await client.register(sample.vehicle);await client.post(sample.ping);await client.post(sample.ping);}console.log(JSON.stringify({verified_at:new Date().toISOString(),feed:'https://cdn.mbta.com/realtime/VehiclePositions.pb',route_count:routes.size,bus_samples:samples.length,mock_api_posts:posts,unique_event_ids:seen.size,first_sample:samples[0]},null,2));}finally{await new Promise<void>(r=>s.close(()=>r()));}
