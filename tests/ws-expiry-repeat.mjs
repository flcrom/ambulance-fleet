import {issueToken} from '../.security-build/index.js';
import WebSocket from 'ws';
import assert from 'node:assert/strict';
const root='http://localhost:8787';
for(let n=0;n<5;n++){
 const token=await issueToken({sub:'repeat',fleet_id:'expiry_repro_'+n,role:'dispatcher'},process.env.JWT_SECRET,{ttlSeconds:2});
 const started=Date.now();let finalFrame=false;
 await new Promise((resolve,reject)=>{const w=new WebSocket(root.replace('http','ws')+'/api/events',['fleet.v1','fleet-token.'+token],{headers:{Origin:root}});const deadline=setTimeout(()=>{w.terminate();reject(Error('no close after 12s'));},12000);w.on('message',body=>{const b=JSON.parse(String(body));if(b.type==='auth_expired')finalFrame=true;});w.on('close',code=>{clearTimeout(deadline);try{assert.equal(code,1008);assert.equal(finalFrame,true);console.log(JSON.stringify({case:n,close:code,auth_expired:finalFrame,elapsed_ms:Date.now()-started}));resolve();}catch(e){reject(e);}});w.on('error',reject);});
}
