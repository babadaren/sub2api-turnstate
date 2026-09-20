import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {makeConfig} from '../lib/config.mjs';
import {createExtension} from '../lib/server.mjs';
import {StateStore} from '../lib/states.mjs';
import {renewalAt} from '../lib/automatic.mjs';

const sol='gpt-5.6-sol', astra='gpt-6-astra', grey='gpt-6-sol', A='A'.repeat(292), B='B'.repeat(292);
const headers={authorization:'Bearer isolated-model-control-key',session_id:'isolated-test-session','content-type':'application/json'};
const rule={enabled:true,pinLengths:[292],discardLengths:[312],ttlSeconds:3600,scope:'session',unknownPolicy:'pass',autoLearn:false};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const answer=(res,model=grey,state=A)=>{res.writeHead(200,{'content-type':'application/json','x-codex-turn-state':state});res.end(JSON.stringify({model,status:'completed'}));};
async function fixture(t,handler=(e,res)=>answer(res,e.body.model===sol?grey:e.body.model)) {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'model-controls-')),seen=[],sockets=new Set();
 const origin=http.createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw||'{}'),e={body,raw,headers:req.headers,probe:body.input==='ping'};seen.push(e);await handler(e,res);});
 origin.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});origin.listen(0,'127.0.0.1');await once(origin,'listening');
 const {config}=makeConfig({password:'model-control-test-password',mode:'auto',target:`http://127.0.0.1:${origin.address().port}`});
 const app=await createExtension(config,home,{proxyPort:0,adminPort:0});config.adminPort=app.admin.address().port;config.adminOrigin=`http://127.0.0.1:${config.adminPort}`;
 app.states.configure({[astra]:{...rule},[sol]:{...rule}});
 const send=(model=sol,extra={})=>fetch(`http://127.0.0.1:${app.proxy.address().port}/responses`,{method:'POST',headers,body:JSON.stringify({model,input:'ORIGINAL NOT A PROBE',tools:[{type:'function',name:'test_fn'}]}),...extra});
 const control=async(body)=>{const r=await fetch(config.adminOrigin+'/api/rules/model',{method:'POST',headers:{'x-turnstate-control':config.controlToken,'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
 t.after(async()=>{await app.close(100);for(const s of sockets)s.destroy();origin.closeAllConnections();await new Promise(r=>origin.close(r));fs.rmSync(home,{recursive:true,force:true});});
 return {app,home,config,seen,send,control,ctx:model=>app.states.context(model,headers)};
}

test('sol -> 6-sol / 292 is fixed, injected, reused, and recorded without changing request or response model',async t=>{
 const f=await fixture(t),first=await f.send();assert.equal(first.status,200);assert.equal((await first.json()).model,grey);
 assert.deepEqual(f.seen.map(e=>e.probe),[true,false]);assert.equal(f.seen[1].body.model,sol);assert.equal(f.seen[1].headers['x-codex-turn-state'],A);
 const pin=f.app.states.liveForPreflight(f.ctx(sol));assert.equal(pin.verifiedModel,grey);assert.equal(pin.acceptance,'length');assert.equal(pin.model,sol);
 const expiry=pin.expiresAt;await (await f.send()).text();assert.equal(f.seen.length,3);assert.equal(pin.expiresAt,expiry);
 assert.equal(f.app.automatic.snapshot().renewals[0].credentialsReady,true);
 const record=f.app.journal.recent.findLast(r=>r.kind==='request');assert.equal(record.responseModel,grey);assert.equal(record.modelReportedDifferent,true);assert.equal(record.pinInvalidated,false);
 f.app.states.flush();const loaded=new StateStore(f.home,f.config.logSalt);assert.equal(loaded.liveForPreflight(loaded.context(sol,headers)).state,A);loaded.flush();
});

test('all configured models use target lengths, even luna declarations; states never cross requested-model bindings',async t=>{
 const f=await fixture(t,(_e,res)=>answer(res,'gpt-5.6-luna'));
 await (await f.send(sol)).text();await (await f.send(astra)).text();
 assert.equal(f.seen.filter(e=>e.probe).length,2);assert.notEqual(f.ctx(sol).id,f.ctx(astra).id);
 assert.equal(f.app.states.snapshot().pins.length,2);assert.ok(f.app.states.snapshot().pins.every(p=>p.qualified&&p.verifiedModel==='gpt-5.6-luna'));
});

test('target length without response model is accepted only when a successful completion exists',async t=>{
 const f=await fixture(t,(_e,res)=>{res.writeHead(200,{'content-type':'application/json','x-codex-turn-state':A});res.end('{"status":"completed"}');});
 const r=await f.send();assert.equal(r.status,200);await r.text();assert.equal(f.app.states.liveForPreflight(f.ctx(sol)).verifiedModel,null);
});

test('292 with a failed or missing-terminal response is not fixed',async t=>{
 for(const status of ['failed','in_progress'])await t.test(status,async st=>{
  const f=await fixture(st,(_e,res)=>{res.writeHead(200,{'content-type':'application/json','x-codex-turn-state':A});res.end(JSON.stringify({model:grey,status}));});
  const r=await f.send();assert.equal(r.status,503);await r.text();assert.equal(f.app.states.pins.size,0);assert.equal(f.seen.length,1);
 });
});

test('a 312 miss then a 292 grey-model hit works without an equality retry loop',async t=>{
 let probes=0;const f=await fixture(t,(e,res)=>answer(res,grey,e.probe&&++probes===1?'X'.repeat(312):A));
 f.app.automatic.sleep=async()=>{};await (await f.send()).text();assert.equal(probes,2);assert.equal(f.app.automatic.recent[0].lengthMissCount,1);
});

test('different declared model retains proactive renewal through the next fresh state',async t=>{
 const f=await fixture(t,(e,res)=>answer(res,grey,e.probe?B:A));
 const ctx=f.ctx(sol);f.app.states.adoptProbe(ctx,A,grey);const pin=f.app.states.liveForPreflight(ctx);await f.app.automatic.ensure(ctx,headers,null,'/responses',1);
 f.app.automatic.now=()=>renewalAt(pin);f.app.automatic.tick();await Promise.all([...f.app.automatic.jobs.values()].map(j=>j.promise));
 assert.equal(f.app.states.liveForPreflight(ctx).state,B);assert.equal(f.app.states.liveForPreflight(ctx).source,'renewal');assert.equal(f.app.automatic.totals.renewed,1);
});

test('disable retains lengths but clears only that model pin/credentials, including across reload; delete removes rule',async t=>{
 const f=await fixture(t);for(const model of [astra,sol]){const ctx=f.ctx(model);f.app.states.adoptProbe(ctx,A,model===sol?grey:model);await f.app.automatic.ensure(ctx,headers,null,'/responses',1);}
 const other=f.app.states.liveForPreflight(f.ctx(astra)),otherSlot=f.app.automatic.renewals.get(f.ctx(astra).id);
 let r=await f.control({model:sol,action:'disable'});assert.equal(r.status,200);assert.equal(f.app.states.rules[sol].enabled,false);assert.deepEqual(f.app.states.rules[sol].pinLengths,[292]);
 assert.equal(f.app.states.pins.has(f.ctx(sol).id),false);assert.equal(f.app.automatic.renewals.has(f.ctx(sol).id),false);assert.equal(f.app.states.liveForPreflight(f.ctx(astra)),other);assert.equal(f.app.automatic.renewals.get(f.ctx(astra).id),otherSlot);
 const originalState='Q'.repeat(312);await (await f.send(sol,{headers:{...headers,'x-codex-turn-state':originalState}})).text();assert.equal(f.seen.at(-1).probe,false);assert.equal(f.seen.at(-1).headers['x-codex-turn-state'],originalState);
 r=await f.control({model:sol,action:'enable',acknowledgeExperimental:true});assert.equal(r.status,200);assert.equal(f.app.states.rules[sol].enabled,true);
 r=await f.control({model:sol,action:'delete'});assert.equal(r.status,200);assert.equal(Object.hasOwn(f.app.states.rules,sol),false);
 r=await f.control({model:sol,action:'delete'});assert.equal(r.status,200); // idempotent
 f.app.states.flush();const store=new StateStore(f.home,f.config.logSalt);assert.equal(Object.hasOwn(store.rules,sol),false);assert.equal(store.liveForPreflight(store.context(astra,headers)).state,A);store.flush();assert.equal(f.app.mode,'auto');
});

test('disable/delete during a blocked probe releases original once and cannot affect another model plan',async t=>{
 for(const action of ['disable','delete'])await t.test(action,async st=>{
  const arrived=deferred();const f=await fixture(st,(e,res)=>{if(e.probe){arrived.resolve();return;}answer(res,grey,'Q'.repeat(312));});
  const other=f.ctx(astra);f.app.states.adoptProbe(other,A,astra);await f.app.automatic.ensure(other,headers,null,'/responses',1);
  const pending=f.send(sol,{headers:{...headers,'x-codex-turn-state':'Q'.repeat(312)}});await arrived.promise;
  const c=await f.control({model:sol,action});assert.equal(c.status,200);const r=await pending;assert.equal(r.status,200);assert.equal(r.headers.get('x-codex-turn-state'),'Q'.repeat(312));await r.text();
  assert.deepEqual(f.seen.map(e=>e.probe),[true,false]);assert.equal(f.seen[1].headers['x-codex-turn-state'],'Q'.repeat(312));assert.equal(f.app.automatic.renewals.has(other.id),true);assert.equal(f.app.automatic.waiters,0);
 });
});

test('rapid model disable/re-enable does not rewrite a released original or resurrect an old probe',async t=>{
 const arrived=deferred();const f=await fixture(t,(e,res)=>{if(e.probe){arrived.resolve();return;}answer(res,grey,'Q'.repeat(312));});
 const pending=f.send();await arrived.promise;let rules=structuredClone(f.app.states.rules);rules[sol].enabled=false;f.app.states.configure(rules);f.app.automatic.cancelModels([sol],'model_disabled');rules=structuredClone(f.app.states.rules);rules[sol].enabled=true;f.app.states.configure(rules);
 const r=await pending;assert.equal(r.status,200);assert.equal(r.headers.get('x-codex-turn-state'),'Q'.repeat(312));await r.text();assert.equal(f.app.states.pins.size,0);
});

test('disabling model during already-forwarded request prevents late response rewrite and capture',async t=>{
 const arrived=deferred(),release=deferred();const f=await fixture(t,async(_e,res)=>{arrived.resolve();await release.promise;answer(res,grey,'Q'.repeat(312));});t.after(()=>release.resolve());
 f.app.states.adoptProbe(f.ctx(sol),A,grey);const pending=f.send();await arrived.promise;await f.control({model:sol,action:'disable'});release.resolve();
 const r=await pending;assert.equal(r.headers.get('x-codex-turn-state'),'Q'.repeat(312));await r.text();assert.equal(f.app.states.pins.size,0);assert.equal(f.seen.length,1);
});

test('single-model save respects disabled checkbox, preserves others, and management still requires auth and CSRF',async t=>{
 const f=await fixture(t);const data={model:sol,action:'save',rule:{...rule,enabled:false},acknowledgeExperimental:true};
 const base=f.config.adminOrigin;assert.equal((await fetch(base+'/api/rules/model',{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify(data)})).status,401);
 const login=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'model-control-test-password'})});const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
 const h={cookie,origin:base,'content-type':'application/json'};
 assert.equal((await fetch(base+'/api/rules/model',{method:'POST',headers:h,body:JSON.stringify(data)})).status,403);
 const r=await fetch(base+'/api/rules/model',{method:'POST',headers:{...h,'x-csrf-token':csrf},body:JSON.stringify(data)});assert.equal(r.status,200);await r.text();assert.equal(f.app.states.rules[sol].enabled,false);assert.equal(f.app.states.rules[astra].enabled,true);
 const html=await (await fetch(base)).text(),js=await (await fetch(base+'/app.js')).text();assert.match(html,/name="enabled"/);assert.match(js,/button\('删除'/);assert.match(js,/\?'停用':'启用'/);
 assert.equal((await f.control({model:'__proto__',action:'delete'})).status,400);assert.equal((await f.control({model:sol,action:'enable'})).status,400);
});
