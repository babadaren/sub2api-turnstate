'use strict';
let probeSnapshot = null, probeLoading = false;
const probeNames = {waiting_request:'等待选定会话的下一条成功请求',running:'正在主动探测',found:'命中目标，已保存到此绑定',exhausted:'达到次数上限，未命中',stopped:'已停止',processing_disabled:'处理已关闭，探测停止',waiting_expired:'等待请求超时',deadline:'总时限已到',model_mismatch:'响应模型不符，已停止',response_model_missing:'响应未声明模型，未固定',length_miss:'长度未命中',pinned_for_binding:'已固定到选定绑定',target_candidate:'目标候选',configuration_changed:'规则改变，已停止',binding_refreshed:'绑定已刷新，探测停止',budget_exhausted:'探测预算已用完',timeout:'探测超时，未重试',response_failed:'响应失败，未固定',incomplete_response:'响应不完整，未固定',connection_error:'连接失败，未重试'};
function showProbeSource() {
  const manual = $('probe-form').elements.source.value === 'manual';
  $('probe-manual').hidden = !manual; $('probe-binding-field').hidden = manual;
}
async function refreshProbe() {
  if (!authenticated || probeLoading) return; probeLoading = true;
  try {
    probeSnapshot = await api('/api/probes');
    const f = $('probe-form').elements, selected = f.bindingId.value;
    const bindings = probeSnapshot.bindings.filter(b => b.model === f.model.value.trim());
    f.bindingId.replaceChildren(...bindings.map(b => {const o = text('option', `${b.model} · 客户 ${b.client} · 会话 ${b.session || '无'} · ${b.scope}`); o.value = b.id; return o;}));
    if (!bindings.length) { const o = text('option','暂无绑定：先用目标模型发送一条正常请求'); o.value=''; f.bindingId.append(o); }
    if (bindings.some(b => b.id === selected)) f.bindingId.value = selected;
    const job = probeSnapshot.job;
    const busy = !!job && ['waiting_request','running'].includes(job.status);
    $('probe-start').disabled = busy; $('probe-stop').disabled = !busy;
    if (!job) {$('probe-status').textContent='尚未主动探测。不会在启动服务或倒计时到期时自动产生费用。'; $('probe-results').replaceChildren(); return;}
    $('probe-status').textContent = `${probeNames[job.status] || job.status} · 请求 ${job.model} · 目标长度 ${job.targetLengths.join(',')} · 已尝试 ${job.tried}/${job.maxAttempts} · 命中 ${job.hits} · ${time(job.createdAt)}`;
    $('probe-results').replaceChildren(...job.results.map(r => {const tr=document.createElement('tr');cells(tr,[r.attempt,time(r.time),job.model,r.responseModel || '未取得',r.status,r.length,probeNames[r.outcome]||r.outcome]);return tr;}));
  } catch(e) { if(authenticated) $('probe-status').textContent=e.message; }
  finally { probeLoading=false; }
}
$('probe-form').elements.source.onchange=showProbeSource;
$('probe-form').elements.model.onchange=()=>{
  const f=$('probe-form').elements, rule=rules[f.model.value.trim()];
  f.targetLengths.value=rule ? rule.pinLengths.join(',') : '';
  refreshProbe();
};
$('probe-form').onsubmit=async event=>{
  event.preventDefault();
  const f=event.target.elements;
  if(!confirm('主动探测会使用所选凭据向原 sub2api 发起真实模型请求，可能计费并影响同会话路由。只在已验证的单账号/粘性链路使用。同一出口不保证返回目标长度。确认开始这一次有限探测？'))return;
  try {
    const body={model:f.model.value.trim(),source:f.source.value,endpoint:f.endpoint.value,
      targetLengths:f.targetLengths.value.split(/[,，\s]+/).filter(Boolean).map(Number),maxAttempts:Number(f.maxAttempts.value),intervalSeconds:2,
      acknowledgeBillable:true,acknowledgeExperimental:true};
    if(body.source==='next_request')body.bindingId=f.bindingId.value;
    else {body.apiKey=f.apiKey.value.trim();body.sessionId=f.sessionId.value.trim();body.turnId=f.turnId.value.trim();}
    const promise=api('/api/probes/start',body); f.apiKey.value=''; f.sessionId.value=''; f.turnId.value='';
    await promise;notify(body.source==='next_request'?'已布置一次探测：请用选定模型/同一会话再发一条消息，成功结束后开始。':'主动探测已开始；凭据只留在本次任务内存。');await refreshProbe();
  }catch(e){notify(e.message);}
};
$('probe-stop').onclick=async()=>{try{await api('/api/probes/stop',{});notify('已停止探测；已发送的请求仍可能计费。');await refreshProbe();}catch(e){notify(e.message);}};
setInterval(()=>{if(authenticated&&!document.hidden)refreshProbe();},3000);
showProbeSource();
