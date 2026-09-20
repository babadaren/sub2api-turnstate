import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {gzipSync,deflateSync,brotliCompressSync} from 'node:zlib';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {inspectProbeResponse} from '../lib/probe-response.mjs';
import {ProxyPool} from '../lib/proxy-pool.mjs';
import {AutomaticGate} from '../lib/automatic.mjs';
import {StateStore} from '../lib/states.mjs';
import {Journal} from '../lib/journal.mjs';
import {makeConfig} from '../lib/config.mjs';
const state='S'.repeat(292),model='gpt-6-astra';
const event=v=>'data: '+JSON.stringify(v)+'\n\n';
const sse=event({type:'response.created',response:{model:'gpt-6-sol',status:'in_progress'}})+event({type:'response.completed',response:{model:'gpt-6-sol',status:'completed'}});
function response({length=292,type=null,encoding=null,status=200,duplicates=false}={}){
 const r=new PassThrough();r.statusCode=status;r.headers={'x-codex-turn-state':'S'.repeat(length)};
 if(type!==null)r.headers['content-type']=type;if(encoding)r.headers['content-encoding']=encoding;
 r.headersDistinct={'x-codex-turn-state':duplicates?[state,state]:[r.headers['x-codex-turn-state']]};return r;
}
function inspect(body=sse,params={},options={}){
 return new Promise(resolve=>{const r=response(params);inspectProbeResponse(r,[292],out=>{r.destroy();resolve(out);},options);
 if(!r.destroyed){const chunks=Array.isArray(body)?body:[body];for(const b of chunks)if(!r.destroyed)r.write(b);if(!r.destroyed)r.end();}
 });
}
test('incident: HTTP 200 / 312 without Content-Type is a miss, not a fatal format error',async()=>{
 const r=await inspect('',{length:312});assert.equal(r.error,'length_miss');assert.equal(r.responseContentType,'missing');assert.equal(r.state,'');assert.equal(r.accepted,false);
});
test('no Content-Type with successful SSE/292 is recognized without assuming requested model',async()=>{
 const r=await inspect(sse);assert.equal(r.accepted,true);assert.equal(r.responseDetection,'body_sse');assert.equal(r.responseModel,'gpt-6-sol');assert.equal(r.state,state);
});
test('sniffing handles split SSE prefixes, BOM, comments, and explicit event lines',async t=>{
 for(const prefix of ['','\uFEFF',': comment\n','event: response.created\n'])await t.test(JSON.stringify(prefix),async()=>{
  const r=await inspect([prefix,'d','a','ta:',sse.slice(5)]);assert.equal(r.accepted,true);
 });
});
test('JSON terminal responses work with missing or fallback media types',async t=>{
 for(const type of [null,'text/plain','application/octet-stream','Application/JSON; charset=utf-8'])await t.test(String(type),async()=>{
  const r=await inspect('{"status":"completed","model":"gpt-5.5"}',{type});assert.equal(r.accepted,true);assert.equal(r.responseModel,'gpt-5.5');
 });
});
test('target-length header never makes HTML, arbitrary text, invalid JSON, failure or incomplete stream valid',async t=>{
 const cases=[['<html>test</html>',{},'unsupported_response_type'],['unrelated body',{},'unsupported_response_type'],
 ['{bad json',{},'invalid_response_json'],[event({type:'response.failed',response:{status:'failed',error:{code:'server_error'}}}),{},'response_failed'],
 [event({type:'response.created',response:{model,status:'in_progress'}}),{},'incomplete_response'],
 [sse,{type:'text/html'},'unsupported_response_type'],['',{},'unsupported_response_type']];
 for(const [body,params,error] of cases)await t.test(error,async()=>{const r=await inspect(body,params);assert.equal(r.error,error);assert.equal(r.accepted,false);assert.equal(r.state,'');});
});
test('gzip, deflate, brotli are decoded with bounds and verified before acceptance',async t=>{
 for(const [encoding,encode] of [['gzip',gzipSync],['deflate',deflateSync],['br',brotliCompressSync]])await t.test(encoding,async()=>{
  const raw=encode(Buffer.from(sse));const r=await inspect(raw,{encoding});assert.equal(r.accepted,true);assert.equal(r.responseDetection,'body_sse');assert.equal(r.decodedBytes,Buffer.byteLength(sse));assert.equal(r.rawBytes,raw.length);
 });
});
test('unsupported encoding, broken compression and oversized decoding never become pins',async t=>{
 await t.test('encoding',async()=>assert.equal((await inspect('x',{encoding:'custom'})).error,'unsupported_content_encoding'));
 await t.test('corrupt gzip',async()=>{const r=await inspect(Buffer.from('not gzip'),{encoding:'gzip'});assert.equal(r.error,'response_decode_error');assert.equal(r.accepted,false);});
 await t.test('truncated gzip with complete event',async()=>{const bytes=gzipSync(Buffer.from(sse));const r=await inspect(bytes.subarray(0,bytes.length-8),{encoding:'gzip'});assert.equal(r.accepted,false);assert.equal(r.error,'response_decode_error');});
 await t.test('decoded byte limit',async()=>{const body=event({type:'response.created',response:{model},padding:'x'.repeat(70000)})+sse;const r=await inspect(gzipSync(body),{encoding:'gzip'});assert.equal(r.error,'response_too_large');assert.equal(r.accepted,false);});
});
test('HTTP auth, rate-limit and errors take precedence even with a non-target state',async t=>{
 for(const status of [401,403,429,500,503])await t.test(String(status),async()=>{const r=await inspect('',{length:312,status});assert.equal(r.error,'http_'+status);assert.equal(r.accepted,false);});
});
test('duplicate/unsafe state and cancellation are not accepted',async()=>{
 assert.equal((await inspect(sse,{duplicates:true})).accepted,false);
 const c=new AbortController();c.abort();assert.equal((await inspect(sse,{}, {signal:c.signal})).error,'cancelled');
});
async function poolFixture(t,transport,n=4){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'probe-format-')),{config}=makeConfig({password:'probe-format-test-password',mode:'auto'});
 const journal=new Journal(home,config),pool=new ProxyPool(home,config,journal,{transport}),states=new StateStore(home,config.logSalt);let local=0;
 pool.mutate({action:'import',text:Array.from({length:n},(_,i)=>`8.8.8.${i+1}:1080`).join('\n')});
 pool.configureProfile({type:'codex',token:'synthetic-token',accountId:'synthetic-account',clientKey:'synthetic-key'});pool.setEnabled(true,true);
 const gate=new AutomaticGate(config,states,journal,()=>true,{scheduler:false,proxyPool:pool,sleep:async()=>{},probe:async()=>{local++;return {status:200,length:292,state,accepted:true,completed:true,responseModel:model};}});
 t.after(async()=>{await gate.close();states.flush();pool.close();await journal.flush();fs.rmSync(home,{recursive:true,force:true});});
 const headers={authorization:'Bearer synthetic-key'},ctx=states.context(model,headers);
 return {gate,pool,states,ctx,headers,get local(){return local;}};
}
test('actual gate tries 312/no-type first node then pins second SSE/no-type 292 without stopping',async t=>{
 const seen=[];const f=await poolFixture(t,async node=>{seen.push(node.id);return inspect(sse,{length:seen.length===1?312:292});});
 const r=await f.gate.ensure(f.ctx,f.headers,{},'/responses',10);assert.equal(r.allow,true);assert.equal(seen.length,2);assert.equal(f.local,0);
 assert.equal(f.states.liveForPreflight(f.ctx).state,state);assert.equal(f.pool.data.nextId,f.pool.data.nodes[2].id);
 assert.equal(f.gate.recent[0].attempts,2);assert.equal(f.gate.recent[0].lastResult.responseDetection,'body_sse');
});
test('all nodes with malformed responses fall back once; no endless rescans inside same task',async t=>{
 let seen=0;const f=await poolFixture(t,async()=>{seen++;return inspect('<html>bad</html>');});
 const r=await f.gate.ensure(f.ctx,f.headers,{},'/responses',10);assert.equal(r.allow,true);assert.equal(seen,4);assert.equal(f.local,1);assert.equal(f.gate.recent[0].attempts,5);
});
test('upstream 403 still stops node rotation and never bypasses authentication through fallback',async t=>{
 let seen=0;const f=await poolFixture(t,async()=>{seen++;return inspect('',{status:403});});const r=await f.gate.ensure(f.ctx,f.headers,{},'/responses',10);
 assert.equal(r.allow,false);assert.equal(r.reason,'http_403');assert.equal(seen,1);assert.equal(f.local,0);
});
