import test from 'node:test';import assert from 'node:assert/strict';
import net from 'node:net';import {once} from 'node:events';
import {proxyHandshake,readExact,publicIPv4,resolveProxyHost} from '../lib/proxy-tunnel.mjs';
async function pair(t,handler){
 const sockets=new Set(),server=net.createServer(s=>{sockets.add(s);s.on('error',()=>{});s.once('close',()=>sockets.delete(s));handler(s).catch(()=>s.destroy());});
 server.listen(0,'127.0.0.1');await once(server,'listening');const client=net.connect(server.address().port,'127.0.0.1');client.on('error',()=>{});await once(client,'connect');
 t.after(async()=>{client.destroy();for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));});return client;
}
test('HTTP CONNECT carries proxy basic auth, not upstream credentials, and preserves following tunnel bytes',async t=>{
 let captured='';const socket=await pair(t,async s=>{while(!captured.endsWith('\r\n\r\n'))captured+=(await readExact(s,1)).toString();s.write('HTTP/1.1 200 Connection established\r\n\r\nNEXT');});
 await proxyHandshake(socket,{protocol:'http',username:'test-user',password:'test-pass'},'api.openai.com',443);
 assert.match(captured,/CONNECT api.openai.com:443 HTTP\/1.1/);assert.match(captured,/Proxy-Authorization: Basic dGVzdC11c2VyOnRlc3QtcGFzcw==/);assert.equal(captured.includes('Bearer'),false);assert.equal((await readExact(socket,4)).toString(),'NEXT');
});
test('HTTP 407 is a proxy authentication failure and is never read as upstream model response',async t=>{
 const socket=await pair(t,async s=>{s.once('data',()=>s.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'));});
 await assert.rejects(proxyHandshake(socket,{protocol:'http',username:'u',password:'p'},'api.openai.com',443),{code:'proxy_auth_failed'});
});
test('SOCKS5 supports username/password and remote destination DNS with fragmented replies',async t=>{
 const socket=await pair(t,async s=>{
  assert.deepEqual([...await readExact(s,3)],[5,1,2]);s.write(Buffer.from([5]));setTimeout(()=>s.write(Buffer.from([2])),5);
  assert.deepEqual([...await readExact(s,2)],[1,1]);assert.equal((await readExact(s,1)).toString(),'u');assert.equal((await readExact(s,1))[0],1);assert.equal((await readExact(s,1)).toString(),'p');s.write(Buffer.from([1,0]));
  const h=await readExact(s,5);assert.deepEqual([...h.subarray(0,4)],[5,1,0,3]);assert.equal((await readExact(s,h[4])).toString(),'chatgpt.com');assert.equal((await readExact(s,2)).readUInt16BE(),443);
  s.write(Buffer.from([5,0,0,1,127,0,0,1,0,80]));s.write('OK');
 });
 await proxyHandshake(socket,{protocol:'socks5',username:'u',password:'p'},'chatgpt.com',443);assert.equal((await readExact(socket,2)).toString(),'OK');
});
test('SOCKS5 rejects authentication downgrade and closes instead of sending provider data',async t=>{
 const socket=await pair(t,async s=>{await readExact(s,3);s.write(Buffer.from([5,0]));});
 await assert.rejects(proxyHandshake(socket,{protocol:'socks5',username:'u',password:'p'},'chatgpt.com',443),{code:'proxy_auth_failed'});
});
test('read cancellation does not leak stream listeners',async t=>{
 const socket=await pair(t,async()=>{}),controller=new AbortController();
 const pending=readExact(socket,10,controller.signal);controller.abort();await assert.rejects(pending,{code:'cancelled'});assert.equal(socket.listenerCount('readable'),0);
});
test('proxy DNS resolution rejects loopback and reserved targets before any socket connection',async()=>{
 assert.equal(publicIPv4('8.8.8.8'),true);assert.equal(publicIPv4('127.0.0.1'),false);assert.equal(publicIPv4('::1'),false);
 await assert.rejects(resolveProxyHost('127.0.0.1'),{code:'proxy_address_rejected'});
 await assert.rejects(resolveProxyHost('localhost'),{code:'proxy_address_rejected'});
});
