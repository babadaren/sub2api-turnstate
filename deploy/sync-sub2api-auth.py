#!/usr/bin/env python3
"""Root-only fixed SELECT exporter. Never print, persist on disk, or refresh OAuth secrets.
The generated /run file is transient plaintext (0640, root:sub2api-turnstate).
No network listener, arbitrary query parameter, shell command or refresh_token read.
"""
import datetime
import hashlib
import hmac
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import tempfile
import time

CONFIG = pathlib.Path('/etc/sub2api-turnstate/local-auth-reader.json')
DIRECTORY = pathlib.Path('/run/sub2api-turnstate-auth')
OUTPUT = DIRECTORY / 'accounts.json'
MAX_BYTES = 1024 * 1024

def validate_config(cfg):
    for key in ('container', 'database', 'db_user'):
        if not isinstance(cfg.get(key), str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,63}', cfg[key]):
            raise ValueError('invalid configuration')
    for key in ('account_ids', 'api_key_ids'):
        ids = cfg.get(key)
        if not isinstance(ids, list) or not 1 <= len(ids) <= 32 or any(type(i) is not int or not 0 < i < 2**53 for i in ids):
            raise ValueError('invalid allowlist')
    if not re.fullmatch(r'[a-f0-9]{64}', cfg.get('log_salt', '')):
        raise ValueError('invalid salt')
    return cfg

def query_sql(cfg):
    # All substitutions are validated integer allowlists from a root-owned file.
    accounts = ','.join(str(n) for n in cfg['account_ids'])
    keys = ','.join(str(n) for n in cfg['api_key_ids'])
    return """BEGIN READ ONLY;
SET LOCAL statement_timeout='5s';
SELECT json_build_object(
  'accounts', COALESCE((SELECT json_agg(row_to_json(a)) FROM (
    SELECT id, platform, type, status, schedulable,
      credentials->>'access_token' AS token,
      credentials->>'chatgpt_account_id' AS account_id,
      credentials->>'expires_at' AS expires_at
    FROM accounts WHERE id IN (%s) AND deleted_at IS NULL
      AND platform='openai' AND type='oauth'
  ) a), '[]'::json),
  'clients', COALESCE((SELECT json_agg(row_to_json(k)) FROM (
    SELECT DISTINCT k.id, k.group_id, k.key, k.expires_at, ag.account_id
    FROM api_keys k JOIN users u ON u.id=k.user_id
      JOIN account_groups ag ON ag.group_id=k.group_id
    WHERE k.id IN (%s) AND ag.account_id IN (%s)
      AND k.deleted_at IS NULL AND k.status='active'
      AND (k.expires_at IS NULL OR k.expires_at>NOW())
      AND (COALESCE(k.quota,0)<=0 OR COALESCE(k.quota_used,0)<k.quota)
      AND u.deleted_at IS NULL AND u.status='active'
  ) k), '[]'::json)
);
COMMIT;
""" % (accounts, keys, accounts)

def epoch_ms(value):
    if value is None or value == '':
        return None
    try:
        n = float(value)
        if not 0 < n < 1e15:
            return None
        return int(n if n > 1e12 else n * 1000)
    except (TypeError, ValueError, OverflowError):
        try:
            return int(datetime.datetime.fromisoformat(str(value).replace('Z', '+00:00')).timestamp()*1000)
        except (TypeError, ValueError, OverflowError):
            return None

def sanitize(raw, cfg, now):
    """Extract only selected fields; no refresh_token or full API key leaves this process."""
    result = []
    for a in raw.get('accounts', []):
        if a.get('id') not in cfg['account_ids']:
            continue
        clients = []
        for c in raw.get('clients', []):
            if c.get('account_id') != a['id'] or c.get('id') not in cfg['api_key_ids']:
                continue
            key = c.get('key')
            if not isinstance(key, str) or not key or len(key) > 8192 or re.search(r'\s', key):
                continue
            expiry = epoch_ms(c.get('expires_at'))
            if c.get('expires_at') is not None and (expiry is None or expiry <= now):
                continue
            digest = hmac.new(cfg['log_salt'].encode(), key.encode(), hashlib.sha256).hexdigest()
            clients.append({'id':c['id'], 'groupId':c['group_id'], 'hash':digest, 'expiresAt':expiry})
        expires = epoch_ms(a.get('expires_at')) or 0
        usable = (a.get('status') == 'active' and a.get('schedulable') is not False and
                  a.get('platform') == 'openai' and a.get('type') == 'oauth' and expires > now + 60000)
        token, account = a.get('token'), a.get('account_id')
        usable = usable and isinstance(token, str) and bool(re.fullmatch(r'[\x21-\x7e]{1,16000}', token))
        usable = usable and isinstance(account, str) and bool(re.fullmatch(r'[\w-]{1,128}', account, flags=re.ASCII))
        result.append({'id':a['id'], 'platform':'openai', 'type':'oauth',
            'status':'active' if usable else 'unavailable', 'token':token if usable else None,
            'accountId':account if usable else None, 'expiresAt':expires, 'clients':clients})
    return result

def read_config():
    fd = os.open(str(CONFIG), os.O_RDONLY | os.O_NOFOLLOW)
    try:
        s = os.fstat(fd)
        if s.st_uid != 0 or not stat.S_ISREG(s.st_mode) or s.st_mode & 0o077 or s.st_size > 16384:
            raise ValueError('unsafe config')
        with os.fdopen(fd, 'r') as f:
            fd = None
            return validate_config(json.load(f))
    finally:
        if fd is not None:
            os.close(fd)

def publish(payload):
    s = DIRECTORY.lstat()
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o027:
        raise ValueError('unsafe runtime directory')
    blob = json.dumps(payload, separators=(',', ':'), ensure_ascii=True).encode()
    if len(blob) > MAX_BYTES:
        raise ValueError('export too large')
    fd, name = tempfile.mkstemp(prefix='.accounts-', dir=str(DIRECTORY))
    try:
        os.fchown(fd, 0, os.getegid())
        os.fchmod(fd, 0o640)
        with os.fdopen(fd, 'wb') as f:
            fd = None
            f.write(blob); f.flush(); os.fsync(f.fileno())
        os.replace(name, str(OUTPUT))
    finally:
        if fd is not None:
            os.close(fd)
        if os.path.exists(name):
            os.unlink(name)

def main():
    if os.geteuid() != 0:
        print('local_auth_sync: root required', file=sys.stderr)
        return 1
    cfg = None
    try:
        cfg = read_config()
        result = subprocess.run(['/usr/bin/docker', 'exec', '-i', cfg['container'],
            'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', cfg['db_user'], '-d', cfg['database']],
            input=query_sql(cfg), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=12,
            env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin', 'HOME':'/nonexistent', 'LANG':'C.UTF-8'})
        if result.returncode or len(result.stdout.encode()) > MAX_BYTES:
            raise ValueError('database query failed')
        raw = json.loads(result.stdout)
        now = int(time.time()*1000)
        payload = {'version':1,'ok':True,'fetchedAt':now,
            'saltId':hmac.new(cfg['log_salt'].encode(), b'local-auth-salt-v1', hashlib.sha256).hexdigest(),
            'accounts':sanitize(raw,cfg,now)}
        publish(payload)
        print('local_auth_sync: ok; accounts=%d; client_bindings=%d' %
              (len(payload['accounts']), sum(len(a['clients']) for a in payload['accounts'])))
        return 0
    except Exception:
        # Never log exception text, database output, error messages or credentials.
        if cfg:
            try:
                publish({'version':1,'ok':False,'fetchedAt':int(time.time()*1000),
                    'saltId':hmac.new(cfg['log_salt'].encode(), b'local-auth-salt-v1', hashlib.sha256).hexdigest(),
                    'accounts':[]})
            except Exception:
                pass
        print('local_auth_sync: unavailable; no stale credential will be used', file=sys.stderr)
        return 1

if __name__ == '__main__':
    sys.exit(main())
