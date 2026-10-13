import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import * as a from '../.security-build/index.js';
const secret = 'unit-test-only-not-a-deployment-key'.repeat(2);
const now = 1800000000000;
const base = {sub:'dispatcher-1', fleet_id:'fleet-1', role:'dispatcher'};
const sign = (payload, header={alg:'HS256',typ:'JWT'}, k=secret) => {
  const enc = v => Buffer.from(JSON.stringify(v)).toString('base64url');
  const data = `${enc(header)}.${enc(payload)}`;
  return `${data}.${createHmac('sha256',k).update(data).digest('base64url')}`;
};
const payload = extra => ({...base,iat:now/1000,exp:now/1000+300,iss:'ambulance-fleet',aud:'fleet-api',...extra});
const fails = (fn, status=401) => assert.rejects(fn, e => e instanceof a.ApiError && e.status === status);
const throws = (fn,status=400) => assert.throws(fn,e => e instanceof a.ApiError && e.status===status);
test('issue/verify each role and project exact claims only', async () => {
  for (const role of ['dispatcher','bridge','crew']) {
    const c = {...base, role, ...(role==='crew'?{vehicle_id:'vehicle-1'}:{})};
    const token = await a.issueToken(c,secret,{nowMs:now});
    assert.deepEqual(await a.verifyToken(token,secret,now), {...c,exp:now/1000+300});
    assert.deepEqual(await a.verifyToken(sign({...payload(),...c, extra:'ignored'}),secret,now),{...c,exp:now/1000+300});
  }
});
test('verify independently minted HMAC JWT', async()=>assert.deepEqual(await a.verifyToken(sign(payload()),secret,now),{...base,exp:now/1000+300}));
test('signature, secret, encoding and malformed token negative cases',async()=>{
  const good=sign(payload());
  for(const token of ['', 'a.b', 'a.b.c.d','!._.x',good.slice(0,-2)+'00', `${good}=`, 'a'.repeat(4097)]) await fails(()=>a.verifyToken(token,secret,now));
  await fails(()=>a.verifyToken(good,secret+'other',now));
  await fails(()=>a.verifyToken(good,'short',now),503);
});
test('alg confusion and header extension rejected',async()=>{
  for(const header of [{alg:'none'},{alg:'RS256'},{alg:'HS256',jku:'https://untrusted.invalid'},{alg:'HS256',crit:[]},{alg:'HS256',typ:'other'},{alg:'HS256',kid:'key'}]) await fails(()=>a.verifyToken(sign(payload(),header),secret,now));
});
test('registered claim negative cases including exp boundary, future iat and excessive TTL',async()=>{
  for(const extra of [{iss:'other'},{aud:['fleet-api']},{exp:now/1000},{iat:now/1000+1},{iat:'123'},{exp:1.5},{exp:now/1000+3601},{iat:-1},{nbf:now/1000+1},{nbf:'future'},{exp:null}]) await fails(()=>a.verifyToken(sign(payload(extra)),secret,now));
  assert.deepEqual(await a.verifyToken(sign(payload({nbf:now/1000})),secret,now),{...base,exp:now/1000+300});
});
test('claim binding negative cases',async()=>{
  for(const extra of [{role:'admin'},{role:'crew'},{fleet_id:'demo'},{fleet_id:'DEMO'},{fleet_id:'../fleet'},{sub:''},{sub:1},{vehicle_id:''},{role:['crew']}]) await fails(()=>a.verifyToken(sign(payload(extra)),secret,now));
});
test('token issue validates lifetime/secret/binding',async()=>{
  for(const ttlSeconds of [0,3601,0.5,NaN]) await fails(()=>a.issueToken(base,secret,{nowMs:now,ttlSeconds}),400);
  await fails(()=>a.issueToken({...base,role:'crew'},secret));
  await fails(()=>a.issueToken(base,'short'),503);
});
test('HTTP bearer and WebSocket protocol extraction',()=>{
  const token=sign(payload());
  assert.equal(a.extractToken(new Request('https://fleet.test/api/fleet',{headers:{Authorization:`Bearer ${token}`}})),token);
  assert.equal(a.extractToken(new Request('https://fleet.test/api/events',{headers:{Upgrade:'websocket','Sec-WebSocket-Protocol':`fleet.v1, fleet-token.${token}`}})),token);
  for(const headers of [{},{Authorization:'Basic xyz'},{Authorization:`Bearer ${token}, other`},{'Sec-WebSocket-Protocol':`fleet-token.${token}`},{Upgrade:'websocket','Sec-WebSocket-Protocol':`fleet-token.${token}, fleet-token.${token}`},{Upgrade:'websocket',Authorization:`Bearer ${token}`,'Sec-WebSocket-Protocol':`fleet-token.${token}`}]) throws(()=>a.extractToken(new Request('https://fleet.test/api/events',{headers})),401);
  for(const param of ['token','access_token','AUTH','authorization','jwt','fleet-token']) throws(()=>a.extractToken(new Request(`https://fleet.test/api/events?${param}=secret`,{headers:{Authorization:`Bearer ${token}`}})),401);
});
test('authorize env gates and live auth',async()=>{
  const token=await a.issueToken(base,secret);
  const req=new Request('https://fleet.test/api/fleet',{headers:{Authorization:`Bearer ${token}`}});
  for(const env of [{},{LIVE_ENABLED:'false',JWT_SECRET:secret},{LIVE_ENABLED:'true'},{LIVE_ENABLED:'true',JWT_SECRET:'short'}]) await fails(()=>a.authorize(req,env),503);
  assert.equal((await a.authorize(req,{LIVE_ENABLED:'true',JWT_SECRET:secret})).sub,base.sub);
});
test('role, vehicle and tenant authorization',()=>{
  a.requireRole(base,'dispatcher'); a.requireFleet(base,'fleet-1');
  throws(()=>a.requireRole(base,'crew'),403); throws(()=>a.requireFleet(base,'other'),403); throws(()=>a.requireFleet({...base,fleet_id:'demo'},'demo'),403);
  const crew={...base,role:'crew',vehicle_id:'v1'}; a.requireVehicleAccess(crew,'v1'); throws(()=>a.requireVehicleAccess(crew,'v2'),403);
  a.requireVehicleAccess({...base,role:'bridge'},'v2');
});
test('same-origin browser requests and WebSocket origin mandatory',()=>{
  for(const headers of [{},{Origin:'https://fleet.test'},{Origin:'https://fleet.test',Upgrade:'websocket'}]) a.assertSameOrigin(new Request('https://fleet.test/api/events',{headers}));
  for(const headers of [{Origin:'null'},{Origin:'https://evil.test'},{Upgrade:'websocket'}]) throws(()=>a.assertSameOrigin(new Request('https://fleet.test/api/events',{headers})),403);
});
test('bounded strict JSON parsing',async()=>{
  const req=(body,headers={})=>new Request('https://fleet.test',{method:'POST',body,headers:{'Content-Type':'application/json',...headers}});
  assert.deepEqual(await a.readJson(req('{"id":"v1"}')), {id:'v1'});
  await fails(()=>a.readJson(req('broken')),400);
  await fails(()=>a.readJson(req('null',{'Content-Type':'text/plain'})),415);
  await fails(()=>a.readJson(req('{}',{'Content-Encoding':'gzip'})),415);
  await fails(()=>a.readJson(req('{}',{'Content-Length':'20000'})),413);
  await fails(()=>a.readJson(req('123456',{'Content-Length':'1'}),5),413);
  await fails(()=>a.readJson(req('123456'),5),413);
  await fails(()=>a.readJson(req(new Uint8Array([0xff]))),400);
});
test('input helper negative cases',()=>{
  for(const v of [null,[],1,'str']) throws(()=>a.assertRecord(v));
  a.rejectUnknownKeys({id:'v1'},['id']); throws(()=>a.rejectUnknownKeys({patient:'x'},['id']));
  assert.equal(a.validateIdentifier('v1'),'v1'); for(const v of ['', '../x','x/y',1,'x'.repeat(129)]) throws(()=>a.validateIdentifier(v));
  assert.equal(a.validateText(' A1 '),'A1'); for(const v of ['', 'x\n', 'x'.repeat(121),1]) throws(()=>a.validateText(v));
  for(const v of [NaN,Infinity,'1',-91,91]) throws(()=>a.validateFinite(v,-90,90)); assert.equal(a.validateFinite(0,-90,90),0);
  assert.equal(a.validateHistoryLimit(null),100); assert.equal(a.validateHistoryLimit('500'),500);
  for(const v of ['0','501','-1','1.5','1e2','01','']) throws(()=>a.validateHistoryLimit(v));
});
test('rate limiting burst, refill, isolation and clock rollback',()=>{
  const r=new a.RateLimiter(2,1); assert.equal(r.consume('x',1,1000).allowed,true); assert.equal(r.consume('x',1,1000).allowed,true);
  assert.deepEqual(r.consume('x',1,1000),{allowed:false,remaining:0,retryAfterSeconds:1});
  assert.equal(r.consume('y',1,1000).allowed,true); assert.equal(r.consume('x',1,2000).allowed,true);
  assert.equal(r.consume('x',1,1000).allowed,false); assert.equal(r.consume('x',1,2000).allowed,false);
  throws(()=>r.enforce('x',1,2000),429); assert.equal(r.consume('x',1,3000).allowed,true);
  assert.notEqual(a.principalRateKey(base,'ping'),a.principalRateKey({...base,fleet_id:'other'},'ping'));
});
test('rate limiter key bound fails closed, reclaims idle and validates configuration',()=>{
  const r=new a.RateLimiter(2,1,1); r.consume('a',1,0); assert.equal(r.consume('b',1,0).allowed,false); assert.equal(r.consume('b',1,2000).allowed,true);
  for(const args of [[0,1],[2,0],[2,1,0],[2,Infinity]]) assert.throws(()=>new a.RateLimiter(...args));
  for(const args of [['',1,0],['x',3,0],['x',NaN,0],['x',1,NaN]]) assert.throws(()=>r.consume(...args));
});
test('error response no-store and internal details redacted',async()=>{
  const response=a.apiErrorResponse(new Error('SECRET stack trace'));
  assert.equal(response.status,500); assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.deepEqual(await response.json(),{error:{code:'INTERNAL_ERROR',message:'Internal error'}});
});
test('strict vehicle create and patch validation rejects extra patient fields and derived offline',()=>{
  assert.deepEqual(a.validateVehicleRegistration({id:'v1',callsign:'Unit 1',type:'BLS'}),{id:'v1',callsign:'Unit 1',type:'BLS',source:'device'});
  assert.equal(a.validateVehicleRegistration({id:'v1',callsign:'MBTA',type:'BLS',source:'stand_in'}).source,'stand_in');
  for(const v of [{id:'v1',callsign:'Unit 1',type:'BLS',patient:'name'},{id:'v1',callsign:'Unit 1',type:'bus'},{id:'v1',callsign:'Unit 1',type:'BLS',source:'other'}]) throws(()=>a.validateVehicleRegistration(v));
  assert.deepEqual(a.validateVehiclePatch({destination:null}),{destination:null});
  assert.deepEqual(a.validateVehiclePatch({status:'en_route',destination:{label:'Hospital',lat:10,lon:20}}),{status:'en_route',destination:{label:'Hospital',lat:10,lon:20}});
  for(const v of [{},{status:'offline'},{source:'device'},{destination:{label:'Hospital',lat:NaN,lon:20}},{destination:{label:'Hospital',lat:10,lon:20,patient:'name'}},{status:['available']}]) throws(()=>a.validateVehiclePatch(v));
  a.requireRegistrationAccess(base,'device'); a.requireRegistrationAccess({...base,role:'bridge'},'stand_in');
  throws(()=>a.requireRegistrationAccess({...base,role:'bridge'},'device'),403);
  throws(()=>a.requireRegistrationAccess({...base,role:'crew'},'stand_in'),403);
});
test('Unicode spoofing controls and separators rejected; real multilingual names permitted',()=>{
  for (const c of ['\u202e','\u200b','\u200d','\u2028','\u2029','\u0085','\u009f','\ud800','\ufeff']) throws(()=>a.validateText(`Unit${c}1`));
  assert.equal(a.validateText(' दिल्ली 1 '),'दिल्ली 1'); assert.equal(a.validateText('東京 1'),'東京 1');
});
test('UTF-8 BOM rejected, not silently stripped',async()=>{
  await fails(()=>a.readJson(new Request('https://fleet.test',{method:'POST',headers:{'Content-Type':'application/json'},body:new Uint8Array([0xef,0xbb,0xbf,0x7b,0x7d])})),400);
});
test('crew TTL capped on issuance and independent verification',async()=>{
  const crew={...base,role:'crew',vehicle_id:'v1'};
  await fails(()=>a.issueToken(crew,secret,{nowMs:now,ttlSeconds:901}),400);
  await fails(()=>a.verifyToken(sign(payload({...crew,exp:now/1000+901})),secret,now));
  assert.equal((await a.verifyToken(await a.issueToken(crew,secret,{nowMs:now,ttlSeconds:900}),secret,now)).exp,now/1000+900);
});
test('401 challenge and exact 429 retry delay headers',async()=>{
  assert.equal(a.apiErrorResponse(new a.ApiError(401,'UNAUTHORIZED','Authentication required')).headers.get('WWW-Authenticate'),'Bearer realm="fleet-api"');
  const r=new a.RateLimiter(1,0.1); r.consume('x',1,0);
  let error; try {r.enforce('x',1,0);}catch(e){error=e;}
  assert.equal(a.apiErrorResponse(error).headers.get('Retry-After'),'10');
  assert.equal(a.apiErrorResponse(new a.ApiError(429,'RATE_LIMITED','Too many requests')).headers.get('Retry-After'),'1');
  assert.throws(()=>new a.ApiError(429,'RATE_LIMITED','bad',NaN));
});
test('WS close-at-exp schedules exact remaining interval, supports cleanup and already-expired closure',()=>{
  const closed=[]; let delay, callback, cancelled;
  const socket={close:(...args)=>closed.push(args)};
  const cancel=a.closeWebSocketAtExpiry(socket,{exp:now/1000+5},{nowMs:now+500,schedule:(cb,ms)=>{callback=cb;delay=ms;return 123;},cancel:h=>{cancelled=h;}});
  assert.equal(delay,4500); assert.deepEqual(closed,[]); callback(); assert.deepEqual(closed,[[1008,'Authentication expired']]); cancel(); assert.equal(cancelled,123);
  a.closeWebSocketAtExpiry(socket,{exp:now/1000},{nowMs:now}); assert.equal(closed.length,2);
  for(const exp of [NaN,1.5,now/1000+3601]) assert.throws(()=>a.closeWebSocketAtExpiry(socket,{exp},{nowMs:now}));
});
test('BOM in signed JWT payload rejected and explicit issuer backdating works',async()=>{
  const h=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
  const p=Buffer.from('\ufeff'+JSON.stringify(payload())).toString('base64url'); const data=`${h}.${p}`;
  await fails(()=>a.verifyToken(`${data}.${createHmac('sha256',secret).update(data).digest('base64url')}`,secret,now));
  const token=await a.issueToken(base,secret,{nowMs:now-30000,ttlSeconds:300});
  assert.equal((await a.verifyToken(token,secret,now)).exp,now/1000+270);
});
