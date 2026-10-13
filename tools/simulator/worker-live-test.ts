import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
const output=await build({entryPoints:['worker-probe.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
const mf=new Miniflare({modules:true,script:output.outputFiles[0].text,compatibilityDate:'2026-08-06'});
try{const r=await mf.dispatchFetch('http://localhost/');const b=await r.json() as any;console.log(JSON.stringify({verified_at:new Date().toISOString(),compatibility_date:'2026-08-06',...b},null,2));if(b.routes?.error||b.feed?.error||!(b.feed?.count>0))throw new Error('Worker live feed failed');}finally{await mf.dispose();}
