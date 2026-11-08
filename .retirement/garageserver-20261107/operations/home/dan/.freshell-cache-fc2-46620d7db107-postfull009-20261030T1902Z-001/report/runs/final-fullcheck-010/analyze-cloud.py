"""Verify actual current-attempt cloud footers, terminal states and closure."""
from pathlib import Path
from datetime import datetime,timezone
import hashlib,json,re
import sys
sys.dont_write_bytecode = True
sys.path.insert(0, '/home/dan/code/freshell/.worktrees/.the-usual-logs/freshcodex-complete/reports/final-fullcheck-010-staging-001')
from staging_context import context
A,D,AUTH,R,W,CONTRACT=context()
HEAD=A.head
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def latest(kind,success=True):
    files=sorted(D.glob('cloud-'+kind+'-query-*.json'))
    assert files,kind
    p=files[-1];q=json.loads(p.read_text())
    if success:assert q['exit_code']==0,(p,q.get('stderr'))
    return p,q
fp,f=latest('footer');lp,l=latest('lifecycle')
assert f['job']==l['job'] and f['execution']==l['execution']
job,execution=f['job'],f['execution']
records=json.loads(f['stdout']);life=json.loads(l['stdout'])
assert len(records)<10000 and len(life)<10000,'A capped query cannot prove completeness'
footers=[]
for r in records:
    text=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',r.get('textPayload','')).strip()
    m=re.fullmatch(r'(Test Files|Tests)\s+(.+)',text)
    if not m or not re.search(r'\d+ (?:passed|failed|skipped)',m.group(2)):continue
    labels=r.get('labels',{})
    assert r.get('resource',{}).get('labels',{}).get('job_name')==job
    assert labels.get('run.googleapis.com/execution_name')==execution
    count={k:int(n) for n,k in re.findall(r'(\d+) (passed|failed|skipped)',m.group(2))}
    total=re.search(r'\((\d+)\)\s*$',m.group(2))
    footers.append(dict(timestamp=r.get('timestamp'),task_index=labels.get('run.googleapis.com/task_index'),
        task_attempt=labels.get('run.googleapis.com/task_attempt'),kind=m.group(1),counts=count,
        total=int(total.group(1)) if total else None,text=text,insert_id=r.get('insertId')))
tasks={}
for row in footers:
    assert row['task_index'] is not None and row['task_attempt'] is not None
    key=row['task_index']+':'+row['task_attempt']
    task=tasks.setdefault(key,{})
    assert row['kind'] not in task,'Inspect duplicate task/attempt footer records; never silently deduplicate'
    task[row['kind']]=row
assert len(tasks)==4 and len(footers)==8 and {k.split(':')[0] for k in tasks}=={'0','1','2','3'}
assert all(set(v)=={'Tests','Test Files'} for v in tasks.values())
assert all(key.endswith(':0') for key in tasks), 'All actual task attempts must be attempt 0'
totals={kind:{k:sum(row[kind]['counts'].get(k,0) for row in tasks.values()) for k in ['passed','failed','skipped']} for kind in ['Tests','Test Files']}
terminal=[r for r in life if 'varlog%2Fsystem' in r.get('logName','') and re.search(r'exit|terminat|killed',r.get('textPayload',''),re.I)]
terminal_tasks={}
for r in terminal:
    labels=r.get('labels',{});key=str(labels.get('run.googleapis.com/task_index'))+':'+str(labels.get('run.googleapis.com/task_attempt'))
    terminal_tasks.setdefault(key,[]).append(r)
assert set(tasks)<=set(terminal_tasks),('Missing actual terminal task records',terminal_tasks)
exit_codes={}
for key in tasks:
    actual={int(m.group(1)) for r in terminal_tasks[key] if (m:=re.fullmatch(r'Container called exit\((\d+)\)\.',r.get('textPayload','')))}
    assert len(actual)==1,(key,terminal_tasks[key])
    exit_codes[key]=next(iter(actual))
dispatch_candidates=[(p,q) for p in sorted(D.glob('cloud-execution-query-*.json')) if (q:=json.loads(p.read_text()))['exit_code']==0]
assert dispatch_candidates, 'A live successful current-execution spec capture is required'
dispatch_query,dispatch_record=dispatch_candidates[0]
dispatch=json.loads(dispatch_record['stdout'])
assert dispatch['metadata']['name']==execution and dispatch['spec']['taskCount']==4 and dispatch['spec']['parallelism']==4
assert dispatch['spec']['template']['spec']['maxRetries']==0
absence={}
for kind in ['job','execution']:
    p,q=latest(kind,False)
    absent=q['exit_code'] not in [None,0] and ('Cannot find' in q['stderr'] or 'NOT_FOUND' in q['stderr'])
    absence[kind]=dict(path=str(p),sha256=sha(p),absent=absent,exit_code=q['exit_code'],stderr=q['stderr'])
    assert absent,(kind,q)
bp,bq=latest('build');build=json.loads(bq['stdout'])
assert build['status']=='SUCCESS' and build.get('finishTime') and build['id']==bq['build_id']
assert build['substitutions']['_FRESHELL_BUILD_COMMIT']==HEAD
expected_image='us-west1-docker.pkg.dev/misc-puttering-project/freshell-e2e/freshell-e2e:'+HEAD[:12]
assert build['substitutions']['_IMAGE']==expected_image
build_record=dict(id=build['id'],status=build['status'],create_time=build.get('createTime'),start_time=build.get('startTime'),finish_time=build.get('finishTime'),
    substitutions=build['substitutions'],actual_source=build.get('source'),source_provenance=build.get('sourceProvenance'),
    step_statuses=[dict(id=s.get('id'),name=s.get('name'),status=s.get('status')) for s in build.get('steps',[])],
    query=str(bp),query_sha256=sha(bp),closure='Terminal remote build; content-addressed image/archive/build record intentionally retained')
queries={str(p):dict(sha256=sha(p),exit_code=json.loads(p.read_text())['exit_code']) for p in D.glob('cloud-*-query-*.json')}
out=dict(at=datetime.now(timezone.utc).isoformat(),head=HEAD,job=job,execution=execution,
    footers=footers,actual_task_attempts=tasks,totals=totals,actual_terminal_task_records=terminal_tasks,actual_task_exit_codes=exit_codes,
    cloud_phase_passed=not totals['Tests']['failed'] and all(code==0 for code in exit_codes.values()),
    actual_dispatched_spec=dispatch['spec'],dispatch_query_sha256=sha(dispatch_query),
    closure=absence,cloud_build=build_record,metadata_queries=queries,
    metadata_query_errors_retained=[str(p) for p in D.glob('cloud-*-query-*.json') if json.loads(p.read_text())['exit_code'] not in [0] and 'Cannot find' not in json.loads(p.read_text()).get('stderr','') and 'NOT_FOUND' not in json.loads(p.read_text()).get('stderr','')],
    no_workload_retry=True,no_local_backend_fallback=True)
p=D/'cloud-evidence-verified.json';assert not p.exists();p.write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps(dict(path=str(p),sha256=sha(p),totals=totals,tasks=list(tasks),closure={k:v['absent'] for k,v in absence.items()},build_status=build['status'])))
