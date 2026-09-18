import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { makeConfig, validateConfig } from '../lib/config.mjs';
import { createExtension } from '../lib/server.mjs';
import { ResponseMetadata } from '../lib/response-meta.mjs';
const read = async req => {const chunks=[];for await(const c of req)chunks.push(c);return Buffer.concat(chunks);};
async function fixture(t, handler, options={}) {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'metadata-test-'));
 const origin=http.createServer(handler), sockets=new Set();
 origin.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
 origin.listen(0,'127.0.0.1');await once(origin,'listening');
 const {config}=makeConfig({password:'metadata-private-test-password',target:`http://127.0.0.1:${origin.address().port}`,...options});
 const app=await createExtension(config,home,{proxyPort:0,adminPort:0});
 config.proxyPort=app.proxy.address().port;config.adminPort=app.admin.address().port;
 config.adminOrigin=`http://127.0.0.1:${config.adminPort}`;
 t.after(async()=>{await app.close(100);for(const s of sockets)s.destroy();origin.closeAllConnections();await new Promise(r=>origin.close(r));fs.rmSync(home,{force:true,recursive:true});});
 return {home,config,app,url:`http://127.0.0.1:${config.proxyPort}`};
}
test('1.4 MiB JSON and >64 KiB SSE events retain exact model while payload bytes and secrets stay out of logs',async t=>{
 const model='gpt-5.6-sol';
 const payload=JSON.stringify({input:'private-request-'.repeat(100000),model});
 const stream='data: '+JSON.stringify({type:'response.created',response:{instructions:'private-response-'.repeat(9000),model}})+'\n\n'+
  'data: '+JSON.stringify({type:'response.completed',response:{model,status:'completed'}})+'\n\n';
 const f=await fixture(t,async(req,res)=>{assert.equal((await read(req)).toString(),payload);res.writeHead(200,{'content-type':'text/event-stream','x-codex-turn-state':'S'.repeat(312),'x-request-id':'diagnostic-test-id'});res.end(stream);});
 const response=await fetch(f.url+'/responses',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer never-log-this'},body:payload});
 assert.equal(await response.text(),stream);
 const record=f.app.journal.recent.findLast(r=>r.kind==='request');
 assert.equal(record.model,model);assert.equal(record.responseModel,model);assert.equal(record.requestModelReason,'json_model');
 assert.equal(record.responseModelReason,'declared_model');assert.equal(record.responseCompleted,true);
 assert.equal(record.upstreamRequestId,'diagnostic-test-id');assert.equal(record.responseMetadataTruncated,false);
 await f.app.journal.flush();const log=fs.readFileSync(path.join(f.home,'records.jsonl'),'utf8');
 for(const text of ['private-request-','private-response-','never-log-this','S'.repeat(312)])assert.equal(log.includes(text),false);
});
test('configured inspection limit and encoded bodies bypass safely with distinct reasons',async t=>{
 const seen=[];
 const f=await fixture(t,async(req,res)=>{seen.push(await read(req));res.end('ok');},{requestMetadataMaxBytes:65536});
 const cases=[{body:JSON.stringify({model:'gpt-6-astra',input:'z'.repeat(70000)}),reason:'body_too_large'},
 {body:'compressed-placeholder',encoding:'gzip',reason:'encoded_body'},
 {body:'{',reason:'invalid_json'},{body:'{}',reason:'missing_model'}];
 for(const item of cases){
  const r=await fetch(f.url+'/responses',{method:'POST',headers:{'content-type':'application/json',...(item.encoding?{'content-encoding':item.encoding}:{})},body:item.body});
  await r.text();assert.equal(seen.at(-1).toString(),item.body);
  const event=f.app.journal.recent.findLast(x=>x.kind==='request');
  assert.equal(event.model,null);assert.equal(event.requestModelReason,item.reason);
 }
});
test('response diagnostics distinguish budget/encoding/missing model and handle split UTF-8',()=>{
 const small=new ResponseMetadata({'content-type':'text/event-stream'},100);
 small.push(Buffer.from('data: '+JSON.stringify({response:{instructions:'x'.repeat(200),model:'gpt-6-astra'}})+'\n\n'));small.end();
 assert.equal(small.model,null);assert.equal(small.reason(),'metadata_limit');
 const encoded=new ResponseMetadata({'content-type':'text/event-stream','content-encoding':'gzip'});assert.equal(encoded.reason(),'encoded_response');
 const missing=new ResponseMetadata({'content-type':'application/json'});missing.push(Buffer.from('{}'));missing.end();assert.equal(missing.reason(),'model_missing');
 const good=new ResponseMetadata({'content-type':'text/event-stream'});
 const bytes=Buffer.from('data: '+JSON.stringify({response:{instructions:'测试中文',model:'gpt-6-astra',status:'completed'}})+'\n\n');
 for(const b of bytes)good.push(Buffer.from([b]));good.end();
 assert.equal(good.model,'gpt-6-astra');assert.equal(good.completed,true);assert.equal(good.reason(),'declared_model');
});
test('metadata concurrency guard bypasses rather than rejecting an additional request',async t=>{
 const f=await fixture(t,async(req,res)=>{await read(req);res.end('ok');},{metadataConcurrency:1});
 const held=http.request(f.url+'/responses',{method:'POST',headers:{'content-type':'application/json'}},r=>r.resume());
 held.on('error',()=>{});t.after(()=>held.destroy());held.write('{');
 let busy=false;
 for(let i=0;i<30;i++){
  const r=await fetch(f.config.adminOrigin+'/api/status',{headers:{'x-turnstate-control':f.config.controlToken}});
  if((await r.json()).inspection.requestReaders===1){busy=true;break;}await delay(10);
 }
 assert.equal(busy,true);
 const second=await fetch(f.url+'/responses',{method:'POST',body:'{"model":"gpt-6-astra"}'});assert.equal(await second.text(),'ok');
 const record=f.app.journal.recent.findLast(r=>r.kind==='request');assert.equal(record.requestModelReason,'inspection_busy');assert.equal(record.model,null);
 held.end('"model":"gpt-6-astra"}');
});
test('old configs gain bounded defaults; oversized concurrency budgets are rejected',()=>{
 const {config}=makeConfig({password:'metadata-private-test-password'});
 const old={...config};delete old.requestMetadataMaxBytes;delete old.responseMetadataMaxBytes;delete old.metadataConcurrency;
 assert.equal(validateConfig(old).requestMetadataMaxBytes,8*1024*1024);
 assert.throws(()=>validateConfig({...config,metadataConcurrency:16,requestMetadataMaxBytes:16*1024*1024,responseMetadataMaxBytes:16*1024*1024}));
});
