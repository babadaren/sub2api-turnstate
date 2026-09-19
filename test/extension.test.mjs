import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import http from 'node:http';import net from 'node:net';import { once } from 'node:events';
import { makeConfig,validateConfig } from '../lib/config.mjs';
import { createExtension } from '../lib/server.mjs';
import { cleanHeaders,routeName } from '../lib/policy.mjs';
const read=async req=>{const b=[];for await(const c of req)b.push(c);return Buffer.concat(b);};
async function fixture(t,handler,upgrade,mode='auto'){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'ext050-')),sockets=new Set(),origin=http.createServer(handler);
 origin.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});if(upgrade)origin.on('upgrade',upgrade);
 origin.listen(0,'127.0.0.1');await once(origin,'listening');const {config}=makeConfig({password:'ext-test-password-123!',target:`http://127.0.0.1:${origin.address().port}`,mode});const app=await createExtension(config,home,{proxyPort:0,adminPort:0});config.adminPort=app.admin.address().port;config.proxyPort=app.proxy.address().port;config.adminOrigin=`http://127.0.0.1:${config.adminPort}`;
 t.after(async()=>{await app.close(100);for(const s of sockets)s.destroy();origin.closeAllConnections();await new Promise(r=>origin.close(r));fs.rmSync(home,{recursive:true,force:true});});return{app,home,config,url:`http://127.0.0.1:${config.proxyPort}`,admin:config.adminOrigin};
}
test('versioned/unversioned aliases recognized, private IDs and queries not logged',()=>{
 for(const base of ['/responses','/v1/responses']){assert.equal(routeName(base),base);assert.equal(routeName(base+'?private=secret'),base);assert.equal(routeName(base+'/compact'),base+'/compact');assert.equal(routeName(base+'/private-id'),base);}
 for(const p of ['/responses-other','/response','/v1/chat/completions','/admin/responses'])assert.equal(routeName(p),null);
});
test('remote target/self loops and public plaintext administration rejected',()=>{
 const {config}=makeConfig({password:'test-password-12345!'});for(const target of ['http://172.18.0.1:1081','http://127.0.0.1:17890'])assert.throws(()=>validateConfig({...config,target}));assert.throws(()=>validateConfig({...config,adminOrigin:'http://state.example.com'}));
});
test('local controls and hop-by-hop headers removed without changing upstream authentication',()=>{
 const h=cleanHeaders({connection:'keep-alive, x-private','x-private':'x','x-turnstate-control':'x','proxy-authorization':'x',authorization:'Bearer preserved',session_id:'keep'});for(const n of ['x-private','x-turnstate-control','proxy-authorization'])assert.equal(h[n],undefined);assert.equal(h.authorization,'Bearer preserved');assert.equal(h.session_id,'keep');
});
test('unknown models forward once, preserve auth/path/bytes and ignore proxy environment',async t=>{
 let count=0,captured;const f=await fixture(t,async(req,res)=>{count++;captured={headers:req.headers,url:req.url,body:await read(req)};res.writeHead(500,{'x-codex-turn-state':'Q'.repeat(312)});res.end('origin error');});
 const keys=['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'],old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));for(const k of keys)process.env[k]='http://127.0.0.1:1';t.after(()=>{for(const k of keys)if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];});
 const body=JSON.stringify({model:'unconfigured-model',input:'NEVER-LOG-PROMPT'});const r=await fetch(f.url+'/responses?private=secret',{method:'POST',headers:{authorization:'Bearer NEVER-LOG-KEY',cookie:'NEVER-LOG-COOKIE','content-type':'application/json'},body});assert.equal(r.status,500);assert.equal(await r.text(),'origin error');assert.equal(count,1);assert.equal(captured.url,'/responses?private=secret');assert.equal(captured.body.toString(),body);assert.equal(captured.headers.authorization,'Bearer NEVER-LOG-KEY');await f.app.journal.flush();const log=fs.readFileSync(path.join(f.home,'records.jsonl'),'utf8');for(const s of ['NEVER-LOG-PROMPT','NEVER-LOG-KEY','NEVER-LOG-COOKIE','private=secret','Q'.repeat(312)])assert.equal(log.includes(s),false);
});
test('large uninspectable request streams byte-for-byte without making up a model',async t=>{
 const body=JSON.stringify({model:'large-unknown',input:'x'.repeat(9*1024*1024)});const f=await fixture(t,async(req,res)=>{assert.equal((await read(req)).toString(),body);res.end('ok');});const r=await fetch(f.url+'/responses',{method:'POST',body});assert.equal(await r.text(),'ok');const record=f.app.journal.recent.at(-1);assert.equal(record.model,null);assert.equal(record.requestModelReason,'body_too_large');
});
test('SSE first chunk arrives before response completion',async t=>{
 let release;const hold=new Promise(r=>release=r);const f=await fixture(t,async(req,res)=>{await read(req);res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: first\n\n');await hold;res.end('data: last\n\n');});t.after(()=>release());const r=await fetch(f.url+'/responses',{method:'POST',body:'{"model":"stream-test"}'});const reader=r.body.getReader();assert.match(Buffer.from((await reader.read()).value).toString(),/first/);release();let rest='';while(true){const part=await reader.read();if(part.done)break;rest+=Buffer.from(part.value);}assert.match(rest,/last/);
});
test('WebSocket handshake and subsequent opaque bytes remain unchanged',async t=>{
 const f=await fixture(t,(_req,res)=>res.end(),(req,socket,head)=>{assert.equal(req.headers['x-codex-turn-state'],'S'.repeat(312));socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nX-Codex-Turn-State: '+ 'R'.repeat(312)+'\r\n\r\n');if(head.length)socket.write(head);socket.pipe(socket);});
 const req=http.request(f.url+'/responses',{headers:{connection:'Upgrade',upgrade:'websocket','x-codex-turn-state':'S'.repeat(312)}});const upgraded=once(req,'upgrade');req.end();const [response,socket]=await upgraded;assert.equal(response.statusCode,101);assert.equal(response.headers['x-codex-turn-state'].length,312);const returned=once(socket,'data');socket.write(Buffer.from([0x81,0x03,0x00,0x41,0xff]));assert.deepEqual((await returned)[0],Buffer.from([0x81,0x03,0x00,0x41,0xff]));socket.destroy();assert.equal(f.app.automatic.totals.starts,0);
});
test('admin rejects anonymous, foreign Origin and missing CSRF, logout invalidates session',async t=>{
 const f=await fixture(t,(_req,res)=>res.end('ok'));assert.equal((await fetch(f.admin+'/api/states')).status,401);const credentials={username:'admin',password:'ext-test-password-123!'};
 assert.equal((await fetch(f.admin+'/api/login',{method:'POST',headers:{origin:'https://foreign.example','content-type':'application/json'},body:JSON.stringify(credentials)})).status,403);
 const login=await fetch(f.admin+'/api/login',{method:'POST',headers:{origin:f.admin,'content-type':'application/json'},body:JSON.stringify(credentials)});const cookies=login.headers.get('set-cookie');assert.match(cookies,/HttpOnly/);assert.match(cookies,/SameSite=Strict/);const cookie=cookies.split(';')[0],{csrf}=await login.json();const headers={cookie,origin:f.admin,'content-type':'application/json','x-csrf-token':csrf};assert.equal((await fetch(f.admin+'/api/automation',{method:'POST',headers:{...headers,origin:'https://evil.example'},body:'{"enabled":false}'})).status,403);assert.equal((await fetch(f.admin+'/api/logout',{method:'POST',headers,body:'{}'})).status,200);assert.equal((await fetch(f.admin+'/api/status',{headers:{cookie}})).status,401);
});
