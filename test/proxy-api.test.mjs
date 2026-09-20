import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {createExtension} from '../lib/server.mjs';import {makeConfig} from '../lib/config.mjs';
async function fixture(t){const home=fs.mkdtempSync(path.join(os.tmpdir(),'proxy-api-')),{config}=makeConfig({password:'proxy-admin-test-password',mode:'off'});
 const app=await createExtension(config,home,{proxyPort:0,adminPort:0,proxyPoolOptions:{checkTransport:async()=>({ok:true,exitIP:'8.8.8.8',country:'US'}),transport:()=>assert.fail('no model probes expected')}});
 config.adminPort=app.admin.address().port;config.adminOrigin=`http://127.0.0.1:${config.adminPort}`;
 t.after(async()=>{await app.close(100);fs.rmSync(home,{recursive:true,force:true});});
 const base=config.adminOrigin,post=async(route,body)=>{const r=await fetch(base+route,{method:'POST',headers:{'x-turnstate-control':config.controlToken,'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
 return{home,config,app,base,post};
}
test('proxy management requires login/CSRF; secrets are write-only; pool cannot silently enable without upstream source',async t=>{
 const f=await fixture(t),initialRules=JSON.stringify(f.app.states.rules);
 assert.equal((await fetch(f.base+'/api/proxy-pool')).status,401);
 let r=await f.post('/api/proxy-pool/nodes',{action:'import',text:'8.8.8.8:1080:secret-user:secret-password'});assert.equal(r.status,200);const id=r.data.nodes[0].id;
 assert.equal(JSON.stringify(r.data).includes('secret-user'),false);assert.equal(JSON.stringify(r.data).includes('secret-password'),false);
 assert.equal((await f.post('/api/proxy-pool/switch',{enabled:true,acknowledgeExperimental:true})).status,400);
 const login=await fetch(f.base+'/api/login',{method:'POST',headers:{origin:f.base,'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'proxy-admin-test-password'})});
 const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
 const req={method:'POST',headers:{cookie,origin:f.base,'content-type':'application/json'},body:JSON.stringify({id,action:'delete'})};
 assert.equal((await fetch(f.base+'/api/proxy-pool/nodes',req)).status,403);
 r=await f.post('/api/proxy-pool/source',{type:'codex',token:'source-token-secret',accountId:'dummy-account',clientKey:'allowed-local-client'});assert.equal(r.status,200);assert.equal(r.data.ready,true);
 for(const secret of ['source-token-secret','allowed-local-client','dummy-account'])assert.equal(JSON.stringify(r.data).includes(secret),false);
 assert.equal((await f.post('/api/proxy-pool/switch',{enabled:true,acknowledgeExperimental:true})).status,200);
 const check=await f.post('/api/proxy-pool/check',{id});assert.equal(check.data.exitIP,'8.8.8.8');
 assert.equal(f.app.automatic.totals.attempts,0);assert.equal(f.app.mode,'off');assert.equal(JSON.stringify(f.app.states.rules),initialRules);
 const deleted=await fetch(f.base+'/api/proxy-pool/nodes',{...req,headers:{...req.headers,'x-csrf-token':csrf}});assert.equal(deleted.status,200);await deleted.text();assert.equal(f.app.proxyPool.snapshot().enabled,false);
 const html=await(await fetch(f.base)).text(),js=await(await fetch(f.base+'/proxy-pool.js')).text();assert.match(html,/pool-source-form/);assert.match(js,/开启节点探测/);assert.match(js,/\.password\.value=''/);
 await f.app.journal.flush();const logs=fs.readFileSync(path.join(f.home,'records.jsonl'),'utf8');for(const secret of ['secret-password','source-token-secret','allowed-local-client'])assert.equal(logs.includes(secret),false);
});
