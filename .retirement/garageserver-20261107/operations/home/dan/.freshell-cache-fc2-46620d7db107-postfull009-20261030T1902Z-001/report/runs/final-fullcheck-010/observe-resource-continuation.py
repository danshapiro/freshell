"""Observe only one admitted launcher; record reserves and allocated ownership."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib, json, os, re, signal, subprocess, threading, time

import sys
sys.dont_write_bytecode = True
sys.path.insert(0, '/home/dan/code/freshell/.worktrees/.the-usual-logs/freshcodex-complete/reports/final-fullcheck-010-staging-001')
from staging_context import context
A,D,AUTH,R,W,CONTRACT=context()
HEAD=A.head
STOP=threading.Event()
def now(): return datetime.now(timezone.utc).isoformat()
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def put(name,data):
    p=D/name
    tmp=p.with_suffix(p.suffix+'.tmp')
    tmp.write_text(json.dumps(data,indent=2)+'\n');tmp.replace(p)
def processes():
    rows={};roots=[]
    for p in Path('/proc').iterdir():
        if not p.name.isdigit(): continue
        try:
            a=(p/'cmdline').read_bytes();parts=a.split(b'\0')
            stat=(p/'stat').read_text().rpartition(') ')[2].split()
            pid=int(p.name)
            rows[pid]=dict(pid=pid,ppid=int(stat[1]),pgid=int(stat[2]),session_id=int(stat[3]),state=stat[0],start_identity=stat[19],
                exe=os.readlink(p/'exe'),cwd=os.readlink(p/'cwd'),command_sha256=hashlib.sha256(a).hexdigest())
            if pid==26925 and rows[pid]['start_identity']=='421623879' and str(R/'run-final-verification.py').encode() in parts and b'final-fullcheck-010' in parts:
                roots.append(pid)
        except (OSError,ValueError,IndexError): pass
    assert len(roots)<=1, roots
    owned=set(roots)
    while True:
        added={p for p,r in rows.items() if r['ppid'] in owned}-owned
        if not added: break
        owned.update(added)
    return roots,{p:rows[p] for p in owned}

def group_members(pgid):
    members={}
    for path in Path('/proc').iterdir():
        if not path.name.isdigit(): continue
        try:
            fields=(path/'stat').read_text().rpartition(') ')[2].split()
            if int(fields[2])==pgid:
                members[int(path.name)]=dict(pid=int(path.name),start_identity=fields[19],pgid=pgid,session_id=int(fields[3]))
        except (OSError,ValueError,IndexError): pass
    return members

def reserve_watch():
    minimum={k:None for k in AUTH['live_minimum_bytes']};samples=0;errors=[];cancel=None;recorded_group=None
    with (D/'space.jsonl').open('x') as output:
        while not STOP.is_set():
            started=time.monotonic();row=dict(at=now(),filesystems={})
            for name,path in [('/','/'),('/home',str(W))]:
                s=os.statvfs(path)
                a=dict(path=path,device=os.stat(path).st_dev,available_bytes=s.f_bavail*s.f_frsize,free_inodes=s.f_favail,total_inodes=s.f_files)
                row['filesystems'][name]=a
                minimum[name]=a['available_bytes'] if minimum[name] is None else min(minimum[name],a['available_bytes'])
            output.write(json.dumps(row)+'\n');output.flush();samples+=1
            roots,owned=processes()
            if roots and recorded_group is None:
                root=owned[roots[0]];pgid=root['pgid'];members=group_members(pgid)
                exclusive=pgid>1 and pgid!=os.getpgrp() and set(members)<=set(owned)
                recorded_group=dict(at=now(),root=root,pgid=pgid,session_id=root['session_id'],members=list(members.values()),exclusively_owned=exclusive)
                put('owned-original-process-group.json',recorded_group)
                if not exclusive:
                    errors.append(dict(at=now(),event='original_process_group_not_exclusive',record=recorded_group))
                    print(json.dumps(dict(event='verification.process_group_not_exclusive',pgid=pgid)),flush=True)
            lost=[k for k,v in row['filesystems'].items() if v['available_bytes']<AUTH['live_minimum_bytes'][k] or v['free_inodes']<=10000]
            if lost and cancel is None:
                cancel=dict(at=now(),filesystems=lost,observation=row,roots=roots,owned=list(owned.values()),recorded_group=recorded_group,signals=[])
                # Root's approved outer guard may cancel only the exact recorded
                # original group. Revalidate root start identity, group and all
                # current members; never fall back to individual/broad signals.
                if recorded_group and recorded_group['exclusively_owned']:
                    root=recorded_group['root'];pgid=recorded_group['pgid']
                    current=owned.get(root['pid']);members=group_members(pgid)
                    safe=current and current['start_identity']==root['start_identity'] and current['pgid']==pgid and members and set(members)<=set(owned) and pgid!=os.getpgrp()
                    if safe:
                        try:
                            os.killpg(pgid,signal.SIGTERM)
                            cancel['signals'].append(dict(pgid=pgid,root_pid=root['pid'],root_start_identity=root['start_identity'],members=list(members.values()),signal='SIGTERM'))
                        except OSError as e: errors.append(dict(at=now(),pgid=pgid,error=repr(e)))
                    else: errors.append(dict(at=now(),event='owned_group_revalidation_failed',pgid=pgid))
                elif roots:
                    errors.append(dict(at=now(),event='no_exclusively_owned_recorded_group_for_reserve_cancellation'))
                put('capacity-cancellation.json',cancel)
                print(json.dumps(dict(event='verification.reserve_lost',filesystems=lost,roots=roots)),flush=True)
            STOP.wait(max(0,1-(time.monotonic()-started)))
    put('space-completion.json',dict(at=now(),samples=samples,minimum_available_bytes=minimum,errors=errors,cancellation=cancel,
        floor_bytes=AUTH['live_minimum_bytes'],sample_seconds=1))

assert not (D/'observer002-start.json').exists()
put('observer002-start.json',dict(at=now(),pid=os.getpid(),role='Read-only current-resource metadata continuation after failed observer; no reserve writer',head=HEAD))
# The separate same-invocation capacity continuation already owns live guards.
watch=None
print(json.dumps(dict(event='verification.observer_ready',pid=os.getpid())),flush=True)
state=json.loads((D/'observer-state.json').read_text())
state.pop('at',None)
state['original_observer_failed_receipt']='observer-first-normal-join.json'
state['current_observer_role']='Resource metadata continuation only; separate capacity-continuation owns guards; no workload rerun'
seen=0;last_process=0;log=None;event_keys=set()
try:
    log=(D/'observed-events002.jsonl').open('x')
    while True:
        invocation=json.loads((D/'invocation.json').read_text()) if (D/'invocation.json').exists() else None
        path=D/'check.log'
        if path.exists():
            lines=path.read_text(errors='replace').splitlines()
            for n in range(seen,len(lines)):
                line=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',lines[n])
                if not line.startswith('{'): continue
                try: e=json.loads(line)
                except ValueError: continue
                event=str(e.get('event',''))
                if not (event.startswith('sandbox_') or event=='owned.strict_compiler.selected' or event.startswith('runtime_build.preflight.')): continue
                key=str(n+1)+':'+event
                if key in event_keys: continue
                event_keys.add(key)
                log.write(json.dumps(dict(observed_at=now(),log_line=n+1,event=e))+'\n');log.flush()
                name=e.get('container',e.get('containerName'))
                if name:
                    assert re.fullmatch(r'freshell-sandbox-[A-Za-z0-9]{8}',name)
                    row=state['containers'].setdefault(name,dict(name=name,events={}))
                    row['events'][key]=e
                    if event=='sandbox_owner_guard_started': row['guard_pid']=e['pid']
                    if event=='owned.strict_compiler.selected': row['control_directory']=e['controlDirectory']
            seen=max(0,len(lines)-1)
        for name,row in list(state['containers'].items()):
            control=Path(row.get('control_directory','/tmp/'+name))
            if control.exists():
                for filename in ['container.name','container.id','owner-guard.json','owner-guard.done']:
                    p=control/filename
                    try:
                        if p.is_file(): row.setdefault('control_files',{})[filename]=dict(text=p.read_text(),sha256=sha(p))
                    except FileNotFoundError: pass
            cid=row.get('control_files',{}).get('container.id',{}).get('text','').strip()
            if not row.get('actual_container') and re.fullmatch('[a-f0-9]{64}',cid):
                try:
                    r=subprocess.run(['/usr/bin/docker','inspect',cid],capture_output=True,text=True,timeout=10)
                    if r.returncode==0:
                        a=json.loads(r.stdout)[0]
                        row['actual_container']=dict(at=now(),id=a['Id'],name=a['Name'],image=a['Image'],state=a['State'],
                            mounts=[{k:m.get(k) for k in ['Type','Name','Source','Destination','RW']} for m in a['Mounts']],
                            profile={k:a['HostConfig'].get(k) for k in ['NetworkMode','ReadonlyRootfs','PidsLimit','Memory','SecurityOpt','Privileged','CapAdd','PidMode','Tmpfs']},
                            command_sha256=hashlib.sha256(json.dumps(a['Config']['Cmd']).encode()).hexdigest())
                except Exception as e: state['errors'].append(dict(at=now(),stage='inspect',name=name,error=repr(e)))
        if invocation:
            since=datetime.fromisoformat(invocation['started_at']).timestamp()
            for manifest in (W/'.runtime-build').glob('preflight-*/manifest.json'):
                if str(manifest) in state['preflight_snapshots'] or manifest.stat().st_mtime<since: continue
                try:
                    m=json.loads(manifest.read_text());assert m['revision']==HEAD and m['repoRoot']==str(W)
                    out=D/(manifest.parent.name+'-manifest.json');out.write_bytes(manifest.read_bytes())
                    binaries={k:dict(path=v,bytes=Path(v).stat().st_size,sha256=sha(Path(v))) for k,v in m['binaries'].items()}
                    state['preflight_snapshots'][str(manifest)]=dict(copy=str(out),sha256=sha(out),binaries=binaries)
                except Exception as e: state['errors'].append(dict(at=now(),stage='manifest',error=repr(e)))
            for receipt in (W/'.runtime-evidence'/HEAD).glob('*/cleanup.json'):
                if str(receipt) in state['fixture_cleanup_receipts'] or receipt.stat().st_mtime<since: continue
                raw=receipt.read_bytes();m=json.loads(raw)
                if m.get('completedAt','')<invocation['started_at']: continue
                out=D/(receipt.parent.name+'-cleanup.json');out.write_bytes(raw)
                state['fixture_cleanup_receipts'][str(receipt)]=dict(copy=str(out),sha256=sha(out),run_id=receipt.parent.name)
            for events in R.glob('fullgate-compiler-*.jsonl'):
                if str(events) in state['compiler_events'] or events.stat().st_mtime<since: continue
                # File remains mutable while the run is active; final capture
                # below replaces this provisional snapshot after normal closure.
                state['compiler_events'][str(events)]=dict(first_seen_at=now())
        if time.monotonic()-last_process>=10:
            roots,owned=processes()
            with (D/'owned-process-observations002.jsonl').open('a') as output:
                output.write(json.dumps(dict(at=now(),roots=roots,owned=list(owned.values())))+'\n')
            state['process_snapshots']+=1;last_process=time.monotonic()
        put('observer002-state.json',dict(at=now(),**state))
        if (D/'completion.json').exists(): break
        # If owned-group cancellation terminated the launcher before it could
        # publish a completion file, the operator must first join its actual
        # original tool and owned resources, then provide this explicit stop
        # receipt. Never fabricate a canonical completion or a successful exit.
        stop_receipt=D/'observer-stop-after-owned-closure.json'
        if stop_receipt.exists():
            settlement=json.loads(stop_receipt.read_text())
            assert (D/'capacity-cancellation.json').exists()
            assert settlement['original_tool_joined_normally'] is True and settlement['owned_resources_closed'] is True and settlement['owned_process_group_closed'] is True
            assert settlement['actual_original_exit_code']!=0 and settlement['proof_receipts']
            break
        time.sleep(0.2)
    for name in state['compiler_events']:
        p=Path(name);out=D/p.name;out.write_bytes(p.read_bytes())
        state['compiler_events'][name].update(copy=str(out),sha256=sha(out))
finally:
    if log: log.close()
    STOP.set()
    put('observer002-normal-completion.json',dict(at=now(),pid=os.getpid(),**state,
        original_completion_sha256=sha(D/'completion.json') if (D/'completion.json').exists() else None,
        scope='Only actual current-run identities and observations; no global idleness or complete per-spawn audit'))
print(json.dumps(dict(event='verification.observer_normal_completion',containers=len(state['containers']),errors=len(state['errors']))),flush=True)
