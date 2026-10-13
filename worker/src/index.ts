import { authorize, ApiError, assertSameOrigin, apiErrorResponse } from './auth/index';
import type { AuthEnv } from './auth/index';
export { FleetStore } from './store';
export interface Env extends AuthEnv { FLEETS: DurableObjectNamespace; ASSETS: Fetcher }
export function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: {'Content-Type':'application/json', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'X-Robots-Tag':'noindex, nofollow'} }); }
export default {
 async fetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname === 'fleet.flcrom.dev') { url.hostname = 'siren.flcrom.dev'; return Response.redirect(url.toString(), 301); }
  if (!url.pathname.startsWith('/api/')) {
   const response = await env.ASSETS.fetch(request); const headers = new Headers(response.headers);
   headers.set('X-Robots-Tag','noindex, nofollow'); headers.set('X-Content-Type-Options','nosniff'); headers.set('Referrer-Policy','no-referrer');
   headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://tile.openstreetmap.org https://*.tile.openstreetmap.org; connect-src 'self' wss:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'");
   return new Response(response.body,{status:response.status,headers});
  }
  try {
   if(url.pathname==='/api/health' && request.method==='GET') return json({ok:true,version:'1',mode:env.LIVE_ENABLED==='true'?'live':'demo'});
   assertSameOrigin(request);
   const demo = url.pathname === '/api/demo/fleet' || url.pathname === '/api/demo/events';
   if (demo && request.method !== 'GET') throw new ApiError(405,'METHOD','Read-only demo');
   if(url.pathname.startsWith('/api/demo/') && !demo) throw new ApiError(404,'NOT_FOUND','Unknown endpoint');
   const headers = new Headers(request.headers); headers.delete('x-fleet-context');
   let fleetId = demo && url.searchParams.get('mode')==='stand_in' ? 'demo-standin' : 'demo';
   if(!demo) {
    const claims = await authorize(request,env);
    if(claims.fleet_id.startsWith('demo') || !/^[a-zA-Z0-9_-]{1,80}$/.test(claims.fleet_id)) throw new ApiError(403,'FLEET','Invalid fleet');
    fleetId=claims.fleet_id; headers.set('x-fleet-context',JSON.stringify(claims));
   }
   // Caller cannot choose an object ID; only verified JWT fleet scope does.
   headers.set('x-fleet-id',fleetId);
   let body:ArrayBuffer|undefined;
   if(request.body){const reader=request.body.getReader();let size=0;const chunks:Uint8Array[]=[];for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>4096){await reader.cancel();throw new ApiError(413,'BODY_SIZE','Body too large');}chunks.push(r.value);}const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}body=bytes.buffer;}
   const forwarded=new Request(request.url,{method:request.method,headers,body});
   const response = await env.FLEETS.get(env.FLEETS.idFromName(fleetId)).fetch(forwarded);
   if(response.status===101) return response;
   const output = new Headers(response.headers); output.set('Cache-Control','no-store'); output.set('X-Robots-Tag','noindex, nofollow');
   return new Response(response.body,{status:response.status,headers:output});
  } catch(error) {
   if(request.body&&!request.bodyUsed)await request.body.cancel().catch(()=>{});
   if(error instanceof ApiError)return apiErrorResponse(error);
   console.error('fleet request failed'); return json({error:{code:'INTERNAL',message:'Request could not be completed'}},500);
  }
 }
};
