#!/usr/bin/env python3
"""Explicit root installer for the optional local reader. No model requests.
Application and database configuration are not modified. Approve IDs explicitly.
"""
import argparse
import datetime
import grp
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import tempfile

P=pathlib.Path
ROOT=P('/etc/sub2api-turnstate')
INSTALL=P('/usr/local/lib/sub2api-turnstate-auth')
CONFIG=ROOT/'local-auth-reader.json'
UNIT=P('/etc/systemd/system/sub2api-turnstate-auth-sync.service')
TIMER=P('/etc/systemd/system/sub2api-turnstate-auth-sync.timer')
MARKER='# Managed by sub2api-turnstate-extension local-auth v1'
SERVICE=MARKER+'''
[Unit]
Description=Read approved local Sub2API OAuth metadata into private runtime memory
After=docker.service
[Service]
Type=oneshot
User=root
Group=sub2api-turnstate
ExecStart=/usr/bin/python3 -B /usr/local/lib/sub2api-turnstate-auth/sync-sub2api-auth.py
RuntimeDirectory=sub2api-turnstate-auth
RuntimeDirectoryMode=0750
RuntimeDirectoryPreserve=yes
UMask=0027
TimeoutStartSec=20
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/run/sub2api-turnstate-auth
RestrictAddressFamilies=AF_UNIX
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
LimitCORE=0
'''
TIMER_TEXT=MARKER+'''
[Unit]
Description=Keep approved local Sub2API OAuth access credentials synchronized
[Timer]
OnBootSec=5s
OnUnitInactiveSec=60s
AccuracySec=1s
Unit=sub2api-turnstate-auth-sync.service
[Install]
WantedBy=timers.target
'''
def run(args):
    r=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=30)
    if r.returncode:raise RuntimeError('reader setup command failed: '+args[0])
    return r.stdout

def atomic(file,text,mode):
    fd,tmp=tempfile.mkstemp(prefix='.reader-',dir=str(file.parent))
    try:
        os.fchmod(fd,mode)
        with os.fdopen(fd,'w') as stream:fd=None;stream.write(text);stream.flush();os.fsync(stream.fileno())
        os.replace(tmp,str(file))
    finally:
        if fd is not None:os.close(fd)
        if os.path.exists(tmp):os.unlink(tmp)

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--account-id',action='append',type=int,required=True)
    ap.add_argument('--api-key-id',action='append',type=int,required=True);ap.add_argument('--apply',action='store_true');args=ap.parse_args()
    for ids in [args.account_id,args.api_key_id]:
        if not 1<=len(ids)<=32 or any(not 0<i<2**53 for i in ids):raise SystemExit('invalid ID allowlist')
    if not args.apply:
        print(json.dumps({'apply':False,'accountIds':args.account_id,'apiKeyIds':args.api_key_id,'intervalSeconds':60}));return
    if os.geteuid()!=0:raise SystemExit('root required')
    g=grp.getgrnam('sub2api-turnstate');root_stat=ROOT.lstat()
    if not stat.S_ISDIR(root_stat.st_mode) or root_stat.st_uid!=0 or root_stat.st_mode&0o077:raise SystemExit('unsafe extension configuration directory')
    source=P(__file__).resolve().parent/'sync-sub2api-auth.py';code=source.read_text()
    assert 'Root-only fixed SELECT exporter' in code
    fd=os.open('/var/lib/sub2api-turnstate/config.json',os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'r') as f:log_salt=json.load(f)['logSalt']
    assert isinstance(log_salt,str) and re.fullmatch('[a-f0-9]{64}',log_salt)
    cfg={'container':'sub2api-postgres','database':'sub2api','db_user':'sub2api',
         'account_ids':list(dict.fromkeys(args.account_id)),'api_key_ids':list(dict.fromkeys(args.api_key_id)),'log_salt':log_salt}
    for file in [UNIT,TIMER]:
        if file.exists() and (file.is_symlink() or not file.read_text().startswith(MARKER)):raise SystemExit('refuse to replace unowned unit')
    if INSTALL.exists():
        s=INSTALL.lstat()
        if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022:raise SystemExit('unsafe reader directory')
    else:INSTALL.mkdir(mode=0o755)
    if CONFIG.exists():
        if CONFIG.is_symlink() or CONFIG.stat().st_uid!=0:raise SystemExit('unsafe reader config')
        old=json.loads(CONFIG.read_text())
        if old['account_ids']!=cfg['account_ids'] or old['api_key_ids']!=cfg['api_key_ids']:raise SystemExit('existing allowlist differs; review it as root first')
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup=ROOT/('local-auth-install-'+stamp);backup.mkdir(mode=0o700)
    targets=[INSTALL/'sync-sub2api-auth.py',CONFIG,UNIT,TIMER];existing={}
    for i,file in enumerate(targets):
        if file.exists():
            if file.is_symlink():raise SystemExit('unsafe destination')
            shutil.copy2(file,backup/str(i));existing[str(file)]=str(backup/str(i))
    was_enabled=subprocess.run(['systemctl','is-enabled',TIMER.name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
    try:
        atomic(targets[0],code,0o644);atomic(CONFIG,json.dumps(cfg,indent=2)+'\n',0o600)
        atomic(UNIT,SERVICE,0o644);atomic(TIMER,TIMER_TEXT,0o644)
        run(['/usr/bin/systemd-analyze','verify',str(UNIT),str(TIMER)])
        run(['/usr/bin/systemctl','daemon-reload'])
        run(['/usr/bin/systemctl','start',UNIT.name])
        # Inspect only format/status, never print token-bearing runtime content.
        exported=json.loads(P('/run/sub2api-turnstate-auth/accounts.json').read_text())
        if not exported.get('ok'):raise RuntimeError('reader is not ready')
        run(['/usr/bin/systemctl','enable','--now',TIMER.name])
        file_stat=P('/run/sub2api-turnstate-auth/accounts.json').stat()
        assert file_stat.st_uid==0 and file_stat.st_gid==g.gr_gid and stat.S_IMODE(file_stat.st_mode)==0o640
        print(json.dumps({'installed':True,'timerEnabled':True,'approvedAccountIds':cfg['account_ids'],
            'approvedClientKeyIds':cfg['api_key_ids'],'intervalSeconds':60,'runtimeMode':'0640',
            'accountsExported':len(exported['accounts']),'backup':str(backup),'modelRequestsSent':0}))
    except Exception:
        subprocess.run(['systemctl','disable','--now',TIMER.name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        subprocess.run(['systemctl','stop',UNIT.name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        for file in targets:
            if str(file) in existing:shutil.copy2(existing[str(file)],file)
            elif file.exists():file.unlink()
        subprocess.run(['systemctl','daemon-reload'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        if was_enabled:subprocess.run(['systemctl','enable','--now',TIMER.name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        else:
            cache=P('/run/sub2api-turnstate-auth/accounts.json')
            if cache.exists():cache.unlink()
        raise SystemExit('local reader installation failed; files restored; no credential values printed')

if __name__=='__main__':main()
