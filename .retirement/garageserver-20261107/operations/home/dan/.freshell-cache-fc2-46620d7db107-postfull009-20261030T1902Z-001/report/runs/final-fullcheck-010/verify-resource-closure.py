"""Verify exact observed owned resources after normal launcher completion."""
from pathlib import Path
from datetime import datetime,timezone
import hashlib,json,os,re,subprocess
import sys
sys.dont_write_bytecode = True
sys.path.insert(0, '/home/dan/code/freshell/.worktrees/.the-usual-logs/freshcodex-complete/reports/final-fullcheck-010-staging-001')
from staging_context import context
A,D,AUTH,R,W,CONTRACT=context()
HEAD=A.head
inv=json.loads((D/'invocation.json').read_text());done=json.loads((D/'completion.json').read_text())
observer=json.loads((D/'observer002-normal-completion.json').read_text())
snapshot=json.loads((D/'resource-snapshot-after.json').read_text())
assert all(v['exit_code']==0 for v in snapshot['commands'].values())
def rows(kind):return [json.loads(s) for s in snapshot['commands'][kind]['stdout'].splitlines() if s.strip()]
ids={x['ID'] for x in rows('containers')}
names={n for x in rows('containers') for n in x.get('Names','').split(',')}
volumes={x['Name'] for x in rows('volumes')}
tags={x['Repository']+':'+x['Tag'] for x in rows('images')}
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def query(argv):
    p=subprocess.run(argv,stdin=subprocess.DEVNULL,capture_output=True,text=True,timeout=30)
    return dict(argv=argv,exit_code=p.returncode,stdout=p.stdout,stderr=p.stderr)
fixture=[];errors=[]
for p in sorted((W/'.runtime-evidence'/done['head']).glob('*/cleanup.json')):
    raw=p.read_bytes();m=json.loads(raw)
    if m.get('completedAt','')<inv['started_at']:continue
    copy=D/(p.parent.name+'-cleanup.json')
    if copy.exists():assert copy.read_bytes()==raw
    else:copy.write_bytes(raw)
    def base36(n):
        out=''
        while n: n,r=divmod(n,36);out='0123456789abcdefghijklmnopqrstuvwxyz'[r]+out
        return out or '0'
    testroot=Path('/tmp')/('f'+base36(os.getuid()))/p.parent.name[:12]
    retained_tree=[]
    if testroot.exists():
        for entry in sorted(testroot.rglob('*')):
            retained_tree.append(dict(relative_path=str(entry.relative_to(testroot)),
                kind='symlink' if entry.is_symlink() else 'directory' if entry.is_dir() else 'socket' if entry.is_socket() else 'file',
                bytes=entry.lstat().st_size if not entry.is_dir() else None))
    image=m.get('runtimeImage') or {}
    row=dict(run_id=p.parent.name,source_receipt=str(p),preserved_copy=str(copy),sha256=sha(copy),cleanup_ok=m.get('ok'),
        errors=m.get('errors'),unsafe_broker_attempts=m.get('unsafeBrokerAttempts'),
        exact_container_ids=m.get('exactContainerIds',[]),containers_present=sorted(set(m.get('exactContainerIds',[]))&ids),
        volumes=m.get('volumes',[]),volumes_present=sorted(set(m.get('volumes',[]))&volumes),runtime_image=image,
        own_tag_absent=not image.get('tag') or image['tag'] not in tags,
        build_dir_absent=not (W/'.runtime-build'/p.parent.name).exists(),
        broker_socket_absent=not (testroot/'broker/docker.sock').exists(),
        fixture_temp_root=str(testroot),fixture_temp_root_retained=testroot.exists(),
        retained_temp_tree_summary=dict(entries=len(retained_tree),by_kind={k:sum(x['kind']==k for x in retained_tree) for k in ['directory','file','symlink','socket']},total_regular_file_bytes=sum(x['bytes'] for x in retained_tree if x['kind']=='file')),retained_temp_has_no_files_or_sockets=all(x['kind']=='directory' for x in retained_tree),
        shared_image_id_deletion_not_claimed=True)
    fixture.append(row)
    if not row['cleanup_ok'] or row['errors'] or row['unsafe_broker_attempts'] or row['containers_present'] or row['volumes_present'] or not row['own_tag_absent'] or not row['build_dir_absent'] or not row['broker_socket_absent']:errors.append(dict(kind='fixture',run_id=row['run_id']))
controls=[]
for name,row in observer['containers'].items():
    control=Path(row.get('control_directory','/tmp/'+name));pid=row.get('guard_pid')
    guard_current=None
    if pid and (Path('/proc')/str(pid)).exists():
        try:
            raw=(Path('/proc')/str(pid)/'cmdline').read_bytes()
            guard_current=dict(pid=pid,same_owned_guard=b'sandbox-owner-guard.py' in raw and str(control).encode() in raw,command_sha256=hashlib.sha256(raw).hexdigest())
        except FileNotFoundError:pass
    actual=row.get('actual_container',{})
    selected=[e for e in row['events'].values() if e.get('event')=='owned.strict_compiler.selected']
    strict_proof=None
    if selected:
        profile=actual.get('profile',{})
        aliases={m['Destination']:m for m in actual.get('mounts',[]) if m['Destination'] in ['/workspace/target','/freshell-test-artifacts']}
        strict_proof=dict(actual_container_captured=bool(actual),
            fixed_policy=profile.get('NetworkMode')=='none' and profile.get('ReadonlyRootfs') is True and profile.get('PidsLimit')==512 and profile.get('Memory')==8589934592 and profile.get('Privileged') is False and 'no-new-privileges' in profile.get('SecurityOpt',[]),
            exact_aliases=set(aliases)=={'/workspace/target','/freshell-test-artifacts'} and all(m.get('Name')==CONTRACT['cache_volume'] for m in aliases.values()) and len({m.get('Source') for m in aliases.values()})==1,
            v2_events_and_unchanged_arguments=all(e.get('transportVersion')==2 and e.get('cargoArgumentsAndProfilesUnchanged') is True for e in selected),
            compiler_selection_events=selected)
        if not all(strict_proof[k] for k in ['actual_container_captured','fixed_policy','exact_aliases','v2_events_and_unchanged_arguments']):errors.append(dict(kind='strict_actual_policy_or_route',name=name,proof=strict_proof))
    out=dict(name=name,control_path=str(control),control_absent=not control.exists(),name_absent=name not in names,
        captured_cid=actual.get('id'),cid_absent=actual.get('id') not in ids,
        guard_pid=pid,guard_current=guard_current,actual_container_profile=actual.get('profile'),actual_mounts=actual.get('mounts'),
        normal_finish_events=[e for e in row['events'].values() if e.get('event') in ['sandbox_workload_finished','sandbox_workload_failed']],
        guard_final_body_observed='owner-guard.done' in row.get('control_files',{}),
        no_unobserved_guard_final_body_claim=True,strict_actual_proof=strict_proof)
    controls.append(out)
    if not out['control_absent'] or not out['name_absent'] or not out['cid_absent'] or (guard_current and guard_current['same_owned_guard']):errors.append(dict(kind='sandbox',name=name))
preflight=[]
for original,row in observer['preflight_snapshots'].items():
    out=dict(original=original,preserved_copy=row['copy'],sha256=row['sha256'],directory_absent=not Path(original).parent.exists(),binaries=row['binaries'])
    preflight.append(out)
    if not out['directory_absent']:errors.append(dict(kind='preflight',path=original))
cfg=json.loads((R/'route.json').read_text())
temps=[]
for n,line in enumerate((D/'check.clean.log').read_text().splitlines(),1):
    if not line.startswith('{'):continue
    try:e=json.loads(line)
    except ValueError:continue
    if e.get('event') not in ['rust_test_temp_created','source_runtime_temp_created']:continue
    for key in ['directory','runtimeDirectory']:
        guest=e.get(key)
        if not guest:continue
        assert guest.startswith('/freshell-test-artifacts/')
        relative=Path(guest).relative_to('/freshell-test-artifacts')
        assert '..' not in relative.parts
        host=Path(cfg['cacheDevice'])/relative
        q=query(['sudo','-n','stat','-Lc','%d %i',str(host)])
        absent=q['exit_code']==1 and 'No such file or directory' in q['stderr']
        temps.append(dict(log_line=n,guest=guest,host=str(host),absence_query=q,absent=absent))
        if not absent:errors.append(dict(kind='guest_temp',path=str(host)))
# Exact-prefix live socket observation; retained socket inodes alone do not
# imply a live broker. Preserve successful query metadata and scoped matches.
socket_query=query(['ss','-H','-xanp'])
socket_stdout=socket_query.pop('stdout')
socket_query['stdout_sha256']=hashlib.sha256(socket_stdout.encode()).hexdigest()
socket_query['stdout_bytes']=len(socket_stdout.encode())
roots=[row['fixture_temp_root']+'/' for row in fixture]
socket_query['exact_owned_path_matches']=[line for line in socket_stdout.splitlines() if any(root in line for root in roots)]
if socket_query['exit_code']!=0 or socket_query['exact_owned_path_matches']:errors.append(dict(kind='owned_sockets',query=socket_query))
# Verify only sampled owned process identities; PID reuse is recorded separately.
observed={}
for line in (D/'owned-process-observations002.jsonl').read_text().splitlines():
    for row in json.loads(line)['owned']:
        observed[(row['pid'],row['start_identity'])]=row
process_rows=[]
for (pid,start),record in sorted(observed.items()):
    try:
        current=(Path('/proc')/str(pid)/'stat').read_text().rpartition(') ')[2].split()[19]
    except (FileNotFoundError,ProcessLookupError):
        current=None
    active=current==start
    process_rows.append(dict(pid=pid,start_identity=start,current_start_identity=current,same_observed_process_active=active,pid_reused=current is not None and current!=start))
    if active:errors.append(dict(kind='owned_process',pid=pid,start_identity=start))
coordinator=query(['pnpm','run','test:status'])
if coordinator['exit_code']!=0:errors.append(dict(kind='coordinator_status_query',query=coordinator))
cache_refs=query(['/usr/bin/docker','ps','-aq','--no-trunc','--filter','volume='+cfg['cacheVolume']])
if cache_refs['exit_code']!=0 or cache_refs['stdout'].strip():errors.append(dict(kind='cache_refs',query=cache_refs))
space=json.loads((D/'space-completion.json').read_text())
out=dict(at=datetime.now(timezone.utc).isoformat(),head=done['head'],fixture_runs=fixture,sandbox_controls=controls,
    preflight_snapshots=preflight,guest_temps=temps,qualified_cache_references=cache_refs,errors=errors,
    exact_fixture_containers=len({x for r in fixture for x in r['exact_container_ids']}),
    exact_fixture_volumes=len({x for r in fixture for x in r['volumes']}),
    observer_errors=observer['errors'],capacity=space,
    socket_metadata_query=socket_query,observed_owned_process_identities=process_rows,coordinator_status_query=coordinator,
    scope='Exact owned resources only; normal fixture temp roots may retain evidence, but brokers/build copies/owned objects are closed. No global idleness or per-spawn audit claim.',
    verification_cleanup_actions='NONE; normal runner/owner cleanup only')
p=D/'resource-closure-receipt.json';assert not p.exists();p.write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps(dict(path=str(p),sha256=sha(p),fixture_runs=len(fixture),fixture_containers=out['exact_fixture_containers'],fixture_volumes=out['exact_fixture_volumes'],sandbox_controls=len(controls),temps=len(temps),errors=errors,observer_errors=observer['errors'])))
assert not errors and not observer['errors'] and space['cancellation'] is None
