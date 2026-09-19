import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { makeConfig } from '../lib/config.mjs';
import { createExtension } from '../lib/server.mjs';
import { defaultPreflight,validatePreflight } from '../lib/preflight.mjs';
const model='gpt-6-astra', state='S'.repeat(292);
const headers={authorization:'Bearer private-test-credential',session_id:'private-test-session','content-type':'application/json'};
const original=JSON.stringify({model,input:'PRIVATE ORIGINAL PROMPT',tools:[{type:'function',name:'do_not_execute',parameters:{type:'object'}}],metadata:{turn_id:'turn-test'}});
function reply(res,len=292,m=model){res.writeHead(200,{'content-type':'application/json','x-codex-turn-state':'S'.repeat(len)});res.end(JSON.stringify({model:m,status:'completed'}));}
async function fixture(t,handler,rule={}){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'preflight-')),sockets=new Set(),seen=[];
 const upstream=http.createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw||'{}'),event={path:req.url,headers:req.headers,raw,body,probe:body.input==='ping'};seen.push(event);await handler(event,res,req);});
 upstream.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const {config}=makeConfig({password:'preflight-testing-123!',target:`http://127.0.0.1:${upstream.address().port}`});
 const app=await createExtension(config,home,{proxyPort:0,adminPort:0});config.adminPort=app.admin.address().port;config.adminOrigin=`http://127.0.0.1:${config.adminPort}`;
 app.setMode('pin');app.preflight.configure({[model]:{...defaultPreflight(),enabled:true,...rule}},true);
 const url=`http://127.0.0.1:${app.proxy.address().port}`;
 t.after(async()=>{await app.close(100);for(const s of sockets)s.destroy();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));fs.rmSync(home,{recursive:true,force:true});});
 return{app,config,home,url,seen,send:(extra={})=>fetch(url+'/responses',{method:'POST',headers,body:original,...extra})};
}
test('preflight disabled and non-target requests retain the original one-request path',async t=>{
 const f=await fixture(t,(e,res)=>reply(res),{enabled:false});let r=await f.send();assert.equal(r.status,200);await r.text();assert.equal(f.seen.length,1);assert.equal(f.seen[0].probe,false);
 f.app.preflight.configure({[model]:{...defaultPreflight(),enabled:true}},true);
 r=await f.send({body:JSON.stringify({model:'gpt-5.6-sol',input:'not-a-probe'})});assert.equal(r.status,200);await r.text();assert.equal(f.seen.length,2);
});
test('312 then 292: original body is held, sent exactly once after hit, cached on the next request',async t=>{
 let attempts=0;const f=await fixture(t,(e,res)=>reply(res,e.probe && ++attempts===1?312:292));
 const r=await f.send();assert.equal(r.status,200);await r.text();
 assert.deepEqual(f.seen.map(e=>e.probe),[true,true,false]);assert.equal(f.seen[2].raw,original);assert.equal(f.seen[2].headers['x-codex-turn-state'],state);
 for(const p of f.seen.filter(e=>e.probe)){assert.equal(p.body.max_output_tokens,16);assert.equal(p.body.tools,undefined);assert.equal(p.headers['x-codex-turn-state'],undefined);assert.equal(p.raw.includes('PRIVATE ORIGINAL'),false);}
 const second=await f.send();await second.text();assert.deepEqual(f.seen.map(e=>e.probe),[true,true,false,false]);assert.equal(f.app.preflight.totals.cacheHits,1);
 const record=f.app.journal.recent.filter(e=>e.kind==='request').at(-1);assert.equal(record.preflight.action,'cache_hit');assert.equal(record.originalForwarded,true);
 await f.app.journal.flush();const log=fs.readFileSync(path.join(f.home,'records.jsonl'),'utf8');for(const value of ['private-test-credential','private-test-session','PRIVATE ORIGINAL',state])assert.equal(log.includes(value),false);
});
test('exhaustion blocks original, maxAttempts includes the first attempt, cooldown prevents another billable loop',async t=>{
 const f=await fixture(t,(e,res)=>reply(res,312),{maxAttempts:2});let r=await f.send();assert.equal(r.status,503);const body=await r.json();assert.equal(body.error.reason,'attempts_exhausted');assert.equal(body.error.attempts,2);
 assert.equal(f.seen.length,2);assert.ok(f.seen.every(e=>e.probe));r=await f.send();assert.equal(r.status,503);await r.text();assert.equal(f.seen.length,2);
 assert.equal(f.app.journal.recent.filter(e=>e.kind==='request').at(-1).originalForwarded,false);
});
test('mismatched response model even with 292 never seeds cache or forwards the original',async t=>{
 const f=await fixture(t,(e,res)=>reply(res,292,'gpt-5.6-luna'));const r=await f.send();assert.equal(r.status,503);assert.equal((await r.json()).error.reason,'model_mismatch');assert.equal(f.seen.length,1);assert.equal(f.app.states.snapshot().pins.length,0);
});
test('simultaneous requests for the same binding share a single probe but each original is sent once',async t=>{
 let release,arrive;const hold=new Promise(r=>release=r),ready=new Promise(r=>arrive=r);
 const f=await fixture(t,async(e,res)=>{if(e.probe){arrive();await hold;}reply(res);});t.after(()=>release());
 const a=f.send();await ready;const b=f.send();await delay(30);assert.equal(f.seen.length,1);assert.equal(f.app.preflight.waiters,2);release();
 const responses=await Promise.all([a,b]);for(const r of responses){assert.equal(r.status,200);await r.text();}assert.deepEqual(f.seen.map(e=>e.probe),[true,false,false]);assert.equal(f.app.preflight.waiters,0);
});
test('credentials/sessions do not share a fixed value',async t=>{
 const f=await fixture(t,(e,res)=>reply(res));let r=await f.send();await r.text();r=await f.send({headers:{...headers,authorization:'Bearer separate-private-credential'}});await r.text();assert.equal(f.seen.filter(e=>e.probe).length,2);
});
test('expired or manually entered unverified state must be probed, not treated as a qualified cache hit',async t=>{
 const f=await fixture(t,(e,res)=>reply(res));const ctx=f.app.states.context(model,headers,{metadata:{turn_id:'turn-test'}});
 f.app.states.decide(ctx,state,'response','observe');assert.equal(f.app.states.liveForPreflight(ctx),null);let r=await f.send();await r.text();assert.equal(f.seen.filter(e=>e.probe).length,1);
 f.app.states.pins.get(ctx.id).expiresAt=0;r=await f.send();await r.text();assert.equal(f.seen.filter(e=>e.probe).length,2);
});
test('passthrough failure policy preserves original headers and response instead of applying pin filters',async t=>{
 const f=await fixture(t,(e,res)=>e.probe?reply(res,292,'gpt-5.6-luna'):reply(res,312),{failurePolicy:'passthrough'});
 const r=await f.send({headers:{...headers,'x-codex-turn-state':'X'.repeat(312)}});assert.equal(r.status,200);assert.equal(r.headers.get('x-codex-turn-state').length,312);await r.text();
 assert.deepEqual(f.seen.map(e=>e.probe),[true,false]);assert.equal(f.seen[1].headers['x-codex-turn-state'],'X'.repeat(312));
});
test('authentication, rate-limit and upstream errors do not loop probes',async t=>{
 for(const code of [401,403,429,500])await t.test(String(code),async st=>{const f=await fixture(st,(e,res)=>{res.writeHead(code);res.end();});const r=await f.send();assert.equal(r.status,503);assert.equal((await r.json()).error.reason,'http_'+code);assert.equal(f.seen.length,1);});
});
test('a real upstream failure after preflight success does not replay the original',async t=>{
 const f=await fixture(t,(e,res)=>{if(e.probe)reply(res);else{res.writeHead(500);res.end('failed once');}});const r=await f.send();assert.equal(r.status,500);await r.text();assert.deepEqual(f.seen.map(e=>e.probe),[true,false]);
});
test('disconnected client cancels its wait/probe and no original is ever sent',async t=>{
 let arrive;const arrived=new Promise(r=>arrive=r);const f=await fixture(t,e=>{if(e.probe)arrive();});
 const controller=new AbortController();const req=f.send({signal:controller.signal}).catch(e=>e);await arrived;controller.abort();await req;
 for(let i=0;i<50 && f.app.preflight.waiters;i++)await delay(10);
 assert.equal(f.seen.length,1);assert.equal(f.app.preflight.waiters,0);assert.equal(f.app.preflight.heldBytes,0);
});
test('disabling while waiting cancels probes and sends the unchanged original once',async t=>{
 let arrive;const arrived=new Promise(r=>arrive=r);const f=await fixture(t,(e,res)=>{if(e.probe)arrive();else reply(res);});
 const req=f.send();await arrived;f.app.setMode('off');const r=await req;assert.equal(r.status,200);await r.text();assert.deepEqual(f.seen.map(e=>e.probe),[true,false]);assert.equal(f.seen[1].headers['x-codex-turn-state'],undefined);
});
test('preflight has a total wall-clock deadline and does not forward on timeout',async t=>{
 const f=await fixture(t,()=>{},{maxWaitSeconds:5});const begin=Date.now();const r=await f.send();assert.equal(r.status,503);const reason=(await r.json()).error.reason;assert.ok(['deadline','timeout'].includes(reason));assert.ok(Date.now()-begin<6500);assert.equal(f.seen.length,1);
});
test('shared hourly budget prevents outbound traffic and persists to disk',async t=>{
 const f=await fixture(t,(e,res)=>reply(res));f.app.probes.attempts=Array(30).fill(Date.now());const r=await f.send();assert.equal(r.status,503);assert.equal((await r.json()).error.reason,'hourly_budget');assert.equal(f.seen.length,0);
 f.app.probes.attempts=[];assert.equal(f.app.probes.consumeAttempt(),true);assert.equal(JSON.parse(fs.readFileSync(path.join(f.home,'probe-budget.json'),'utf8')).attempts.length,1);
});
test('unidentified and oversized input is not secretly assigned to astra for preflight',async t=>{
 const f=await fixture(t,(e,res)=>reply(res));const r=await f.send({body:JSON.stringify({input:'ordinary unidentified request'})});await r.text();assert.equal(f.seen.length,1);assert.equal(f.seen[0].probe,false);
});
test('preflight config requires admin auth, CSRF and billable opt-in; disabled configs need no billable acknowledgement',async t=>{
 const f=await fixture(t,(e,res)=>reply(res));const base=f.config.adminOrigin;
 assert.equal((await fetch(base+'/api/preflight')).status,401);
 let r=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'preflight-testing-123!'})});const cookie=r.headers.get('set-cookie').split(';')[0],{csrf}=await r.json();
 const h={cookie,origin:base,'content-type':'application/json'};const body={rules:{[model]:{...defaultPreflight(),enabled:true}}};
 r=await fetch(base+'/api/preflight/config',{method:'POST',headers:h,body:JSON.stringify(body)});assert.equal(r.status,403);
 r=await fetch(base+'/api/preflight/config',{method:'POST',headers:{...h,'x-csrf-token':csrf},body:JSON.stringify(body)});assert.equal(r.status,400);
 body.rules[model].enabled=false;r=await fetch(base+'/api/preflight/config',{method:'POST',headers:{...h,'x-csrf-token':csrf},body:JSON.stringify(body)});assert.equal(r.status,200);await r.text();assert.equal(f.seen.length,0);
});
test('configuration bounds reject unlimited retry and unknown model keys',()=>{
 for(const bad of [{maxAttempts:0},{maxAttempts:11},{maxWaitSeconds:61},{intervalSeconds:0},{cooldownSeconds:0},{failurePolicy:'retry_forever'}])assert.throws(()=>validatePreflight({[model]:{...defaultPreflight(),...bad}}));
 assert.throws(()=>validatePreflight(JSON.parse('{"__proto__":{"enabled":true}}')));
});
