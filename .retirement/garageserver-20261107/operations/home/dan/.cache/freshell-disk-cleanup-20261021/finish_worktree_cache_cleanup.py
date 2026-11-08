import datetime
import fcntl
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys

BASE = Path('/home/dan/code/freshell/.worktrees')
EVIDENCE = Path('/home/dan/.cache/freshell-disk-cleanup-20261021')
AUDIT = EVIDENCE/'audit_worktree_targets.py'
RECEIPT = EVIDENCE/'worktree-cache-cleanup-recheck.json'
PROTECTED = {'codex-proxy-ws-frame-cap', '.the-usual-logs'}
LOCK_NAMES = {'.freshell-runtime-artifacts.lock', '.cargo-lock', '.cargo-build-lock', '.cargo-artifact-lock'}

def run(args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout

def allocated(path):
    return int(run(['du','-x','-s','-B1',str(path)]).split()[0])

def available():
    return int(run(['df','-B1','--output=avail',str(BASE)]).splitlines()[-1])

def state(wt):
    return {'head':run(['git','-C',str(wt),'rev-parse','HEAD']).strip(), 'status':run(['git','-C',str(wt),'status','--porcelain=v1','-z'])}

def scan(wt):
    data = json.loads(run(['sudo','-n','python3',str(AUDIT),'--processes','--ignore-pid',str(os.getpid())]))
    if data['permission_denied']:
        raise RuntimeError('Incomplete privileged process scan')
    prefix = str(wt)+'/'
    hits = []
    for item in data['hits']:
        values = [item['cwd'], item['exe'], *item['fds'], *item['mappings'], *item['target_env'], *item['relevant_args']]
        if any(value == str(wt) or prefix in value for value in values):
            hits.append(item)
    return hits

def save():
    RECEIPT.write_text(json.dumps(receipt,indent=2)+'\n')

def locks_under(target):
    paths = [target/'.freshell-runtime-artifacts.lock']
    for parent, dirs, files in os.walk(target, followlinks=False):
        dirs[:] = [name for name in dirs if not (Path(parent)/name).is_symlink()]
        for name in files:
            path = Path(parent)/name
            if name in LOCK_NAMES and path not in paths:
                paths.append(path)
    return sorted(paths, key=str)

receipt = {'started_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'available_bytes_before':available(),'policy':'Remove confirmed-idle generated Cargo artifacts and run-private runtime executable snapshots only. Preserve all coordination lock inodes and their ancestors, source/Git state, evidence, dependencies, production main, recently rebuilt unrelated codex-proxy worktree, and all active or uncertain uses. No processes stopped and no tests/builds run.','worktrees':[],'docker_mount_confirmation':'Docker audit agent confirmed no current worktree target or .runtime-build bind mounts and no test/sandbox containers running.'}
save()
for wt in sorted(BASE.iterdir()):
    if wt.name in PROTECTED or not wt.is_dir() or wt.is_symlink():
        continue
    target = wt/'target'
    runtime = wt/'.runtime-build'
    roots = [p for p in (target,runtime) if p.is_dir() and not p.is_symlink()]
    if not roots or sum(allocated(p) for p in roots) < 65536:
        continue
    item = {'worktree':str(wt),'git_before':state(wt),'roots_before':{str(p):allocated(p) for p in roots},'deleted':[],'retained':[]}
    receipt['worktrees'].append(item)
    save()
    if run(['git','-C',str(wt),'ls-files','-z','--','target','.runtime-build']):
        item['retained'].append('Tracked contents detected; entire worktree skipped')
        save()
        continue
    if run(['git','-C',str(wt),'check-ignore','target/probe','.runtime-build/probe']).splitlines() != ['target/probe','.runtime-build/probe']:
        item['retained'].append('Generated roots not both ignored; skipped')
        save()
        continue
    hits = scan(wt)
    if hits:
        item['retained'].append({'active_processes':hits})
        save()
        continue
    target.mkdir(exist_ok=True)
    paths = locks_under(target)
    handles = []
    try:
        for path in paths:
            fd = os.open(path, os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW, 0o664)
            handle = os.fdopen(fd,'a+b')
            handles.append(handle)
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise RuntimeError('Nonregular lock '+str(path))
            fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
            fcntl.lockf(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
        item['held_locks'] = [{'path':str(p),'inode':os.fstat(h.fileno()).st_ino} for p,h in zip(paths,handles)]
        hits = scan(wt)
        if hits:
            item['retained'].append({'active_processes_after_locks':hits})
            continue
        preserved = set(paths)
        for path in paths:
            preserved.update(p for p in path.parents if p == target or target in p.parents)
        def delete_contents(root):
            for child in sorted(root.iterdir()):
                if child in preserved:
                    if child.is_dir() and not child.is_symlink():
                        delete_contents(child)
                    continue
                if child.is_mount():
                    raise RuntimeError('Unexpected mount point '+str(child))
                size = allocated(child)
                entry = {'path':str(child),'allocated_bytes_before':size,'reason':'Idle, ignored, generated Cargo output or private runtime executable snapshot; no process/mapping/fd/environment/argument references, no container bind, all runtime/Cargo locks held.'}
                if child.is_symlink() or not child.is_dir():
                    child.unlink()
                else:
                    shutil.rmtree(child)
                if child.exists() or child.is_symlink():
                    raise RuntimeError('Removal incomplete '+str(child))
                item['deleted'].append(entry)
                save()
        for root in roots:
            delete_contents(root)
        for entry in item['held_locks']:
            if os.stat(entry['path']).st_ino != entry['inode']:
                raise RuntimeError('Lock inode changed '+entry['path'])
        item['roots_after'] = {str(p):allocated(p) for p in roots}
        item['git_after'] = state(wt)
        if item['git_after'] != item['git_before']:
            raise RuntimeError('Concurrent source/Git state changed; stopping cleanup')
    except BlockingIOError:
        item['retained'].append('Artifact/Cargo coordination lock held; nothing deleted')
    finally:
        for h in reversed(handles):
            h.close()
        save()
    print(json.dumps({'worktree':wt.name,'allocated_before':sum(item['roots_before'].values()),'allocated_after':sum(item.get('roots_after',{}).values()),'deleted_entries':len(item['deleted']),'retained':item['retained']}),flush=True)

receipt['finished_utc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
receipt['available_bytes_after'] = available()
receipt['reliability_git_final'] = state(BASE/'durable-souls-reliability')
save()
print(json.dumps({'receipt':str(RECEIPT),'available_bytes_after':receipt['available_bytes_after'],'total_allocated_before':sum(sum(x['roots_before'].values()) for x in receipt['worktrees']),'total_allocated_after':sum(sum(x.get('roots_after',x['roots_before']).values()) for x in receipt['worktrees'])}),flush=True)
