import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { openProxyTLS } from './proxy-tunnel.mjs';
import { inspectProbeResponse } from './probe-response.mjs';
import { validModel } from './states.mjs';

export const PROBE_ENDPOINTS=Object.freeze({codex:'https://chatgpt.com/backend-api/codex/responses',responses:'https://api.openai.com/v1/responses'});
const SAFE_ERRORS=new Set(['cancelled','proxy_address_rejected','proxy_connection_error','proxy_closed','proxy_handshake_error','proxy_headers_too_large','proxy_auth_failed','proxy_connect_rejected','proxy_tls_verification_failed','proxy_credentials_invalid']);
const safeError=e=>SAFE_ERRORS.has(e?.code)?e.code:'proxy_connection_error';

export async function requestViaProxy(node,url,{method='GET',headers={},body=null,signal,seconds=15,onResponse}) {
  const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();
  let socket,agent,request,timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},seconds*1000);
  try {
    socket=await openProxyTLS(node,url.hostname,Number(url.port)||443,controller.signal);
    agent=new https.Agent({keepAlive:false,maxSockets:1});
    agent.createConnection=(_o,callback)=>{callback(null,socket);};
    return await new Promise(resolve=>{
      let done=false,response,responseCleanup;
      const finish=result=>{if(done)return;done=true;controller.signal.removeEventListener('abort',cancel);responseCleanup?.();response?.destroy();request?.destroy();resolve(result);};
      const cancel=()=>finish({error:timedOut?'timeout':'cancelled'});
      controller.signal.addEventListener('abort',cancel,{once:true});
      request=https.request({hostname:url.hostname,port:Number(url.port)||443,path:url.pathname+url.search,method,headers,agent},res=>{
        response=res;try{responseCleanup=onResponse(res,finish);if(done)responseCleanup?.();}catch{finish({error:'invalid_response'});}
        res.on('error',()=>finish({error:'upstream_stream_error'}));res.on('aborted',()=>finish({error:'upstream_aborted'}));
      });
      request.on('error',()=>finish({error:timedOut?'timeout':controller.signal.aborted?'cancelled':'proxy_connection_error'}));
      if(controller.signal.aborted)cancel();else request.end(body);
    });
  } catch(e) {return {error:timedOut?'timeout':signal?.aborted?'cancelled':safeError(e)};}
  finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);request?.destroy();agent?.destroy();socket?.destroy();}
}

export async function directProxyProbe(node,profile,model,targetLengths,signal,seconds=15) {
  const result={status:0,length:0,responseModel:null,state:'',accepted:false,completed:false};
  if(!validModel(model)||!PROBE_ENDPOINTS[profile?.type]||!profile.token)return {...result,error:'proxy_source_missing'};
  const url=new URL(PROBE_ENDPOINTS[profile.type]);
  const data={model,stream:true,store:false,instructions:'Reply only OK.',input:[{role:'user',content:[{type:'input_text',text:'ping'}]}]};
  if(profile.type==='responses')data.max_output_tokens=16;
  // The Codex OAuth path does not guarantee an output-token cap. The payload is
  // deliberately tiny; the socket deadline is not a billing/cancellation guarantee.
  const body=Buffer.from(JSON.stringify(data));
  const headers={'content-type':'application/json',accept:'text/event-stream','content-length':body.length,
    authorization:'Bearer '+profile.token,'user-agent':'sub2api-turnstate/0.9.0','accept-encoding':'identity'};
  if(profile.type==='codex') {
    headers['chatgpt-account-id']=profile.accountId;
    headers['openai-beta']='responses=experimental';
    headers.session_id=randomUUID();
  }
  // Never forward a client API key, Cookie, original prompt, turn state or route
  // overrides to the remote service. Only the explicitly supplied source token.
  const out=await requestViaProxy(node,url,{method:'POST',headers,body,signal,seconds,
    onResponse:(res,finish)=>inspectProbeResponse(res,targetLengths,finish,{signal})});
  return {...result,...out};
}

export async function checkProxyNode(node,signal) {
  // Public network diagnostic only: no provider authentication or model call.
  return requestViaProxy(node,new URL('https://www.cloudflare.com/cdn-cgi/trace'),{signal,seconds:12,onResponse(res,finish){
    if(res.statusCode!==200){finish({ok:false,error:'connectivity_http_'+res.statusCode});return;}
    let size=0,parts=[];
    res.on('data',b=>{size+=b.length;if(size>16384){finish({ok:false,error:'diagnostic_too_large'});return;}parts.push(b);});
    res.on('end',()=>{const values=Object.fromEntries(Buffer.concat(parts).toString('utf8').split('\n').filter(s=>s.includes('=')).map(s=>{const i=s.indexOf('=');return [s.slice(0,i),s.slice(i+1)];}));
      const exitIP=/^[0-9a-f:.]{3,64}$/i.test(values.ip||'')?values.ip:null,country=/^[A-Z]{2}$/.test(values.loc||'')?values.loc:null;
      finish({ok:!!exitIP,exitIP,country,error:exitIP?null:'exit_ip_unavailable'});
    });
  }});
}
