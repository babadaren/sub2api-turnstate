import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns/promises';

export class ProxyError extends Error { constructor(code) { super(code); this.code=code; } }
export function publicIPv4(ip) {
  if(net.isIP(ip)!==4)return false;
  const [a,b,c]=ip.split('.').map(Number);
  return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||
    (a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0||b===2))||
    (a===198&&(b===18||b===19||(b===51&&c===100)))||(a===203&&b===0&&c===113));
}
export async function resolveProxyHost(host) {
  if(net.isIP(host)) { if(!publicIPv4(host))throw new ProxyError('proxy_address_rejected');return host; }
  const all=await dns.lookup(host,{all:true,family:4});
  if(!all.length||all.some(x=>!publicIPv4(x.address)))throw new ProxyError('proxy_address_rejected');
  return all[0].address; // Pin the checked resolution for the connection, preventing rebinding.
}
function ready(socket,event,signal) {
  return new Promise((resolve,reject)=>{
    const clean=()=>{socket.removeListener(event,ok);socket.removeListener('error',bad);socket.removeListener('close',closed);signal?.removeEventListener('abort',aborted);};
    const ok=()=>{clean();resolve();},bad=()=>{clean();reject(new ProxyError('proxy_connection_error'));},closed=()=>{clean();reject(new ProxyError('proxy_closed'));};
    const aborted=()=>{clean();reject(new ProxyError('cancelled'));};
    socket.once(event,ok);socket.once('error',bad);socket.once('close',closed);signal?.addEventListener('abort',aborted,{once:true});if(signal?.aborted)aborted();
  });
}
export function readExact(socket,n,signal) {
  return new Promise((resolve,reject)=>{
    const clean=()=>{socket.removeListener('readable',read);socket.removeListener('error',bad);socket.removeListener('end',bad);socket.removeListener('close',bad);signal?.removeEventListener('abort',abort);};
    const bad=()=>{clean();reject(new ProxyError('proxy_handshake_error'));},abort=()=>{clean();reject(new ProxyError('cancelled'));};
    const read=()=>{const b=socket.read(n);if(b!==null){clean();resolve(b);}};
    socket.on('readable',read);socket.once('error',bad);socket.once('end',bad);socket.once('close',bad);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();else read();
  });
}
export async function proxyHandshake(socket,node,host,port,signal) {
  if(!/^[a-z0-9.-]{1,253}$/i.test(host)||!Number.isInteger(port)||port<1||port>65535)throw new ProxyError('invalid_destination');
  if(node.protocol==='http'||node.protocol==='https') {
    const auth=node.username?'Proxy-Authorization: Basic '+Buffer.from(node.username+':'+node.password).toString('base64')+'\r\n':'';
    socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
    let text='';
    while(!text.endsWith('\r\n\r\n')) { if(text.length>=16384)throw new ProxyError('proxy_headers_too_large');text+=(await readExact(socket,1,signal)).toString('latin1'); }
    const code=Number(/^HTTP\/1\.[01] (\d{3})(?: |\r)/.exec(text)?.[1]);
    if(code===407)throw new ProxyError('proxy_auth_failed');
    if(code!==200)throw new ProxyError('proxy_connect_rejected');
  } else if(node.protocol==='socks5') {
    const user=Buffer.from(node.username||''),pass=Buffer.from(node.password||'');
    socket.write(Buffer.from([5,1,user.length?2:0]));
    const hello=await readExact(socket,2,signal);
    if(hello[0]!==5||hello[1]!== (user.length?2:0))throw new ProxyError('proxy_auth_failed');
    if(user.length) {
      if(user.length>255||pass.length>255)throw new ProxyError('proxy_credentials_invalid');
      socket.write(Buffer.concat([Buffer.from([1,user.length]),user,Buffer.from([pass.length]),pass]));
      const auth=await readExact(socket,2,signal);if(auth[0]!==1||auth[1]!==0)throw new ProxyError('proxy_auth_failed');
    }
    const dest=Buffer.from(host),p=Buffer.alloc(2);p.writeUInt16BE(port);
    socket.write(Buffer.concat([Buffer.from([5,1,0,3,dest.length]),dest,p]));
    const h=await readExact(socket,4,signal);if(h[0]!==5||h[1]!==0||h[2]!==0)throw new ProxyError('proxy_connect_rejected');
    const n=h[3]===1?4:h[3]===4?16:h[3]===3?(await readExact(socket,1,signal))[0]:-1;
    if(n<0)throw new ProxyError('proxy_handshake_error');await readExact(socket,n+2,signal);
  } else throw new ProxyError('proxy_protocol_invalid');
}
// Credentials go only into the proxy handshake; upstream HTTPS remains end-to-end.
// No certificate bypass, environment proxies, redirects, or client API keys here.
export async function openProxyTLS(node,host,port=443,signal) {
  let socket;
  const abort=()=>socket?.destroy();
  signal?.addEventListener('abort',abort,{once:true});
  try {
    if(signal?.aborted)throw new ProxyError('cancelled');
    const address=await resolveProxyHost(node.host);
    if(signal?.aborted)throw new ProxyError('cancelled');
    socket=node.protocol==='https'?tls.connect({host:address,port:node.port,servername:net.isIP(node.host)?undefined:node.host,rejectUnauthorized:true,ALPNProtocols:['http/1.1']}):net.connect({host:address,port:node.port});
    socket.on('error',()=>{});await ready(socket,node.protocol==='https'?'secureConnect':'connect',signal);
    await proxyHandshake(socket,node,host,port,signal);
    const raw=socket;socket=tls.connect({socket:raw,servername:host,rejectUnauthorized:true,ALPNProtocols:['http/1.1']});
    socket.on('error',()=>{});await ready(socket,'secureConnect',signal);
    if(!socket.authorized)throw new ProxyError('proxy_tls_verification_failed');
    return socket;
  } catch(e) {socket?.destroy();throw e instanceof ProxyError?e:new ProxyError('proxy_connection_error');}
  finally {signal?.removeEventListener('abort',abort);}
}
