import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { makeConfig } from '../lib/config.mjs';
import { planNginx, connectNginx, disconnectNginx, dashboardNginx } from '../lib/nginx.mjs';
import { createExtension } from '../lib/server.mjs';

const { config } = makeConfig({ password: 'nginx-test-password-123!' });
const original = `server {\n    listen 127.0.0.1:8088;\n    proxy_connect_timeout 15s;\n    location ^~ /openai/v1/ {\n        rewrite ^/openai/(.*)$ /$1 break;\n        proxy_pass http://127.0.0.1:18080;\n    }\n    location ^~ /openai/ {\n        rewrite ^/openai/(.*)$ /v1/$1 break;\n        proxy_pass http://127.0.0.1:18080;\n    }\n    location / {\n        proxy_pass http://127.0.0.1:18080;\n    }\n}\n`;
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-nginx-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test('Nginx plan preserves path rewrite and adds backup without POST-retry override', () => {
  const plan = planNginx(original, config);
  assert.equal(plan.count, 3); assert.match(plan.updated, /rewrite \^\/openai/);
  assert.match(plan.upstream, /18080 backup/); assert.match(plan.upstream, /default 127.0.0.1:18080/);
  assert.equal(plan.updated.includes('non_idempotent'), false);
  assert.equal(plan.updated.includes('http_502'), false);
  assert.throws(() => planNginx(plan.updated, config));
  assert.throws(() => dashboardNginx('evil.example; return 200;', 17891));
});
test('failed nginx validation restores original bytes and removes only owned snippet', t => {
  const dir = temp(t), file = path.join(dir, 'site.conf'), snippet = path.join(dir, 'upstream.conf');
  fs.writeFileSync(file, original);
  let checks = 0, reloads = 0;
  assert.throws(() => connectNginx(file, config, { stateDir: path.join(dir, 'state'), snippet,
    validate: () => { checks++; if (checks === 2) throw new Error('test rejection'); }, reload: () => { reloads++; } }), /restored/);
  assert.equal(fs.readFileSync(file, 'utf8'), original); assert.equal(fs.existsSync(snippet), false); assert.equal(reloads, 1);
});
test('takeover/disconnect round trip; manual changes are never silently overwritten', t => {
  const dir = temp(t), file = path.join(dir, 'site.conf'), snippet = path.join(dir, 'upstream.conf');
  fs.writeFileSync(file, original);
  const options = { stateDir: path.join(dir, 'state'), snippet, validate: () => {}, reload: () => {} };
  assert.equal(connectNginx(file, config, options).connected, true);
  const managed = fs.readFileSync(file, 'utf8');
  fs.appendFileSync(file, '\n# manual edit\n');
  assert.throws(() => disconnectNginx(options), /edited/);
  assert.match(fs.readFileSync(file, 'utf8'), /manual edit/);
  fs.writeFileSync(file, managed);
  assert.equal(disconnectNginx(options).changed, true);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.existsSync(snippet), false);
});

test('real nginx: rewritten paths, direct non-Codex route, backup on refused connection, no replay on 502', { skip: !fs.existsSync('/usr/sbin/nginx') }, async t => {
  const dir = temp(t), home = path.join(dir, 'home'); fs.mkdirSync(home);
  const seen = [];
  const origin = http.createServer(async (req, res) => {
    for await (const _ of req) {}
    seen.push({ path: req.url, state: req.headers['x-codex-turn-state'] });
    res.writeHead(req.headers['x-test-fail'] ? 502 : 200, { 'content-type': 'application/json', 'x-codex-turn-state': 'R'.repeat(312) });
    res.end(JSON.stringify({ path: req.url }));
  });
  origin.listen(0, '127.0.0.1'); await once(origin, 'listening');
  const { config: cfg } = makeConfig({ password: 'nginx-live-test-123!', target: `http://127.0.0.1:${origin.address().port}` });
  const app = await createExtension(cfg, home, { proxyPort: 0, adminPort: 0 });
  cfg.proxyPort = app.proxy.address().port; cfg.adminPort = app.admin.address().port;
  app.setMode('drop312');
  const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const site = original.replaceAll('18080', String(origin.address().port)).replace('8088', String(port));
  const plan = planNginx(site, cfg);
  fs.writeFileSync(path.join(dir, 'nginx.conf'), `pid ${dir}/nginx.pid;\nerror_log ${dir}/error.log;\nmaster_process off;\nevents { worker_connections 128; }\nhttp { access_log off; client_body_temp_path ${dir}/body; proxy_temp_path ${dir}/proxy; proxy_buffering off; proxy_http_version 1.1; ${plan.upstream}\n${plan.updated}\n}`);
  execFileSync('/usr/sbin/nginx', ['-t', '-p', dir, '-c', path.join(dir, 'nginx.conf')], { stdio: 'pipe' });
  const nginx = spawn('/usr/sbin/nginx', ['-p', dir, '-c', path.join(dir, 'nginx.conf'), '-g', 'daemon off;'], { stdio: 'ignore' });
  let closed = false;
  t.after(async () => {
    nginx.kill('SIGTERM'); await once(nginx, 'exit').catch(() => {});
    if (!closed) await app.close(100);
    origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve));
  });
  for (let n = 0; n < 30; n++) { try { await fetch(`http://127.0.0.1:${port}/health`); break; } catch { await delay(50); } }
  const url = `http://127.0.0.1:${port}`;
  let response = await fetch(`${url}/openai/v1/responses`, { method: 'POST', headers: { 'x-codex-turn-state': 'Q'.repeat(312) }, body: '{}' });
  assert.equal(response.status, 200); assert.equal((await response.json()).path, '/v1/responses');
  assert.equal(seen.at(-1).state, undefined); assert.equal(response.headers.has('x-codex-turn-state'), false);
  for (const alias of ['/responses', '/responses/compact', '/responses?probe=alias']) {
    response = await fetch(`${url}${alias}`, { method: 'POST', headers: { 'x-codex-turn-state': 'Q'.repeat(312) }, body: '{}' });
    assert.equal(response.status, 200); assert.equal((await response.json()).path, alias);
    assert.equal(seen.at(-1).state, undefined);
    assert.equal(response.headers.has('x-codex-turn-state'), false);
    assert.equal(app.journal.recent.at(-1).path, alias.split('?')[0]);
  }
  response = await fetch(`${url}/openai/responses`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 200); assert.equal((await response.json()).path, '/v1/responses');
  response = await fetch(`${url}/api/v1/status`, { headers: { 'x-codex-turn-state': 'Q'.repeat(312) } }); await response.text();
  assert.equal(seen.at(-1).state.length, 312);
  const before = seen.length;
  response = await fetch(`${url}/v1/responses`, { method: 'POST', headers: { 'x-test-fail': '1' }, body: '{}' }); await response.text();
  assert.equal(response.status, 502); assert.equal(seen.length, before + 1);
  await app.close(100); closed = true;
  response = await fetch(`${url}/v1/responses`, { method: 'POST', headers: { 'x-codex-turn-state': 'Q'.repeat(312) }, body: '{}' });
  assert.equal(response.status, 200); await response.text(); assert.equal(seen.at(-1).state.length, 312);
});
