import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { AutomaticGate, renewalAt, renewalLeadMs } from '../lib/automatic.mjs';
import { StateStore } from '../lib/states.mjs';
import { Journal } from '../lib/journal.mjs';
import { makeConfig } from '../lib/config.mjs';
import { createExtension } from '../lib/server.mjs';

const model='gpt-6-astra', A='A'.repeat(292), B='B'.repeat(292), C='C'.repeat(292);
const headers={authorization:'Bearer renewal-private-key',session_id:'renewal-private-session'};
const hit=state=>({status:200,length:state.length,responseModel:model,accepted:true,completed:true,state});
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function abortable(signal){return new Promise(resolve=>{if(signal.aborted)return resolve();signal.addEventListener('abort',resolve,{once:true});});}
function fixture(t,probe=async()=>hit(B),options={}) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'renewal-'));
  const {config}=makeConfig({password:'renewal-testing-password!'});
  let clock=1800000000000, enabled=true;
  const journal=new Journal(home,config), states=new StateStore(home,config.logSalt,e=>journal.add(e),()=>clock);
  const rules=states.rules;rules[model].ttlSeconds=3600;states.configure(rules);
  const ctx=states.context(model,headers);states.adoptProbe(ctx,A,model);
  const gate=new AutomaticGate(config,states,journal,()=>enabled,{scheduler:false,now:()=>clock,probe,sleep:async()=>{},...options});
  t.after(async()=>{await gate.close();states.flush();await journal.flush();fs.rmSync(home,{recursive:true,force:true});});
  return {home,config,states,journal,gate,ctx,get now(){return clock;},setNow:v=>clock=v,
    disable:()=>{enabled=false;gate.cancel('disabled');},enable:()=>{enabled=true;},
    arm:()=>gate.ensure(ctx,headers,{prompt_cache_key:'routing-only'},'/responses',128),
    due:()=>{clock=renewalAt(states.pins.get(ctx.id));gate.tick();},
    finish:()=>Promise.all([...gate.jobs.values()].map(j=>j.promise))};
}

test('one-hour pin renews exactly ten minutes early; shorter TTLs do not cause immediate refresh loops',()=>{
  assert.equal(renewalLeadMs({capturedAt:0,expiresAt:3600000}),600000);
  assert.equal(renewalAt({capturedAt:0,expiresAt:3600000}),3000000);
  assert.equal(renewalAt({capturedAt:0,expiresAt:300000}),200000);
});

test('timer tick starts renewal without a new request; live old pin remains a cache hit while probing',async t=>{
  const hold=deferred();let calls=0;
  const f=fixture(t,async()=>{calls++;await hold.promise;return hit(B);});t.after(()=>hold.resolve());
  await f.arm();const old=f.states.pins.get(f.ctx.id);
  f.setNow(old.expiresAt-600001);f.gate.tick();assert.equal(calls,0);
  f.setNow(old.expiresAt-600000);f.gate.tick();assert.equal(calls,1);
  assert.equal((await f.arm()).action,'cache_hit');assert.equal(f.states.liveForPreflight(f.ctx).state,A);
  assert.equal(f.gate.snapshot().activeJobs[0].purpose,'renewal');
  hold.resolve();await f.finish();const next=f.states.pins.get(f.ctx.id);
  assert.equal(next.state,B);assert.equal(next.source,'renewal');assert.equal(next.expiresAt,f.now+3600000);
  assert.equal(f.gate.snapshot().renewals[0].refreshAt,f.now+3000000);assert.equal(f.gate.totals.renewed,1);
});

test('wrong model, wrong length, and repeated identical 292 do not discard or extend the old pin',async t=>{
  let n=0, f;
  f=fixture(t,async()=>{
    n++;assert.equal(f.states.pins.get(f.ctx.id).state,A);assert.equal(f.states.pins.get(f.ctx.id).expiresAt,1800003600000);
    if(n===1)return {status:200,length:292,responseModel:'gpt-5.6-luna',error:'model_mismatch'};
    if(n===2)return {status:200,length:312,responseModel:model,error:'length_miss'};
    return hit(n===3?A:B);
  });
  await f.arm();f.due();await f.finish();assert.equal(n,4);
  const job=f.gate.snapshot().recent[0];assert.equal(job.mismatchCount,1);assert.equal(job.lengthMissCount,1);assert.equal(job.unchangedCount,1);
  assert.equal(f.states.pins.get(f.ctx.id).state,B);
});

test('expiry during renewal joins the existing job, never uses an expired pin or launches duplicate probes',async t=>{
  const hold=deferred();let calls=0;const f=fixture(t,async()=>{calls++;await hold.promise;return hit(B);});t.after(()=>hold.resolve());
  await f.arm();const expires=f.states.pins.get(f.ctx.id).expiresAt;f.due();f.setNow(expires+1);
  const waiting=f.gate.ensure(f.ctx,headers,null,'/responses',64);
  assert.equal(f.states.liveForPreflight(f.ctx),null);assert.equal(f.gate.waiters,1);assert.equal(calls,1);
  hold.resolve();const result=await waiting;assert.equal(result.allow,true);assert.equal(calls,1);assert.equal(f.states.liveForPreflight(f.ctx).state,B);
});

test('a disconnected foreground waiter does not cancel independently scheduled renewal',async t=>{
  const hold=deferred();const f=fixture(t,async()=>{await hold.promise;return hit(B);});t.after(()=>hold.resolve());
  await f.arm();const expires=f.states.pins.get(f.ctx.id).expiresAt;f.due();f.setNow(expires+1);
  const controller=new AbortController(),waiting=f.gate.ensure(f.ctx,headers,null,'/responses',64,controller.signal);
  controller.abort();assert.equal((await waiting).reason,'client_disconnected');
  assert.equal([...f.gate.jobs.values()][0].controller.signal.aborted,false);
  hold.resolve();await f.finish();assert.equal(f.states.pins.get(f.ctx.id).state,B);
});

test('a newer pin captured during renewal wins; a late renewal cannot overwrite it',async t=>{
  const hold=deferred();const f=fixture(t,async()=>{await hold.promise;return hit(B);});t.after(()=>hold.resolve());
  await f.arm();f.due();f.states.adoptProbe(f.ctx,C,model);hold.resolve();await f.finish();
  assert.equal(f.states.pins.get(f.ctx.id).state,C);assert.equal(f.gate.snapshot().recent[0].status,'superseded');
});

test('late ordinary response using old state cannot roll a renewed pin back',async t=>{
  const f=fixture(t);await f.arm();const old=f.states.pins.get(f.ctx.id);f.due();await f.finish();
  f.states.captureAutomatic(f.ctx,A,model,old);
  assert.equal(f.states.pins.get(f.ctx.id).state,B);
  f.states.invalidateUsedPin(f.ctx,old.fingerprint);
  assert.equal(f.states.liveForPreflight(f.ctx).state,B);
});

test('a repeated expired state from an ordinary response is not assigned a new one-hour lifetime',async t=>{
  const f=fixture(t);const old=f.states.pins.get(f.ctx.id),expires=old.expiresAt;f.setNow(expires+1);
  f.states.captureAutomatic(f.ctx,A,model,old);assert.equal(old.expiresAt,expires);assert.equal(f.states.liveForPreflight(f.ctx),null);
});

test('renewal network failure preserves old pin and honors Retry-After before another timer attempt',async t=>{
  let calls=0;const f=fixture(t,async()=>{calls++;return {status:429,error:'http_429',retryAfterMs:180000};});
  await f.arm();const old=f.states.pins.get(f.ctx.id);f.due();await f.finish();assert.equal(f.states.pins.get(f.ctx.id),old);
  const at=f.now;f.setNow(at+179999);f.gate.tick();assert.equal(calls,1);
  f.setNow(at+180000);f.gate.tick();await f.finish();assert.equal(calls,2);assert.equal(old.expiresAt,1800003600000);
});

test('rejected credentials stop background renewal without deleting the old state',async t=>{
  let calls=0;const f=fixture(t,async()=>{calls++;return {status:401,error:'http_401'};});
  await f.arm();f.due();await f.finish();assert.equal(f.gate.renewals.size,0);assert.equal(f.states.pins.get(f.ctx.id).state,A);
  f.setNow(f.now+120000);f.gate.tick();assert.equal(calls,1);assert.equal(f.gate.snapshot().renewals[0].status,'waiting_credentials');
});

test('off cancels timer work and discards all remembered credentials; late completion cannot adopt',async t=>{
  let routing;const f=fixture(t,async(_target,_model,r,_endpoint,_lengths,signal)=>{routing=r;await abortable(signal);return hit(B);});
  await f.arm();f.due();f.disable();await f.finish();assert.equal(f.gate.renewals.size,0);assert.deepEqual(routing.headers,{});
  assert.equal(f.states.pins.get(f.ctx.id).state,A);f.enable();f.gate.tick();assert.equal(f.gate.jobs.size,0);
});

test('rule/manual-refresh generation invalidation prevents a stale renewal from restoring state',async t=>{
  const hold=deferred();const f=fixture(t,async()=>{await hold.promise;return hit(B);});t.after(()=>hold.resolve());
  await f.arm();f.due();f.states.refresh({model});f.gate.cancel('configuration_changed');hold.resolve();await f.finish();
  assert.equal(f.states.liveForPreflight(f.states.context(model,headers)),null);assert.equal(f.states.pins.get(f.ctx.id).state,A);
});

test('restart has no replay credentials; first matching real request re-arms preserved pin',async t=>{
  const f=fixture(t);await f.arm();f.states.flush();await f.gate.close();
  let calls=0;const restarted=new AutomaticGate(f.config,f.states,f.journal,()=>true,{scheduler:false,now:()=>f.now,probe:async()=>{calls++;return hit(B);}});
  t.after(()=>restarted.close());f.setNow(renewalAt(f.states.pins.get(f.ctx.id)));restarted.tick();assert.equal(calls,0);
  assert.equal(restarted.snapshot().renewals[0].status,'waiting_credentials');
  await restarted.ensure(f.ctx,headers,null,'/responses',1);restarted.tick();await Promise.all([...restarted.jobs.values()].map(j=>j.promise));assert.equal(calls,1);
});

test('routing identities are isolated and secrets are absent from snapshots, journal, and all persisted files',async t=>{
  const seen=[];const f=fixture(t,async(_target,_model,r)=>{seen.push(r.headers.authorization);return hit(B);});
  const other={authorization:'Bearer second-renewal-private-key',session_id:'other-session'},ctx2=f.states.context(model,other);
  f.states.adoptProbe(ctx2,A,model);await f.arm();await f.gate.ensure(ctx2,other,null,'/v1/responses',1);
  f.due();await f.finish();assert.deepEqual(new Set(seen),new Set([headers.authorization,other.authorization]));
  f.states.flush();await f.journal.flush();const text=JSON.stringify(f.gate.snapshot())+fs.readdirSync(f.home).map(name=>fs.readFileSync(path.join(f.home,name),'utf8')).join('');
  // Raw states are intentionally private in states.json; only routing secrets
  // must be absent from every file. No full state appears in the public snapshot.
  for(const secret of ['renewal-private-key','renewal-private-session','second-renewal-private-key','other-session'])assert.equal(text.includes(secret),false);
  assert.equal(JSON.stringify(f.gate.snapshot()).includes(B),false);
});

test('real daemon timer initiates a due renewal without another model request',async t=>{
  let calls=0;const f=fixture(t,async()=>{calls++;return hit(B);},{scheduler:true});
  await f.arm();f.setNow(renewalAt(f.states.pins.get(f.ctx.id)));
  for(let i=0;i<60&&!calls;i++)await delay(25);
  await f.finish();assert.equal(calls,1);assert.equal(f.states.pins.get(f.ctx.id).state,B);
});

test('HTTP request already using A returns A even if timer swaps B before response; future requests use B',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'renewal-http-')),arrived=deferred(),release=deferred(),seen=[];
  const origin=http.createServer(async(req,res)=>{for await(const _ of req){}seen.push(req.headers['x-codex-turn-state']);if(seen.length===1){arrived.resolve();await release.promise;}
    res.writeHead(200,{'content-type':'application/json','x-codex-turn-state':A});res.end(JSON.stringify({model,status:'completed'}));});
  origin.listen(0,'127.0.0.1');await once(origin,'listening');
  const {config}=makeConfig({password:'renewal-http-password!',mode:'auto',target:`http://127.0.0.1:${origin.address().port}`});
  const app=await createExtension(config,home,{proxyPort:0,adminPort:0});const ctx=app.states.context(model,headers);app.states.adoptProbe(ctx,A,model);
  const send=()=>fetch(`http://127.0.0.1:${app.proxy.address().port}/responses`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({model,input:'ordinary'})});
  t.after(async()=>{release.resolve();await app.close(100);origin.closeAllConnections();await new Promise(r=>origin.close(r));fs.rmSync(home,{recursive:true,force:true});});
  const request=send();await arrived.promise;app.states.adoptProbe(ctx,B,model);release.resolve();const result=await request;
  assert.equal(result.headers.get('x-codex-turn-state'),A);await result.text();assert.equal(app.states.pins.get(ctx.id).state,B);
  const renewed=app.states.pins.get(ctx.id),expiry=renewed.expiresAt;
  const next=await send();assert.equal(next.headers.get('x-codex-turn-state'),B);await next.text();assert.deepEqual(seen,[A,B]);
  // The second request was dispatched AFTER renewal, but upstream still echoed A.
  // This is distinct from the first in-flight request and must not roll B back.
  assert.equal(app.states.pins.get(ctx.id),renewed);
  assert.equal(renewed.state,B);assert.equal(renewed.expiresAt,expiry);
  const third=await send();await third.text();assert.deepEqual(seen,[A,B,B]);
  assert.equal(app.states.pins.get(ctx.id).state,B);
});
