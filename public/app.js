'use strict';
const $ = id => document.getElementById(id);
let csrf = '', authenticated = false, rules = {}, stateData = null, loading = false, serverOffset = 0;
const modeName = { off: '停止处理 / 透传', observe: '观察 / 不改写', pin: '模型固定 / 回灌', drop312: '旧版实验过滤' };
const text = (tag, value, cls) => { const el = document.createElement(tag); el.textContent = value ?? '—'; if (cls) el.className = cls; return el; };
const notify = message => { $('message').textContent = message; };
function clearSecrets() { document.querySelectorAll('.revealed-state').forEach(e => e.remove()); }
async function api(route, body) {
  const response = await fetch(route, { credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401) showLogin(); throw new Error(result.error || `HTTP ${response.status}`); }
  return result;
}
function showLogin() { authenticated = false; csrf = ''; clearSecrets(); $('dashboard').hidden = true; $('login').hidden = false; $('badge').textContent = '未登录'; $('pins').replaceChildren(); }
function button(label, handler, secondary = true) { const b = text('button', label); if (secondary) b.className = 'secondary'; b.onclick = () => Promise.resolve().then(handler).catch(e => notify(e.message)); return b; }
function cells(row, values) { for (const value of values) row.append(text('td', value)); }
function time(value) { return value ? new Date(value).toLocaleString() : '—'; }
function renderRules() {
  const rows = [];
  for (const [model, rule] of Object.entries(rules)) {
    const tr = document.createElement('tr'); cells(tr, [model, rule.enabled ? '启用' : '关闭', rule.pinLengths.join(', ') || (rule.autoLearn ? '自动学习' : '未配置'), rule.discardLengths.join(', ') || '无', `${rule.ttlSeconds} 秒`, rule.scope]);
    const td = document.createElement('td'); td.append(button('编辑', () => editRule(model)), button('刷新该模型', () => refreshPin({ model }))); tr.append(td); rows.push(tr);
  }
  $('rules').replaceChildren(...rows);
}
function editRule(model = '') {
  const form = $('rule-form'), rule = rules[model] || { pinLengths: [], discardLengths: [], ttlSeconds: 300, scope: 'session', unknownPolicy: 'pass', enabled: false, autoLearn: false };
  form.hidden = false; form.elements.model.value = model; form.elements.model.readOnly = !!model;
  for (const name of ['pinLengths','discardLengths']) form.elements[name].value = rule[name].join(',');
  for (const name of ['ttlSeconds','scope','unknownPolicy']) form.elements[name].value = rule[name];
  for (const name of ['enabled','autoLearn']) form.elements[name].checked = rule[name];
  form.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
async function refreshPin(identity) {
  const result = await api('/api/pins/refresh', identity);
  notify(`已失效 ${result.count} 条旧绑定，等待下一条匹配的成功响应获取新值；未发送探测请求。`); await refresh();
}
function countdown() {
  for (const el of document.querySelectorAll('[data-expires]')) {
    const remaining = Math.max(0, Math.ceil((Number(el.dataset.expires) - (Date.now() + serverOffset)) / 1000));
    el.textContent = remaining ? `${Math.floor(remaining / 60)} 分 ${remaining % 60} 秒后失效 / 待刷新` : '等待新响应（旧值不再回灌）';
  }
}
function renderPins(data) {
  const cards = data.pins.map(pin => {
    const card = text('article', '', 'pin-card');
    card.append(text('h3', pin.model), text('p', `${pin.length} 字节 · ${data.mode === 'pin' && pin.status === 'candidate' ? '固定中' : pin.status === 'candidate' ? '候选（未回灌）' : '待刷新'}`, 'pin-label'), text('code', pin.preview));
    const clock = text('p', ''); clock.dataset.expires = pin.expiresAt; card.append(clock);
    card.append(text('p', `隔离：${pin.scope} · 客户标识 ${pin.client} · 会话 ${pin.session || '—'}`, 'hint'), text('p', `指纹 ${pin.fingerprint} · 采集 ${time(pin.capturedAt)} · 来源 ${pin.source}`, 'hint'));
    const actions = text('div', '', 'buttons');
    actions.append(button('查看完整值', async () => {
      const old = card.querySelector('.revealed-state'); if (old) { old.remove(); return; }
      const result = await api('/api/pins/reveal', { id: pin.id }); const view = text('pre', result.state, 'revealed-state'); card.append(view);
      setTimeout(() => view.remove(), 30000);
    }), button('手动刷新', () => refreshPin({ id: pin.id })), button('手动替换', async () => {
      const state = prompt('仅替换这一隔离绑定的值。请粘贴符合模型配置长度的状态；取消则不修改。');
      if (!state) return;
      if (!confirm('这是实验性手动固定，不能验证上游有效性。确认仅用于此绑定？')) return;
      await api('/api/pins/set', { id: pin.id, state: state.trim(), acknowledgeExperimental: true }); notify('已手动替换固定值。'); await refresh();
    })); card.append(actions); return card;
  });
  $('pins').replaceChildren(...(cards.length ? cards : [text('p', '尚无固定值。先让真实请求经过本服务；配置好模型长度和隔离范围后，从成功响应自动采集。', 'hint')])); countdown();
}
function histogram(value) { return Object.entries(value || {}).map(([length, count]) => `${length} : ${count}`).join(' / ') || '—'; }
async function refresh() {
  if (loading) return; loading = true;
  try {
    const status = await api('/api/status'); csrf = status.csrf || csrf; authenticated = true;
    $('login').hidden = true; $('dashboard').hidden = false; $('badge').textContent = modeName[status.mode] || status.mode;
    $('service-info').textContent = `版本 ${status.version} · 上游 ${status.target} · 启动 ${time(status.startedAt)}`;
    for (const [id,key] of [['requests','requests'],['failures','failures'],['removed','removedHeaders']]) $(id).textContent = status.counters[key];
    $('active').textContent = status.active; $('notice').textContent = status.notice;
    const [data, logs] = await Promise.all([api('/api/states'), api('/api/records?limit=100&kind=' + encodeURIComponent($('filter').value))]);
    stateData = data; serverOffset = data.serverTime - Date.now(); rules = data.rules; renderRules(); renderPins(data);
    if (data.persistError) notify('警告：状态文件写入失败，目前只保存在内存中，请检查磁盘和权限。');
    $('observed').replaceChildren(...data.observed.map(o => { const tr = document.createElement('tr'); cells(tr, [o.model,histogram(o.requestLengths),histogram(o.responseLengths),time(o.lastSeen)]); return tr; }));
    $('records').replaceChildren(...logs.records.map(r => { const tr = document.createElement('tr'); cells(tr, [time(r.time),r.kind === 'request' ? `${r.method} ${r.path}` : `${r.kind} / ${r.action}`,r.model ? `${r.model} → ${r.responseModel || '响应未识别'}` : '—',r.status,
      r.requestStateLength === undefined ? '—' : `${r.requestStateLength} → ${r.forwardedStateLength}`,r.responseStateLength === undefined ? '—' : `${r.responseStateLength} → ${r.returnedStateLength}`,r.headersMs == null ? '—' : `${r.headersMs} ms`,[r.requestAction,r.responseAction,r.error].filter(Boolean).join(' / ')]); return tr; }));
  } finally { loading = false; }
}
$('login-form').onsubmit = async event => { event.preventDefault(); try { const form = new FormData(event.target); const result = await api('/api/login', { username: form.get('username'), password: form.get('password') }); csrf = result.csrf; event.target.elements.password.value = ''; notify(''); await refresh(); } catch(e) { notify(e.message); } };
$('rule-form').onsubmit = async event => {
  event.preventDefault();
  try {
    const f = event.target.elements, list = value => value.trim() ? value.split(/[,，\s]+/).filter(Boolean).map(Number) : [];
    if (!confirm('规则只以长度作兼容判断，不能判断上游真实有效性；修改会清除该模型旧绑定。确认保存？')) return;
    const next = { ...rules, [f.model.value.trim()]: { enabled: f.enabled.checked, pinLengths: list(f.pinLengths.value), discardLengths: list(f.discardLengths.value), ttlSeconds: Number(f.ttlSeconds.value), scope: f.scope.value, unknownPolicy: f.unknownPolicy.value, autoLearn: f.autoLearn.checked } };
    await api('/api/rules', { rules: next, acknowledgeExperimental: true }); event.target.hidden = true; notify('规则已保存，其他模型配置保持不变。'); await refresh();
  } catch(e) { notify(e.message); }
};
$('new-rule').onclick = () => editRule(); $('cancel-rule').onclick = () => { $('rule-form').hidden = true; };
async function setMode(mode) { if (mode === 'pin' && !confirm('开启后会按模型规则固定 / 回灌状态。前置扩展无法感知 sub2api 内部账号切换，请仅用于已验证的粘性会话链路。确认启用？')) return; await api('/api/mode', { mode, acknowledgeExperimental: true }); notify('模式已更新。'); await refresh(); }
$('enable').onclick = () => setMode('observe').catch(e => notify(e.message));
$('pin-enable').onclick = () => setMode('pin').catch(e => notify(e.message));
$('disable').onclick = () => setMode('off').catch(e => notify(e.message));
$('refresh').onclick = () => refresh().catch(e => notify(e.message)); $('filter').onchange = $('refresh').onclick;
$('logout').onclick = async () => { try { await api('/api/logout', {}); } finally { showLogin(); } };
setInterval(() => { if (authenticated && !document.hidden) refresh().catch(e => notify(e.message)); }, 5000);
setInterval(countdown, 1000);
refresh().catch(() => {});
