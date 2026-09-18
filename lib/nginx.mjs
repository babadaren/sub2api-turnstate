import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { atomicJSON } from './config.mjs';

export const OWNER = '# Managed by sub2api-turnstate-extension';
const digest = text => createHash('sha256').update(text).digest('hex');
export function renderUpstream(config) {
  const target = new URL(config.target);
  return `${OWNER}\n# Included in the http context, not inside a server block.\nupstream turnstate_sub2api {\n    server 127.0.0.1:${config.proxyPort} max_fails=1 fail_timeout=2s;\n    server 127.0.0.1:${target.port || 80} backup;\n}\nmap $uri $turnstate_backend {\n    default 127.0.0.1:${target.port || 80};\n    ~^/(?:v1/)?responses(?:/|$) turnstate_sub2api;\n}\n`;
}
export function planNginx(original, config) {
  if (original.includes('turnstate_backend') || original.includes('BEGIN TURNSTATE')) throw new Error('Configuration is already managed; disconnect first.');
  const escaped = config.target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp(`^([ \\t]*)proxy_pass[ \\t]+${escaped}\\/?;[ \\t]*$`, 'gm');
  let count = 0;
  const updated = original.replace(expression, (_line, indent) => {
    count++;
    return `${indent}# BEGIN TURNSTATE\n${indent}proxy_pass http://$turnstate_backend;\n${indent}proxy_next_upstream error timeout;\n${indent}proxy_next_upstream_tries 2;\n${indent}# END TURNSTATE`;
  });
  if (!count) throw new Error('No exact proxy_pass matching the loopback target was found. No files changed.');
  // Refuse configs already setting these directives inside locations: automatic
  // merging would be ambiguous. Users can apply the generated plan manually.
  if (/location[\s\S]*proxy_next_upstream(?:_tries)?\s/.test(original)) {
    throw new Error('Existing per-location retry configuration needs manual review.');
  }
  return { original, updated, count, upstream: renderUpstream(config) };
}
function atomicText(file, text, mode = 0o644) {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try { fs.writeFileSync(temp, text, { mode, flag: 'wx' }); fs.renameSync(temp, file); }
  finally { try { fs.unlinkSync(temp); } catch {} }
}
function withLock(stateDir, fn) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lock = path.join(stateDir, 'nginx.lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch { throw new Error(`Deployment lock exists: ${lock}. Verify no operation is running before removing a stale lock.`); }
  try { return fn(); } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
function defaults(options) {
  return {
    stateDir: '/etc/sub2api-turnstate', snippet: '/etc/nginx/conf.d/turnstate-upstream.conf',
    validate: () => execFileSync('/usr/sbin/nginx', ['-t'], { stdio: 'pipe' }),
    reload: () => execFileSync('/usr/bin/systemctl', ['reload', 'nginx'], { stdio: 'pipe' }), ...options
  };
}
export function connectNginx(file, config, options = {}) {
  const opts = defaults(options);
  return withLock(opts.stateDir, () => {
    const manifestFile = path.join(opts.stateDir, 'nginx.json');
    if (fs.existsSync(manifestFile)) throw new Error('A takeover journal already exists. Disconnect/recover before changing the deployment.');
    if (fs.existsSync(opts.snippet)) throw new Error(`Refusing to replace existing file: ${opts.snippet}`);
    const realFile = fs.realpathSync(file), original = fs.readFileSync(realFile, 'utf8');
    const plan = planNginx(original, config), mode = fs.statSync(realFile).mode & 0o777;
    opts.validate();
    const manifest = { phase: 'prepared', file: realFile, snippet: opts.snippet, original,
      originalHash: digest(original), updatedHash: digest(plan.updated), snippetHash: digest(plan.upstream), mode };
    atomicJSON(manifestFile, manifest);
    try {
      atomicText(opts.snippet, plan.upstream);
      atomicText(realFile, plan.updated, mode);
      opts.validate(); opts.reload();
      atomicJSON(manifestFile, { ...manifest, phase: 'connected' });
      return { connected: true, replacements: plan.count, backup: manifestFile };
    } catch (error) {
      atomicText(realFile, original, mode);
      if (fs.existsSync(opts.snippet) && digest(fs.readFileSync(opts.snippet, 'utf8')) === manifest.snippetHash) fs.unlinkSync(opts.snippet);
      try { opts.validate(); opts.reload(); fs.unlinkSync(manifestFile); }
      catch { throw new Error(`Takeover failed; original files restored, but reload/recovery needs inspection. Journal: ${manifestFile}`); }
      throw new Error(`Takeover failed and original configuration was restored: ${error.message}`);
    }
  });
}
export function disconnectNginx(options = {}) {
  const opts = defaults(options);
  return withLock(opts.stateDir, () => {
    const manifestFile = path.join(opts.stateDir, 'nginx.json');
    if (!fs.existsSync(manifestFile)) return { connected: false, changed: false };
    const saved = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const current = fs.readFileSync(saved.file, 'utf8'), hash = digest(current);
    if (![saved.updatedHash, saved.originalHash].includes(hash)) throw new Error('Nginx config was edited after takeover. Refusing to overwrite manual changes; compare the saved journal first.');
    let snippet = null;
    if (fs.existsSync(saved.snippet)) {
      snippet = fs.readFileSync(saved.snippet, 'utf8');
      if (digest(snippet) !== saved.snippetHash) throw new Error('Managed upstream snippet was edited. Refusing to delete it.');
    }
    atomicText(saved.file, saved.original, saved.mode);
    if (snippet !== null) fs.unlinkSync(saved.snippet);
    try { opts.validate(); opts.reload(); }
    catch (error) {
      atomicText(saved.file, current, saved.mode);
      if (snippet !== null) atomicText(saved.snippet, snippet);
      // The active config was not intentionally changed on failure. Keep the journal.
      throw new Error(`Disconnect did not complete; working files restored and journal retained: ${error.message}`);
    }
    fs.renameSync(manifestFile, path.join(opts.stateDir, `nginx-detached-${Date.now()}.json`));
    return { connected: false, changed: true };
  });
}
export function dashboardNginx(domain, adminPort) {
  if (!/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/.test(domain)) throw new Error('Invalid DNS name');
  return `${OWNER}\n# Provision DNS and certificates BEFORE enabling this file.\nserver {\n    listen 80;\n    server_name ${domain};\n    location ^~ /.well-known/acme-challenge/ { root /var/www/letsencrypt; try_files $uri =404; }\n    location / { return 301 https://$host$request_uri; }\n}\nserver {\n    listen 443 ssl;\n    server_name ${domain};\n    ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;\n    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;\n    ssl_protocols TLSv1.2 TLSv1.3;\n    client_max_body_size 80k;\n    location / {\n        proxy_pass http://127.0.0.1:${adminPort};\n        proxy_http_version 1.1;\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-Proto $scheme;\n        proxy_set_header X-Turnstate-Control \"\";\n        proxy_set_header Connection \"\";\n        proxy_read_timeout 30s;\n        proxy_cache off;\n    }\n}\n`;
}
