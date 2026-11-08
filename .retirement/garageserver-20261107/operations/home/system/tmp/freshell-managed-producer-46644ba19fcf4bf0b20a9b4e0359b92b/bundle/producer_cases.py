"""Actual UID0 Rust producer -> exact native cleanup consumer, finite fixtures."""
import json, os, select, subprocess, time, uuid
from pathlib import Path

def run(d):
    admission=json.loads((d.HERE/'runtime-admission.json').read_text())
    assert admission['status']=='AUTHORIZED_ACTUAL_PRODUCER_PHASE'
    assert os.getpid()==1 and os.getuid()==os.getgid()==0
    identity=d.status(1)
    assert identity['nnp']==1 and all(int(identity['caps'][key],16)==0xc1 for key in ['CapEff','CapPrm','CapBnd'])
    assert all(int(identity['caps'][key],16)==0 for key in ['CapInh','CapAmb'])
    for key,path in [('binary',d.BINARY),('probe',d.PROBE)]:
        assert d.digest(path)==admission[key]['sha256']
    for name,value in admission['staged'].items():
        assert d.digest(d.HERE/name)==value
    for relative in ['home','tmp']:
        path=Path('/tmp/uid-qualification')/relative
        path.mkdir(parents=True,exist_ok=True)
        os.chown(path,d.UID,d.GID)
    d.put('parent-identity.json',dict(identity=identity,sourceVariant=admission['source_variant'],**d.stat(1)))
    outcomes=[]
    for case in ['P','L','A','C']:
        outcomes.append(run_case(d,case,admission))
    causal=all(row['safe'] for row in outcomes)
    expected=(all(row['actualConfirmed'] is True and row.get('liveChildAfterConsumer') and not row['safe'] for row in outcomes[:2])
        and all(row['safe'] for row in outcomes[2:])) if admission['phase']=='causal-red' else causal
    d.put('consumer-completion.json',dict(status='EXPECTED_RED' if expected and not causal else 'PASS' if expected else 'BEHAVIOR_FAILURE',
        cases=outcomes,sourceVariant=admission['source_variant'],phase=admission['phase']))
    assert expected, 'Actual producer/consumer behavior did not match the admitted phase expectation'

def run_case(d,case,admission):
    tag='codex-sidecar-'+str(uuid.uuid4())
    control_r,control_w=os.pipe()
    log=(d.EVIDENCE/(case+'-producer.stderr')).open('xb')
    probe=subprocess.Popen([d.PROBE,tag,str(control_r)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,
        pass_fds=(control_r,),env=d.clean_env(),bufsize=0)
    os.close(control_r)
    root=None; members=[]; payload=None; result=None; closed={}
    def call(op,**kwargs):
        request=dict(op=op,**kwargs)
        probe.stdin.write(json.dumps(request).encode()+b'\n'); probe.stdin.flush()
        assert select.select([probe.stdout],[],[],8)[0], 'Actual producer RPC deadline'
        raw=probe.stdout.readline()
        assert raw, 'Actual producer ended before requested operation'
        row=json.loads(raw)
        with (d.EVIDENCE/(case+'-probe-protocol.jsonl')).open('ab') as output:
            output.write(json.dumps(dict(request=request,response=row)).encode()+b'\n')
        return row
    def event(wanted):
        for _ in range(4):
            row=call('read')['value']
            with (d.EVIDENCE/'writer-events.jsonl').open('ab') as output:
                output.write(json.dumps(row).encode()+b'\n')
            if row['event']==wanted: return row
        raise AssertionError('Finite fixture event mismatch')
    def command(value):
        return call('command',command=value)
    try:
        root=event('ready'); members=[root]
        assert root['role']=='root' and root['dumpable']==1
        probe_identity=d.status(probe.pid)
        assert probe_identity['uids']==[0]*4 and probe_identity['gids']==[0]*4 and probe_identity['nnp']==1
        assert int(probe_identity['caps']['CapEff'],16)==0xc1
        witness=dict(identity=probe_identity,**d.stat(probe.pid),exe=os.readlink(f'/proc/{probe.pid}/exe'),
            binarySha256=d.digest(f'/proc/{probe.pid}/exe'),root=root)
        assert witness['exe']==d.PROBE and witness['binarySha256']==admission['probe']['sha256']
        assert root['ppid']==probe.pid
        d.put(case+'-producer-witness.json',witness)
        d.observe(root['pid'],root['start'],'writer',tag=tag)
        def fork():
            command('fork')
            child=event('ready')
            assert child['role']=='later' and child['dumpable']==1 and child['ppid']==root['pid']
            members.append(child)
            d.observe(child['pid'],child['start'],'writer',tag=tag)
            return child
        if case=='P': child=fork()
        payload=call('record')['payload'].encode()
        original=json.loads(payload)
        assert original['pid']==root['pid'] and original['startTime']==root['start']
        assert original['ownershipId']==tag and original['captureComplete'] is True
        assert [root['pid'],root['start']] in original['tree']
        if case=='P' and admission['phase']!='causal-red':
            assert [child['pid'],child['start']] in original['tree'], 'Corrected actual UID0 producer omitted a pre-existing child'
        d.put(case+'-actual-producer-payload.json',payload)
        d.put(case+'-capture-link.json',dict(root=root,members=members,producerTree=original['tree'],producerComplete=original['captureComplete']))
        if case in ['L','A']: child=fork()
        if case in ['P','L']:
            assert os.write(control_w,b'H')==1
            hidden=event('hidden')
            assert (hidden['pid'],hidden['start'])==(child['pid'],child['start'])
            d.observe(child['pid'],child['start'],'hidden')
            command('exit')
            assert call('wait')['success'] is True
            current=d.stat(child['pid'])
            assert current and current['start']==child['start'] and current['ppid']==1 and current['state'] not in ['Z','X']
            d.put(case+'-reparented-child.json',current)
        if case=='C':
            command('negative-control'); event('armed')
            original['captureComplete']=False
            payload=json.dumps(original,separators=(',',':')).encode()
        result=d.consume(case,payload,None,members,admission['binary']['sha256'])
        physical=[d.stat(row['pid']) for row in members]
        live=[row for row in physical if row and row['state'] not in ['Z','X']]
        result.update(case=case,actualConfirmed=result.pop('confirmed'),originalMembers=original['tree'],physicalAfterConsumer=physical)
        if case in ['P','L']:
            result['safe']=not result['actualConfirmed'] or not live
            if live:
                assert os.write(control_w,b'P')==1
                heartbeat=event('heartbeat')
                assert heartbeat['start']==child['start']
                result['liveChildAfterConsumer']=heartbeat
        elif case=='A':
            result['safe']=result['actualConfirmed'] and not live
        else:
            assert result['actualConfirmed'] is False
            command('ping'); heartbeat=event('heartbeat')
            result['safe']=heartbeat['start']==root['start'] and heartbeat['signals']==[]
        d.put(case+'-consumer-outcome.json',result)
        if case=='L' and admission['phase']!='causal-red':
            assert result['actualConfirmed'] is False and live
            assert os.write(control_w,b'X')==1
            deadline=time.monotonic()+5
            while True:
                reaped,wait_status=os.waitpid(child['pid'],os.WNOHANG)
                if reaped:
                    assert reaped==child['pid'] and wait_status==0
                    break
                assert time.monotonic()<deadline, 'Controlled opaque child did not settle'
                os.sched_yield()
            assert d.stat(child['pid']) is None
            cleared=d.consume('L-cleared',payload,None,members,admission['binary']['sha256'])
            assert cleared['confirmed'] is True
            assert cleared['originalInput']['sha256']==result['originalInput']['sha256'], 'Continuation must deliver exact same producer bytes'
            result['sameOriginalAfterPhysicalChildClosure']=dict(confirmed=cleared['confirmed'],waitStatus=wait_status,
                originalInput=cleared['originalInput'],actualHelper=cleared['actualHelper'])
            d.put('L-cleared-continuation.json',result['sameOriginalAfterPhysicalChildClosure'])
    finally:
        # Close exactly the fixture roots and inherited child-control pipe;
        # closure never turns a consumer refusal/false proof into success.
        if root is not None:
            current=d.stat(root['pid'])
            if current and current['start']==root['start'] and current['state'] not in ['Z','X']:
                command('exit')
            call('wait')
            for row in members[1:]:
                current=d.stat(row['pid'])
                if current and current['start']==row['start'] and current['state'] not in ['Z','X']:
                    assert os.write(control_w,b'X')==1
                deadline=time.monotonic()+5
                while d.stat(row['pid']) is not None:
                    pid,status=os.waitpid(row['pid'],os.WNOHANG)
                    if pid:
                        closed[str(pid)]=status; break
                    assert time.monotonic()<deadline, 'Exact controlled orphan did not exit/reap'
                    os.sched_yield()
            probe.stdin.write(b'{"op":"finish"}\n'); probe.stdin.close()
        os.close(control_w)
        probe.wait(timeout=8)
        probe.stdout.close(); log.close()
        d.put(case+'-fixture-closure.json',dict(probePid=probe.pid,probeJoined=True,probeExit=probe.returncode,
            physicalMembersAbsent={str(row['pid']):d.stat(row['pid']) is None for row in members},orphanWaitStatuses=closed))
    assert probe.returncode==0 and all(d.stat(row['pid']) is None for row in members)
    return result
