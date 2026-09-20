import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';

// This path is fixed, not controlled by HTTP input. The root-owned exporter is
// separate from the unprivileged ingress process; it never exposes a web port.
export const LOCAL_AUTH_FILE = '/run/sub2api-turnstate-auth/accounts.json';
export const MAX_AUTH_AGE_MS = 180000;
const MAX_BYTES = 1024 * 1024;
const integer = v => Number.isSafeInteger(v) && v > 0;
const secret = v => typeof v === 'string' && v.length > 0 && v.length <= 16000 && /^[\x21-\x7e]+$/.test(v);
const fail = code => { const error = new Error(code); error.code = code; throw error; };

export class LocalAuthSource {
  constructor(config, options = {}) {
    this.file = options.file || LOCAL_AUTH_FILE;
    this.now = options.now || Date.now;
    this.expectedUid = options.expectedUid ?? 0;
    this.saltId = createHmac('sha256', config.logSalt).update('local-auth-salt-v1').digest('hex');
  }
  read() {
    let fd;
    try {
      // The source directory and file must be owned by the installer, not writable
      // by the dashboard process or other users. Never follow symlinks.
      const dir = fs.lstatSync(path.dirname(this.file));
      if (!dir.isDirectory() || dir.isSymbolicLink() ||
          (process.platform !== 'win32' && (dir.uid !== this.expectedUid || (dir.mode & 0o027)))) fail('local_auth_permissions');
      const before = fs.lstatSync(this.file);
      if (!before.isFile() || before.isSymbolicLink()) fail('local_auth_permissions');
      fd = fs.openSync(this.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > MAX_BYTES || st.size === 0 || st.ino !== before.ino ||
          (process.platform !== 'win32' && (st.uid !== this.expectedUid || (st.mode & 0o137)))) fail('local_auth_permissions');
      const d = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (d.version !== 1 || !Number.isFinite(d.fetchedAt) || !Array.isArray(d.accounts) || d.accounts.length > 32) fail('local_auth_invalid');
      if (d.saltId !== this.saltId) fail('local_auth_salt_changed');
      if (d.fetchedAt > this.now() + 5000 || this.now() - d.fetchedAt > MAX_AUTH_AGE_MS) fail('local_auth_stale');
      if (d.ok !== true) fail('local_auth_sync_failed');
      const accounts = d.accounts.map(a => {
        if (!integer(a.id) || !Number.isFinite(a.expiresAt) || !Array.isArray(a.clients) || a.clients.length > 128) fail('local_auth_invalid');
        const clients = a.clients.map(c => {
          if (!integer(c.id) || !integer(c.groupId) || !/^[a-f0-9]{64}$/.test(c.hash) ||
              !(c.expiresAt === null || Number.isFinite(c.expiresAt))) fail('local_auth_invalid');
          return {id:c.id, groupId:c.groupId, hash:c.hash, expiresAt:c.expiresAt};
        }).filter(c => c.expiresAt === null || c.expiresAt > this.now());
        const ready = a.status === 'active' && a.type === 'oauth' && a.platform === 'openai' &&
          secret(a.token) && /^[\w-]{1,128}$/.test(a.accountId || '') && a.expiresAt > this.now() + 60000 && clients.length > 0;
        return {id:a.id, type:'codex', ready, token:ready?a.token:null, accountId:ready?a.accountId:null,
          expiresAt:a.expiresAt, clients, status:a.status === 'active'?'active':'unavailable'};
      });
      return {fetchedAt:d.fetchedAt, accounts};
    } catch (error) {
      if (error.code?.startsWith('local_auth_')) throw error;
      fail(error.code === 'ENOENT' ? 'local_auth_not_installed' : 'local_auth_unavailable');
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  snapshot() {
    try {
      const d=this.read();
      return {installed:true, fresh:true, error:null, fetchedAt:d.fetchedAt, maxAgeSeconds:MAX_AUTH_AGE_MS/1000,
        accounts:d.accounts.map(a => ({id:a.id, type:a.type, ready:a.ready, status:a.status,
          expiresAt:a.expiresAt, clients:a.clients.map(c=>({id:c.id,groupId:c.groupId,expiresAt:c.expiresAt}))}))};
    } catch(error) {return {installed:error.code!=='local_auth_not_installed',fresh:false,error:error.code,
      fetchedAt:null,maxAgeSeconds:MAX_AUTH_AGE_MS/1000,accounts:[]};}
  }
  resolve(accountRecordId, clientKeyId) {
    if(!integer(accountRecordId) || !integer(clientKeyId)) fail('local_auth_selection_invalid');
    const d=this.read(), account=d.accounts.find(a=>a.id===accountRecordId);
    if(!account) fail('local_auth_account_not_allowed');
    if(!account.ready) fail('local_auth_account_not_ready');
    const client=account.clients.find(c=>c.id===clientKeyId);
    if(!client) fail('local_auth_client_not_allowed');
    return {type:'codex',token:account.token,accountId:account.accountId,allowedClientHash:client.hash,
      expiresAt:account.expiresAt,fetchedAt:d.fetchedAt};
  }
}
