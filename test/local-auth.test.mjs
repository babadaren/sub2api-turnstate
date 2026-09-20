import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { LocalAuthSource } from '../lib/local-auth.mjs';
import { ProxyPool } from '../lib/proxy-pool.mjs';
import { createExtension } from '../lib/server.mjs';
import { makeConfig } from '../lib/config.mjs';

const TOKEN_A='synthetic-upstream-secret-A', TOKEN_B='synthetic-upstream-secret-B', CLIENT='synthetic-local-client-key';
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'local-auth-test-')),dir=path.join(root,'run'),home=path.join(root,'home');
  fs.mkdirSync(dir,{mode:0o750});fs.mkdirSync(home,{mode:0o700});
  const file=path.join(dir,'accounts.json'),{config}=makeConfig({password:'local-auth-testing-pass',mode:'off'});
  let now=1800000000000;
  const hash=createHmac('sha256',config.logSalt).update(CLIENT).digest('hex');
  const initial=()=>({version:1,ok:true,fetchedAt:now,saltId:createHmac('sha256',config.logSalt).update('local-auth-salt-v1').digest('hex'),
    accounts:[{id:1,platform:'openai',type:'oauth',status:'active',token:TOKEN_A,accountId:'synthetic-account',expiresAt:now+3600000,
      clients:[{id:1,groupId:2,hash,expiresAt:null}]}]});
  const write=d=>{fs.writeFileSync(file,JSON.stringify(d),{mode:0o640});if(process.platform!=='win32')fs.chmodSync(file,0o640);};
  write(initial());
  const source=new LocalAuthSource(config,{file,now:()=>now,expectedUid:process.getuid?.()??0});
  const events=[],seen=[],cleanup=[];
  const pool=new ProxyPool(home,config,{add:e=>events.push(e)},{localAuth:source,transport:async(node,profile)=>{
    seen.push({token:profile.token,accountId:profile.accountId});return {status:200,length:292,state:'S'.repeat(292),accepted:true};
  }});
  const configure=()=>{pool.mutate({action:'import',text:'8.8.8.8:8080:synthetic-user:synthetic-password'});
    pool.configureProfile({source:'sub2api',accountRecordId:1,clientKeyId:1});pool.setEnabled(true,true);};
  const routing={headers:{authorization:'Bearer '+CLIENT}};
  let fallbackCount=0;
  const probe=(id='job')=>pool.probe(id,'gpt-6-astra',routing,[292],new AbortController().signal,async()=>{fallbackCount++;return {status:200,length:312,error:'length_miss'};});
  t.after(async()=>{for(const fn of cleanup)await fn();pool.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,dir,home,file,source,pool,config,events,seen,initial,write,configure,routing,probe,cleanup,
    advance:n=>{now+=n;},fallbackCount:()=>fallbackCount};
}

test('local auth snapshot exposes only approved metadata, never token/account identifier/client hash',t=>{
  const f=fixture(t),s=f.source.snapshot();assert.equal(s.fresh,true);assert.equal(s.accounts[0].ready,true);
  assert.deepEqual(s.accounts[0].clients,[{id:1,groupId:2,expiresAt:null}]);
  for(const v of [TOKEN_A,CLIENT,'synthetic-account',f.initial().accounts[0].clients[0].hash])assert.equal(JSON.stringify(s).includes(v),false);
});
test('local selection persists IDs only; outgoing synthetic probe obtains latest token',async t=>{
  const f=fixture(t);f.configure();assert.deepEqual(f.pool.data.profile,{source:'sub2api',type:'codex',accountRecordId:1,clientKeyId:1});
  assert.equal((await f.probe('first')).accepted,true);assert.equal(f.seen[0].token,TOKEN_A);
  const next=f.initial();next.accounts[0].token=TOKEN_B;f.write(next);
  await f.probe('second');assert.equal(f.seen[1].token,TOKEN_B);
  assert.equal(JSON.stringify(f.pool.data).includes(TOKEN_A),false);assert.equal(JSON.stringify(f.pool.data).includes(TOKEN_B),false);
  const logs=JSON.stringify(f.events),pub=JSON.stringify(f.pool.snapshot());
  for(const secret of [TOKEN_A,TOKEN_B,CLIENT,'synthetic-account']){assert.equal(logs.includes(secret),false);assert.equal(pub.includes(secret),false);}
});
test('a source-only save does not enable an existing disabled node pool',t=>{
  const f=fixture(t);f.pool.configureProfile({source:'sub2api',accountRecordId:1,clientKeyId:1});
  assert.equal(f.pool.snapshot().ready,true);assert.equal(f.pool.snapshot().enabled,false);
});
test('stale exporter fails closed for direct proxy and safely uses original sub2api fallback',async t=>{
  const f=fixture(t);f.configure();f.advance(180001);assert.equal(f.pool.ready(),false);
  assert.equal(f.source.snapshot().error,'local_auth_stale');const r=await f.probe();assert.equal(r.probeRoute.reason,'local_auth_stale');
  assert.equal(f.seen.length,0);assert.equal(f.fallbackCount(),1);
});
test('revoked client key is removed on next snapshot, no retained static permission',async t=>{
  const f=fixture(t);f.configure();await f.probe('a');const next=f.initial();next.accounts[0].clients=[];f.write(next);
  const r=await f.probe('b');assert.equal(f.pool.ready(),false);assert.equal(r.probeRoute.kind,'sub2api');assert.equal(f.seen.length,1);
});
test('expired or disabled OAuth account cannot enable independent probes',async t=>{
  for(const flag of ['expired','disabled'])await t.test(flag,async st=>{
    const f=fixture(st),d=f.initial();if(flag==='expired')d.accounts[0].expiresAt-=3600000;else d.accounts[0].status='disabled';f.write(d);
    assert.equal(f.source.snapshot().accounts[0].ready,false);assert.throws(()=>f.pool.configureProfile({source:'sub2api',accountRecordId:1,clientKeyId:1}),/local_auth_account_not_ready/);
  });
});
test('failure marker, corrupt JSON, wrong salt, missing file and future timestamp are rejected',async t=>{
  for(const kind of ['failure','json','salt','missing','future'])await t.test(kind,st=>{
    const f=fixture(st);f.configure();const d=f.initial();
    if(kind==='failure')d.ok=false;if(kind==='salt')d.saltId='wrong';if(kind==='future')d.fetchedAt+=60000;
    f.write(d);if(kind==='json')fs.writeFileSync(f.file,'invalid JSON');if(kind==='missing')fs.unlinkSync(f.file);
    assert.equal(f.pool.ready(),false);assert.equal(f.source.snapshot().fresh,false);
  });
});
test('unapproved or malformed record IDs and unbound callers never reach direct transport',async t=>{
  const f=fixture(t);for(const id of ['1',-1,999,1.5])assert.throws(()=>f.pool.configureProfile({source:'sub2api',accountRecordId:id,clientKeyId:1}));
  assert.throws(()=>f.pool.configureProfile({source:'sub2api',accountRecordId:1,clientKeyId:2}));
  f.configure();const r=await f.pool.probe('bad','gpt-6-astra',{headers:{authorization:'Bearer stranger'}},[292],new AbortController().signal,async()=>({status:401}));
  assert.equal(r.probeRoute.reason,'client_not_bound');assert.equal(f.seen.length,0);
});
test('unsafe file mode, directory mode and symlinks are refused on POSIX', {skip:process.platform==='win32'},t=>{
  const f=fixture(t);fs.chmodSync(f.file,0o644);assert.equal(f.source.snapshot().error,'local_auth_permissions');
  fs.chmodSync(f.file,0o640);fs.chmodSync(f.dir,0o770);assert.equal(f.source.snapshot().error,'local_auth_permissions');
  fs.chmodSync(f.dir,0o750);const dest=path.join(f.dir,'real.json');fs.renameSync(f.file,dest);fs.symlinkSync(dest,f.file);
  assert.equal(f.source.snapshot().error,'local_auth_permissions');
});
test('restart restores local account selection and resolves updated token without secret copies',async t=>{
  const f=fixture(t);f.configure();const next=f.initial();next.accounts[0].token=TOKEN_B;f.write(next);
  const again=new ProxyPool(f.home,f.config,{add:()=>{}},{localAuth:f.source});
  assert.equal(again.ready(),true);assert.equal(again.resolvedProfile().token,TOKEN_B);assert.equal(again.data.profile.token,undefined);again.close();
});
test('manual source and clearing still work, local source does not reuse hidden manual secrets',t=>{
  const f=fixture(t);f.pool.configureProfile({type:'codex',token:TOKEN_A,accountId:'manual-account',clientKey:CLIENT});
  f.pool.configureProfile({source:'sub2api',accountRecordId:1,clientKeyId:1});assert.equal(f.pool.data.profile.token,undefined);
  assert.throws(()=>f.pool.configureProfile({source:'manual',type:'codex'}));
  f.pool.configureProfile({clear:true});assert.equal(f.pool.ready(),false);assert.equal(f.pool.data.profile,null);
});
test('authenticated API provides local-account selection with CSRF, not credential export',async t=>{
  const f=fixture(t),app=await createExtension(f.config,f.home,{proxyPort:0,adminPort:0,proxyPoolOptions:{localAuth:f.source,transport:()=>assert.fail('no real probes')}});
  f.config.adminPort=app.admin.address().port;f.config.adminOrigin=`http://127.0.0.1:${f.config.adminPort}`;const base=f.config.adminOrigin;
  f.cleanup.push(()=>app.close(100));
  assert.equal((await fetch(base+'/api/proxy-pool')).status,401);
  const data={source:'sub2api',accountRecordId:1,clientKeyId:1};
  const login=await fetch(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'local-auth-testing-pass'})});
  const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();const headers={cookie,origin:base,'content-type':'application/json'};
  assert.equal((await fetch(base+'/api/proxy-pool/source',{method:'POST',headers,body:JSON.stringify(data)})).status,403);
  const r=await fetch(base+'/api/proxy-pool/source',{method:'POST',headers:{...headers,'x-csrf-token':csrf},body:JSON.stringify(data)});
  assert.equal(r.status,200);const text=await r.text();assert.equal(JSON.parse(text).ready,true);assert.equal(JSON.parse(text).enabled,false);
  for(const secret of [TOKEN_A,CLIENT,'synthetic-account'])assert.equal(text.includes(secret),false);
  const html=await(await fetch(base)).text();assert.match(html,/pool-local-form/);assert.match(html,/无需手动复制/);
});
