import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const VERSION = '0.6.1';
export const MODES = ['off', 'auto', 'observe', 'pin', 'drop312'];
export const DEFAULT_HOME = '/var/lib/sub2api-turnstate';
export function atomicJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const existing = fs.existsSync(file) ? fs.lstatSync(file) : null;
  if (existing && !existing.isFile()) throw new Error('Refusing to replace a non-regular config file.');
  const tmp = `${file}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    if (existing) {
      fs.chmodSync(tmp, existing.mode & 0o777);
      if (process.getuid?.() === 0) fs.chownSync(tmp, existing.uid, existing.gid);
    }
    fs.renameSync(tmp, file);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}
export function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: scryptSync(password, salt, 32).toString('hex') };
}
export function equalSecret(a, b) {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}
export function makeConfig(options = {}) {
  const password = options.password || randomBytes(24).toString('base64url');
  if (password.length < 14) throw new Error('Administrator password must contain at least 14 characters.');
  const config = {
    version: 1, target: 'http://127.0.0.1:18080', host: '127.0.0.1',
    proxyPort: 17890, adminPort: 17891, adminOrigin: 'http://127.0.0.1:17891',
    mode: 'off', adminUser: 'admin', adminPassword: passwordHash(password),
    controlToken: randomBytes(32).toString('hex'), logSalt: randomBytes(32).toString('hex'),
    maxLogBytes: 5 * 1024 * 1024, logFiles: 3, recentLimit: 1000,
    ...options
  };
  delete config.password;
  validateConfig(config);
  return { config, password };
}
export function validateConfig(config) {
  const target = new URL(config.target), origin = new URL(config.adminOrigin);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' ||
      target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
    throw new Error('Target must be a direct loopback HTTP origin, e.g. http://127.0.0.1:18080.');
  }
  if (config.host !== '127.0.0.1') throw new Error('This preview only binds to 127.0.0.1.');
  for (const p of [config.proxyPort, config.adminPort]) {
    if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error('Invalid listener port.');
  }
  if (config.proxyPort === config.adminPort || [config.proxyPort, config.adminPort].includes(Number(target.port || 80))) {
    throw new Error('Listener/target port collision would create a proxy loop.');
  }
  if (!['https:', 'http:'].includes(origin.protocol) || origin.origin !== config.adminOrigin || origin.username || origin.password) {
    throw new Error('adminOrigin must be an exact HTTP(S) origin without a trailing slash.');
  }
  if (origin.protocol !== 'https:' && origin.hostname !== '127.0.0.1') throw new Error('Public administration requires HTTPS.');
  if (!MODES.includes(config.mode)) throw new Error('Unknown mode.');
  if (!/^[a-f0-9]{64}$/.test(config.controlToken) || !/^[a-f0-9]{64}$/.test(config.logSalt)) throw new Error('Invalid secrets.');
  if (!config.adminPassword?.salt || !config.adminPassword?.hash) throw new Error('Missing password hash.');
  if (!Number.isInteger(config.maxLogBytes) || config.maxLogBytes < 65536 || config.maxLogBytes > 20 * 1024 * 1024) throw new Error('Invalid log size.');
  if (!Number.isInteger(config.logFiles) || config.logFiles < 1 || config.logFiles > 5) throw new Error('Invalid retention.');
  if (!Number.isInteger(config.recentLimit) || config.recentLimit < 1 || config.recentLimit > 2000) throw new Error('Invalid record limit.');
  // Bounded diagnostics: old installs receive defaults in memory, without rewriting secrets.
  config.requestMetadataMaxBytes ??= 8 * 1024 * 1024;
  config.responseMetadataMaxBytes ??= 4 * 1024 * 1024;
  config.metadataConcurrency ??= 4;
  for (const field of ['requestMetadataMaxBytes', 'responseMetadataMaxBytes']) {
    if (!Number.isInteger(config[field]) || config[field] < 65536 || config[field] > 16 * 1024 * 1024) throw new Error('Invalid metadata byte limit.');
  }
  if (!Number.isInteger(config.metadataConcurrency) || config.metadataConcurrency < 1 || config.metadataConcurrency > 16 ||
      (config.requestMetadataMaxBytes + config.responseMetadataMaxBytes) * config.metadataConcurrency > 128 * 1024 * 1024) throw new Error('Metadata inspection budget is too large.');
  return config;
}
export function loadConfig(home) {
  return validateConfig(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')));
}
