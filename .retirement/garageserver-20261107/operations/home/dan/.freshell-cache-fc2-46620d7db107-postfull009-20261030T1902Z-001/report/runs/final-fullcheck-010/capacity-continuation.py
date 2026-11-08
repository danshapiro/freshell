"""Continue the admitted read-only reserve guard for the SAME actual launcher.
The original observer failure/gap remains failed evidence; no workload retry.
"""
from pathlib import Path
from datetime import datetime, timezone
import hashlib, json, os, signal, time
D = Path(__file__).resolve().parent
AUTH = json.loads((D/'root-execution-admission.json').read_text())
ROOT = dict(pid=26925, pgid=26925, session_id=26925, start_identity='421623879')
def now(): return datetime.now(timezone.utc).isoformat()
def root_identity():
    try:
        p=Path('/proc')/str(ROOT['pid']); f=(p/'stat').read_text().rpartition(') ')[2].split()
        parts=(p/'cmdline').read_bytes().split(b'\0')
        return dict(pid=ROOT['pid'],pgid=int(f[2]),session_id=int(f[3]),start_identity=f[19],canonical_argv_matches=str(D.parent.parent/'run-final-verification.py').encode() in parts and b'final-fullcheck-010' in parts)
    except FileNotFoundError:return None
actual=root_identity();assert actual and all(actual[k]==v for k,v in ROOT.items()) and actual['canonical_argv_matches']
assert os.getpgrp()!=ROOT['pgid']
start=dict(at=now(),pid=os.getpid(),same_original_root=actual,original_observer_failed=True,workload_restarted=False)
(D/'capacity-continuation-start.json').write_text(json.dumps(start,indent=2)+'\n')
print(json.dumps(dict(event='verification.capacity_continuation_ready',**start)),flush=True)
minimum={k:None for k in AUTH['live_minimum_bytes']}; samples=0; cancellation=None; errors=[]
with (D/'space-continuation.jsonl').open('x') as output:
    while True:
        before=time.monotonic();row=dict(at=now(),filesystems={})
        for name,path in [('/','/'),('/home',AUTH['worktree'])]:
            fs=os.statvfs(path);value=dict(path=path,device=os.stat(path).st_dev,available_bytes=fs.f_bavail*fs.f_frsize,free_inodes=fs.f_favail,total_inodes=fs.f_files)
            row['filesystems'][name]=value;minimum[name]=value['available_bytes'] if minimum[name] is None else min(minimum[name],value['available_bytes'])
        output.write(json.dumps(row)+'\n');output.flush();samples+=1
        lost=[k for k,v in row['filesystems'].items() if v['available_bytes']<AUTH['live_minimum_bytes'][k] or v['free_inodes']<=AUTH['available_inode_floor']]
        if lost and cancellation is None:
            actual=root_identity();members=[]
            for p in Path('/proc').iterdir():
                if not p.name.isdigit():continue
                try:
                    f=(p/'stat').read_text().rpartition(') ')[2].split()
                    if int(f[2])==ROOT['pgid']:members.append(dict(pid=int(p.name),pgid=int(f[2]),session_id=int(f[3]),start_identity=f[19]))
                except (OSError,IndexError,ValueError):pass
            safe=actual and all(actual[k]==v for k,v in ROOT.items()) and actual['canonical_argv_matches'] and members and all(v['session_id']==ROOT['session_id'] for v in members)
            cancellation=dict(at=now(),lost=lost,observation=row,revalidated_root=actual,members=members,signal=None)
            if safe:
                os.killpg(ROOT['pgid'],signal.SIGTERM);cancellation['signal']='SIGTERM'
            else:errors.append(dict(at=now(),event='group_revalidation_failed'))
            (D/'capacity-continuation-cancellation.json').write_text(json.dumps(cancellation,indent=2)+'\n')
            print(json.dumps(dict(event='verification.reserve_lost',lost=lost,cancellation=cancellation)),flush=True)
        if (D/'completion.json').exists() or root_identity() is None:break
        time.sleep(max(0,1-(time.monotonic()-before)))
done=dict(at=now(),samples=samples,minimum_available_bytes=minimum,errors=errors,cancellation=cancellation,sample_seconds=1,original_observer_gap_not_repaired_or_exempted=True,original_root=ROOT)
(D/'capacity-continuation-completion.json').write_text(json.dumps(done,indent=2)+'\n')
print(json.dumps(dict(event='verification.capacity_continuation_closed',**done)),flush=True)
