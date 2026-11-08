from pathlib import Path
from datetime import datetime,timezone
import hashlib,json,re
import sys
sys.dont_write_bytecode = True
sys.path.insert(0, '/home/dan/code/freshell/.worktrees/.the-usual-logs/freshcodex-complete/reports/final-fullcheck-010-staging-001')
from staging_context import context
A,D,AUTH,R,W,CONTRACT=context()
HEAD=A.head
lines=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',(D/'check.log').read_text(errors='replace')).splitlines()
events=[];failures=[];cloud=[]
for n,line in enumerate(lines,1):
    if line.startswith('{'):
        try:e=json.loads(line)
        except ValueError:continue
        if str(e.get('event','')).startswith('runtime_build.preflight.') or e.get('msg') in ['Starting test phase','Test phase exited','All test phases passed','Dispatching default Vitest phase to cloud','Cloud default phase complete; running local phases']:
            events.append(dict(log_line=n,event=e))
        if (e.get('msg')=='Test phase exited' and e.get('code')!=0) or e.get('event')=='runtime_build.preflight.failed':failures.append(dict(log_line=n,text=line))
    if '[vitest-cloud]' in line and any(k in line for k in ['Job:','Execution:','Succeeded tasks:','Failed tasks:']):cloud.append(dict(log_line=n,text=line))
    if re.search(r'^\s*FAIL\s|^error: (?:test failed|could not compile)|^test result: FAILED\.|Failed (?:Tests|Suites)\s+[1-9]',line):failures.append(dict(log_line=n,text=line))
space=json.loads((D/'space-continuation.jsonl').read_text().splitlines()[-1])
observer=json.loads((D/'observer002-state.json').read_text()) if (D/'observer002-state.json').exists() else None
sample_age=(datetime.now(timezone.utc)-datetime.fromisoformat(space['at'])).total_seconds()
out=dict(at=datetime.now(timezone.utc).isoformat(),log_lines=len(lines),milestones=events,cloud=cloud,actual_failure_signals=failures,
    latest_space=space,capacity_cancelled=(D/'capacity-cancellation.json').exists(),completion_exists=(D/'completion.json').exists(),tail=lines[-2:])
p=D/'status-observations.jsonl'
with p.open('a') as f:f.write(json.dumps(out)+'\n')
print(json.dumps(dict(at=out['at'],log_lines=len(lines),
    prerequisite_completions=sum(e['event'].get('event')=='runtime_build.preflight.completed' for e in events),
    latest_milestone=events[-1] if events else None,cloud=cloud[-4:],actual_failure_signals=failures[-6:],
    free_bytes={k:v['available_bytes'] for k,v in space['filesystems'].items()},
    reserve_sample_age_seconds=sample_age,observer_at=observer.get('at') if observer else None,observer_errors=observer.get('errors') if observer else None,
    capacity_cancelled=out['capacity_cancelled'],completion_exists=out['completion_exists'],tail=lines[-2:])))
