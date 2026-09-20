import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { ProxyPool,parseNodeImport,validateNode } from '../lib/proxy-pool.mjs';
import { makeConfig } from '../lib/config.mjs';
import { AutomaticGate } from '../lib/automatic.mjs';
import { StateStore } from '../lib/states.mjs';
import { Journal } from '../lib/journal.mjs';
const model='gpt-6-astra',state='S'.repeat(292),key='proxy-test-client-secret',source='test-source-token-not-real';
const routing={headers:{authorization:'Bearer '+key,session_id:'private-session'},payload:{}};
const sourceProfile={type:'codex',token:source,accountId:'synthetic-account',clientKey:key};
const hit={status:200,length:292,responseModel:model,state,accepted:true,completed:true,error:null};
function fixture(t,options={}) {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'ts-proxy-')),{config}=makeConfig({password:'proxy-unit-password',mode:'auto'}),journal=new Journal(home,config);
 const pool=new ProxyPool(home,config,journal,options);
 t.after(async()=>{pool.close();await journal.flush();fs.rmSync(home,{recursive:true,force:true});});return {home,config,journal,pool};
}
function configure(pool,n=3){pool.mutate({action:'import',text:Array.from({length:n},(_,i)=>`socks5://test-user:test-pass@8.8.8.${i+1}:1080`).join('\n')});pool.configureProfile(sourceProfile);pool.setEnabled(true,true);return pool.data.nodes;}

test('import supports URL, host-port credentials, Chinese labels, and SOCKS5 remote DNS',()=>{
 for(const text of ['8.8.8.8:1080:usr:pass','8.8.8.8:1080 usr:pass','8.8.8.8:1080，用户密码：usr:pass','8.8.8.8:1080\n用户密码：usr:pass']){const [n]=parseNodeImport(text);assert.equal(n.username,'usr');assert.equal(n.password,'pass');assert.equal(n.protocol,'http');}
 const [n]=parseNodeImport('socks5h://usr:p%40ss%3Apart@8.8.8.8:1080');assert.equal(n.protocol,'socks5');assert.equal(n.password,'p@ss:part');
 assert.equal(parseNodeImport('https://8.8.8.8:8443')[0].protocol,'https');
});
test('private/invalid proxies, injection and unsupported protocols are rejected without credential echo',()=>{
 for(const host of ['127.0.0.1','10.0.0.1','172.18.0.1','192.168.1.1','169.254.169.254','localhost','my.local','224.0.0.1','100.64.0.1'])assert.throws(()=>validateNode({host,port:1080}));
 for(const text of ['ftp://secret:password@8.8.8.8:21','http://usr:secret@8.8.8.8:8080/private','8.8.8.8:70000']){try{parseNodeImport(text);assert.fail('accepted invalid input');}catch(e){assert.equal(e.message.includes('secret'),false);}}
 assert.throws(()=>validateNode({host:'8.8.8.8',port:1080,username:'u\r\nHeader',password:'p'}));
});
test('node maintenance edits credentials privately, toggles, reorders and deletes idempotent identities',t=>{
 const {pool}=fixture(t);configure(pool);const [a,b]=pool.data.nodes;
 pool.mutate({action:'save',id:a.id,node:{name:'renamed'}});assert.equal(pool.data.nodes[0].password,'test-pass');
 pool.mutate({action:'down',id:a.id});assert.equal(pool.data.nodes[0].id,b.id);
 pool.mutate({action:'disable',id:a.id});assert.equal(pool.data.nodes.find(n=>n.id===a.id).enabled,false);
 pool.mutate({action:'enable',id:a.id});pool.mutate({action:'delete',id:a.id});assert.equal(pool.data.nodes.length,2);
});
test('encrypted disk and snapshots never contain passwords, upstream token, or raw client key',async t=>{
 const {pool,home,config,journal}=fixture(t);configure(pool);
 await journal.flush();const disk=fs.readFileSync(pool.file,'utf8'),logs=fs.readFileSync(path.join(home,'records.jsonl'),'utf8'),snapshot=JSON.stringify(pool.snapshot());
 for(const s of ['test-user','test-pass',source,key,'synthetic-account']){assert.equal(disk.includes(s),false);assert.equal(logs.includes(s),false);assert.equal(snapshot.includes(s),false);}
 const loaded=new ProxyPool(home,config,journal);assert.equal(loaded.data.nodes[0].password,'test-pass');assert.equal(loaded.data.profile.token,source);assert.equal(loaded.allowed(routing),true);loaded.close();
 if(process.platform!=='win32')assert.equal(fs.statSync(pool.file).mode&0o077,0);
});
test('corrupted encrypted configuration fails closed rather than silently taking over',t=>{
 const {pool,home,config,journal}=fixture(t);configure(pool);const d=JSON.parse(fs.readFileSync(pool.file));d.tag='0'.repeat(32);fs.writeFileSync(pool.file,JSON.stringify(d));
 const next=new ProxyPool(home,config,journal);assert.equal(next.snapshot().configurationError,true);assert.equal(next.ready(),false);assert.throws(()=>next.setEnabled(true,true));next.close();
});
test('cannot enable remote probing with only a proxy password and no upstream authentication',t=>{
 const {pool}=fixture(t);pool.mutate({action:'import',text:'8.8.8.8:1080:usr:pass'});
 assert.equal(pool.ready(),false);assert.throws(()=>pool.setEnabled(true,true));assert.equal(pool.snapshot().enabled,false);
 assert.throws(()=>pool.configureProfile({type:'codex',token:source,accountId:'synthetic-account'}));
});
test('off and unbound callers use unchanged Sub2API path, never remote upstream credentials',async t=>{
 let remote=0,local=0;const {pool}=fixture(t,{transport:async()=>{remote++;return hit;}});configure(pool);
 const fallback=async()=>{local++;return hit;};pool.setEnabled(false);
 let r=await pool.probe('j1',model,routing,[292],null,fallback);assert.equal(r.probeRoute.reason,'pool_disabled');
 pool.setEnabled(true,true);r=await pool.probe('j2',model,{headers:{authorization:'Bearer unknown'}},[292],null,fallback);assert.equal(r.probeRoute.reason,'client_not_bound');assert.equal(remote,0);assert.equal(local,2);
});
test('sequential misses rotate nodes and successful job leaves cursor for the following job',async t=>{
 const seen=[];const {pool}=fixture(t,{transport:async node=>{seen.push(node.id);return seen.length===1?{status:200,length:312,error:'length_miss'}:hit;}});const nodes=configure(pool);
 const fail=()=>assert.fail('unexpected local call');let r=await pool.probe('job',model,routing,[292],null,fail);assert.equal(r.retryProxy,true);
 r=await pool.probe('job',model,routing,[292],null,fail);assert.equal(r.accepted,true);pool.endJob('job');
 await pool.probe('next',model,routing,[292],null,fail);assert.deepEqual(seen,nodes.map(n=>n.id));assert.equal(pool.data.nextId,nodes[0].id);
});
test('starting at node eight wraps once; exhausted round uses default for remainder without endless rescan',async t=>{
 const seen=[];let local=0;const {pool}=fixture(t,{transport:async n=>{seen.push(n.id);return {status:200,length:312,error:'length_miss'};}});const nodes=configure(pool,8);pool.data.nextId=nodes[7].id;
 const fallback=async()=>{local++;return {status:200,length:312,error:'length_miss'};};
 for(let i=0;i<10;i++)await pool.probe('batch',model,routing,[292],null,fallback);
 assert.deepEqual(seen,[nodes[7],...nodes.slice(0,7)].map(n=>n.id));assert.equal(local,2);assert.equal(pool.data.nextId,nodes[7].id);
});
test('cursor survives service reload',async t=>{
 const {pool,home,config,journal}=fixture(t,{transport:async()=>hit});const nodes=configure(pool);await pool.probe('j',model,routing,[292],null,()=>assert.fail());
 const loaded=new ProxyPool(home,config,journal);assert.equal(loaded.data.nextId,nodes[1].id);loaded.close();
});
test('proxy auth/transport failure may try next; upstream auth and rate limit do not rotate to evade rejection',async t=>{
 for(const error of ['proxy_auth_failed','proxy_connection_error','http_401','http_403','http_429'])await t.test(error,async st=>{
 const {pool}=fixture(st,{transport:async()=>({status:error.startsWith('http_')?Number(error.slice(5)):0,length:0,error})});configure(pool);
 const out=await pool.probe('j',model,routing,[292],null,()=>assert.fail());assert.equal(!!out.retryProxy,error.startsWith('proxy_'));
 });
});
test('disabling pool cancels in-flight remote probe and ignores its late successful state',async t=>{
 let arrived;const a=new Promise(r=>arrived=r);
 const {pool}=fixture(t,{transport:async(_n,_p,_m,_l,signal)=>{arrived();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));return hit;}});configure(pool);
 const p=pool.probe('j',model,routing,[292],null,()=>assert.fail());await a;pool.setEnabled(false);const out=await p;
 assert.equal(out.accepted,undefined);assert.equal(out.retryProxy,true);assert.equal(pool.controllers.size,0);
});
test('client disconnect aborts remote work and never falls back to a second request',async t=>{
 let arrived;const a=new Promise(r=>arrived=r),c=new AbortController();
 const {pool}=fixture(t,{transport:async(_n,_p,_m,_l,signal)=>{arrived();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));return {error:'cancelled'};}});configure(pool);
 const p=pool.probe('j',model,routing,[292],c.signal,()=>assert.fail());await a;c.abort();assert.equal((await p).error,'cancelled');
});
test('connectivity check does not invoke a model transport or require a source token',async t=>{
 const {pool}=fixture(t,{transport:()=>assert.fail(),checkTransport:async()=>({ok:true,exitIP:'8.8.8.8',country:'US'})});pool.mutate({action:'import',text:'8.8.8.8:1080'});
 const r=await pool.check(pool.data.nodes[0].id);assert.equal(r.ok,true);assert.equal(pool.ready(),false);
});
test('actual AutomaticGate uses proxy once, shares model hit and retains route provenance',async t=>{
 let remote=0,local=0;const {pool,home,config,journal}=fixture(t,{transport:async()=>{remote++;return hit;}});configure(pool);
 const states=new StateStore(home,config.logSalt),ctx=states.context(model,routing.headers);
 const gate=new AutomaticGate(config,states,journal,()=>true,{scheduler:false,proxyPool:pool,probe:async()=>{local++;return hit;},sleep:async()=>{}});
 t.after(async()=>{await gate.close();states.flush();});
 const r=await gate.ensure(ctx,routing.headers,{},'/responses',10);assert.equal(r.allow,true);assert.equal(remote,1);assert.equal(local,0);
 assert.equal(states.pins.get(ctx.id).probeRoute.kind,'proxy');assert.equal(pool.jobs.size,0);
 const b=states.context(model,{...routing.headers,session_id:'other'});assert.equal((await gate.ensure(b,routing.headers,{},'/responses',10)).action,'cache_hit');assert.equal(remote,1);
});
test('AutomaticGate honors default fallback after all imported proxies miss and logs each route',async t=>{
 let remote=0,local=0;const {pool,home,config,journal}=fixture(t,{transport:async()=>{remote++;return {status:200,length:312,error:'length_miss'};}});configure(pool,2);
 const states=new StateStore(home,config.logSalt),ctx=states.context(model,routing.headers);
 const gate=new AutomaticGate(config,states,journal,()=>true,{scheduler:false,proxyPool:pool,probe:async()=>{local++;return hit;},sleep:async()=>{}});
 t.after(async()=>{await gate.close();states.flush();});
 assert.equal((await gate.ensure(ctx,routing.headers,{},'/responses',10)).allow,true);assert.equal(remote,2);assert.equal(local,1);
 assert.equal(states.pins.get(ctx.id).probeRoute.reason,'node_round_exhausted');
});
