import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { makeConfig } from '../lib/config.mjs';
import { createExtension } from '../lib/server.mjs';
import { ResponseMetadata } from '../lib/response-meta.mjs';
import { pinInvalidationReason } from '../lib/failure-policy.mjs';
import { renewalAt } from '../lib/automatic.mjs';

const model='gpt-6-astra', A='A'.repeat(292), B='B'.repeat(292);
const headers={authorization:'Bearer test-private-invalidation-key',session_id:'test-private-invalidation-session','content-type':'application/json'};
const original=JSON.stringify({model,input:'PRIVATE ORIGINAL BODY'});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const event=value=>'data: '+JSON.stringify(value)+'\n\n';
const failure=(error={code:'server_error'},kind='response.failed')=>event({type:'response.created',response:{model,status:'in_progress'}})+event(
  kind==='error'?{type:'error',...error}:{type:kind,response:{model,status:kind==='response.incomplete'?'incomplete':'failed',
    ...(kind==='response.incomplete'?{incomplete_details:error}:{error})}});
function sendFailure(res,body=failure(),status=200){res.writeHead(status,{'content-type':'text/event-stream','x-request-id':'synthetic-request-id'});res.end(body);}
function success(res,state=A){res.writeHead(200,{'content-type':'application/json','x-codex-turn-state':state});res.end(JSON.stringify({model,status:'completed'}));}
async function fixture(t,handler){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'invalidation-')),seen=[],sockets=new Set();
  const upstream=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw||'{}');
    const e={raw,body,headers:req.headers,probe:body.input==='ping'};seen.push(e);await handler(e,res,seen.length);});
  upstream.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const {config}=makeConfig({password:'invalidation-test-password!',mode:'auto',target:`http://127.0.0.1:${upstream.address().port}`});
  const app=await createExtension(config,home,{proxyPort:0,adminPort:0});
  const rules=structuredClone(app.states.rules);rules[model].ttlSeconds=3600;app.states.configure(rules);
  const ctx=app.states.context(model,headers);app.states.adoptProbe(ctx,A,model);const pin=app.states.pins.get(ctx.id);
  t.after(async()=>{await app.close(100);for(const s of sockets)s.destroy();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));fs.rmSync(home,{recursive:true,force:true});});
  return {app,ctx,pin,home,seen,send:()=>fetch(`http://127.0.0.1:${app.proxy.address().port}/responses`,{method:'POST',headers,body:original})};
}

test('generic same-model SSE failures keep the exact live pin and renewal plan without extra probes',async t=>{
  const cases=[['server_error',failure({code:'server_error',message:'PRIVATE ERROR CONTENT'})],
    ['flat error',failure({code:'server_error',message:'PRIVATE ERROR CONTENT'},'error')],
    ['context limit',failure({code:'context_length_exceeded'})],
    ['quota',failure({code:'insufficient_quota'})],
    ['content filter',failure({reason:'content_filter'},'response.incomplete')],
    ['unknown incomplete',failure({reason:'unrecognized_private_reason'},'response.incomplete')],
    ['uncoded failure',failure({message:'x-codex-turn-state expired (untrusted free-form text)'})]];
  for(const [name,body] of cases)await t.test(name,async st=>{
    const f=await fixture(st,(_e,res,n)=>n===1?sendFailure(res,body):success(res));
    const expiry=f.pin.expiresAt,refreshAt=renewalAt(f.pin);const r=await f.send();assert.equal(r.status,200);assert.equal(await r.text(),body);
    const record=f.app.journal.recent.findLast(x=>x.kind==='request');
    assert.equal(record.responseFailed,true);assert.equal(record.pinInvalidated,false);assert.equal(record.pinDecision,'retained');
    assert.equal(f.app.states.liveForPreflight(f.ctx),f.pin);assert.equal(f.pin.expiresAt,expiry);
    assert.equal(f.app.automatic.snapshot().renewals[0].refreshAt,refreshAt);
    const next=await f.send();assert.equal(next.status,200);await next.text();assert.equal(f.seen.length,2);assert.ok(f.seen.every(x=>!x.probe));
    assert.equal(f.app.automatic.totals.starts,0);assert.equal(f.app.journal.total.failures,1);
    assert.equal(f.app.journal.recent.filter(x=>x.action==='invalidated_response').length,0);
  });
});

test('generic HTTP errors including 409 do not invalidate a live state or replay original requests',async t=>{
  for(const status of [400,409,429,500,503])await t.test(String(status),async st=>{
    const f=await fixture(st,(_e,res,n)=>{if(n===1){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'server_error'}}));}else success(res);});
    const expiry=f.pin.expiresAt,r=await f.send();assert.equal(r.status,status);await r.text();assert.equal(f.app.states.liveForPreflight(f.ctx),f.pin);
    assert.equal(f.pin.expiresAt,expiry);const next=await f.send();await next.text();assert.equal(f.seen.length,2);assert.ok(f.seen.every(x=>!x.probe));
  });
});

test('structured state rejection invalidates once and next request discovers a replacement once',async t=>{
  const body=failure({code:'invalid_value',type:'invalid_request_error',param:'x-codex-turn-state',message:'PRIVATE RAW STATE '+A});
  const f=await fixture(t,(e,res,n)=>n===1?sendFailure(res,body):success(res,B));
  const expiry=f.pin.expiresAt;const r=await f.send();assert.equal(await r.text(),body);assert.equal(f.app.states.liveForPreflight(f.ctx),null);
  const invalid=f.app.journal.recent.filter(x=>x.action==='invalidated_response');assert.equal(invalid.length,1);
  const request=f.app.journal.recent.findLast(x=>x.kind==='request');
  assert.equal(invalid[0].reason,'explicit_turn_state_error');assert.equal(invalid[0].previousExpiresAt,expiry);
  assert.equal(invalid[0].requestRecordId,request.id);assert.equal(invalid[0].upstreamRequestId,'synthetic-request-id');
  assert.equal(invalid[0].errorCode,'invalid_value');assert.equal(request.pinInvalidated,true);
  const next=await f.send();assert.equal(next.status,200);await next.text();assert.deepEqual(f.seen.map(x=>x.probe),[false,true,false]);
  assert.equal(f.app.states.liveForPreflight(f.ctx).state,B);
  await f.app.journal.flush();const log=fs.readFileSync(path.join(f.home,'records.jsonl'),'utf8');
  for(const secret of ['test-private-invalidation-key','test-private-invalidation-session','PRIVATE RAW STATE',A,'PRIVATE ORIGINAL BODY'])assert.equal(log.includes(secret),false);
});

test('HTTP 401/403 retain conservative auth invalidation but create only one state event per pin',async t=>{
  for(const code of [401,403])await t.test(String(code),async st=>{
    const f=await fixture(st,(_e,res)=>sendFailure(res,failure({code:'authentication_error'}),code));
    const r=await f.send();assert.equal(r.status,code);await r.text();assert.equal(f.pin.pending,true);
    const events=f.app.journal.recent.filter(x=>x.action==='invalidated_response');assert.equal(events.length,1);
    assert.equal(events[0].reason,'http_'+code);assert.equal(f.seen.length,1);
  });
});

test('concurrent explicit failures of the same pin emit one invalidation, not duplicate tasks',async t=>{
  const ready=deferred(),release=deferred();let arrived=0;
  const f=await fixture(t,async(e,res)=>{if(e.probe)return success(res,B);if(++arrived<=2){if(arrived===2)ready.resolve();await release.promise;sendFailure(res,failure({code:'turn_state_expired'}));}else success(res,B);});
  t.after(()=>release.resolve());const a=f.send(),b=f.send();await ready.promise;release.resolve();
  for(const r of await Promise.all([a,b]))await r.text();
  assert.equal(f.app.journal.recent.filter(x=>x.action==='invalidated_response').length,1);
  const requests=f.app.journal.recent.filter(x=>x.kind==='request');assert.equal(requests.filter(x=>x.pinInvalidated).length,1);
  assert.equal(f.app.automatic.totals.starts,0);
  const r=await f.send();await r.text();assert.equal(f.seen.filter(x=>x.probe).length,1);
});

test('same request failure does not revoke the replacement acquired during its stream',async t=>{
  const arrived=deferred(),release=deferred();const f=await fixture(t,async(_e,res)=>{arrived.resolve();await release.promise;sendFailure(res,failure({code:'invalid_turn_state'}));});
  t.after(()=>release.resolve());const request=f.send();await arrived.promise;f.app.states.adoptProbe(f.ctx,B,model);const newer=f.app.states.pins.get(f.ctx.id);release.resolve();
  await (await request).text();assert.equal(f.app.states.liveForPreflight(f.ctx),newer);assert.equal(newer.state,B);
  assert.equal(f.app.journal.recent.filter(x=>x.action==='invalidated_response').length,0);
});

test('response-model differences and conflicts are diagnostic only in length mode',async t=>{
  for(const conflict of [false,true])await t.test(conflict?'conflict':'mismatch',async st=>{
    const text=(conflict?event({type:'response.created',response:{model}}):'')+event({type:'response.completed',response:{model:'gpt-5.6-luna',status:'completed'}});
    const f=await fixture(st,(_e,res)=>sendFailure(res,text));await (await f.send()).text();
    assert.equal(f.app.states.liveForPreflight(f.ctx),f.pin);assert.equal(f.seen.length,1);
    assert.equal(f.app.journal.recent.filter(x=>x.action==='invalidated_response').length,0);assert.equal(f.app.journal.recent.findLast(x=>x.kind==='request').responseModelConflict,conflict);
  });
});

test('explicit SSE state rejection is acted on before terminal EOF, even if client disconnects',async t=>{
  const emitted=deferred();const f=await fixture(t,(_e,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write(failure({code:'turn_state_expired'}));emitted.resolve();});
  const r=await f.send();await emitted.promise;await delay(15);assert.equal(f.pin.pending,true);await r.body.cancel();
  assert.equal(f.app.journal.recent.filter(x=>x.action==='invalidated_response').length,1);
});

test('off switch suppresses late invalidation and extra probing',async t=>{
  const arrived=deferred(),release=deferred();const f=await fixture(t,async(_e,res)=>{arrived.resolve();await release.promise;sendFailure(res,failure({code:'turn_state_expired'}));});
  t.after(()=>release.resolve());const p=f.send();await arrived.promise;f.app.setMode('off');release.resolve();await (await p).text();
  assert.equal(f.pin.pending,false);assert.equal(f.app.journal.recent.filter(x=>x.action==='invalidated_response').length,0);
});

test('metadata retains only bounded enum codes; messages and unknown field values cannot enter logs',()=>{
  const m=new ResponseMetadata({'content-type':'text/event-stream'});
  m.push(Buffer.from(failure({code:'private_key_with_underscores',type:'secret-token-type',param:'private-request-value',message:'private_body'})));
  m.end();assert.equal(m.failed,true);assert.equal(m.errorCode,'other');assert.equal(m.errorType,'other');assert.equal(m.errorParam,'other');
  assert.equal(pinInvalidationReason(200,m,model),null);for(const text of ['private_key','secret-token','private-request','private_body'])assert.equal(JSON.stringify(m).includes(text),false);
  const explicit=new ResponseMetadata({'content-type':'application/json'});explicit.push(Buffer.from(JSON.stringify({error:{code:'invalid_request_error',param:'x-codex-turn-state'}})));explicit.end();
  assert.equal(pinInvalidationReason(400,explicit,model),'explicit_turn_state_error');
  const harmless=new ResponseMetadata({'content-type':'application/json'});harmless.push(Buffer.from(JSON.stringify({error:{code:'server_error',param:'x-codex-turn-state',message:'invalid_turn_state'}})));harmless.end();
  assert.equal(pinInvalidationReason(500,harmless,model),null);
});
