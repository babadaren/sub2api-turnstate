import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { makeConfig, validateConfig } from '../lib/config.mjs';
import { createExtension } from '../lib/server.mjs';
import { inspectState, cleanHeaders } from '../lib/policy.mjs';

const password = 'preview-test-password-123!';
const bodyOf = async req => { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks); };
async function fixture(t, handler, upgrade) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'turnstate-test-'));
  const origin = http.createServer(handler);
  const originSockets = new Set();
  origin.on('connection', socket => { originSockets.add(socket); socket.on('close', () => originSockets.delete(socket)); });
  if (upgrade) origin.on('upgrade', upgrade);
  origin.listen(0, '127.0.0.1'); await once(origin, 'listening');
  const { config } = makeConfig({ password, target: `http://127.0.0.1:${origin.address().port}` });
  const app = await createExtension(config, home, { proxyPort: 0, adminPort: 0 });
  config.proxyPort = app.proxy.address().port; config.adminPort = app.admin.address().port;
  config.adminOrigin = `http://127.0.0.1:${config.adminPort}`;
  t.after(async () => {
    await app.close(100); for (const socket of originSockets) socket.destroy(); origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve));
    fs.rmSync(home, { force: true, recursive: true });
  });
  return { app, config, home, proxy: `http://127.0.0.1:${config.proxyPort}`, admin: config.adminOrigin, origin };
}

test('policy never pins 292 or fabricates missing state; unknown lengths pass', () => {
  for (const mode of ['off', 'observe', 'drop312']) {
    assert.equal(inspectState('A'.repeat(292), mode).remove, false);
    assert.equal(inspectState('', mode).outgoingLength, 0);
    assert.equal(inspectState('B'.repeat(300), mode).remove, false);
  }
  assert.equal(inspectState('B'.repeat(312), 'drop312').remove, true);
  assert.equal(inspectState('B'.repeat(312), 'off').remove, false);
  assert.equal(inspectState('B'.repeat(312), 'drop312', false).remove, false);
});
test('config rejects remote origins and self-proxy loops', () => {
  const { config } = makeConfig({ password });
  assert.throws(() => validateConfig({ ...config, target: 'http://172.18.0.1:1081' }));
  assert.throws(() => validateConfig({ ...config, target: 'http://127.0.0.1:17890' }));
  assert.throws(() => validateConfig({ ...config, adminOrigin: 'http://stats.example.com' }));
});
test('hop-by-hop and local control secrets are not forwarded', () => {
  const headers = cleanHeaders({ connection: 'keep-alive, x-secret-hop', 'x-secret-hop': 'secret',
    'proxy-authorization': 'secret', 'x-turnstate-control': 'secret', authorization: 'Bearer app-token', session_id: 's1' });
  assert.equal(headers['x-secret-hop'], undefined);
  assert.equal(headers['proxy-authorization'], undefined);
  assert.equal(headers['x-turnstate-control'], undefined);
  assert.equal(headers.authorization, 'Bearer app-token');
  assert.equal(headers.session_id, 's1');
});
test('direct loopback HTTP ignores proxy environment; body/auth preserved; 500 is not retried', async t => {
  let count = 0, captured;
  const f = await fixture(t, async (req, res) => {
    count++; captured = { headers: req.headers, body: await bodyOf(req), url: req.url };
    res.writeHead(500, { 'x-codex-turn-state': 'A'.repeat(292) }); res.end('intentional-origin-error');
  });
  const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  t.after(() => { for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; });
  for (const key of keys) process.env[key] = 'http://127.0.0.1:1';
  const payload = JSON.stringify({ model: 'test-model', input: 'do-not-log-this-prompt' });
  const response = await fetch(`${f.proxy}/v1/responses?private-query=do-not-log`, { method: 'POST',
    headers: { authorization: 'Bearer secret-api-key', cookie: 'secret-session', session_id: 'session-preserve', 'content-type': 'application/json' }, body: payload });
  assert.equal(response.status, 500); assert.equal(await response.text(), 'intentional-origin-error');
  assert.equal(count, 1); assert.equal(captured.body.toString(), payload);
  assert.equal(captured.headers.authorization, 'Bearer secret-api-key'); assert.equal(captured.headers.session_id, 'session-preserve');
  assert.equal(response.headers.get('x-codex-turn-state').length, 292);
  await f.app.journal.flush();
  const log = fs.readFileSync(path.join(f.home, 'records.jsonl'), 'utf8');
  for (const secret of ['secret-api-key', 'secret-session', 'do-not-log', 'A'.repeat(292)]) assert.equal(log.includes(secret), false);
  assert.match(log, /test-model/);
});
test('observe/off preserve 312; explicit drop312 removes it on both directions', async t => {
  const seen = [];
  const f = await fixture(t, async (req, res) => { seen.push(req.headers['x-codex-turn-state']); await bodyOf(req); res.setHeader('x-codex-turn-state', 'R'.repeat(312)); res.end('ok'); });
  for (const mode of ['observe', 'drop312', 'off']) {
    f.app.setMode(mode);
    const response = await fetch(`${f.proxy}/v1/responses`, { method: 'POST', headers: { 'x-codex-turn-state': 'Q'.repeat(312) }, body: '{}' });
    assert.equal(await response.text(), 'ok');
    assert.equal(response.headers.has('x-codex-turn-state'), mode !== 'drop312');
  }
  assert.deepEqual(seen.map(v => v?.length ?? 0), [312, 0, 312]);
});
test('non-Codex requests bypass policy unchanged', async t => {
  const f = await fixture(t, async (req, res) => { await bodyOf(req); assert.equal(req.headers['x-codex-turn-state'].length, 312); res.setHeader('x-codex-turn-state', 'R'.repeat(312)); res.end('ok'); });
  f.app.setMode('drop312');
  const response = await fetch(`${f.proxy}/v1/messages`, { method: 'POST', headers: { 'x-codex-turn-state': 'Q'.repeat(312) }, body: '{}' });
  assert.equal((await response.text()), 'ok'); assert.equal(response.headers.get('x-codex-turn-state').length, 312);
  assert.equal(f.app.journal.total.requests, 0);
});
test('large request is streamed intact and not rejected by log parsing limit', async t => {
  const payload = JSON.stringify({ model: 'large-test', input: 'x'.repeat(2 * 1024 * 1024) });
  const f = await fixture(t, async (req, res) => { assert.equal((await bodyOf(req)).toString(), payload); res.end('ok'); });
  const response = await fetch(`${f.proxy}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
  assert.equal(await response.text(), 'ok');
  assert.equal(f.app.journal.recent.at(-1).model, null);
});
test('SSE first chunk reaches client before upstream response is finished', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: first\n\n');
    await gate; res.end('data: done\n\n');
  });
  t.after(() => release());
  const response = await fetch(`${f.proxy}/v1/responses`);
  const reader = response.body.getReader();
  const first = await Promise.race([reader.read(), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('stream buffered')), 2000); timer.unref(); })]);
  assert.match(Buffer.from(first.value).toString(), /first/);
  release();
  let rest = ''; while (true) { const part = await reader.read(); if (part.done) break; rest += Buffer.from(part.value); }
  assert.match(rest, /done/);
});
test('admin requires authentication, origin and CSRF; logs hide credentials', async t => {
  const f = await fixture(t, (_req, res) => res.end('ok'));
  assert.equal((await fetch(`${f.admin}/api/status`)).status, 401);
  const credentials = JSON.stringify({ username: 'admin', password });
  assert.equal((await fetch(`${f.admin}/api/login`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: credentials })).status, 403);
  const login = await fetch(`${f.admin}/api/login`, { method: 'POST', headers: { origin: f.admin, 'content-type': 'application/json' }, body: credentials });
  assert.equal(login.status, 200);
  const cookies = login.headers.get('set-cookie'); assert.match(cookies, /HttpOnly/); assert.match(cookies, /SameSite=Strict/);
  const cookie = cookies.split(';')[0], { csrf } = await login.json();
  const common = { cookie, origin: f.admin, 'content-type': 'application/json' };
  assert.equal((await fetch(`${f.admin}/api/mode`, { method: 'POST', headers: common, body: '{"mode":"off"}' })).status, 403);
  assert.equal((await fetch(`${f.admin}/api/mode`, { method: 'POST', headers: { ...common, 'x-csrf-token': csrf }, body: '{"mode":"off"}' })).status, 200);
  assert.equal(f.app.mode, 'off');
  assert.equal((await fetch(`${f.admin}/api/mode`, { method: 'POST', headers: { ...common, 'x-csrf-token': csrf }, body: '{"mode":"drop312"}' })).status, 400);
  const status = await fetch(`${f.admin}/api/status`, { headers: { cookie } });
  const text = await status.text(); assert.equal(text.includes(f.config.controlToken), false); assert.equal(text.includes(f.config.adminPassword.hash), false);
  assert.equal((await fetch(`${f.admin}/api/logout`, { method: 'POST', headers: { ...common, 'x-csrf-token': csrf }, body: '{}' })).status, 200);
  assert.equal((await fetch(`${f.admin}/api/status`, { headers: { cookie } })).status, 401);
});
test('WebSocket handshake and opaque bytes pass without being buffered or parsed', async t => {
  let captured;
  const f = await fixture(t, (_req, res) => { res.writeHead(400); res.end(); }, (req, socket) => {
    captured = req.headers;
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Codex-Turn-State: ' + 'R'.repeat(292) + '\r\n\r\n');
    socket.on('data', bytes => socket.write(bytes));
  });
  await new Promise((resolve, reject) => {
    const request = http.request(`${f.proxy}/v1/responses`, { headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'x-codex-turn-state': 'Q'.repeat(292), authorization: 'Bearer ws-secret' } });
    request.on('error', reject);
    request.on('upgrade', (response, socket) => {
      assert.equal(response.headers['x-codex-turn-state'].length, 292);
      const frame = Buffer.from([0x81, 0x82, 1, 2, 3, 4, 105, 107]);
      socket.once('data', bytes => { try { assert.deepEqual(bytes, frame); socket.destroy(); resolve(); } catch (e) { reject(e); } });
      socket.write(frame);
    });
    request.end();
  });
  assert.equal(captured.authorization, 'Bearer ws-secret');
  assert.equal(f.app.journal.total.websocketHandshakes, 1);
});

test('model-specific pinning uses JSON model, supports different lengths, isolates credentials/sessions', async t => {
  const seen = [];
  const f = await fixture(t, async (req, res) => {
    const payload = JSON.parse((await bodyOf(req)).toString()); seen.push(req.headers['x-codex-turn-state']);
    const values = { 'gpt-6-astra': 'A'.repeat(292), 'gpt-5.6-sol': 'S'.repeat(280) };
    if (values[payload.model]) res.setHeader('x-codex-turn-state', values[payload.model]); res.end('ok');
  });
  const rules = f.app.states.rules;
  f.app.states.configure({ ...rules, 'gpt-5.6-sol': { ...rules['gpt-5.6-sol'], enabled: true, pinLengths: [280], discardLengths: [320] } });
  f.app.setMode('pin');
  const send = async (model, state, credential = 'one', session = 's1') => {
    const r = await fetch(`${f.proxy}/v1/responses`, { method: 'POST', headers: { 'content-type':'application/json', authorization:`Bearer ${credential}`, session_id:session, ...(state ? { 'x-codex-turn-state':state } : {}) }, body:JSON.stringify({ model, input:'private-prompt' }) }); await r.text(); return r;
  };
  await send('gpt-6-astra'); await send('gpt-5.6-sol');
  await send('gpt-6-astra','Q'.repeat(312)); await send('gpt-5.6-sol','Q'.repeat(320));
  assert.equal(seen[2], 'A'.repeat(292)); assert.equal(seen[3], 'S'.repeat(280));
  await send('gpt-6-astra',undefined,'two'); assert.equal(seen[4],undefined);
  await send('gpt-6-astra',undefined,'one','s2'); assert.equal(seen[5],undefined);
  await send('unknown-model','Q'.repeat(312)); assert.equal(seen[6].length,312);
  await send('gpt-5.6-sol','Q'.repeat(300)); assert.equal(seen[7].length,300); // unknown length passes, not discarded globally
  assert.equal(f.app.states.snapshot().pins.length,4);
  const snapshot = JSON.stringify(f.app.states.snapshot());
  for (const secret of ['Bearer one','Bearer two','A'.repeat(292),'S'.repeat(280)]) assert.equal(snapshot.includes(secret),false);
});
test('refresh only invalidates the matching binding, does not probe, and strips stale state on next matching request', async t => {
  let count = 0, seen;
  const f = await fixture(t, async (req,res) => { count++; seen = req.headers['x-codex-turn-state']; await bodyOf(req); res.setHeader('x-codex-turn-state',(count === 1 ? 'A' : 'B').repeat(292));res.end('ok'); });
  f.app.setMode('pin');
  const headers = { authorization:'Bearer example', session_id:'session', 'content-type':'application/json' };
  const send = async state => { const response = await fetch(`${f.proxy}/v1/responses`, { method:'POST',headers:{ ...headers, ...(state ? {'x-codex-turn-state':state} : {}) },body:'{"model":"gpt-6-astra"}' });await response.text(); };
  await send(); const id = f.app.states.snapshot().pins[0].id;
  const r = await fetch(`${f.admin}/api/pins/refresh`, { method:'POST',headers:{ 'x-turnstate-control':f.config.controlToken,'content-type':'application/json' },body:JSON.stringify({ id }) });
  assert.equal(r.status,200); assert.equal((await r.json()).pending,true); assert.equal(count,1);
  await send('A'.repeat(292)); assert.equal(seen,undefined); assert.equal(f.app.states.reveal(id).state,'B'.repeat(292));
});
test('model pin mode requires admin acknowledgement; full state requires authenticated POST; state errors never change upstream auth', async t => {
  const f = await fixture(t, async (req,res) => { await bodyOf(req); res.writeHead(401, {'x-codex-turn-state':'E'.repeat(292)});res.end('denied'); });
  assert.equal((await fetch(`${f.admin}/api/pins/reveal`,{method:'POST',headers:{origin:f.admin,'content-type':'application/json'},body:'{"id":"x"}'})).status,401);
  assert.equal((await fetch(`${f.admin}/api/mode`,{method:'POST',headers:{'x-turnstate-control':f.config.controlToken},body:'{"mode":"pin"}'})).status,400);
  f.app.setMode('pin');
  const response = await fetch(`${f.proxy}/v1/responses`,{method:'POST',headers:{authorization:'Bearer failed',session_id:'s','content-type':'application/json'},body:'{"model":"gpt-6-astra"}'});
  assert.equal(response.status,401);assert.equal(response.headers.get('x-codex-turn-state'),'E'.repeat(292));await response.text();
  assert.equal(f.app.states.snapshot().pins.length,0);
});
test('observation collects candidates without replay; stopping preserves headers despite existing pins', async t => {
  const seen = [];
  const f = await fixture(t, async (req,res) => { seen.push(req.headers['x-codex-turn-state']);await bodyOf(req);res.setHeader('x-codex-turn-state','A'.repeat(292));res.end('ok'); });
  const send = async state => { const response=await fetch(`${f.proxy}/v1/responses`,{method:'POST',headers:{authorization:'Bearer a',session_id:'s','content-type':'application/json',...(state?{'x-codex-turn-state':state}:{})},body:'{"model":"gpt-6-astra"}'});await response.text(); };
  await send();await send();assert.deepEqual(seen,[undefined,undefined]);assert.equal(f.app.states.snapshot().pins.length,1);
  f.app.setMode('pin');await send();assert.equal(seen[2],'A'.repeat(292));
  f.app.setMode('off');await send('Q'.repeat(312));assert.equal(seen[3],'Q'.repeat(312));
});
