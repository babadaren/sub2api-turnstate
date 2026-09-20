import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHmac, createCipheriv, createDecipheriv, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { atomicJSON } from './config.mjs';
import { publicIPv4 } from './proxy-tunnel.mjs';
import { directProxyProbe, checkProxyNode } from './proxy-probe.mjs';
import { LocalAuthSource } from './local-auth.mjs';

const MAX_NODES=128;
const err=s=>{throw new Error(s);};
const cleanString=(s,n=255)=>typeof s==='string'&&Buffer.byteLength(s)<=n&&!/[\r\n\0]/.test(s);
export function validateNode(input,previous={}) {
  if(!input||typeof input!=='object'||Array.isArray(input))err('节点格式不正确');
  const protocol=input.protocol??previous.protocol??'http';
  if(!['http','https','socks5'].includes(protocol))err('协议只支持 HTTP、HTTPS、SOCKS5');
  const host=String(input.host??previous.host??'').trim().toLowerCase(),port=Number(input.port??previous.port);
  if(!/^[a-z0-9.-]{1,253}$/.test(host)||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||
    (net.isIP(host)&&!publicIPv4(host)))err('仅接受公网 IPv4 或公网域名');
  if(!Number.isInteger(port)||port<1||port>65535)err('端口必须是 1–65535 的整数');
  const username=input.username??previous.username??'',password=input.password??previous.password??'';
  if(!cleanString(username)||!cleanString(password)||(!username&&password)||username.includes(':'))err('代理账号密码格式不正确');
  const name=input.name??previous.name??`${protocol}://${host}:${port}`;
  if(!cleanString(name,120)||!name)err('节点名称过长或不正确');
  const enabled=input.enabled??previous.enabled??true;if(typeof enabled!=='boolean')err('节点启用状态不正确');
  return {id:previous.id||randomUUID(),name,protocol,host,port,username,password,enabled};
}
export function parseNodeImport(text) {
  if(typeof text!=='string'||Buffer.byteLength(text)>60000)err('导入内容过大');
  const input=text.replace(/用户密码\s*[：:]\s*/g,'').replace(/[，,]/g,' ');
  const lines=input.split(/\r?\n/).map(s=>s.trim()).filter(Boolean),nodes=[];
  for(let i=0;i<lines.length;i++) {
    let line=lines[i],data;
    if(/^\w+:\/\//.test(line)) {
      try {const u=new URL(line);if(u.search||u.hash||!['','/'].includes(u.pathname))err('代理 URL 不能包含路径');
        data={protocol:u.protocol.replace(':','').replace('socks5h','socks5'),host:u.hostname,port:Number(u.port||({'http:':80,'https:':443,'socks5:':1080,'socks5h:':1080}[u.protocol])),username:decodeURIComponent(u.username),password:decodeURIComponent(u.password)};
      }catch{err('代理 URL 格式不正确；特殊字符请进行 URL 编码');}
    } else {
      if(/^[^\s:]+:\d+$/.test(line)&&i+1<lines.length&&/^[^\s:]+:[^\s]+$/.test(lines[i+1])&&!/^[^\s:]+:\d+$/.test(lines[i+1]))line+=' '+lines[++i];
      let m=/^([^\s:]+):(\d+)\s+(\S[^:]*):(.+)$/.exec(line);
      if(!m)m=/^([^\s:]+):(\d+):([^:]+):(.+)$/.exec(line);
      if(m)data={host:m[1],port:Number(m[2]),username:m[3],password:m[4]};
      else {m=/^([^\s:]+):(\d+)$/.exec(line);if(!m)err('每行填写 host:port:user:password 或代理 URL');data={host:m[1],port:Number(m[2])};}
    }
    nodes.push(validateNode(data));if(nodes.length>MAX_NODES)err('最多维护 128 个节点');
  }
  if(!nodes.length)err('没有可导入的节点');return nodes;
}
const resumable=new Set(['length_miss','model_mismatch','unchanged_state','proxy_connection_error','proxy_closed',
  'proxy_handshake_error','proxy_auth_failed','proxy_connect_rejected','proxy_tls_verification_failed','proxy_address_rejected',
  'timeout','upstream_aborted','upstream_stream_error','http_502','http_503','http_504',
  'unsupported_response_type','unsupported_content_encoding','response_decode_error','invalid_response_json','response_too_large','incomplete_response']);

export class ProxyPool {
  constructor(home,config,journal,options={}) {
    this.file=path.join(home,'proxy-pool.enc.json');this.journal=journal;
    this.key=createHmac('sha256',Buffer.from(config.controlToken,'hex')).update('turnstate-proxy-v1').digest();
    this.salt=config.logSalt;this.data={version:1,enabled:false,nextId:null,nodes:[],profile:null};
    this.invalid=false;this.generation=0;this.jobs=new Map();this.controllers=new Set();this.results=new Map();this.checking=new Set();
    this.transport=options.transport||directProxyProbe;this.checkTransport=options.checkTransport||checkProxyNode;
    this.localAuth=options.localAuth||new LocalAuthSource(config);
    try {const packed=JSON.parse(fs.readFileSync(this.file,'utf8')),d=createDecipheriv('aes-256-gcm',this.key,Buffer.from(packed.iv,'hex'));
      d.setAuthTag(Buffer.from(packed.tag,'hex'));d.setAAD(Buffer.from('turnstate-proxy-v1'));
      const parsed=JSON.parse(Buffer.concat([d.update(Buffer.from(packed.data,'base64')),d.final()]).toString('utf8'));
      if(parsed.version!==1||!Array.isArray(parsed.nodes)||parsed.nodes.length>MAX_NODES||typeof parsed.enabled!=='boolean')throw new Error('invalid');
      parsed.nodes=parsed.nodes.map(n=>validateNode(n,{id:n.id}));this.data=parsed;
    }catch(e){if(e.code!=='ENOENT')this.invalid=true;}
  }
  persist(next=this.data) {
    if(this.invalid)err('节点配置无法解密，请恢复配置与原控制密钥；已停止节点探测');
    const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key,iv);c.setAAD(Buffer.from('turnstate-proxy-v1'));
    const body=Buffer.concat([c.update(JSON.stringify(next),'utf8'),c.final()]);
    atomicJSON(this.file,{version:1,iv:iv.toString('hex'),tag:c.getAuthTag().toString('hex'),data:body.toString('base64')});
    this.data=next;
  }
  hashClient(credential) {return createHmac('sha256',this.salt).update(String(credential).replace(/^Bearer\s+/i,'').trim()).digest('hex');}
  resolvedProfile() {
    const p=this.data.profile;
    if(p?.source==='sub2api')return this.localAuth.resolve(p.accountRecordId,p.clientKeyId);
    return p;
  }
  ready() {
    try {const p=this.resolvedProfile();return !this.invalid&&!!p?.token&&!!p.allowedClientHash&&!!p.type&&(p.type!=='codex'||!!p.accountId);}
    catch{return false;}
  }
  snapshot() {
    const profile=this.data.profile;let resolved=null,sourceError=null;
    try {resolved=this.resolvedProfile();}catch(e){sourceError=e.code||'local_auth_unavailable';}
    return {enabled:this.data.enabled,ready:this.ready(),configurationError:this.invalid,nextNodeId:this.data.nextId,
      profile:profile?{type:profile.type,source:profile.source||'manual',tokenConfigured:!!resolved?.token,
        accountConfigured:!!resolved?.accountId,clientKeyConfigured:!!resolved?.allowedClientHash,
        ...(profile.source==='sub2api'?{accountRecordId:profile.accountRecordId,clientKeyId:profile.clientKeyId,
          expiresAt:resolved?.expiresAt||null,syncedAt:resolved?.fetchedAt||null,error:sourceError}:{})}:null,
      localAuth:this.localAuth.snapshot(),
      nodes:this.data.nodes.map(n=>({id:n.id,name:n.name,protocol:n.protocol,host:n.host,port:n.port,enabled:n.enabled,
        usernameConfigured:!!n.username,passwordConfigured:!!n.password,lastResult:this.results.get(n.id)||null,checking:this.checking.has(n.id)})),
      activeRequests:this.controllers.size,
      notice:'仅短探测使用导入节点；正式请求仍走 sub2api。可读取管理员批准的本机 OAuth 账号，Token 不回显且不重复保存到节点配置。独立探测不进入 sub2api 计费记录；跨出口兼容性未保证。'};
  }
  cancel() {this.generation++;for(const c of this.controllers)c.abort();this.jobs.clear();}
  mutate(body) {
    const d=structuredClone(this.data),{action}=body;
    if(action==='import') {
      const nodes=parseNodeImport(body.text);for(const n of nodes) {
        const old=d.nodes.find(x=>x.protocol===n.protocol&&x.host===n.host&&x.port===n.port&&x.username===n.username);
        if(old)Object.assign(old,n,{id:old.id});else d.nodes.push(n);
      }
      if(d.nodes.length>MAX_NODES)err('最多维护 128 个节点');
    } else if(action==='save') {
      const old=d.nodes.find(x=>x.id===body.id),n=validateNode(body.node,old||{});
      if(body.id&&!old)err('节点不存在');if(old)Object.assign(old,n);else d.nodes.push(n);
      if(d.nodes.length>MAX_NODES)err('最多维护 128 个节点');
    } else {
      const i=d.nodes.findIndex(x=>x.id===body.id);if(i<0)err('节点不存在');
      if(action==='delete')d.nodes.splice(i,1);
      else if(action==='enable'||action==='disable')d.nodes[i].enabled=action==='enable';
      else if(action==='up'&&i>0)[d.nodes[i-1],d.nodes[i]]=[d.nodes[i],d.nodes[i-1]];
      else if(action==='down'&&i<d.nodes.length-1)[d.nodes[i],d.nodes[i+1]]=[d.nodes[i+1],d.nodes[i]];
      else if(!['up','down'].includes(action))err('节点操作不正确');
    }
    if(!d.nodes.some(n=>n.id===d.nextId&&n.enabled))d.nextId=d.nodes.find(n=>n.enabled)?.id||null;
    if(!d.nodes.some(n=>n.enabled))d.enabled=false;
    this.persist(d);this.cancel();
    this.journal.add({kind:'proxy_pool',action:'nodes_'+action,count:d.nodes.length});return this.snapshot();
  }
  configureProfile(body) {
    const d=structuredClone(this.data);
    if(body.clear===true){d.profile=null;d.enabled=false;}
    else if(body.source==='sub2api') {
      // Persist identifiers only. Resolve a fresh export on every actual probe.
      this.localAuth.resolve(body.accountRecordId,body.clientKeyId);
      d.profile={source:'sub2api',type:'codex',accountRecordId:body.accountRecordId,clientKeyId:body.clientKeyId};
    }
    else {
      const old=d.profile?.source==='sub2api'?{}:d.profile||{},type=body.type??old.type;
      if(body.source!==undefined&&body.source!=='manual')err('认证来源不正确');
      if(!['codex','responses'].includes(type))err('上游类型不正确');
      const token=body.token||old.token,accountId=body.accountId??old.accountId??'';
      if(!cleanString(token,16000)||!token||/\s/.test(token))err('需要填写上游访问凭据，不是代理密码或 sub2api API Key');
      if(type==='codex'&&(!/^[\w-]{1,128}$/.test(accountId)))err('Codex 上游需要账户 ID');
      if(body.clientKey!==undefined&&(!cleanString(body.clientKey,8192)||!body.clientKey.trim()))err('需要填写允许触发探测的本机 API Key');
      const allowedClientHash=body.clientKey?this.hashClient(body.clientKey):old.allowedClientHash;
      if(!allowedClientHash)err('需要绑定允许触发探测的本机 API Key');
      d.profile={type,token,accountId:type==='codex'?accountId:'',allowedClientHash};
    }
    this.persist(d);this.cancel();this.journal.add({kind:'proxy_pool',action:'source_configured',ready:this.ready()});return this.snapshot();
  }
  setEnabled(enabled,ack=false) {
    if(typeof enabled!=='boolean')err('开关格式不正确');
    if(enabled&&(!ack||!this.ready()||!this.data.nodes.some(n=>n.enabled)))err('需先配置上游认证、导入启用节点，并确认跨出口探测可能计费');
    this.persist({...this.data,enabled});this.cancel();this.journal.add({kind:'proxy_pool',action:enabled?'enabled':'disabled'});return this.snapshot();
  }
  allowed(routing,profile=undefined) {
    try {profile??=this.resolvedProfile();}catch{return false;}
    const key=routing.headers?.authorization||routing.headers?.['x-api-key']||'';
    const actual=Buffer.from(this.hashClient(key)),expected=Buffer.from(profile?.allowedClientHash||'');
    return !!key&&actual.length===expected.length&&timingSafeEqual(actual,expected);
  }
  endJob(id) {this.jobs.delete(id);}
  async probe(jobId,model,routing,lengths,signal,fallback) {
    if(!this.data.enabled)return {...await fallback(),probeRoute:{kind:'sub2api',reason:'pool_disabled'}};
    let profile;
    try {profile=this.resolvedProfile();}
    catch(error){return {...await fallback(),probeRoute:{kind:'sub2api',reason:error.code||'local_auth_unavailable'}};}
    if(this.invalid||!profile?.token||!profile.allowedClientHash||!this.allowed(routing,profile))return {...await fallback(),probeRoute:{kind:'sub2api',reason:!profile?.token?'source_missing':'client_not_bound'}};
    let scan=this.jobs.get(jobId);
    if(!scan) {
      const ids=this.data.nodes.filter(n=>n.enabled).map(n=>n.id),start=Math.max(0,ids.indexOf(this.data.nextId));
      scan={generation:this.generation,ids:[...ids.slice(start),...ids.slice(0,start)],offset:0};this.jobs.set(jobId,scan);
    }
    if(scan.generation!==this.generation||scan.offset>=scan.ids.length)return {...await fallback(),probeRoute:{kind:'sub2api',reason:'node_round_exhausted'}};
    const id=scan.ids[scan.offset++],node=this.data.nodes.find(n=>n.id===id&&n.enabled);
    if(!node)return {status:0,length:0,error:'proxy_configuration_changed',retryProxy:true};
    const enabled=this.data.nodes.filter(n=>n.enabled),index=enabled.findIndex(n=>n.id===id);
    this.persist({...this.data,nextId:enabled[(index+1)%enabled.length]?.id||null});
    const controller=new AbortController(),abort=()=>controller.abort(),gen=this.generation;
    this.controllers.add(controller);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const started=Date.now();let out;
    try {out=await this.transport({...node},{...profile},model,lengths,controller.signal,15);}
    catch{out={status:0,length:0,error:'proxy_connection_error'};}
    finally{this.controllers.delete(controller);signal?.removeEventListener('abort',abort);}
    if(signal?.aborted)return {status:0,length:0,error:'cancelled'};
    if(gen!==this.generation)return {status:0,length:0,error:'proxy_configuration_changed',retryProxy:true};
    const route={kind:'proxy',nodeId:id,nodeName:node.name,authSource:this.data.profile?.source||'manual',
      ...(this.data.profile?.source==='sub2api'?{accountRecordId:this.data.profile.accountRecordId}:{})};
    const summary={time:new Date().toISOString(),status:out.status||0,length:out.length||0,responseModel:out.responseModel||null,
      outcome:out.error||'candidate',durationMs:Date.now()-started,
      responseContentType:out.responseContentType||null,responseEncoding:out.responseEncoding||null,responseDetection:out.responseDetection||null};
    this.results.set(id,{...this.results.get(id),probe:summary});
    this.journal.add({kind:'proxy_pool',action:'probe_result',model,nodeId:id,...summary});
    return {...out,probeRoute:route,retryProxy:!out.accepted&&resumable.has(out.error)};
  }
  async check(id) {
    const node=this.data.nodes.find(n=>n.id===id);if(!node)err('节点不存在');
    if(this.checking.has(id)||this.checking.size>=2)err('节点检查正在运行');
    const c=new AbortController();this.controllers.add(c);this.checking.add(id);
    try {
      const result=await this.checkTransport({...node},c.signal);
      const safe={ok:!!result.ok,exitIP:result.exitIP||null,country:result.country||null,error:result.error||null,time:new Date().toISOString()};
      if(this.data.nodes.some(n=>n.id===id))this.results.set(id,{...this.results.get(id),connectivity:safe});
      this.journal.add({kind:'proxy_pool',action:'connectivity_test',nodeId:id,ok:safe.ok,error:safe.error});return safe;
    }finally{this.checking.delete(id);this.controllers.delete(c);}
  }
  close(){this.cancel();this.key.fill(0);}
}
