import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { makeConfig,atomicJSON } from '../lib/config.mjs';
import { createExtension } from '../lib/server.mjs';
import { AutomaticGate,automaticBackoff } from '../lib/automatic.mjs';
import { StateStore } from '../lib/states.mjs';
import { Journal } from '../lib/journal.mjs';
const model='gpt-6-astra',state='S'.repeat(292);
const headers={authorization:'Bearer private-auto-key',session_id:'private-session','content-type':'application/json'};
const original=JSON.stringify({model,input:'PRIVATE ORIGINAL PROMPT',tools:[{type:'function',name:'private_tool'}]});
function reply(res,length=292,m=model){res.writeHead(200,{'content-type':'application/json','x-codex-turn-state':'S'.repeat(length)});res.end(JSON.stringify({model:m,status:'completed'}));}
async function fixture(t,handler,mode='auto') {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'single-auto-')),sockets=new Set(),seen=[];
 const origin=http.createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw||'{}'),event={path:req.url,headers:req.headers,raw,body,probe:body.input==='ping'};seen.push(event);await handler(event,res,req);});
 origin.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});origin.listen(0,'127.0.0.1');await once(origin,'listening');
 const {config}=makeConfig({password:'automatic-test-password!',target:`http://127.0.0.1:${origin.address().port}`,mode});
 const app=await createExtension(config,home,{proxyPort:0,adminPort:0});config.adminPort=app.admin.address().port;config.adminOrigin=`http://127.0.0.1:${config.adminPort}`;
 const url=`http://127.0.0.1:${app.proxy.address().port}`;
 t.after(async()=>{await app.close(100);for(const s of sockets)s.destroy();origin.closeAllConnections();await new Promise(r=>origin.close(r));fs.rmSync(home,{recursive:true,force:true});});
 return{home,app,config,seen,url,send:(extra={})=>fetch(url+'/responses',{method:'POST',headers,body:original,...extra})};
}
test('single switch starts the full automatic pipeline without any other config and preserves original bytes',async t=>{
 let probes=0;const f=await fixture(t,(e,res)=>reply(res,e.probe&&++probes===1?312:292,e.probe&&probes===1?'gpt-5.6-luna':model));
 const r=await f.send();assert.equal(r.status,200);await r.text();assert.deepEqual(f.seen.map(e=>e.probe),[true,true,false]);assert.equal(f.seen[2].raw,original);assert.equal(f.seen[2].headers['x-codex-turn-state'],state);
 for(const e of f.seen.filter(e=>e.probe)){assert.equal(e.body.model,model);assert.equal(e.body.input,'ping');assert.equal(e.body.max_output_tokens,16);assert.equal(e.body.tools,undefined);assert.equal(e.headers['x-codex-turn-state'],undefined);}
 assert.equal(f.app.automatic.snapshot().recent[0].mismatchCount,1);
 const next=await f.send();await next.text();assert.equal(f.seen.length,4);assert.equal(f.app.automatic.totals.cacheHits,1);
 await f.app.journal.flush();const log=fs.readFileSync(path.join(f.home,'records.jsonl'),'utf8');for(const v of ['private-auto-key','private-session','PRIVATE ORIGINAL',state])assert.equal(log.includes(v),false);
});
test('off means no body/state processing, unchanged headers and no probes even with saved state',async t=>{
 const f=await fixture(t,(e,res)=>reply(res,312),'off');const ctx=f.app.states.context(model,headers);f.app.states.adoptProbe(ctx,state,model);
 const r=await f.send({headers:{...headers,'x-codex-turn-state':'Q'.repeat(312)}});assert.equal(r.status,200);assert.equal(r.headers.get('x-codex-turn-state').length,312);await r.text();assert.equal(f.seen.length,1);assert.equal(f.seen[0].headers['x-codex-turn-state'].length,312);assert.equal(f.app.automatic.totals.starts,0);assert.equal(f.app.states.snapshot().observed.length,0);
});
test('global disable releases a held original unchanged and cannot be undone by immediately enabling',async t=>{
 let arrive;const arrived=new Promise(r=>arrive=r);const f=await fixture(t,(e,res)=>{if(e.probe)arrive();else reply(res,312);});
 const p=f.send({headers:{...headers,'x-codex-turn-state':'Q'.repeat(312)}});await arrived;f.app.setMode('off');f.app.setMode('auto');const r=await p;assert.equal(r.status,200);assert.equal(r.headers.get('x-codex-turn-state').length,312);await r.text();assert.deepEqual(f.seen.map(e=>e.probe),[true,false]);assert.equal(f.seen[1].headers['x-codex-turn-state'].length,312);assert.equal(f.app.states.snapshot().pins.length,0);
});
test('disable before in-flight response arrives prevents any late rewrite or adoption',async t=>{
 let arrive,release;const arrived=new Promise(r=>arrive=r),hold=new Promise(r=>release=r);const f=await fixture(t,async(e,res)=>{arrive();await hold;reply(res,312);});
 const ctx=f.app.states.context(model,headers);f.app.states.adoptProbe(ctx,state,model);const p=f.send();await arrived;f.app.setMode('off');release();const r=await p;assert.equal(r.headers.get('x-codex-turn-state').length,312);await r.text();assert.equal(f.app.states.reveal(ctx.id).state,state);
});
test('disconnected client cancels infinite retry and discards the unsent original',async t=>{
 let arrive;const arrived=new Promise(r=>arrive=r);const f=await fixture(t,e=>{if(e.probe)arrive();});const controller=new AbortController();const p=f.send({signal:controller.signal}).catch(e=>e);await arrived;controller.abort();await p;for(let i=0;i<80&&f.app.automatic.waiters;i++)await delay(10);assert.equal(f.app.automatic.waiters,0);assert.equal(f.app.automatic.heldBytes,0);assert.equal(f.seen.length,1);
});
test('simultaneous same-binding requests share one probe, each original forwarded once',async t=>{
 let arrive,release;const arrived=new Promise(r=>arrive=r),hold=new Promise(r=>release=r);const f=await fixture(t,async(e,res)=>{if(e.probe){arrive();await hold;}reply(res);});t.after(()=>release());const a=f.send();await arrived;const b=f.send();await delay(30);assert.equal(f.app.automatic.waiters,2);release();for(const r of await Promise.all([a,b])){assert.equal(r.status,200);await r.text();}assert.deepEqual(f.seen.map(e=>e.probe),[true,false,false]);
});
test('different credentials never borrow a pin',async t=>{
 const f=await fixture(t,(e,res)=>reply(res));let r=await f.send();await r.text();r=await f.send({headers:{...headers,authorization:'Bearer other-key'}});await r.text();assert.equal(f.seen.filter(e=>e.probe).length,2);
});
test('expired or manual-refresh state automatically reprobes on the next request',async t=>{
 let n=0;const f=await fixture(t,(e,res)=>{if(e.probe)n++;res.writeHead(200,{'content-type':'application/json','x-codex-turn-state':String.fromCharCode(65+n).repeat(292)});res.end(JSON.stringify({model,status:'completed'}));});let r=await f.send();await r.text();const ctx=f.app.states.context(model,headers);f.app.states.pins.get(ctx.id).expiresAt=0;r=await f.send();await r.text();f.app.states.refresh({model});r=await f.send();await r.text();assert.equal(f.seen.filter(e=>e.probe).length,3);
});
test('wrong-model original response invalidates only the state used; no automatic original replay',async t=>{
 const f=await fixture(t,(e,res)=>reply(res,292,e.probe?model:'gpt-5.6-luna'));const r=await f.send();await r.text();assert.equal(f.seen.length,2);assert.equal(f.app.states.liveForPreflight(f.app.states.context(model,headers)),null);
});
test('authorization/rate-limit/server failures remain explicit, not count based stopping',async t=>{
 for(const status of [401,403,429,500])await t.test(String(status),async st=>{const f=await fixture(st,(e,res)=>{res.writeHead(status);res.end();});const r=await f.send();assert.equal(r.status,503);assert.equal((await r.json()).error.reason,'http_'+status);assert.equal(f.seen.length,1);assert.equal(f.seen[0].probe,true);});
});
test('no traffic does not launch a scan or retain API keys on disk',async t=>{
 const f=await fixture(t,(e,res)=>reply(res));await delay(40);assert.equal(f.seen.length,0);assert.equal(f.app.automatic.totals.attempts,0);assert.equal(fs.existsSync(path.join(f.home,'probe-budget.json')),false);
});
test('UI is one switch; old manual/quota API is retired behind authentication',async t=>{
 const f=await fixture(t,(e,res)=>reply(res),'off'),base=f.config.adminOrigin;
 assert.equal((await fetch(base+'/api/automation')).status,401);
 const login=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'automatic-test-password!'})});const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();const common={cookie,origin:base,'content-type':'application/json'};
 assert.equal((await fetch(base+'/api/automation',{method:'POST',headers:common,body:'{"enabled":true}'})).status,403);
 const h={...common,'x-csrf-token':csrf};let r=await fetch(base+'/api/automation',{method:'POST',headers:h,body:'{"enabled":true}'});assert.equal(r.status,200);assert.equal((await r.json()).enabled,true);assert.equal(f.app.mode,'auto');
 for(const route of ['/api/probes/start','/api/probes/budget','/api/preflight/config']){r=await fetch(base+route,{method:'POST',headers:h,body:'{}'});assert.equal(r.status,410);}
 const html=await (await fetch(base)).text();assert.match(html,/id="toggle"/);for(const obsolete of ['probe-form','preflight-form','maxAttempts','maxRunSeconds','probe-budget-form'])assert.equal(html.includes(obsolete),false);
 r=await fetch(base+'/api/automation',{method:'POST',headers:h,body:'{"enabled":false}'});await r.text();assert.equal(f.app.mode,'off');assert.equal(JSON.parse(fs.readFileSync(path.join(f.home,'runtime.json'))).enabled,false);assert.equal(f.seen.length,0);
});
test('old pin mode migrates to auto without clearing pins and quota/time files are never read',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'auto-migrate-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));const {config}=makeConfig({password:'test-migration-password!',mode:'off'});
 atomicJSON(path.join(home,'runtime.json'),{mode:'pin'});for(const file of ['preflight.json','probe-budget.json','probe-limits.json'])fs.writeFileSync(path.join(home,file),'legacy intentionally invalid');
 const store=new StateStore(home,config.logSalt),ctx=store.context(model,headers);store.adoptProbe(ctx,state,model);store.flush();
 const app=await createExtension(config,home,{proxyPort:0,adminPort:0});assert.equal(app.mode,'auto');assert.equal(app.states.liveForPreflight(app.states.context(model,headers)).state,state);app.setMode('off');await app.close(100);
 const second=await createExtension(config,home,{proxyPort:0,adminPort:0});assert.equal(second.mode,'off');assert.equal(second.states.snapshot().pins.length,1);await second.close(100);
});
test('more than 100 misses ignore old 10/30 quotas and total duration while still verifying target',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'auto-long-'));const {config}=makeConfig({password:'auto-many-tests-123!'});const journal=new Journal(home,config),states=new StateStore(home,config.logSalt),ctx=states.context(model,headers);let count=0;
 const gate=new AutomaticGate(config,states,journal,()=>true,{sleep:async()=>{},probe:async()=>{count++;return count<=105?{status:200,length:count%2?292:312,responseModel:'gpt-5.6-luna',error:'model_mismatch'}:{status:200,length:292,responseModel:model,accepted:true,state};}});
 const result=await gate.ensure(ctx,headers,null,'/responses',original.length);assert.equal(result.allow,true);assert.equal(count,106);assert.equal(gate.snapshot().recent[0].mismatchCount,105);assert.equal(states.snapshot().pins.length,1);
 const snapshot=JSON.stringify(gate.snapshot());for(const field of ['maxAttempts','maxRunSeconds','deadline','budget','quota'])assert.equal(snapshot.includes('"'+field+'"'),false);
 await gate.close();states.flush();await journal.flush();fs.rmSync(home,{recursive:true,force:true});
});
test('automatic spacing backs off but never represents a stop count',()=>{assert.equal(automaticBackoff(1),2000);assert.equal(automaticBackoff(11),8000);assert.equal(automaticBackoff(10000),30000);});
