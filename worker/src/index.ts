import { authorize, issueToken, requireRole, ApiError, assertSameOrigin, apiErrorResponse } from './auth/index';
import type { AuthEnv } from './auth/index';
export { FleetStore } from './store';
export interface Env extends AuthEnv { FLEETS: DurableObjectNamespace; ASSETS: Fetcher; PROVISION_KEY?: string }
const OPS_COOKIE = '__Host-siren_ops';
const encoder = new TextEncoder();
async function secretEquals(a: string, b: string): Promise<boolean> {
 const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', encoder.encode(a)), crypto.subtle.digest('SHA-256', encoder.encode(b))]);
 const x = new Uint8Array(ha), y = new Uint8Array(hb); let diff = 0;
 for (let i = 0; i < 32; i++) diff |= x[i] ^ y[i];
 return diff === 0;
}
function opsCookieHeaders(token: string | null, ttl: number): Headers {
 const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
 headers.set('Set-Cookie', token === null
  ? `${OPS_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`
  : `${OPS_COOKIE}=${token}; Path=/; Max-Age=${ttl}; HttpOnly; Secure; SameSite=Strict`);
 return headers;
}
/** Owner ops endpoints: one-time fleet password setup, password login issuing an HttpOnly session cookie, logout and session inspection. */
async function handleOps(pathname: string, request: Request, env: Env): Promise<Response> {
 if (env.LIVE_ENABLED !== 'true') throw new ApiError(503, 'LIVE_DISABLED', 'Live API unavailable');
 if (pathname === '/api/ops/logout') {
  // Revoke every live stream for this fleet at its Durable Object before
  // clearing the cookie; otherwise sockets upgraded before logout would keep
  // streaming until token expiry. Without a session, just clear the cookie.
  try {
   const claims = await authorize(request, env);
   const revoked = await env.FLEETS.get(env.FLEETS.idFromName(claims.fleet_id)).fetch(new Request(request.url, { method: 'POST', headers: new Headers({ 'Content-Type': 'application/json', 'x-fleet-id': claims.fleet_id, 'x-ops-action': 'logout' }), body: '{}' }));
   if (!revoked.ok) throw new ApiError(502, 'LOGOUT_FAILED', 'Sign-out could not revoke live streams');
  } catch (error) { if (error instanceof ApiError && error.status === 401) { /* no session: cookie clear below is enough */ } else throw error; }
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: opsCookieHeaders(null, 0) });
 }
 if (pathname === '/api/ops/session') {
  const claims = await authorize(request, env);
  return new Response(JSON.stringify({ ok: true, fleet_id: claims.fleet_id, role: claims.role, sub: claims.sub, exp: claims.exp }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } });
 }
 const length = Number(request.headers.get('content-length') ?? '0');
 if (!Number.isSafeInteger(length) || length < 1 || length > 2048) throw new ApiError(413, 'BODY_SIZE', 'Body too large');
 let payload: unknown;
 try { payload = JSON.parse(await request.text()); } catch { throw new ApiError(400, 'INVALID_JSON', 'Body must be JSON'); }
 if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ApiError(400, 'INVALID_JSON', 'Body must be a JSON object');
 const { fleet_id, password, key } = payload as Record<string, unknown>;
 if (typeof fleet_id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(fleet_id) || fleet_id.startsWith('demo')) throw new ApiError(400, 'FLEET', 'Invalid fleet');
 if (typeof password !== 'string' || !password) throw new ApiError(400, 'PASSWORD', 'Password required');
 const action = pathname === '/api/ops/setup' ? 'setup' : 'login';
 if (action === 'setup' && (!env.PROVISION_KEY || typeof key !== 'string' || !(await secretEquals(key, env.PROVISION_KEY)))) throw new ApiError(404, 'NOT_FOUND', 'Unknown endpoint');
 const forwardHeaders = new Headers({ 'Content-Type': 'application/json', 'x-fleet-id': fleet_id, 'x-ops-action': action });
 const forwarded = new Request(request.url, { method: 'POST', headers: forwardHeaders, body: JSON.stringify({ password }) });
 const response = await env.FLEETS.get(env.FLEETS.idFromName(fleet_id)).fetch(forwarded);
 if (action === 'setup' || !response.ok) {
  const output = new Headers(response.headers); output.set('Cache-Control', 'no-store'); output.set('X-Robots-Tag', 'noindex, nofollow');
  return new Response(response.body, { status: response.status, headers: output });
 }
 const secret = env.JWT_SECRET;
 if (!secret || encoder.encode(secret).byteLength < 32) throw new ApiError(503, 'AUTH_NOT_CONFIGURED', 'Live API unavailable');
 const ttl = 3600;
 const token = await issueToken({ sub: 'owner', fleet_id, role: 'dispatcher' }, secret, { ttlSeconds: ttl });
 return new Response(JSON.stringify({ ok: true, fleet_id, role: 'dispatcher', exp: Math.floor(Date.now() / 1000) + ttl }), { status: 200, headers: opsCookieHeaders(token, ttl) });
}
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
   if (url.pathname.startsWith('/api/ops/') && url.pathname !== '/api/ops/action') {
    if (request.method !== 'POST' && url.pathname !== '/api/ops/session') throw new ApiError(405, 'METHOD', 'Method not allowed');
    if (!['/api/ops/login', '/api/ops/setup', '/api/ops/logout', '/api/ops/session'].includes(url.pathname)) throw new ApiError(404, 'NOT_FOUND', 'Unknown endpoint');
    return await handleOps(url.pathname, request, env);
   }
   const crewMatch = url.pathname.match(/^\/api\/vehicles\/([a-zA-Z0-9_-]{1,80})\/crew-token$/);
   if (crewMatch) {
    if (request.method !== 'POST') throw new ApiError(405, 'METHOD', 'Method not allowed');
    const claims = await authorize(request, env);
    requireRole(claims, 'dispatcher');
    const vehicle_id = crewMatch[1];
    const secret = env.JWT_SECRET;
    if (!secret || encoder.encode(secret).byteLength < 32) throw new ApiError(503, 'AUTH_NOT_CONFIGURED', 'Live API unavailable');
    const ttl = 900; // crew tokens are deliberately short-lived; the app re-mints on demand
    const token = await issueToken({ sub: `crew:${vehicle_id}`, fleet_id: claims.fleet_id, role: 'crew', vehicle_id }, secret, { ttlSeconds: ttl });
    return json({ ok: true, token, vehicle_id, exp: Math.floor(Date.now() / 1000) + ttl });
   }
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
