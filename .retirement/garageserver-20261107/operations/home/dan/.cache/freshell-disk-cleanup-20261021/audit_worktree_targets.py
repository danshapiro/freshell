import datetime
import json
import os
from pathlib import Path
import subprocess
import sys

BASE = Path('/home/dan/code/freshell/.worktrees')
OUT = Path('/home/dan/.cache/freshell-disk-cleanup-20261021/worktree-target-recheck-initial.json')

def run(args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout

def scan():
    hits = []
    denied = []
    ignored = {os.getpid()}
    if '--ignore-pid' in sys.argv:
        ignored.add(int(sys.argv[sys.argv.index('--ignore-pid')+1]))
    for p in Path('/proc').iterdir():
        if not p.name.isdigit() or int(p.name) in ignored:
            continue
        try:
            argv = (p/'cmdline').read_bytes().replace(b'\0', b'\n').decode(errors='replace').splitlines()
            if not argv:
                continue
            comm = (p/'comm').read_text().strip()
            cwd = os.readlink(p/'cwd')
            exe = os.readlink(p/'exe')
            status = (p/'status').read_text()
            ppid = int(next(s for s in status.splitlines() if s.startswith('PPid:')).split()[1])
            reasons = []
            if str(BASE)+'/' in cwd:
                reasons.append('worktree_cwd')
            if str(BASE)+'/' in exe:
                reasons.append('worktree_executable')
            arg_paths = [a for a in argv if a.startswith(str(BASE)+'/') or 'run-final-' in a or 'durable-souls-' in a or 'playwright' in a or 'cargo' in a or 'run-standard-tests' in a or 'run-source-runtime' in a]
            if arg_paths:
                reasons.append('relevant_argument')
            fds = []
            for fd in (p/'fd').iterdir():
                try:
                    name = os.readlink(fd)
                    if str(BASE)+'/' in name:
                        fds.append(name)
                except OSError:
                    pass
            if fds:
                reasons.append('worktree_fd')
            mappings = [s.split()[-1] for s in (p/'maps').read_text().splitlines() if str(BASE)+'/' in s]
            if mappings:
                reasons.append('worktree_mapping')
            target_env = [a.split('=',1)[1] for a in (p/'environ').read_bytes().decode(errors='replace').split('\0') if a.startswith('CARGO_TARGET_DIR=') and str(BASE)+'/' in a]
            if target_env:
                reasons.append('cargo_target_env')
            if reasons:
                hits.append({'pid':int(p.name),'ppid':ppid,'comm':comm,'cwd':cwd,'exe':exe,'argv_program':argv[0], 'relevant_args':arg_paths,'reasons':reasons,'fds':sorted(set(fds)),'mappings':sorted(set(mappings)),'target_env':target_env})
        except PermissionError:
            denied.append(int(p.name))
        except (OSError, StopIteration, ValueError):
            pass
    return {'hits':hits,'permission_denied':denied}

if __name__ == '__main__':
    if '--processes' in sys.argv:
        print(json.dumps(scan()))
    else:
        targets = []
        for wt in sorted(BASE.iterdir()):
            target = wt/'target'
            if wt.name == '.the-usual-logs' or not target.exists():
                continue
            targets.append({'worktree':str(wt),'target':str(target),'symlink':target.is_symlink(),'allocated_bytes':int(run(['du','-x','-s','-B1',str(target)]).split()[0])})
        proc = json.loads(run(['sudo','-n','python3',__file__,'--processes']))
        out = {'utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'available_bytes':int(run(['df','-B1','--output=avail',str(BASE)]).splitlines()[-1]),'targets':targets,'processes':proc}
        OUT.write_text(json.dumps(out,indent=2)+'\n')
        print(json.dumps({'receipt':str(OUT),'available_bytes':out['available_bytes'],'targets':sorted(targets,key=lambda x:x['allocated_bytes'],reverse=True),'processes':proc}))
