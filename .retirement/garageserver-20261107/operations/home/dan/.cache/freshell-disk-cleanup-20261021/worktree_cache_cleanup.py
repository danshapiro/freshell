import datetime
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess

BASE = Path('/home/dan/code/freshell/.worktrees')
EVIDENCE = Path('/home/dan/.cache/freshell-disk-cleanup-20261021')
RECEIPT = EVIDENCE / 'worktree-cache-cleanup.json'
PROTECTED = {'durable-souls-reliability'}
CACHE_NAMES = ('incremental', 'deps', 'build', '.fingerprint')

PROC_SCAN = r'''
import json, os, pathlib, sys
wt = sys.argv[1]
target = wt + '/target'
owner_pid = int(sys.argv[2])
hits = []
ignore = {'du', 'find', 'sort', 'head', 'git'}
for p in pathlib.Path('/proc').iterdir():
 if not p.name.isdigit() or int(p.name) in (os.getpid(), owner_pid): continue
 try:
  comm = (p/'comm').read_text().strip()
  if comm in ignore: continue
  cwd = os.readlink(p/'cwd')
  exe = os.readlink(p/'exe')
  reasons = []
  if cwd == wt or cwd.startswith(wt+'/'): reasons.append('cwd')
  if exe.startswith(wt+'/'): reasons.append('executable')
  for fd in (p/'fd').iterdir():
   try:
    name = os.readlink(fd)
    if name.startswith(target+'/') and not name.endswith('.freshell-runtime-artifacts.lock'): reasons.append('target_fd'); break
   except OSError: pass
  if any(target+'/' in line for line in (p/'maps').read_text().splitlines()): reasons.append('target_mapping')
  env = (p/'environ').read_bytes().split(bytes([0]))
  if any(v.startswith(b'CARGO_TARGET_DIR=') and target.encode() in v for v in env): reasons.append('cargo_target_env')
  cmd = (p/'cmdline').read_bytes().split(bytes([0]))
  if any(target.encode() in v for v in cmd): reasons.append('target_argument')
  if reasons: hits.append({'pid': int(p.name), 'comm': comm, 'reasons': sorted(set(reasons))})
 except (OSError, ValueError): pass
print(json.dumps(hits))
'''

def command(args):
    return subprocess.run(args, check=True, capture_output=True).stdout

def git_state(wt):
    return {
        'head': command(['git', '-C', str(wt), 'rev-parse', 'HEAD']).decode().strip(),
        'status_hex': command(['git', '-C', str(wt), 'status', '--porcelain=v1', '-z']).hex(),
    }

def disk_bytes(path):
    return int(command(['du', '-x', '-s', '-B1', str(path)]).split()[0])

def scan_processes(wt):
    return json.loads(command(['sudo', '-n', 'python3', '-c', PROC_SCAN, str(wt), str(os.getpid())]))

def write_receipt():
    RECEIPT.write_text(json.dumps(receipt, indent=2) + '\n')

receipt = {
    'started_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'free_bytes_before': shutil.disk_usage(BASE).free,
    'policy': 'Remove only four generated Cargo cache directories, retain target/profile roots, existing lock inodes, direct executable outputs, all source/config/reports, Git state and active targets.',
    'worktrees': [], 'total_removed_allocated_bytes': 0,
}
write_receipt()

for wt in sorted(BASE.iterdir()):
    target = wt/'target'
    if wt.name == '.the-usual-logs' or not target.is_dir() or target.is_symlink():
        continue
    item = {'worktree': str(wt), 'removed': [], 'skipped': []}
    receipt['worktrees'].append(item)
    if wt.name in PROTECTED:
        item['skipped'].append('Protected active build target')
        write_receipt()
        continue
    state_before = git_state(wt)
    item['git_before'] = state_before
    if command(['git', '-C', str(wt), 'ls-files', '-z', '--', 'target']):
        item['skipped'].append('Tracked target contents')
        write_receipt()
        continue
    profiles = []
    for name in ('debug', 'release'):
        p = target/name
        if p.is_dir() and not p.is_symlink(): profiles.append(p)
    for child in target.iterdir():
        if child.is_symlink() or not child.is_dir() or child.name in ('debug', 'release', 'tmp'): continue
        for name in ('debug', 'release'):
            p = child/name
            if p.is_dir() and not p.is_symlink(): profiles.append(p)
    candidates = [p/name for p in profiles for name in CACHE_NAMES if (p/name).is_dir() and not (p/name).is_symlink()]
    if not candidates:
        item['skipped'].append('No selected cache children')
        write_receipt()
        continue
    handles = []
    lock_paths = [target/'.freshell-runtime-artifacts.lock']
    lock_paths += [p/name for p in profiles for name in ('.cargo-lock', '.cargo-build-lock', '.cargo-artifact-lock') if (p/name).exists()]
    try:
        for path in lock_paths:
            if path.is_symlink(): raise RuntimeError('Symlink lock: '+str(path))
            handle = path.open('a+b')
            handles.append(handle)
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        item['lock_paths'] = [str(p) for p in lock_paths]
        item['target_bytes_before'] = disk_bytes(target)
        for cache in candidates:
            users = scan_processes(wt)
            if users:
                item['skipped'].append({'cache': str(cache), 'active_processes': users})
                break
            if cache.is_symlink() or not cache.is_dir() or cache.name not in CACHE_NAMES or cache.parent not in profiles:
                raise RuntimeError('Candidate changed: '+str(cache))
            allocated = disk_bytes(cache)
            shutil.rmtree(cache)
            if cache.exists(): raise RuntimeError('Removal incomplete: '+str(cache))
            item['removed'].append({'path': str(cache), 'allocated_bytes': allocated})
            receipt['total_removed_allocated_bytes'] += allocated
            write_receipt()
        item['target_bytes_after'] = disk_bytes(target)
    except BlockingIOError:
        item['skipped'].append('Artifact or Cargo lock is held')
    finally:
        for handle in reversed(handles): handle.close()
    item['git_after'] = git_state(wt)
    if item['git_after'] != state_before:
        item['warning'] = 'Concurrent Git/source state changed; no source mutation performed by cleanup'
    write_receipt()
    print(json.dumps({'worktree': wt.name, 'removed_bytes': sum(x['allocated_bytes'] for x in item['removed']), 'skipped': item['skipped']}), flush=True)

receipt['finished_utc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
receipt['free_bytes_after'] = shutil.disk_usage(BASE).free
write_receipt()
print(json.dumps({'receipt': str(RECEIPT), 'total_removed_allocated_bytes': receipt['total_removed_allocated_bytes'], 'free_bytes_after': receipt['free_bytes_after']}), flush=True)
