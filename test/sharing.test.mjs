import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {StateStore,defaultRules,validateRules} from '../lib/states.mjs';
import {createExtension} from '../lib/server.mjs';
import {makeConfig} from '../lib/config.mjs';
import {renewalAt} from '../lib/automatic.mjs';
const model='gpt-6-astra', sol='gpt-5.6-sol', A='A'.repeat(292), B='B'.repeat(292);
const credentials=(key='one',session='s1')=>({authorization:'Bearer private-sharing-'+key,session_id:session,'content-type':'application/json'});
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {resolve,promise};}
function reply(res,state=A,m=model){res.writeHead(200,{'content-type':'application/json','x-codex-turn-state':state});res.end(JSON.stringify({model:m,status:'completed'}));}
async function fixture(t,handler=(e,res)=>reply(res,A,e.body.model)){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'model-sharing-')),seen=[],sockets=new Set();
  const origin=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw||'{}');const e={raw,body,headers:req.headers,probe:body.input==='ping'};seen.push(e);await handler(e,res);});
  origin.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});origin.listen(0,'127.0.0.1');await once(origin,'listening');
  const {config}=makeConfig({password:'sharing-fixture-password!',mode:'auto',target:`http://127.0.0.1:${origin.address().port}`});
  const app=await createExtension(config,home,{proxyPort:0,adminPort:0});
  config.adminPort=app.admin.address().port;config.adminOrigin=`http://127.0.0.1:${config.adminPort}`;
  const send=(h=credentials(),m=model,signal)=>fetch(`http://127.0.0.1:${app.proxy.address().port}/responses`,{method:'POST',headers:h,body:JSON.stringify({model:m,input:'PRIVATE USER BODY '+(h.session_id||'none')}),signal});
  const control=async(m,rule,action='save')=>{const response=await fetch(config.adminOrigin+'/api/rules/model',{method:'POST',headers:{'x-turnstate-control':config.controlToken,'content-type':'application/json'},body:JSON.stringify({model:m,action,rule,acknowledgeExperimental:true})});return {status:response.status,data:await response.json()};};
  t.after(async()=>{await app.close(100);for(const s of sockets)s.destroy();origin.closeAllConnections();await new Promise(r=>origin.close(r));fs.rmSync(home,{recursive:true,force:true});});
  return {app,home,config,seen,send,control,ctx:(h=credentials(),m=model)=>app.states.context(m,h)};
}

test('default rules are 3600 seconds and model-shared; missing auth never receives a binding',t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'sharing-store-'));const store=new StateStore(home,'unit-salt');t.after(()=>{store.flush();fs.rmSync(home,{recursive:true,force:true});});
  for(const r of Object.values(defaultRules())){assert.equal(r.ttlSeconds,3600);assert.equal(r.scope,'model');}
  const a=store.context(model,credentials('one','a')),b=store.context(model,credentials('two','b'));
  assert.equal(a.id,b.id);assert.equal(a.id,store.context(model,{authorization:'Bearer another-key'}).id);
  assert.notEqual(a.id,store.context(sol,credentials()).id);assert.equal(store.context(model,{}).id,null);
  for(const scope of ['model','credential','session','turn']){const rules=defaultRules();rules[model].scope=scope;assert.doesNotThrow(()=>validateRules(rules));}
});

test('six concurrent sessions and API keys share one probe, while every original keeps its own auth and bytes',async t=>{
  const arrived=deferred(),release=deferred();const f=await fixture(t,async(e,res)=>{if(e.probe){arrived.resolve();await release.promise;}reply(res);});t.after(()=>release.resolve());
  const hs=Array.from({length:6},(_,i)=>credentials('key'+i,'session'+i));const pending=hs.map(h=>f.send(h));await arrived.promise;
  for(let i=0;i<100&&f.app.automatic.waiters<6;i++)await delay(5);
  assert.equal(f.app.automatic.waiters,6);assert.equal(f.seen.filter(e=>e.probe).length,1);release.resolve();
  for(const r of await Promise.all(pending)){assert.equal(r.status,200);assert.equal(r.headers.get('x-codex-turn-state'),A);await r.text();}
  const originals=f.seen.filter(e=>!e.probe);assert.equal(originals.length,6);
  for(const h of hs){const e=originals.find(e=>e.headers.authorization===h.authorization);assert.ok(e);assert.equal(e.headers.session_id,h.session_id);assert.equal(e.raw,JSON.stringify({model,input:'PRIVATE USER BODY '+h.session_id}));assert.equal(e.headers['x-codex-turn-state'],A);}
  assert.equal(f.app.states.pins.size,1);assert.equal(f.app.automatic.renewals.size,1);assert.equal(f.app.automatic.totals.starts,1);
  const pin=f.app.states.liveForPreflight(f.ctx()),expiry=pin.expiresAt;assert.equal(pin.scope,'model');assert.equal(pin.session,null);
  await (await f.send(credentials('later','new-session'))).text();assert.equal(f.seen.filter(e=>e.probe).length,1);assert.equal(pin.expiresAt,expiry);
  await f.app.journal.flush();const log=fs.readFileSync(path.join(f.home,'records.jsonl'),'utf8');for(const secret of ['private-sharing','PRIVATE USER BODY',A])assert.equal(log.includes(secret),false);
});

test('distinct requested models still have distinct pins and discovery jobs',async t=>{
  const f=await fixture(t);await f.control(sol,{enabled:true,pinLengths:[292],discardLengths:[312]});
  await (await f.send()).text();await (await f.send(credentials('two','s2'),sol)).text();
  assert.equal(f.seen.filter(e=>e.probe).length,2);assert.equal(f.app.states.pins.size,2);assert.notEqual(f.ctx().id,f.ctx(credentials(),sol).id);
});

test('single-model API defaults to 3600/model and accepts editable durations; invalid values do not mutate rules',async t=>{
  const f=await fixture(t);const name='custom-model';let r=await f.control(name,{enabled:false,pinLengths:[280],discardLengths:[]});
  assert.equal(r.status,200);assert.equal(f.app.states.rules[name].ttlSeconds,3600);assert.equal(f.app.states.rules[name].scope,'model');
  for(const seconds of [30,1800,7200,86400]){r=await f.control(name,{ttlSeconds:seconds});assert.equal(r.status,200);assert.equal(f.app.states.rules[name].ttlSeconds,seconds);}
  for(const bad of [0,29,86401,1.5,'3600',null]){r=await f.control(name,{ttlSeconds:bad});assert.equal(r.status,400);assert.equal(f.app.states.rules[name].ttlSeconds,86400);}
  const html=await (await fetch(f.config.adminOrigin)).text();const js=await (await fetch(f.config.adminOrigin+'/app.js')).text();
  assert.match(html,/name="ttlSeconds"[^>]*value="3600"/);assert.match(html,/name="scope"/);assert.match(js,/ttlSeconds,scope:f.scope.value/);
  assert.equal((await fetch(f.config.adminOrigin+'/api/states')).status,401);
});

test('editing TTL keeps the live state, recomputes from capture time and preserves its armed renewal without probes',async t=>{
  const f=await fixture(t);await (await f.send()).text();const old=f.app.states.liveForPreflight(f.ctx());
  const captured=old.capturedAt,fp=old.fingerprint,count=f.seen.length,clock=captured+120000;f.app.states.now=()=>clock;
  const r=await f.control(model,{ttlSeconds:7200});assert.equal(r.status,200);
  const pin=f.app.states.liveForPreflight(f.ctx());assert.equal(pin.fingerprint,fp);assert.equal(pin.capturedAt,captured);assert.equal(pin.expiresAt,captured+7200000);
  const plan=f.app.automatic.snapshot().renewals[0];assert.equal(plan.credentialsReady,true);assert.equal(plan.refreshAt,captured+6600000);
  await (await f.send(credentials('second','other-session'))).text();assert.equal(f.seen.length,count+1);assert.equal(f.app.automatic.totals.starts,1);
  f.app.states.flush();const loaded=new StateStore(f.home,f.config.logSalt,()=>{},()=>clock);assert.equal(loaded.rules[model].ttlSeconds,7200);assert.equal(loaded.liveForPreflight(loaded.context(model,credentials('third'))).state,A);loaded.flush();
});

test('shortening TTL beyond elapsed age never serves an expired pin',async t=>{
  const f=await fixture(t);await (await f.send()).text();const pin=f.app.states.liveForPreflight(f.ctx());f.app.states.now=()=>pin.capturedAt+60000;
  const r=await f.control(model,{ttlSeconds:30});assert.equal(r.status,200);assert.equal(f.app.states.liveForPreflight(f.ctx()),null);assert.equal(f.app.automatic.renewals.size,0);
});

test('explicit session-to-model migration keeps only the newest live state and never extends its old deadline',async t=>{
  const f=await fixture(t);await f.control(model,{scope:'session'});let clock=Date.now();f.app.states.now=()=>clock;
  const c1=f.ctx(credentials('one','a'));f.app.states.adoptProbe(c1,A,model);clock+=1000;
  const c2=f.ctx(credentials('two','b'));f.app.states.adoptProbe(c2,B,model);const old=f.app.states.liveForPreflight(c2),expiry=old.expiresAt;
  await f.app.automatic.ensure(c1,credentials('one','a'),null,'/responses',1);await f.app.automatic.ensure(c2,credentials('two','b'),null,'/responses',1);
  assert.equal(f.app.automatic.renewals.size,2);const r=await f.control(model,{scope:'model',ttlSeconds:7200});assert.equal(r.status,200);
  assert.equal(f.app.states.pins.size,1);const shared=f.app.states.liveForPreflight(f.ctx(credentials('other','c')));assert.equal(shared.state,B);assert.equal(shared.expiresAt,expiry);
  assert.equal(f.app.automatic.renewals.size,1);assert.equal(f.seen.length,0);
});

test('expired or invalidated states are not resurrected when switching to model sharing',async t=>{
  const f=await fixture(t);await f.control(model,{scope:'session'});const ctx=f.ctx();f.app.states.adoptProbe(ctx,A,model);f.app.states.pins.get(ctx.id).expiresAt=0;
  await f.control(model,{scope:'model',ttlSeconds:3600});assert.equal(f.app.states.pins.size,0);
});

test('one disconnected shared waiter does not cancel discovery needed by remaining sessions',async t=>{
  const arrived=deferred(),release=deferred();const f=await fixture(t,async(e,res)=>{if(e.probe){arrived.resolve();await release.promise;}reply(res);});t.after(()=>release.resolve());
  const controller=new AbortController(),p1=f.send(credentials(),model,controller.signal).catch(()=>null);await arrived.promise;
  const p2=f.send(credentials('two','s2'));for(let i=0;i<100&&f.app.automatic.waiters<2;i++)await delay(5);controller.abort();await p1;
  assert.equal([...f.app.automatic.jobs.values()][0].controller.signal.aborted,false);release.resolve();const response=await p2;assert.equal(response.status,200);await response.text();assert.equal(f.seen.filter(e=>e.probe).length,1);
});

test('bad credential cannot revoke another caller shared pin or replace background renewal authentication',async t=>{
  const f=await fixture(t,(e,res)=>{if(e.headers.authorization.includes('rejected')){res.writeHead(401,{'content-type':'application/json'});res.end('{"error":{"code":"invalid_api_key"}}');}else reply(res);});
  await (await f.send()).text();const pin=f.app.states.liveForPreflight(f.ctx()),slot=f.app.automatic.renewals.get(pin.id),expiry=pin.expiresAt;
  const bad=await f.send(credentials('rejected','bad-session'));assert.equal(bad.status,401);await bad.text();
  assert.equal(f.app.states.liveForPreflight(f.ctx()),pin);assert.equal(pin.expiresAt,expiry);assert.equal(f.app.automatic.renewals.get(pin.id),slot);
  assert.equal(slot.routing.headers.authorization,credentials().authorization);await (await f.send()).text();assert.equal(f.seen.filter(e=>e.probe).length,1);
});

test('a failed probe credential does not place other keys behind its auth cooldown',async t=>{
  const f=await fixture(t,(e,res)=>{if(e.headers.authorization.includes('rejected')){res.writeHead(401);res.end();}else reply(res);});
  const bad=await f.send(credentials('rejected'));assert.equal(bad.status,503);await bad.text();const good=await f.send();assert.equal(good.status,200);await good.text();
  assert.equal(f.seen.filter(e=>e.probe).length,2);assert.equal(f.app.states.pins.size,1);
});

test('shared pin has one early renewal while active sessions keep using the old value',async t=>{
  let probes=0;const renewalStarted=deferred(),release=deferred();
  const f=await fixture(t,async(e,res)=>{if(e.probe && ++probes===2){renewalStarted.resolve();await release.promise;return reply(res,B);}reply(res,e.headers['x-codex-turn-state']||A);});t.after(()=>release.resolve());
  await (await f.send()).text();const old=f.app.states.liveForPreflight(f.ctx());f.app.states.now=()=>renewalAt(old);f.app.automatic.tick();await renewalStarted.promise;f.app.automatic.tick();
  const r=await f.send(credentials('two','s2'));assert.equal(r.headers.get('x-codex-turn-state'),A);await r.text();assert.equal(probes,2);
  release.resolve();await Promise.all([...f.app.automatic.jobs.values()].map(j=>j.promise));assert.equal(f.app.states.pins.size,1);assert.equal(f.app.states.liveForPreflight(f.ctx()).state,B);
  assert.equal(f.app.automatic.totals.renewalStarts,1);assert.equal(f.app.automatic.renewals.size,1);f.app.automatic.tick();assert.equal(probes,2);
});

test('a preserved shared pin needs a successful request to arm renewal, never an unverified cache-hit credential',async t=>{
  const f=await fixture(t);const ctx=f.ctx();f.app.states.adoptProbe(ctx,A,model);f.app.states.flush();
  assert.equal(f.app.automatic.renewals.size,0);await f.app.automatic.ensure(ctx,credentials('unverified'),null,'/responses',1);assert.equal(f.app.automatic.renewals.size,0);
  const r=await f.send();await r.text();assert.equal(f.seen.length,1);assert.equal(f.seen[0].probe,false);assert.equal(f.app.automatic.renewals.size,1);
});
