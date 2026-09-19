#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_HOME, VERSION, makeConfig, loadConfig, atomicJSON, passwordHash } from '../lib/config.mjs';
import { createExtension } from '../lib/server.mjs';
import { domainSetup } from '../lib/domain.mjs';
import { OWNER, planNginx, connectNginx, disconnectNginx, dashboardNginx } from '../lib/nginx.mjs';

const args = process.argv.slice(2), command = args.shift() || 'help';
const has = name => args.includes(`--${name}`);
const arg = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback; };
const home = path.resolve(arg('home', process.env.TURNSTATE_HOME || DEFAULT_HOME));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UNIT = '/etc/systemd/system/sub2api-turnstate.service';
const SERVICE = 'sub2api-turnstate.service';
const INSTALL = `/opt/sub2api-turnstate/releases/${VERSION}`;
function print(value) { console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2)); }
function requireRoot() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('This operation requires root on Linux.');
  if (!has('apply')) throw new Error('No changes made. Repeat with --apply after reviewing the plan.');
}
function systemctl(...values) { execFileSync('/usr/bin/systemctl', values, { stdio: 'pipe' }); }
function requireOwnedService() {
  if (!fs.existsSync(UNIT) || !fs.readFileSync(UNIT, 'utf8').startsWith(OWNER)) throw new Error('Managed service not found.');
}
function getPassword() {
  return has('password-stdin') ? fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '') : process.env.TURNSTATE_ADMIN_PASSWORD;
}
function initialize() {
  const file = path.join(home, 'config.json');
  if (fs.existsSync(file)) return loadConfig(home);
  const suppliedPassword = getPassword();
  const { config, password } = makeConfig({ target: arg('target', 'http://127.0.0.1:18080'),
    adminOrigin: arg('admin-origin', 'http://127.0.0.1:17891'), password: suppliedPassword });
  atomicJSON(file, config);
  if (!suppliedPassword) fs.writeFileSync(path.join(home, 'initial-admin-password.txt'), password + '\n', { mode: 0o600, flag: 'wx' });
  print(`Configuration: ${file}\nAdministrator: admin\n` + (suppliedPassword ? 'Supplied password set.' : `Initial password saved privately: ${home}/initial-admin-password.txt`));
  return config;
}
function localRequest(port, route, config, body, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const content = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (Number(port) === config.adminPort) headers['x-turnstate-control'] = config.controlToken;
    if (content) { headers['content-type'] = 'application/json'; headers['content-length'] = content.length; }
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method: content ? 'POST' : 'GET', headers, agent: false }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; if (data.length > 65536) req.destroy(new Error('Unexpected large response')); });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Local API returned ${res.statusCode}`));
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Local API returned invalid JSON')); }
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error('Local API timeout'))); req.on('error', reject); req.end(content);
  });
}
async function ready(config) {
  const [admin, proxy] = await Promise.all([
    localRequest(config.adminPort, '/api/status', config),
    localRequest(config.proxyPort, '/__turnstate_health', config)
  ]);
  if (admin.service !== 'sub2api-turnstate-extension' || proxy.service !== admin.service) throw new Error('Ports are not owned by this extension');
  return admin;
}
async function install() {
  requireRoot();
  if (home !== DEFAULT_HOME) throw new Error('System service installation uses the fixed managed home; use init/serve for a custom home.');
  if (fs.existsSync(UNIT)) throw new Error('A service unit already exists. This preview does not perform in-place upgrades; disconnect and uninstall the managed service first.');
  if (!/^\/[\w/.-]+$/.test(process.execPath) || process.execPath.startsWith('/root/')) throw new Error('Use a system-wide Node executable readable by the service user, not /root/nvm.');
  const config = initialize();
  if (fs.existsSync('/usr/local/bin/turnstate') && !fs.readFileSync('/usr/local/bin/turnstate', 'utf8').includes(OWNER)) throw new Error('Refusing to replace existing /usr/local/bin/turnstate. Use a private npm prefix for installation.');
  const pw = path.join(home, 'initial-admin-password.txt');
  if (fs.existsSync(pw)) {
    fs.mkdirSync('/etc/sub2api-turnstate', { recursive: true, mode: 0o700 });
    fs.copyFileSync(pw, '/etc/sub2api-turnstate/initial-admin-password', fs.constants.COPYFILE_EXCL);
    fs.chmodSync('/etc/sub2api-turnstate/initial-admin-password', 0o600); fs.unlinkSync(pw);
    print('Initial administrator password: /etc/sub2api-turnstate/initial-admin-password (root only)');
  }
  let uid, gid;
  try { uid = Number(execFileSync('/usr/bin/id', ['-u', 'sub2api-turnstate'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()); }
  catch {
    execFileSync('/usr/sbin/useradd', ['--system', '--user-group', '--home-dir', DEFAULT_HOME, '--shell', '/usr/sbin/nologin', 'sub2api-turnstate']);
    uid = Number(execFileSync('/usr/bin/id', ['-u', 'sub2api-turnstate'], { encoding: 'utf8' }).trim());
  }
  gid = Number(execFileSync('/usr/bin/id', ['-g', 'sub2api-turnstate'], { encoding: 'utf8' }).trim());
  fs.chownSync(home, uid, gid);
  for (const name of fs.readdirSync(home)) {
    const file = path.join(home, name);
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Refusing symlink in managed home');
    if (fs.statSync(file).isFile()) fs.chownSync(file, uid, gid);
  }
  fs.mkdirSync(INSTALL, { recursive: true, mode: 0o755 });
  for (const name of ['bin', 'lib', 'public', 'package.json']) fs.cpSync(path.join(ROOT, name), path.join(INSTALL, name), { recursive: true, force: true, dereference: false });
  const unit = `${OWNER}\n[Unit]\nDescription=Sub2API Turn-State ingress extension\nAfter=network.target\n\n[Service]\nType=simple\nUser=sub2api-turnstate\nGroup=sub2api-turnstate\nWorkingDirectory=${INSTALL}\nExecStart=${process.execPath} ${INSTALL}/bin/turnstate.mjs serve --home ${DEFAULT_HOME}\nRestart=on-failure\nRestartSec=2\nTimeoutStopSec=40\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=true\nReadWritePaths=${DEFAULT_HOME}\nRestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX\nUMask=0077\n\n[Install]\nWantedBy=multi-user.target\n`;
  fs.mkdirSync('/usr/local/bin', { recursive: true });
  fs.writeFileSync('/usr/local/bin/turnstate', `#!/bin/sh\n${OWNER}\nexec ${process.execPath} ${INSTALL}/bin/turnstate.mjs "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(UNIT, unit, { mode: 0o644 });
  systemctl('daemon-reload'); systemctl('enable', '--now', SERVICE);
  let healthy = false;
  for (let n = 0; n < 20; n++) { try { await ready(config); healthy = true; break; } catch { await delay(300); } }
  if (!healthy) throw new Error('Service not healthy; Nginx was not modified. Inspect journalctl -u sub2api-turnstate.');
  const conf = arg('nginx-conf');
  if (conf) {
    const origin = await localRequest(new URL(config.target).port || 80, '/health', config);
    if (origin.status !== 'ok') throw new Error('Sub2API health check failed; Nginx was not modified.');
    print(connectNginx(conf, config));
  }
  if (arg('domain')) print(domainSetup(arg('domain'), config, false));
  print({ installed: true, mode: 'off on fresh install; existing switch retained', dashboardOrigin: config.adminOrigin,
    nginxTakenOver: !!conf, note: 'The original Sub2API egress proxy was not modified.' });
}
async function main() {
  if (command === '--version' || command === 'version') return print(VERSION);
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22+ is required; no system runtime is upgraded automatically.');
  if (command === 'help' || command === '--help') return print(`turnstate ${VERSION}

start / enable      Enable automatic probe + pin on matching requests (billable).
stop / disable      Cancel probes; relay pending/new requests without state changes.
status / doctor     Show health and the single switch state.
auto-status         Show automatic discovery and cache activity.
states              Show configured model rules and masked pins.
refresh --model X   Invalidate cached state; next matching request probes automatically.
rules --file FILE --ack-experimental  Update per-model state formats.
install --apply --nginx-conf FILE [--domain NAME] [--admin-origin ORIGIN]
connect --nginx-conf FILE --apply / disconnect --apply
service-stop --apply / uninstall --apply
domain-enable --domain NAME --apply
init [--home DIR] / serve [--home DIR]
password --password-stdin / nginx-plan --nginx-conf FILE

No manual probing, batch limits, total duration or shared quota settings.
`);
  if (command === 'init') { initialize(); return; }
  if (command === 'install') return install();
  if (command === 'disconnect') { requireRoot(); return print(disconnectNginx()); }
  if (command === 'uninstall' || command === 'service-stop') {
    requireRoot(); requireOwnedService(); print(disconnectNginx());
    systemctl(command === 'uninstall' ? 'disable' : 'stop', ...(command === 'uninstall' ? ['--now', SERVICE] : [SERVICE]));
    if (command === 'uninstall') {
      fs.unlinkSync(UNIT); systemctl('daemon-reload');
      // Keep release copies and data deliberately; never recursively delete operator files.
      print('Service removed. Data/backups/releases retained. Remove the console Nginx site separately if desired. You may now npm uninstall -g @babadaren/sub2api-turnstate.');
    }
    return;
  }
  const config = loadConfig(home);
  if (command === 'serve') {
    const app = await createExtension(config, home);
    print(`turnstate ${VERSION}: loopback proxy ${config.proxyPort}, admin ${config.adminPort}, mode ${app.mode}`);
    let stopping = false;
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
      if (stopping) return; stopping = true;
      await app.close(30_000); process.exit(0);
    });
    return;
  }
  if (command === 'password') {
    const password = getPassword();
    if (!password || password.length < 14) throw new Error('Provide a password of at least 14 characters via stdin or TURNSTATE_ADMIN_PASSWORD.');
    config.adminPassword = passwordHash(password); atomicJSON(path.join(home, 'config.json'), config);
    return print('Password changed on disk. Restart the service to apply and invalidate old sessions.');
  }
  if (command === 'nginx-plan') {
    const file = arg('nginx-conf'); if (!file) throw new Error('--nginx-conf is required');
    const plan = planNginx(fs.readFileSync(file, 'utf8'), config);
    return print(`# Candidate upstream snippet:\n${plan.upstream}\n# Candidate ${file}:\n${plan.updated}`);
  }
  if (command === 'nginx-dashboard') return print(dashboardNginx(arg('domain'), config.adminPort));
  if (command === 'connect') {
    requireRoot(); const file = arg('nginx-conf'); if (!file) throw new Error('--nginx-conf is required');
    await ready(config);
    const origin = await localRequest(new URL(config.target).port || 80, '/health', config);
    if (origin.status !== 'ok') throw new Error('Sub2API health check failed; Nginx was not modified.');
    return print(connectNginx(file, config));
  }
  if (command === 'status') return print(await ready(config));
  if (command === 'domain-enable') { requireRoot(); return print(domainSetup(arg('domain'), config, true)); }
  if (command === 'states') return print(await localRequest(config.adminPort, '/api/states', config));
  if (command === 'auto-status') return print(await localRequest(config.adminPort,'/api/automation',config));
  if (/^(probe-|preflight-)/.test(command)) throw new Error('Legacy probe settings removed. Use turnstate start / stop / auto-status.');
  if (command === 'refresh') return print(await localRequest(config.adminPort, '/api/pins/refresh', config, { model: arg('model'), id: arg('id') }));
  if (command === 'rules') {
    if (!has('ack-experimental')) throw new Error('Rule changes require --ack-experimental.');
    const file = arg('file'); if (!file) throw new Error('--file is required');
    return print(await localRequest(config.adminPort, '/api/rules', config, { rules: JSON.parse(fs.readFileSync(file, 'utf8')), acknowledgeExperimental: true }));
  }
  if (command === 'doctor') {
    let service, origin;
    try { service = await ready(config); } catch (error) { service = { error: error.message }; }
    try { origin = await localRequest(new URL(config.target).port || 80, '/health', config); } catch (error) { origin = { error: error.message }; }
    return print({ node: process.version, extension: service, sub2api: origin, egressProxy: 'not inspected or modified', mode: 'ingress-sidecar' });
  }
  if (['start','enable','stop','disable'].includes(command)) {
    if (command === 'start' && process.getuid?.() === 0 && fs.existsSync(UNIT)) { requireOwnedService(); systemctl('start', SERVICE); await delay(350); }
    return print(await localRequest(config.adminPort,'/api/automation',config,{enabled:['start','enable'].includes(command)}));
  }
  throw new Error('Unknown command; run turnstate help');
}
main().catch(error => { console.error(`turnstate: ${error.message}`); process.exitCode = 1; });
