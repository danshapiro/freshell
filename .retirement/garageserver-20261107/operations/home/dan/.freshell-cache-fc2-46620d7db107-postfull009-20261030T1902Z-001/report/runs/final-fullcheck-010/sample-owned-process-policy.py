"""Metadata only: sample actual observed sandbox PIDs; never execute in guests."""
from pathlib import Path
from datetime import datetime,timezone
import hashlib,json,re,subprocess
D=Path(__file__).resolve().parent
state=json.loads((D/'observer002-state.json').read_text())
def sha(raw):return hashlib.sha256(raw).hexdigest()
def now():return datetime.now(timezone.utc).isoformat()
records=[]
for name,row in state['containers'].items():
    actual=row.get('actual_container',{});cid=actual.get('id')
    if not cid or not re.fullmatch('[0-9a-f]{64}',cid):continue
    prior=list(D.glob(name+'-process-policy-*.json'))
    if prior and any(json.loads(p.read_text()).get('actual_workload_samples') for p in prior):continue
    query=['/usr/bin/docker','top',cid,'-eo','pid,ppid,uid,gid,args']
    result=subprocess.run(query,stdin=subprocess.DEVNULL,capture_output=True,text=True,timeout=10)
    process_rows=[]
    for line in result.stdout.splitlines()[1:]:
        match=re.match(r'\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)',line)
        if not match:continue
        pid,ppid,uid,gid,command=match.groups();path=Path('/proc')/pid
        sample=dict(pid=int(pid),ppid=int(ppid),docker_top_host_uid=int(uid),docker_top_host_gid=int(gid),command=command)
        try:
            fields=(path/'stat').read_text().rpartition(') ')[2].split();status={}
            for field in (path/'status').read_text().splitlines():
                key,sep,value=field.partition(':')
                if sep and key in ['Uid','Gid','CapInh','CapPrm','CapEff','CapAmb','NoNewPrivs','NSpid']:status[key]=value.strip()
            sample.update(start_identity=fields[19],status=status,uid_map=(path/'uid_map').read_text(),gid_map=(path/'gid_map').read_text())
            sample['workload_command_sample']=bool(re.search(r'(?:^|[ /])(?:cargo|rustc|rustdoc)(?:[ -]|$)',command))
            sample['zero_recorded_capabilities']=all(int(status.get(key,'1'),16)==0 for key in ['CapInh','CapPrm','CapEff','CapAmb'])
            sample['no_new_privileges']=status.get('NoNewPrivs')=='1'
        except (OSError,IndexError) as error:sample['metadata_race_or_read_error']=repr(error)
        process_rows.append(sample)
    output=dict(at=now(),container=name,cid=cid,actual_observed_profile=actual.get('profile'),actual_observed_mounts=actual.get('mounts'),
        query=dict(command=query,exit_code=result.returncode,stdout=result.stdout,stderr=result.stderr),processes=process_rows,
        actual_workload_samples=[p for p in process_rows if p.get('workload_command_sample')],scope='Observed actual consumer PIDs only; root init is not workload proof; short-lived races retained, no per-child audit or guest exec')
    p=D/(name+f'-process-policy-{len(prior)+1:03}.json');assert not p.exists();p.write_text(json.dumps(output,indent=2)+'\n')
    records.append(dict(path=str(p),sha256=sha(p.read_bytes()),container=name,query_exit=result.returncode,workload_samples=len(output['actual_workload_samples'])))
print(json.dumps(dict(records=records)))
