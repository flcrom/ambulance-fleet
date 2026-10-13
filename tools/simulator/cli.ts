import {setTimeout as delay} from 'node:timers/promises';
import {IngestClient} from '../../worker/src/feeds/core';
import {syntheticPings} from './simulator';
const client=new IngestClient(process.env.FLEET_API_URL??'',process.env.FLEET_TOKEN??'');
let stop=false;for(const s of ['SIGINT','SIGTERM'] as const)process.on(s,()=>{stop=true;});
do{for(const ping of await syntheticPings())await client.post(ping);if(process.env.ONCE==='true')break;await delay(5000);}while(!stop);
