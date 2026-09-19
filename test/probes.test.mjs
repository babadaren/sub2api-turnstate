import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { makeConfig } from '../lib/config.mjs';
import { StateStore } from '../lib/states.mjs';
import { ProbeManager } from '../lib/probes.mjs';
import { ResponseMetadata } from '../lib/response-meta.mjs';
import { Journal } from '../lib/journal.mjs';
import { createExtension } from '../lib/server.mjs';
const model='gpt-6-astra';
const input=extra=>({model,source:'manual',apiKey:'unit-private-key',sessionId:'unit-session',maxAttempts:3,acknowledgeBillable:true,acknowledgeExperimental:true,...extra});
const read=async req=>{let raw='';for await(const chunk of req)raw+=chunk;return JSON.parse(raw);};
async function fixture(t, handler){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'probe-test-')), sockets=new Set();
 const origin=http.createServer(handler);origin.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
 origin.listen(0,'127.0.0.1');await once(origin,'listening');
 const {config}=makeConfig({password:'probe-test-password-123!',target:`http://127.0.0.1:${origin.address().port}`});
 const journal=new Journal(home,config),states=new StateStore(home,config.logSalt,r=>journal.add(r));
 const manager=new ProbeManager(config,states,journal,()=> 'pin');
 t.after(async()=>{await manager.close();states.flush();await journal.flush();for(const s of sockets)s.destroy();origin.closeAllConnections();await new Promise(r=>origin.close(r));fs.rmSync(home,{force:true,recursive:true});});
 return{home,config,states,journal,manager};
}
function success(res, length=292, responseModel=model){res.writeHead(200,{'content-type':'application/json','x-codex-turn-state':'P'.repeat(length)});res.end(JSON.stringify({model:responseModel,status:'completed'}));}

test('bounded response metadata is read-only, supports SSE/JSON and hides output text',()=>{
 const m=new ResponseMetadata({'content-type':'text/event-stream'});
 m.push(Buffer.from('event: response.created\ndata: {"type":"response.created","response":{"model":"gpt-5.6-luna"}}\n\n'));
 m.push(Buffer.from('data: {"type":"response.completed","response":{"model":"gpt-5.6-luna","status":"completed"}}\n\n'));
 m.end();assert.equal(m.model,'gpt-5.6-luna');assert.equal(m.completed,true);assert.equal(m.buffer,'');
 const b=new ResponseMetadata({'content-type':'application/json'},100);b.push(Buffer.from('x'.repeat(1024)));assert.equal(b.truncated,true);assert.equal(b.buffer,'');
});

test('serial probe misses 312 then pins 292 for exact model and credential/session without replaying stale state',async t=>{
 const seen=[];
 const f=await fixture(t,async(req,res)=>{seen.push({body:await read(req),headers:req.headers,url:req.url});success(res,seen.length===1?312:292);});
 const old=process.env.HTTP_PROXY;process.env.HTTP_PROXY='http://127.0.0.1:1';t.after(()=>{if(old===undefined)delete process.env.HTTP_PROXY;else process.env.HTTP_PROXY=old;});
 f.manager.start(input());await f.manager.pending;
 assert.equal(seen.length,2);assert.equal(f.manager.snapshot().job.status,'found');
 for(const r of seen){assert.equal(r.body.model,model);assert.equal(r.body.input,'ping');assert.equal(r.body.max_output_tokens,16);assert.equal(r.headers['x-codex-turn-state'],undefined);assert.equal(r.headers.authorization,'Bearer unit-private-key');assert.equal(r.url,'/responses');}
 const ctx=f.states.context(model,{authorization:'Bearer unit-private-key',session_id:'unit-session'});
 assert.equal(f.states.decide(ctx,'','request','pin').outgoingLength,292);
 const foreign=f.states.context(model,{authorization:'Bearer other-private-key',session_id:'unit-session'});
 assert.equal(f.states.decide(foreign,'','request','pin').outgoingLength,0);
 assert.equal(f.states.snapshot().pins[0].source,'probe');
 await f.journal.flush();const journal=fs.readFileSync(path.join(f.home,'records.jsonl'),'utf8');
 for(const secret of ['unit-private-key','unit-session','P'.repeat(292)]){assert.equal(journal.includes(secret),false);assert.equal(JSON.stringify(f.manager.snapshot()).includes(secret),false);}
});

test('model mismatch cannot seed astra even when response state length is 292',async t=>{
 let calls=0;const f=await fixture(t,async(req,res)=>{await read(req);calls++;success(res,292,'gpt-5.6-luna');});
 f.manager.start(input());await f.manager.pending;
 assert.equal(calls,3);assert.equal(f.manager.snapshot().job.status,'exhausted');assert.equal(f.manager.snapshot().job.mismatchCount,3);assert.equal(f.states.snapshot().pins.length,0);
});

test('missing response model and error events cannot create pins',async t=>{
 const f=await fixture(t,async(req,res)=>{await read(req);res.writeHead(200,{'content-type':'text/event-stream','x-codex-turn-state':'P'.repeat(292)});res.end('data: {"type":"error","error":{"code":"test"}}\n\n');});
 f.manager.start(input());await f.manager.pending;assert.equal(f.manager.snapshot().job.status,'response_failed');assert.equal(f.states.snapshot().pins.length,0);
});

test('authentication/rate limit/server failures are never looped or followed',async t=>{
 for(const status of [401,403,429,500,302]){
  await t.test(String(status),async st=>{let calls=0;const f=await fixture(st,async(req,res)=>{await read(req);calls++;res.writeHead(status,{location:'http://127.0.0.1:1/private'});res.end();});f.manager.start(input());await f.manager.pending;assert.equal(calls,1);assert.equal(f.manager.snapshot().job.status,'http_'+status);assert.equal(f.states.snapshot().pins.length,0);});
 }
});

test('next-request probe binds only the explicitly selected model/session, ignoring luna and other credentials',async t=>{
 let calls=0;const f=await fixture(t,async(req,res)=>{await read(req);calls++;success(res);});
 const headers={authorization:'Bearer unit-private-key',session_id:'unit-session', 'x-codex-turn-state':'S'.repeat(312)};
 const ctx=f.states.context(model,headers);f.manager.remember(ctx);
 f.manager.start(input({source:'next_request',bindingId:ctx.id,apiKey:undefined,sessionId:undefined}));
 assert.equal(f.manager.snapshot().job.status,'waiting_request');assert.equal(calls,0);
 f.manager.trigger(f.states.context('gpt-5.6-luna',headers),headers,null);
 f.manager.trigger(f.states.context(model,{...headers,authorization:'Bearer another-key'}),headers,null);
 assert.equal(calls,0);assert.equal(f.manager.snapshot().job.status,'waiting_request');
 f.manager.trigger(ctx,headers,null);await f.manager.pending;assert.equal(calls,1);assert.equal(f.manager.snapshot().job.status,'found');
});

test('probe confirmation, scope, length, concurrency and rate limits are enforced before requests',async t=>{
 const f=await fixture(t,async(req,res)=>{await read(req);success(res);});
 for(const args of [{acknowledgeBillable:false},{acknowledgeExperimental:false},{maxAttempts:0},{maxAttempts:1.5},{maxAttempts:Number.MAX_SAFE_INTEGER+1},{maxRunSeconds:3601},{intervalSeconds:0},{sessionId:''},{model:'gpt-5.6-sol'},{targetLengths:[312]}])assert.throws(()=>f.manager.start(input(args)));
 const ctx=f.states.context(model,{authorization:'Bearer unit-private-key',session_id:'unit-session'});f.manager.remember(ctx);
 f.manager.start(input({source:'next_request',bindingId:ctx.id}));assert.throws(()=>f.manager.start(input()));f.manager.stop();
 assert.throws(()=>f.manager.start(input()),/cooldown/);assert.equal(f.manager.snapshot().job.tried,0);
});

test('cancel aborts an in-flight probe and preserves pre-existing state',async t=>{
 let arrived;const gate=new Promise(r=>{arrived=r;});
 const f=await fixture(t,async req=>{await read(req);arrived();});
 const ctx=f.states.context(model,{authorization:'Bearer unit-private-key',session_id:'unit-session'});
 f.states.decide(ctx,'A'.repeat(292),'response','pin');
 f.manager.start(input());await gate;f.manager.stop();await f.manager.pending;
 assert.equal(f.manager.snapshot().job.status,'stopped');assert.equal(f.states.reveal(ctx.id).state,'A'.repeat(292));
});

test('refresh/rule epoch invalidation prevents late probe result from restoring old binding',async t=>{
 let release,arrived;const wait=new Promise(r=>{release=r;}),gate=new Promise(r=>{arrived=r;});
 const f=await fixture(t,async(req,res)=>{await read(req);arrived();await wait;success(res);});
 f.manager.start(input());await gate;f.states.refresh({model});release();await f.manager.pending;
 assert.equal(f.manager.snapshot().job.status,'binding_changed');assert.equal(f.states.snapshot().pins.length,0);
});

test('all-312 probes exhaust the requested count instead of pretending to have fixed 292',async t=>{
 let calls=0;const f=await fixture(t,async(req,res)=>{await read(req);calls++;success(res,312);});
 f.manager.start(input({maxAttempts:2}));await f.manager.pending;assert.equal(calls,2);assert.equal(f.manager.snapshot().job.status,'exhausted');assert.equal(f.manager.snapshot().job.hits,0);assert.equal(f.states.snapshot().pins.length,0);
});

test('HTTP console probe routes require login/CSRF and log requested versus response-declared model',async t=>{
 const f=await fixture(t,async(req,res)=>{await read(req);success(res,312,'gpt-5.6-luna');});
 const app=await createExtension(f.config,f.home,{proxyPort:0,adminPort:0});
 f.config.adminPort=app.admin.address().port;f.config.adminOrigin=`http://127.0.0.1:${f.config.adminPort}`;
 t.after(()=>app.close(100));const url=f.config.adminOrigin;
 assert.equal((await fetch(url+'/api/probes')).status,401);
 const login=await fetch(url+'/api/login',{method:'POST',headers:{origin:url,'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'probe-test-password-123!'})});
 const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
 const common={cookie,origin:url,'content-type':'application/json'};
 assert.equal((await fetch(url+'/api/probes/start',{method:'POST',headers:common,body:JSON.stringify(input())})).status,403);
 assert.equal((await fetch(url+'/api/probes/start',{method:'POST',headers:{...common,'x-csrf-token':csrf},body:JSON.stringify(input({acknowledgeBillable:false}))})).status,400);
 const response=await fetch(`http://127.0.0.1:${app.proxy.address().port}/responses`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer test'},body:JSON.stringify({model,input:'not-logged'})});await response.text();
 const r=app.journal.recent.filter(r=>r.kind==='request').at(-1);assert.equal(r.requestedModel,model);assert.equal(r.forwardedModel,model);assert.equal(r.responseModel,'gpt-5.6-luna');assert.equal(r.modelReportedDifferent,true);
});


test('a declared output-token cap is accepted without pretending a full completion occurred',async t=>{
 const f=await fixture(t,async(req,res)=>{await read(req);res.writeHead(200,{'content-type':'text/event-stream','x-codex-turn-state':'P'.repeat(292)});res.end('data: '+JSON.stringify({type:'response.incomplete',response:{model,status:'incomplete',incomplete_details:{reason:'max_output_tokens'}}})+'\n\n');});
 f.manager.start(input());await f.manager.pending;assert.equal(f.manager.snapshot().job.status,'found');assert.equal(f.states.snapshot().pins[0].source,'probe');
});

test('a successful response missing model identity is not pinned',async t=>{
 const f=await fixture(t,async(req,res)=>{await read(req);res.writeHead(200,{'content-type':'application/json','x-codex-turn-state':'P'.repeat(292)});res.end('{"status":"completed"}');});
 f.manager.start(input());await f.manager.pending;assert.equal(f.manager.snapshot().job.status,'response_model_missing');assert.equal(f.states.snapshot().pins.length,0);
});

test('hourly request budget blocks starts without any outbound request',async t=>{
 let calls=0;const f=await fixture(t,async(req,res)=>{calls++;await read(req);success(res);});
 f.manager.attempts=Array(30).fill(Date.now());assert.throws(()=>f.manager.start(input()),/budget/);assert.equal(calls,0);
});

test('manual probe: eleven wrong-model successes then exact-model 292 pins on attempt twelve, not before',async t=>{
 let calls=0;const f=await fixture(t,async(req,res)=>{
   const body=await read(req);calls++;assert.equal(body.model,model);assert.equal(body.input,'ping');
   assert.equal(req.headers['x-codex-turn-state'],undefined);
   if(calls<=11){assert.equal(f.states.snapshot().pins.length,0);success(res,calls%2?312:292,'gpt-5.6-luna');}
   else success(res,292,model);
 });
 f.manager.start(input({maxAttempts:50,maxRunSeconds:60}));await f.manager.pending;
 const j=f.manager.snapshot().job;
 assert.equal(calls,12);assert.equal(j.status,'found');assert.equal(j.tried,12);assert.equal(j.mismatchCount,11);assert.equal(j.hits,1);
 assert.equal(j.results.filter(r=>r.outcome==='model_mismatch'&&r.retryable).length,11);
 assert.equal(f.states.snapshot().pins.length,1);
});

test('retrying model mismatch remains cancellable during the interval',async t=>{
 let calls=0;const f=await fixture(t,async(req,res)=>{await read(req);calls++;success(res,312,'gpt-5.6-luna');});
 f.manager.start(input({maxAttempts:50,maxRunSeconds:60}));
 for(let i=0;i<100&&!f.manager.snapshot().job.results.length;i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(f.manager.snapshot().job.status,'running');f.manager.stop();await f.manager.pending;
 assert.equal(calls,1);assert.equal(f.manager.snapshot().job.status,'stopped');assert.equal(f.states.snapshot().pins.length,0);
});

test('shared hourly budget is adjustable above thirty and persists usage when raised or restarted',async t=>{
 let calls=0;const f=await fixture(t,async(req,res)=>{calls++;await read(req);success(res);});
 assert.throws(()=>f.manager.configureBudget({maxAttemptsPerHour:100},false));
 assert.throws(()=>f.manager.configureBudget({maxAttemptsPerHour:0},true));
 f.manager.attempts=Array(30).fill(Date.now());assert.equal(f.manager.consumeAttempt(),false);
 const b=f.manager.configureBudget({maxAttemptsPerHour:100},true);assert.equal(b.used,30);assert.equal(b.remaining,70);
 for(let i=0;i<5;i++)assert.equal(f.manager.consumeAttempt(),true);
 const reopened=new ProbeManager(f.config,f.states,f.journal,()=> 'pin');t.after(()=>reopened.close());
 assert.equal(reopened.budgetLimit,100);assert.equal(reopened.budgetStatus().used,35);
 reopened.configureBudget({maxAttemptsPerHour:35},true);assert.equal(reopened.consumeAttempt(),false);
 assert.equal(calls,0);
});

test('budget management API requires authentication, CSRF and billable acknowledgement',async t=>{
 const f=await fixture(t,async(req,res)=>{await read(req);success(res);});
 const app=await createExtension(f.config,f.home,{proxyPort:0,adminPort:0});
 f.config.adminPort=app.admin.address().port;f.config.adminOrigin=`http://127.0.0.1:${f.config.adminPort}`;t.after(()=>app.close(100));
 const u=f.config.adminOrigin;
 assert.equal((await fetch(u+'/api/probes/budget')).status,401);
 const login=await fetch(u+'/api/login',{method:'POST',headers:{origin:u,'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'probe-test-password-123!'})});
 const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();const h={cookie,origin:u,'content-type':'application/json'};
 const body={maxAttemptsPerHour:100,acknowledgeBillable:true,acknowledgeExperimental:true};
 assert.equal((await fetch(u+'/api/probes/budget',{method:'POST',headers:h,body:JSON.stringify(body)})).status,403);
 assert.equal((await fetch(u+'/api/probes/budget',{method:'POST',headers:{...h,'x-csrf-token':csrf},body:JSON.stringify({...body,acknowledgeBillable:false})})).status,400);
 const r=await fetch(u+'/api/probes/budget',{method:'POST',headers:{...h,'x-csrf-token':csrf},body:JSON.stringify(body)});
 assert.equal(r.status,200);assert.equal((await r.json()).remaining,100);
});
