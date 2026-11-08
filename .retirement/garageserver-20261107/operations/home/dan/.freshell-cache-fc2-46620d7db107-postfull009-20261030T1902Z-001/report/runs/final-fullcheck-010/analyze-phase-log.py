"""Account for actual canonical log phases without counting nested Cargo children twice."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib, json, re

import sys
sys.dont_write_bytecode = True
sys.path.insert(0, '/home/dan/code/freshell/.worktrees/.the-usual-logs/freshcodex-complete/reports/final-fullcheck-010-staging-001')
from staging_context import context
A,D,AUTH,R,W,CONTRACT=context()
HEAD=A.head
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
done=json.loads((D/'completion.json').read_text())
assert sha(D/'check.log')==done['log_sha256']
clean=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',(D/'check.log').read_text(errors='replace'))
p=D/'check.clean.log'; assert not p.exists();p.write_text(clean)
lines=clean.splitlines();events=[]
for n,line in enumerate(lines,1):
    if not line.startswith('{'):continue
    try:e=json.loads(line)
    except ValueError:continue
    if isinstance(e,dict):events.append(dict(log_line=n,**e))
starts=[e for e in events if e.get('component')=='standard-test-runner' and e.get('msg')=='Starting test phase']
exits=[e for e in events if e.get('component')=='standard-test-runner' and e.get('msg')=='Test phase exited']
phases={}
def counts(text):
    return {kind:int(n) for n,kind in re.findall(r'(\d+) (passed|failed|skipped)',text)}
for start in starts:
    suite=start['suite']; assert suite not in phases
    end=next((e for e in exits if e.get('suite')==suite and e['log_line']>start['log_line']),None)
    lo=start['log_line'];hi=end['log_line'] if end else len(lines)
    footers=[]
    for n in range(lo,hi):
        line=lines[n-1];m=re.fullmatch(r'\s*(Test Files|Tests)\s+(.+)',line)
        if m and re.search(r'\d+ (?:passed|failed|skipped)',m.group(2)):
            total=re.search(r'\((\d+)\)\s*$',m.group(2))
            footers.append(dict(log_line=n,kind=m.group(1),counts=counts(m.group(2)),total=int(total.group(1)) if total else None,text=line.strip()))
    phases[suite]=dict(start=start,end=end,footers=footers)
rust=phases.get('rust');groups=[];raw_results=[];ignored=[]
if rust:
    lo=rust['start']['log_line'];hi=rust['end']['log_line'] if rust['end'] else len(lines)
    current=None
    for n in range(lo,hi):
        line=lines[n-1]
        if re.match(r'^\s*(?:Running (?:unittests |tests/)|Doc-tests )',line):
            current=dict(log_line=n,header=line.strip(),results=[],ignored=[]);groups.append(current)
        m=re.match(r'^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;',line)
        if m:
            row=dict(log_line=n,status=m.group(1),passed=int(m.group(2)),failed=int(m.group(3)),ignored=int(m.group(4)),measured=int(m.group(5)),filtered=int(m.group(6)),text=line)
            raw_results.append(row)
            assert current is not None,'Cargo result before header'
            current['results'].append(row)
        m=re.match(r'^test (.+?) \.\.\. ignored(?:, (.*))?$',line)
        if m:
            row=dict(log_line=n,name=m.group(1),reason=m.group(2),header=current['header'] if current else None,text=line)
            ignored.append(row)
            if current:current['ignored'].append(row)
    for g in groups:g['outer_footer']=g['results'][-1] if g['results'] else None
outer=[g['outer_footer'] for g in groups if g['outer_footer']]
totals=None  # Use the adopted current-running-boundary Rust accounting helper
out=dict(at=datetime.now(timezone.utc).isoformat(),completion=done,log_lines=len(lines),log_bytes=(D/'check.log').stat().st_size,
         log_sha256=sha(D/'check.log'),clean_log_sha256=sha(p),events=events,
         actual_preflight_completed=[e for e in events if e.get('event')=='runtime_build.preflight.completed'],
         strict_host_compiler=[dict(log_line=n,text=line) for n,line in enumerate(lines,1) if line.startswith('STRICT_COMPILER ')],
         typecheck_headers=[dict(log_line=n,text=line) for n,line in enumerate(lines,1) if re.match('> freshell@.+ typecheck:(client|tools|runtime) ',line)],
         phases=phases,reached_suites=list(phases),unreached_suites=[x for x in ['client-local-only','source-runtime','rust','electron'] if x not in phases],
         rust=dict(groups=groups,top_level_group_count=len(groups) if rust else None,outer_totals=totals,raw_result_blocks=len(raw_results) if rust else None,
                   ignored_lines=ignored,missing_outer_footers=[g['header'] for g in groups if not g['outer_footer']],
                   counting_rule='Raw observations only; adopted Rust helper plus current source-identity review own verified outer/nested counts'),
         compiler_events=[e for e in events if e.get('event')=='owned.strict_compiler.selected'],
         sandbox_events=[e for e in events if str(e.get('event','')).startswith('sandbox_')],
         failure_signals=[dict(log_line=n,text=line) for n,line in enumerate(lines,1) if re.search(r'Failed (?:Tests|Suites) |^ FAIL |^error: test failed|"msg":"Test phase exited".*"code":[1-9]',line)])
p=D/'phase-summary.json'; assert not p.exists();p.write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps(dict(path=str(p),sha256=sha(p),reached=out['reached_suites'],unreached=out['unreached_suites'],
                     phase_exits={k:v['end'] for k,v in phases.items()},rust_top_level=totals,rust_groups=out['rust']['top_level_group_count'],rust_raw=out['rust']['raw_result_blocks'],failure_signals=len(out['failure_signals']))))
