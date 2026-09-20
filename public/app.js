'use strict';
const $=id=>document.getElementById(id);
const scopeNames={model:'按模型共享',credential:'按 API Key 共享',session:'按会话隔离',turn:'按轮次隔离'};
let authenticated=false,enabled=false,csrf='',loading=false,switchBusy=false,rules={},serverOffset=0,revealed=null,renewalById=new Map(),recordsPager=null;
const names={model_disabled:'模型已停用',model_removed:'模型已删除',retained:'固定值保留',invalidated:'固定值已作废',already_invalidated_or_replaced:'固定值已作废或已更换',expired_or_replaced:'固定值到期或已更换',response_model_conflict:'响应模型声明冲突',response_model_mismatch:'响应模型不一致',explicit_turn_state_error:'明确的状态参数错误',expiry_window:'计划提前更新',missing_pin:'首次获取',pin_invalidated:'失效后重取',pin_expired:'到期后重取',unqualified_pin:'固定值待核对',unknown_prior_invalidation:'旧版失效原因未记录',server_error:'上游生成错误',context_length_exceeded:'上下文长度超限',rate_limit_exceeded:'上游限流',insufficient_quota:'上游额度不足',other:'未识别错误（已脱敏）',renewed:'已提前更新',superseded:'已有更新值',unchanged_state:'仍是旧值，继续探测',renewal_started:'提前更新开始',renewal_attempt:'提前更新探测',probing:'正在自动探测',retrying:'未命中，继续探测',found:'已固定',disabled:'已关闭 / 原样透传',client_disconnected:'客户端已断开',configuration_changed:'规则已改变',model_mismatch:'响应模型未命中',length_miss:'长度未命中',http_401:'认证失败',http_403:'无权限',http_429:'上游限流',timeout:'单次连接超时',connection_error:'连接错误',response_failed:'响应失败',waiting_capacity:'等待队列已满',probe_capacity:'其他绑定正在探测',missing_binding:'缺少会话绑定',service_stopped:'服务停止',json_model:'已解析',processing_off:'已关闭，未解析',body_limit:'正文超出解析上限',encoded_body:'压缩正文未解析',inspection_busy:'解析繁忙',declared_model:'响应声明',metadata_limit:'响应诊断达到上限',no_response:'无响应'};
function node(tag,value,cls){const e=document.createElement(tag);e.textContent=value??'—';if(cls)e.className=cls;return e;}
function cells(tr,values){for(const v of values)tr.append(node('td',v));}
function time(v){return v?new Date(v).toLocaleString():'—';}
function note(s){$('message').textContent=s;}
function forget(){revealed=null;document.querySelectorAll('.revealed-state').forEach(e=>e.remove());}
function showLogin(){authenticated=false;enabled=false;csrf='';forget();$('dashboard').hidden=true;$('login').hidden=false;$('badge').textContent='未登录';$('pins').replaceChildren();recordsPager?.reset();}
async function api(route,body){const r=await fetch(route,{credentials:'same-origin',cache:'no-store',...(body===undefined?{}:{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify(body)})});const d=await r.json();if(!r.ok){if(r.status===401)showLogin();const error=new Error(d.error?.message||d.error||`HTTP ${r.status}`);error.code=d.code;throw error;}return d;}
function button(label,fn){const b=node('button',label,'secondary');b.type='button';b.onclick=()=>Promise.resolve().then(fn).catch(e=>note(e.message));return b;}
function clocks(){const now=Date.now()+serverOffset;document.querySelectorAll('[data-expires]').forEach(e=>{const n=Math.max(0,Math.ceil((Number(e.dataset.expires)-now)/1000));e.textContent=n?`${Math.floor(n/60)} 分 ${n%60} 秒后过期`:(enabled?'已过期，下一条请求自动重取':'已过期，关闭中');});document.querySelectorAll('[data-refresh]').forEach(e=>{
 const r=renewalById.get(e.dataset.binding);if(!r){e.textContent='等待建立提前更新计划';return;}
 if(!enabled){e.textContent='已关闭提前更新';return;}
 const labels={waiting_credentials:'等待下一条目标请求提供认证（内存中无凭据）',waiting_request:'等待下一条请求重新获取',renewing:'正在提前探测；旧值到期前继续使用',disabled:'此模型未启用提前更新'};
 if(labels[r.status]){e.textContent=labels[r.status];return;}
 const target=r.status==='error_backoff'?r.nextRetryAt:r.refreshAt;
 const n=Math.max(0,Math.ceil((target-now)/1000));
 e.textContent=r.status==='error_backoff'?`上次更新未成功（${names[r.lastError]||r.lastError}）；${n} 秒后重试`:
   n?`${Math.floor(n/60)} 分 ${n%60} 秒后开始提前探测`:'提前探测即将开始';
 });if(revealed&&Date.now()>=revealed.until)forget();}
function pins(data){$('pins').replaceChildren(...(data.pins.length?data.pins.map(p=>{const c=node('article','','pin-card');const usable=p.status==='candidate'&&p.qualified===true;c.append(node('h3',p.model),node('p',`${p.length} 字节 · ${usable?(enabled?'固定可用':'已保存，关闭中'):'待重新获取'}`,'pin-label'),node('code',p.preview));const clock=node('p','');clock.dataset.expires=p.expiresAt;const renewClock=node('p','','hint');renewClock.dataset.refresh='1';renewClock.dataset.binding=p.id;c.append(clock,renewClock,node('p',`采集 ${time(p.capturedAt)} · 来源 ${p.source} · 指纹 ${p.fingerprint} · 响应声明 ${p.verifiedModel||'未提供'} · 按长度采纳`,'hint'),node('p',p.scope==='model'?'按模型共享 · 所有会话共用一个固定值':`绑定 ${p.client} · ${scopeNames[p.scope]||p.scope} · 会话 ${p.session||'—'}`,'hint'));const actions=node('div','','buttons');actions.append(button('查看完整值',async()=>{forget();const d=await api('/api/pins/reveal',{id:p.id});revealed={id:p.id,state:d.state,until:Date.now()+30000,fingerprint:p.fingerprint};await refresh();}),button('刷新固定值',async()=>{forget();await api('/api/pins/refresh',{id:p.id});note('旧值已失效；启动状态下，下一条匹配请求将自动探测。');await refresh();}));c.append(actions);if(revealed?.id===p.id&&revealed.fingerprint===p.fingerprint)c.append(node('pre',revealed.state,'revealed-state'));return c;}):[node('p',enabled?'尚无固定值；下一条已配置模型请求到达后自动探测。':'已关闭；启动后自动处理目标请求。','hint')]));clocks();}
async function modelAction(model,action){if(action==='delete'&&!confirm(`删除 ${model} 的规则和固定值？仅影响本扩展，原 sub2api 模型仍可调用。`))return;forget();await api('/api/rules/model',{model,action,acknowledgeExperimental:true});if($('rule-form').elements.model.value===model)$('rule-form').hidden=true;note(action==='delete'?'模型规则已删除；该模型恢复原样转发。':action==='disable'?'模型已停用；相关探测已取消，其余模型不受影响。':'模型已启用，将按配置长度自动处理。');await refresh();}
function edit(model=''){const f=$('rule-form');f.hidden=false;f.elements.model.value=model;f.elements.model.readOnly=!!model;f.elements.enabled.checked=rules[model]?.enabled??true;f.elements.ttlSeconds.value=rules[model]?.ttlSeconds??3600;f.elements.scope.value=rules[model]?.scope??'model';f.elements.pinLengths.value=rules[model]?.pinLengths.join(',')||'';f.elements.discardLengths.value=rules[model]?.discardLengths.join(',')||'';}
async function refresh(){if(loading)return;loading=true;try{const s=await api('/api/status');csrf=s.csrf||csrf;authenticated=true;enabled=s.enabled;$('login').hidden=true;$('dashboard').hidden=false;$('badge').textContent=enabled?'已启动':'已关闭';$('switch-status').textContent=enabled?'自动探测与固定已启动':'已关闭状态处理';$('toggle').textContent=enabled?'关闭':'启动';$('toggle').disabled=switchBusy;$('toggle').className=enabled?'secondary':'';$('switch-description').textContent=enabled?'已有固定值直接使用；到期前自动更新，没有则先探测再发送原请求。':'所有新请求原样转发；不探测、不修改状态头。';$('service-info').textContent=`版本 ${s.version} · 上游 ${s.target} · 启动 ${time(s.startedAt)}`;$('requests').textContent=s.counters.requests;const [a,d]=await Promise.all([api('/api/automation'),api('/api/states'),recordsPager.refresh()]);serverOffset=d.serverTime-Date.now();rules=d.rules;renewalById=new Map((a.renewals||[]).map(r=>[r.bindingId,r]));pins(d);$('waiting').textContent=a.waitingRequests;$('cache-hits').textContent=a.totals.cacheHits;$('found').textContent=a.totals.found;$('auto-summary').textContent=a.activeJobs.length?`探测任务 ${a.activeJobs.length}（提前更新 ${a.activeJobs.filter(j=>j.purpose==='renewal').length}）；等待原请求 ${a.waitingRequests}。旧值未过期时请求不等待更新。`:`当前没有探测任务；已建立 ${(a.renewals||[]).filter(r=>r.credentialsReady).length} 个内存认证更新计划。`;$('auto-records').replaceChildren(...[...a.activeJobs,...a.recent].map(j=>{const tr=document.createElement('tr');cells(tr,[time(j.startedAt),j.model,j.attempts,(names[j.trigger]||(j.purpose==='renewal'?'提前更新':'首次获取'))+' · '+(names[j.status]||j.status)+(j.triggerReason?' · '+(names[j.triggerReason]||j.triggerReason):''),j.lastResult?.responseModel||'—',j.lastResult?.length??'—',j.nextAttemptAt?`${Math.max(0,Math.ceil((j.nextAttemptAt-Date.now())/1000))} 秒后`:'—']);return tr;}));$('rules').replaceChildren(...Object.entries(rules).map(([m,r])=>{const tr=document.createElement('tr');cells(tr,[m,(r.enabled?'':'停用 · ')+(r.pinLengths.join(', ')||'未配置'),`${r.ttlSeconds} 秒`,scopeNames[r.scope]||r.scope]);const td=document.createElement('td');td.append(button('编辑',()=>edit(m)),button(r.enabled?'停用':'启用',()=>modelAction(m,r.enabled?'disable':'enable')),button('删除',()=>modelAction(m,'delete')));tr.append(td);return tr;}));if(d.persistError)note('状态持久化失败，请检查服务器磁盘和权限。');}finally{loading=false;}}
function renderRecordsPage(records,page){
  if(records){
    const rows=records.map(r=>{const tr=document.createElement('tr');
      const target=r.requestedModel||r.model;
      const model=target?`${target} → ${r.responseModel||names[r.responseModelReason]||'未声明'}`:(names[r.requestModelReason]||'—');
      cells(tr,[time(r.time),r.kind==='request'?`${r.method} ${r.path}`:`${r.kind} / ${r.action}`,model,r.responseFailed?`${r.status} / 流式失败`:r.status,
        r.requestStateLength===undefined?'—':`${r.requestStateLength} → ${r.forwardedStateLength}`,
        r.responseStateLength===undefined?'—':`${r.responseStateLength} → ${r.returnedStateLength}`,
        [r.requestAction,r.automatic?.action,r.outcome,r.error,r.responseErrorCode,r.responseIncompleteReason,r.pinInvalidationReason||r.reason,r.pinDecision==='not_used'?null:r.pinDecision].filter(Boolean).map(v=>names[v]||v).join(' / ')]);return tr;});
    if(!rows.length){const tr=node('tr',''),td=node('td','暂无记录');td.colSpan=7;tr.append(td);rows.push(tr);}
    $('records').replaceChildren(...rows);
  }
  $('records-prev').disabled=page.loading||!page.hasPrevious;
  $('records-next').disabled=page.loading||!page.hasNext;
  $('records-latest').disabled=page.loading;
  $('records-go').disabled=page.loading||!page.total;
  $('records-page').disabled=page.loading||!page.total;
  $('records-page').max=String(page.totalPages);
  if(document.activeElement!==$('records-page'))$('records-page').value=page.page;
  $('records-page-info').textContent=page.hasData?`第 ${page.page} / ${page.totalPages} 页 · ${page.rangeStart}–${page.rangeEnd} 条 / 共 ${page.total} 条 · 每页 20 条`:'正在读取记录';
  $('records-live-status').textContent=page.loading?'正在加载…':page.live?'最新一页自动刷新':'正在查看历史页；新记录不会打乱本页，点击“最新 20 条”恢复实时查看。';
  $('records').setAttribute('aria-busy',String(page.loading));
}
recordsPager=createRecordsPager({fetchPage:route=>api(route),render:renderRecordsPage,onError:error=>{if(authenticated)note(error.message);}});
$('records-prev').onclick=()=>recordsPager.previous();
$('records-next').onclick=()=>recordsPager.next();
$('records-latest').onclick=()=>recordsPager.latest();
$('records-jump').onsubmit=event=>{event.preventDefault();recordsPager.go(Number($('records-page').value));};
$('toggle').onclick=async()=>{if(switchBusy)return;switchBusy=true;$('toggle').disabled=true;try{const next=!enabled;await api('/api/automation',{enabled:next});enabled=next;note(next?'已启动：自动探测、固定和提前更新；探测可能计费。':'已关闭：已取消探测，等待中的原请求原样放行。');}catch(e){note(e.message);}finally{switchBusy=false;await refresh().catch(e=>note(e.message));}};
$('login-form').onsubmit=async e=>{e.preventDefault();try{const f=e.target.elements;const d=await api('/api/login',{username:f.username.value,password:f.password.value});f.password.value='';csrf=d.csrf;note('');await refresh();}catch(err){note(err.message);}};
$('logout').onclick=async()=>{try{await api('/api/logout',{});}finally{showLogin();}};
$('new-rule').onclick=()=>edit();$('cancel-rule').onclick=()=>$('rule-form').hidden=true;
$('rule-form').onsubmit=async e=>{e.preventDefault();try{const f=e.target.elements,m=f.model.value.trim(),list=s=>s.split(/[,，\s]+/).filter(Boolean).map(Number);const ttlSeconds=Number(f.ttlSeconds.value);if(!Number.isInteger(ttlSeconds)||ttlSeconds<30||ttlSeconds>86400)throw new Error('有效期必须是 30–86400 秒的整数');const r={enabled:f.enabled.checked,pinLengths:list(f.pinLengths.value),discardLengths:list(f.discardLengths.value),ttlSeconds,scope:f.scope.value};await api('/api/rules/model',{model:m,action:'save',rule:r,acknowledgeExperimental:true});e.target.hidden=true;note('模型规则已保存；有效期以原采集时间计算，启动/关闭状态未改变。');await refresh();}catch(err){note(err.message);}};
document.addEventListener('visibilitychange',()=>{if(document.hidden)forget();});setInterval(()=>{if(authenticated&&!document.hidden)refresh().catch(e=>note(e.message));},3000);setInterval(clocks,1000);refresh().catch(()=>{});
