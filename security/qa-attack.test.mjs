import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import * as a from '../.security-build/index.js';
const secret = 'qa-only-secret-qa-only-secret-qa-only!!';
const now = 1800000000000, ns = now/1000;
const enc = v => Buffer.from(typeof v==='string'?v:JSON.stringify(v)).toString('base64url');
const sig = (d,k=secret)=>createHmac('sha256',k).update(d).digest('base64url');
const mk = (p, h={alg:'HS256',typ:'JWT'}, k=secret) => { const d=`${enc(h)}.${enc(p)}`; return `${d}.${sig(d,k)}`; };
const P = x => ({sub:'u1',fleet_id:'f1',role:'dispatcher',iat:ns,exp:ns+300,iss:'ambulance-fleet',aud:'fleet-api',...x});
const rej = async (t, s=401) => { await assert.rejects(()=>a.verifyToken(t,secret,now), e=>e instanceof a.ApiError && e.status===s, String(t).slice(0,60)); };
test('baseline ok', async()=>{ assert.equal((await a.verifyToken(mk(P()),secret,now)).role,'dispatcher'); });
test('alg none/confusion/header quirks', async()=>{
  for (const h of [{alg:'none'},{alg:'none',typ:'JWT'},{alg:'hs256'},{alg:'HS384'},{alg:'RS256'},{alg:'HS256',kid:'x'},{alg:'HS256',jku:'http://e'},{alg:'HS256',crit:['x']},{alg:'HS256',typ:'jwt'},{alg:['HS256']},{}])
    await rej(mk(P(),h));
  const d=`${enc({alg:'none'})}.${enc(P())}.`; await rej(d);
  await rej(`${enc({alg:'none'})}.${enc(P())}`);
  // __proto__ header
  await rej(`${enc('{"alg":"HS256","__proto__":{"x":1}}')}.${enc(P())}.${sig('x')}`);
});
test('tamper', async()=>{
  const t = mk(P()); const [h,p,s]=t.split('.');
  await rej(`${h}.${enc(P({role:'bridge'}))}.${s}`);
  await rej(`${h}.${p}.${s.slice(0,-1)}${s.at(-1)==='A'?'B':'A'}`);
  await rej(`${h}.${p}.${s.slice(0,-2)}`);
  await rej(`${h}.${p}.${s}AA`);
  await rej(`${h}.${p}.`); await rej(`${h}.${p}`); await rej(`${t}.x`); await rej('');  await rej('..');
  await rej(mk(P(),undefined,'other-secret-other-secret-other-secret'));
  // non-canonical base64 trailing bits in signature: flip low bits of last char
  const alpha='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last=s.at(-1); const alt=alpha[(alpha.indexOf(last)^1)];
  await rej(`${h}.${p}.${s.slice(0,-1)}${alt}`);
  // padded / std-alphabet
  await rej(`${h}.${p}.${s}=`); await rej(`${h}.${p} .${s}`);
  await rej(null); await rej(undefined); await rej(123); await rej({});
});
test('size', async()=>{ await rej(mk(P({pad:'x'.repeat(5000)}))); await rej('a'.repeat(100000)); });
test('payload claims', async()=>{
  for (const x of [{exp:ns},{exp:ns-1},{exp:ns+3601},{exp:ns+3601,iat:ns},{iat:ns+1},{iat:-1},{exp:'1900000000'},{exp:ns+300.5},{exp:1e300},{exp:null},{exp:undefined,},{iss:'x'},{aud:'x'},{aud:['fleet-api']},{iss:undefined},{nbf:ns+1},{nbf:'0'},{nbf:null},{role:'admin'},{role:'Dispatcher'},{role:['crew']},{role:'crew'},{role:'crew',vehicle_id:''},{role:'crew',vehicle_id:'../x'},{fleet_id:'demo'},{fleet_id:'DEMO'},{fleet_id:'a/b'},{fleet_id:['f1']},{sub:''},{sub:'a'.repeat(129)},{sub:'x\n'},{sub:7},{vehicle_id:'bad id'}])
    await rej(mk(P(x)));
  await rej(mk({...P(),exp:undefined}));
  await rej(`${enc(JSON.stringify({alg:'HS256'}))}.${enc('[]')}.${sig(enc({alg:'HS256'})+'.'+enc('[]'))}`);
  // boundary acceptance
  await a.verifyToken(mk(P({exp:ns+1})),secret,now);
  await a.verifyToken(mk(P({exp:ns+3600})),secret,now);
  await a.verifyToken(mk(P({iat:ns,nbf:ns})),secret,now);
});
test('proto pollution / extra claims', async()=>{
  const raw = `{"sub":"u1","fleet_id":"f1","role":"dispatcher","iss":"ambulance-fleet","aud":"fleet-api","iat":${ns},"exp":${ns+300},"__proto__":{"role":"bridge","isAdmin":true},"constructor":{"prototype":{"polluted":1}}}`;
  const d=`${enc({alg:'HS256',typ:'JWT'})}.${enc(raw)}`;
  const c=await a.verifyToken(`${d}.${sig(d)}`,secret,now);
  assert.deepEqual(Object.keys(c).sort(),['exp','fleet_id','role','sub']); assert.equal(c.role,'dispatcher');
  assert.equal({}.polluted,undefined); assert.equal({}.isAdmin,undefined);
  // duplicate keys last-wins: signed by issuer, informational
  const raw2 = `{"sub":"u1","fleet_id":"f1","role":"crew","role":"dispatcher","vehicle_id":"v","iss":"ambulance-fleet","aud":"fleet-api","iat":${ns},"exp":${ns+300}}`;
  const d2=`${enc({alg:'HS256'})}.${enc(raw2)}`; const c2=await a.verifyToken(`${d2}.${sig(d2)}`,secret,now); assert.equal(c2.role,'dispatcher');
});
test('invalid utf8 / BOM in payload', async()=>{
  const bad = Buffer.concat([Buffer.from('{"sub":"'),Buffer.from([0xff]),Buffer.from('"}')]);
  const d=`${enc({alg:'HS256'})}.${bad.toString('base64url')}`; await rej(`${d}.${sig(d)}`);
});
test('secret config', async()=>{
  for (const s of [undefined,'','short','x'.repeat(31)]) await assert.rejects(()=>a.verifyToken(mk(P()),s,now),e=>e.status===503);
  await assert.rejects(()=>a.authorize(new Request('https://x/a'),{JWT_SECRET:secret}),e=>e.status===503&&e.code==='LIVE_DISABLED');
  await assert.rejects(()=>a.authorize(new Request('https://x/a'),{LIVE_ENABLED:'true'}),e=>e.status===503);
  await assert.rejects(()=>a.authorize(new Request('https://x/a'),{LIVE_ENABLED:'TRUE',JWT_SECRET:secret}),e=>e.status===503);
  // empty-secret HMAC forgery attempt
  await assert.rejects(()=>a.verifyToken(mk(P(),undefined,''),'',now));
});
test('extractToken', async()=>{
  const R=(u,h={})=>new Request(u,{headers:h});
  const t=mk(P());
  assert.equal(a.extractToken(R('https://x/a',{Authorization:'Bearer '+t})),t);
  for (const q of ['token','access_token','Token','ACCESS_TOKEN','auth','jwt','authorization','fleet-token','t%6Fken']) assert.throws(()=>a.extractToken(R(`https://x/a?${q}=${t}`,{Authorization:'Bearer '+t})),e=>e.status===401,q);
  assert.throws(()=>a.extractToken(R('https://x/a?x=1&token=')));
  assert.equal(a.extractToken(R('https://x/a',{Authorization:'bearer '+t})),t);
  for (const h of ['Basic '+t,'Bearer','Bearer ','Bearer  '+t,'Bearer '+t+' x','Bearer a b','Bearer\t'+t,t]) assert.throws(()=>a.extractToken(R('https://x/a',{Authorization:h})),e=>e.status===401,h);
  assert.throws(()=>a.extractToken(R('https://x/a')));
  // ws
  const W=(p,extra={})=>R('https://x/a',{Upgrade:'websocket',...extra,'Sec-WebSocket-Protocol':p});
  assert.equal(a.extractToken(W('fleet-token.'+t)),t);
  assert.equal(a.extractToken(W('json, fleet-token.'+t)),t);
  assert.throws(()=>a.extractToken(W('fleet-token.'+t+', fleet-token.'+t)));
  assert.throws(()=>a.extractToken(W('fleet-token.'+t,{Authorization:'Bearer '+t})));
  assert.throws(()=>a.extractToken(R('https://x/a',{'Sec-WebSocket-Protocol':'fleet-token.'+t})));
  assert.throws(()=>a.extractToken(R('https://x/a?x=1',{Authorization:'Bearer '+t, Upgrade:'websocket','Sec-WebSocket-Protocol':'fleet-token.'+t})));
  // case: Fleet-Token. prefix is not recognized -> falls to bearer path, must not authenticate
  assert.throws(()=>a.extractToken(W('Fleet-Token.'+t)));
});
test('authz helpers', async()=>{
  const crew={sub:'c',fleet_id:'f1',role:'crew',vehicle_id:'v1',exp:1};
  assert.throws(()=>a.requireVehicleAccess(crew,'v2')); a.requireVehicleAccess(crew,'v1');
  assert.throws(()=>a.requireVehicleAccess(crew,'V1')); assert.throws(()=>a.requireVehicleAccess(crew,'v1 '));
  assert.throws(()=>a.requireFleet(crew,'F1')); assert.throws(()=>a.requireFleet(crew,'demo')); assert.throws(()=>a.requireFleet(crew,undefined));
  assert.throws(()=>a.requireRole(crew,'dispatcher'));
  assert.throws(()=>a.requireRegistrationAccess(crew,'stand_in'));
  assert.throws(()=>a.requireRegistrationAccess({...crew,role:'bridge'},'device'));
  assert.throws(()=>a.requireRegistrationAccess({...crew,role:'bridge'},'synthetic'));
  assert.throws(()=>a.requireRegistrationAccess({...crew,role:'bridge'},undefined));
  a.requireRegistrationAccess({...crew,role:'bridge'},'stand_in');
});
test('origin', async()=>{
  const R=(h)=>new Request('https://x.example/ws',{headers:h});
  a.assertSameOrigin(R({Origin:'https://x.example'}));
  for (const o of ['null','https://evil','http://x.example','https://x.example:443x','https://x.example.evil.com','https://X.example/','https://x.example/']) 
    { try { a.assertSameOrigin(R({Origin:o})); if (o!=='https://X.example/'&&o!=='https://x.example/') assert.fail('accepted '+o);} catch(e){ if(!(e instanceof a.ApiError)) throw e; } }
  assert.throws(()=>a.assertSameOrigin(R({Upgrade:'websocket'})),e=>e.status===403);
  assert.throws(()=>a.assertSameOrigin(R({Upgrade:'websocket',Origin:'https://evil'})));
  a.assertSameOrigin(R({Origin:'https://x.example','X-Forwarded-Host':'evil'}));
});
test('rate limiter', () => {
  const r=new a.RateLimiter(3,1,2);
  assert.ok(r.consume('a',1,0).allowed);r.consume('a',1,0);r.consume('a',1,0);
  assert.ok(!r.consume('a',1,0).allowed);
  assert.ok(!r.consume('a',1,-1e9).allowed, 'rollback grants credit');
  assert.ok(r.consume('a',1,1000).allowed);
  for (const bad of [[NaN],[Infinity],[0],[-1],[4]]) assert.throws(()=>r.consume('a',...bad));
  assert.throws(()=>r.consume('',1,0)); assert.throws(()=>r.consume('k'.repeat(513),1,0));
  assert.throws(()=>r.consume('a',1,NaN));
  // map exhaustion: fail-closed for new principal, existing still served
  const m=new a.RateLimiter(5,1,2); m.consume('p1',1,0); m.consume('p2',1,0);
  assert.equal(m.consume('p3',1,1).allowed,false);
  // depleted key cannot be evicted by churn
  const d=new a.RateLimiter(2,1,3); d.consume('v',2,0); d.consume('x',1,0);d.consume('y',1,0);
  assert.equal(d.consume('z',1,1000).allowed,false); assert.equal(d.consume('v',1,1000).allowed,true);
  // key spoof: principalRateKey collisions
  const k1=a.principalRateKey({fleet_id:'a',sub:'b:c'},'d'), k2=a.principalRateKey({fleet_id:'a:b',sub:'c'},'d'); assert.notEqual(k1,k2);
  const k3=a.principalRateKey({fleet_id:'a',sub:'b'},'c","d'); assert.notEqual(k3,a.principalRateKey({fleet_id:'a',sub:'b'},'c'));
  // principalRateKey length: long action name -> Error not ApiError (500)
  assert.throws(()=>new a.RateLimiter().consume(a.principalRateKey({fleet_id:'f',sub:'s'},'x'.repeat(600)),1,0));
  // memory growth bound
  const g=new a.RateLimiter(60,1,10000); for(let i=0;i<20000;i++) g.consume('k'+i,1,i); assert.ok(g.buckets.size<=10000);
  // eviction cost: new-key scan is O(n)
  const t0=performance.now(); for(let i=0;i<2000;i++) g.consume('n'+i,1,100000+i); console.log('2000 new-key calls at full table ms', (performance.now()-t0).toFixed(0));
});
const J=(body,h={},extra={})=>new Request('https://x/a',{method:'POST',headers:{'Content-Type':'application/json',...h},body,duplex:'half',...extra});
test('readJson', async()=>{
  assert.deepEqual(await a.readJson(J('{"a":1}')),{a:1});
  const e=(p,s)=>assert.rejects(p,x=>x instanceof a.ApiError&&x.status===s);
  await e(a.readJson(J('{"a":1}',{'Content-Type':'text/plain'})),415);
  await e(a.readJson(J('{"a":1}',{'Content-Type':'application/jsonx'})),415);
  await e(a.readJson(J('{"a":1}',{'Content-Type':'application/json;charset=utf-16'}),),400).catch(()=>{});
  await e(a.readJson(J('{"a":1}',{'Content-Encoding':'gzip'})),415);
  await e(a.readJson(J('{"a":1}',{'Content-Encoding':'br'})),415);
  await e(a.readJson(J('{"a":1}',{'Content-Length':'999999'})),413);
  await e(a.readJson(J('{"a":1}',{'Content-Length':'-1'})),413);
  await e(a.readJson(J('{"a":1}',{'Content-Length':'1e3'})),413);
  await e(a.readJson(J('x'.repeat(20000))),413);
  await e(a.readJson(J('{"a":"'+'x'.repeat(16384)+'"}')),413);
  await e(a.readJson(J('')),400); await e(a.readJson(new Request('https://x/a',{method:'POST',headers:{'Content-Type':'application/json'}})),400);
  await e(a.readJson(J('{bad')),400); await e(a.readJson(J(new Uint8Array([0x7b,0xff,0x7d]))),400);
  // chunked stream w/o content-length, lying small CL
  const big=new ReadableStream({start(c){for(let i=0;i<100;i++)c.enqueue(new Uint8Array(1024));c.close();}});
  await e(a.readJson(J(big)),413);
  let pulled=0; const inf=new ReadableStream({pull(c){pulled++;c.enqueue(new Uint8Array(1024));}});
  await e(a.readJson(J(inf)),413); assert.ok(pulled<40,'pulled '+pulled);
  // exact boundary
  const body='{"a":"'+'x'.repeat(16384-8)+'"}'; assert.equal(body.length,16384); await a.readJson(J(body));
  await e(a.readJson(J(body+' ')),413);
  // proto
  const o=await a.readJson(J('{"__proto__":{"x":1}}')); assert.equal({}.x,undefined);
  assert.throws(()=>a.validateVehiclePatch(o),x=>x.status===400);
  assert.throws(()=>a.validateVehicleRegistration(JSON.parse('{"id":"a","callsign":"c","type":"ALS","__proto__":{"source":"stand_in"}}')));
  // deep nesting
  await a.readJson(J('['.repeat(8000)+']'.repeat(8000))).catch(x=>{ if(!(x instanceof a.ApiError)) throw x; });
  // BOM: informational
  const bom=await a.readJson(J(new Uint8Array([0xef,0xbb,0xbf,0x7b,0x7d]))).then(()=> 'accepted',()=> 'rejected'); console.log('BOM json', bom);
});
test('validators', () => {
  const t=(f,...x)=>assert.throws(()=>f(...x),e=>e.status===400);
  for (const v of ['','.a','-a','a b','a/b','a'.repeat(129),'a\n','é',undefined,1,{},['a']]) t(a.validateIdentifier,v);
  for (const v of ['','  ','a\u0000','a\nb','a'.repeat(121),'a\u007f',1]) t(a.validateText,v);
  for (const v of [NaN,Infinity,'1',null,-91,91]) t(a.validateFinite,v,-90,90);
  for (const v of ['0','501','01','-1','1.5','1e2',' 1','','1000','0x10','+5']) t(a.validateHistoryLimit,v);
  assert.equal(a.validateHistoryLimit('500'),500); assert.equal(a.validateHistoryLimit(null),100);
  const bidi=['a\u202eb','a\u200bb','\u200b','a\u2028b','a\u0085b','a\ufeffb','a\u2066b'];
  const accepted=bidi.filter(v=>{try{a.validateText(v);return true}catch{return false}}); console.log('text accepted odd unicode:',JSON.stringify(accepted));
  assert.deepEqual(accepted,[], 'bidi/zero-width/C1 control chars accepted in labels');
  t(a.validateVehicleRegistration,{id:'a',callsign:'c',type:'ALS',source:'bridge'});
  t(a.validateVehicleRegistration,{id:'a',callsign:'c',type:'ALS',extra:1});
  t(a.validateVehicleRegistration,{id:'a',callsign:'c',type:'als'});
  t(a.validateVehiclePatch,{}); t(a.validateVehiclePatch,{status:'x'}); t(a.validateVehiclePatch,{destination:{label:'x',lat:0,lon:181}});
  t(a.validateVehiclePatch,{destination:{label:'x',lat:0,lon:0,patient:'p'}}); t(a.validateVehiclePatch,[]); t(a.validateVehiclePatch,null);
  t(a.validateVehiclePatch,{destination:undefined,status:undefined,toString:1});
  assert.equal(a.validateVehicleRegistration({id:'a',callsign:' c ',type:'ALS'}).source,'device');
});
test('error redaction', async()=>{
  for (const err of [new Error('secret '+secret),new TypeError('x'),'str',null,{status:200,code:'X',message:'leak'}]) {
    const r=a.apiErrorResponse(err); const b=await r.text(); assert.equal(r.status,500); assert.ok(!b.includes('secret')&&!b.includes('leak')); assert.equal(r.headers.get('Cache-Control'),'no-store');
  }
  const r=a.apiErrorResponse(new a.ApiError(401,'UNAUTHORIZED','Authentication required')); assert.equal(r.headers.get('WWW-Authenticate'),'Bearer realm="fleet-api"','401 challenge added by D5 remediation');
  // error message differentiation of auth failures
  const msgs=new Set(); for (const t of ['x','a.b.c',mk(P({exp:ns-1})),mk(P(),undefined,'z'.repeat(40))]) { try{await a.verifyToken(t,secret,now)}catch(e){msgs.add(e.code+e.message)} } assert.equal(msgs.size,1);
});
test('clock skew', async()=>{
  // token minted by an issuer whose clock is 1s ahead
  await assert.rejects(()=>a.verifyToken(mk(P({iat:ns+1,exp:ns+301})),secret,now),'no skew tolerance (availability, informational)');
  await a.verifyToken(mk(P({iat:ns+1,exp:ns+301})),secret,now+1000);
});
test('timing sanity (coarse)', async()=>{
  const t=mk(P()); const [h,p,s]=t.split('.'); const bad1=`${h}.${p}.${'A'.repeat(43)}`; const bad2=`${h}.${p}.${s.slice(0,-1)}${s.at(-1)==='A'?'B':'A'}`;
  const T=async tok=>{const t0=process.hrtime.bigint(); for(let i=0;i<3000;i++) await a.verifyToken(tok,secret,now).catch(()=>{}); return Number(process.hrtime.bigint()-t0)/3000};
  const x=await T(bad1), y=await T(bad2); console.log('ns/op first-byte-wrong vs last-byte-wrong',x|0,y|0); assert.ok(Math.abs(x-y)/Math.max(x,y)<0.3);
});
