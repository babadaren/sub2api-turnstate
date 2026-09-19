'use strict';
(() => {
  const form=document.getElementById('preflight-form'); let saved={},busy=false;
  const names={found:'已命中，原请求继续',cache_hit:'使用未过期固定值',running:'正在探测，原请求等待',model_mismatch:'响应模型不符',attempts_exhausted:'次数耗尽',deadline:'总等待超时',length_miss:'长度不匹配',hourly_budget:'每小时额度耗尽',http_401:'认证失败',http_403:'无权限',http_429:'上游限流',timeout:'单次超时',configuration_changed:'配置已改变',all_clients_disconnected:'客户端已断开'};
  function edit() {
    const f=form.elements,r=saved[f.model.value.trim()]||{enabled:false,maxAttempts:3,maxWaitSeconds:45,intervalSeconds:2,cooldownSeconds:60,failurePolicy:'reject'};
    f.enabled.checked=r.enabled;
    for(const k of ['maxAttempts','maxWaitSeconds','intervalSeconds','cooldownSeconds','failurePolicy'])f[k].value=r[k];
  }
  async function update() {
    if(!authenticated || busy || document.hidden)return;busy=true;
    try {
      const d=await api('/api/preflight');saved=d.rules;
      const enabled=Object.keys(saved).filter(m=>saved[m].enabled).join(', ')||'无';
      document.getElementById('preflight-summary').textContent=`启用模型：${enabled}；等待原请求 ${d.waitingRequests}；缓存命中 ${d.totals.cacheHits}；探测次数 ${d.totals.attempts}；成功 ${d.totals.found}；阻止原请求 ${d.totals.blocked}；共享小时额度剩余 ${d.budget?.remaining??'—'}。须同时处于“模型固定 / 回灌”模式才生效。`;
      const rows=[...d.activeJobs,...d.recent].slice(0,30).map(j=>{
        const tr=document.createElement('tr');cells(tr,[time(j.createdAt),j.model,j.attempts+'/'+j.maxAttempts,names[j.status]||j.status,
          j.lastResult?.responseModel||'—',j.lastResult?.length??'—',`${j.finishedAt?'已结束':Math.max(0,Math.ceil((j.deadline-Date.now())/1000))+' 秒'}；模型不符 ${j.mismatchCount||0} 次`]);return tr;
      });document.getElementById('preflight-records').replaceChildren(...rows);
      if(!form.dataset.loaded){edit();form.dataset.loaded='1';}
    }catch(e){notify(e.message);}finally{busy=false;}
  }
  form.elements.model.onchange=edit;
  form.onsubmit=async e=>{
    e.preventDefault();
    const f=form.elements,model=f.model.value.trim();
    if(f.enabled.checked && !confirm('开启后会在原请求之前自动发起可能计费的探测。模型/账号/轮次复用有风险；失败策略为返回错误时，原请求不会送出。确认开启？'))return;
    const r={enabled:f.enabled.checked,failurePolicy:f.failurePolicy.value};
    for(const k of ['maxAttempts','maxWaitSeconds','intervalSeconds','cooldownSeconds'])r[k]=Number(f[k].value);
    if(r.enabled&&r.maxWaitSeconds>90&&!confirm('前置探测总等待超过 90 秒。客户端或 Cloudflare 可能提前超时，断开后会取消探测；更多次试验建议使用上面的独立主动探测。仍要保存？'))return;
    try{
      const latest=await api('/api/preflight');
      const d=await api('/api/preflight/config',{rules:{...latest.rules,[model]:r},acknowledgeBillable:true,acknowledgeExperimental:true});saved=d.rules;
      notify('前置探测配置已保存。只保存开关，不会立即产生探测；启用后在下一条匹配请求到达时触发。');await update();
    }catch(err){notify(err.message);}
  };
  document.getElementById('preflight-disable').onclick=async()=>{
    try{const d=await api('/api/preflight');for(const r of Object.values(d.rules))r.enabled=false;await api('/api/preflight/config',{rules:d.rules});saved=d.rules;edit();notify('已关闭所有前置探测，不再阻塞新请求。原固定模式未修改。');await update();}catch(e){notify(e.message);}
  };
  setInterval(update,3000);update();
})();
