'use strict';
function createProxyPoolPanel({api,notice}) {
  const $=id=>document.getElementById(id);let data=null,busy=false;
  const el=(tag,text)=>{const n=document.createElement(tag);n.textContent=text??'—';return n;};
  const run=fn=>async()=>{try{await fn();}catch(e){notice(e.message);}};
  const btn=(text,fn)=>{const b=el('button',text);b.type='button';b.className='secondary';b.onclick=run(fn);return b;};
  const resultText=n=>{const r=n.lastResult;if(!r)return '未检查';const p=r.probe,c=r.connectivity;return [c?(c.ok?`出口 ${c.exitIP} · ${c.country||'地区未知'}`:`连接检查：${c.error}`):'',p?`探测 ${p.status} · ${p.length} 字节 · ${p.responseModel||'未声明'} · ${p.outcome}`:''].filter(Boolean).join('；');};
  function render(d) {
    data=d;$('pool-toggle').textContent=d.enabled?'关闭节点探测':'开启节点探测';
    $('pool-toggle').disabled=busy||(!d.enabled&&(!d.ready||!d.nodes.some(n=>n.enabled)));
    $('pool-status').textContent=d.configurationError?'节点配置无法解密，已禁止节点探测':d.enabled?'节点探测已启用（还需总开关开启）':d.ready?'节点探测关闭，沿用 sub2api':'节点已可维护；缺少独立上游认证，尚未启用节点探测';
    $('pool-source-state').textContent=d.profile?`${d.profile.type==='codex'?'Codex OAuth':'Responses API'} · 上游凭据${d.profile.tokenConfigured?'已保存':'缺失'} · 调用方绑定${d.profile.clientKeyConfigured?'已保存':'缺失'}`:'尚未配置。代理账号密码不是模型上游认证。';
    $('pool-next').textContent='下次起点：'+(d.nodes.find(n=>n.id===d.nextNodeId)?.name||'第一个启用节点');
    const rows=d.nodes.map((n,i)=>{const tr=el('tr','');for(const text of [i+1,n.name,`${n.protocol}://${n.host}:${n.port}`,n.enabled?'启用':'停用',n.passwordConfigured?'已加密保存':'无密码',resultText(n)])tr.append(el('td',text));
      const ops=el('td','');ops.append(btn('编辑',()=>edit(n)),btn(n.enabled?'停用':'启用',()=>act(n.id,n.enabled?'disable':'enable')),btn('检查出口',async()=>{notice('正在检查代理连接与公网出口，不发送模型请求。');const r=await api('/api/proxy-pool/check',{id:n.id});notice(r.ok?`代理可连接，出口 ${r.exitIP}，地区 ${r.country||'未知'}。这不代表能够取得 292。`:`连接检查未通过：${r.error}`);await refresh();}),btn('上移',()=>act(n.id,'up')),btn('下移',()=>act(n.id,'down')),btn('删除',async()=>{if(confirm(`删除节点“${n.name}”？`))await act(n.id,'delete');}));tr.append(ops);return tr;});
    if(!rows.length){const tr=el('tr',''),td=el('td','尚未导入节点');td.colSpan=7;tr.append(td);rows.push(tr);}$('pool-nodes').replaceChildren(...rows);
  }
  async function refresh(){render(await api('/api/proxy-pool'));}
  async function act(id,action){render(await api('/api/proxy-pool/nodes',{id,action}));}
  function edit(n={}) {const f=$('pool-node-form');f.hidden=false;for(const name of ['id','name','host','port'])f.elements[name].value=n[name]??'';f.elements.protocol.value=n.protocol||'http';f.elements.username.value='';f.elements.password.value='';f.elements.enabled.checked=n.enabled??true;f.elements.clearCredentials.checked=false;}
  $('pool-new').onclick=()=>edit();$('pool-cancel').onclick=()=>$('pool-node-form').hidden=true;
  $('pool-node-form').onsubmit=event=>{event.preventDefault();run(async()=>{const f=event.target.elements;
    const node={name:f.name.value.trim()||`${f.protocol.value}://${f.host.value.trim()}:${f.port.value}`,protocol:f.protocol.value,host:f.host.value.trim(),port:Number(f.port.value),enabled:f.enabled.checked};
    if(f.username.value||f.clearCredentials.checked)node.username=f.username.value;if(f.password.value||f.clearCredentials.checked)node.password=f.password.value;
    render(await api('/api/proxy-pool/nodes',{action:'save',id:f.id.value||undefined,node}));f.username.value='';f.password.value='';event.target.hidden=true;notice('节点已保存。未修改 sub2api 的正式出口。');})()};
  $('pool-import-form').onsubmit=event=>{event.preventDefault();run(async()=>{const text=event.target.elements.nodes.value;render(await api('/api/proxy-pool/nodes',{action:'import',text}));event.target.elements.nodes.value='';notice('节点已导入，账号密码不会返回到页面。');})()};
  $('pool-source-form').onsubmit=event=>{event.preventDefault();run(async()=>{const f=event.target.elements;
    render(await api('/api/proxy-pool/source',{type:f.type.value,token:f.token.value||undefined,accountId:f.accountId.value||undefined,clientKey:f.clientKey.value||undefined}));
    f.token.value='';f.accountId.value='';f.clientKey.value='';notice('上游连接已保存。过期凭据不会由本工具自动刷新。');})()};
  $('pool-clear-source').onclick=run(async()=>{if(confirm('清除上游探测认证并关闭节点探测？'))render(await api('/api/proxy-pool/source',{clear:true}));});
  $('pool-toggle').onclick=run(async()=>{if(busy||!data)return;
    if(!data.enabled&&!confirm('仅短探测使用导入节点，正式请求出口不变。探测绕过 sub2api 记账且可能计费；跨出口状态兼容性尚未保证。确定开启？'))return;
    busy=true;try{render(await api('/api/proxy-pool/switch',{enabled:!data.enabled,acknowledgeExperimental:true}));}finally{busy=false;if(data)render(data);}
  });
  return {refresh,reset(){data=null;$('pool-nodes').replaceChildren();for(const form of ['pool-node-form','pool-import-form','pool-source-form'])$(form).reset();}};
}
