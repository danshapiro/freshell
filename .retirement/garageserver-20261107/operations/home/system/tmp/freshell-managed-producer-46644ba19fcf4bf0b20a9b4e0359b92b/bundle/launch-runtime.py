"""Deferred single exact-owned container launch. No runtime work at import."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import threading
import time
import sys
sys.dont_write_bytecode = True
from runtime_admission import IMAGE, LABEL, profile_arguments, sha, validate, verify_container

HERE = Path(__file__).resolve().parent


def now():
    return datetime.now(timezone.utc).isoformat()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--admission', type=Path, required=True)
    args = parser.parse_args()
    admission = json.loads(args.admission.read_text())
    validate(admission, HERE)  # Includes actual Root release/build/codec receipts and all staged hashes.
    root = Path(admission['temporary_root'])
    assert not root.exists(), 'Never duplicate or reuse an invocation directory'
    os.umask(0o077)
    root.mkdir(mode=0o700)
    evidence, bundle = root / 'evidence', root / 'bundle'
    evidence.mkdir(mode=0o700)
    bundle.mkdir(mode=0o755)
    bundle.chmod(0o755)
    for name in ['container-driver.py', 'cleanup_binding.py', 'producer_cases.py', 'runtime_admission.py', 'launch-runtime.py']:
        shutil.copyfile(HERE / name, bundle / name)
        (bundle / name).chmod(0o444)
    (bundle / 'runtime-admission.json').write_text(json.dumps(admission, indent=2) + '\n')
    (bundle / 'runtime-admission.json').chmod(0o444)
    calls, failures, samples = [], [], []
    stop, reserve_lost = threading.Event(), threading.Event()
    cid, attached, joined = None, None, False
    closed = False
    create_attempted = False
    started = time.monotonic()

    def put(name, value):
        path = root / name
        with path.open('x') as output:
            output.write(json.dumps(value, indent=2) + '\n')

    def query(*argv):
        command = [admission['docker']['cli'], '--host', admission['docker']['endpoint'], *argv]
        before = now()
        try:
            result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, timeout=15,
                                    env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
            row = dict(command=command, started_at=before, finished_at=now(), exit_code=result.returncode,
                       stdout=result.stdout.decode(errors='replace'), stderr=result.stderr.decode(errors='replace'), joined=True)
        except subprocess.TimeoutExpired as error:
            row = dict(command=command, started_at=before, finished_at=now(), exit_code=None, timeout_seconds=15,
                       stdout=(error.stdout or b'').decode(errors='replace'), stderr=(error.stderr or b'').decode(errors='replace'), joined=True)
        calls.append(row)
        put(f'call-{len(calls):03}.json', row)
        return row

    def successful(row):
        assert row['exit_code'] == 0, 'Actual private Docker command failed; inspect its retained receipt'
        return row

    def sample(initial=False):
        spaces = {}
        for name, path, floor in [('/', '/', (40 if initial else 16) * 1024**3),
                                   ('/home', admission['home_reserve_path'], (24 if initial else 16) * 1024**3)]:
            fs = os.statvfs(path)
            row = dict(path=path, device=os.stat(path).st_dev, available_bytes=fs.f_bavail * fs.f_frsize,
                       free_inodes=fs.f_favail, total_inodes=fs.f_files)
            spaces[name] = row
            if row['available_bytes'] < floor or row['free_inodes'] <= 10000:
                reserve_lost.set()
        value = dict(at=now(), initial=initial, filesystems=spaces)
        samples.append(value)
        return value

    def watch():
        try:
            with (root / 'space.jsonl').open('x') as output:
                while not stop.is_set():
                    output.write(json.dumps(sample()) + '\n')
                    output.flush()
                    stop.wait(1)
        except BaseException as error:
            failures.append(dict(stage='reserve_sampler', error=repr(error)))
            reserve_lost.set()

    def exact_inspection(identity):
        row = successful(query('container', 'inspect', identity))
        value = json.loads(row['stdout'])[0]
        assert value['Id'] == cid
        verify_container(value, admission, bundle, evidence)
        return value

    def cleanup():
        nonlocal closed
        if cid is None:
            return
        exact_inspection(cid)
        successful(query('container', 'rm', '--force', cid))
        absent = query('container', 'inspect', cid)
        closed = absent['exit_code'] == 1 and 'No such container' in absent['stderr']
        assert closed, 'Exact owned container absence was not established'

    watcher = threading.Thread(target=watch, name='uid-fixture-reserve-watch')
    watcher.start()
    try:
        put('initial-reserves.json', sample(initial=True))
        assert not reserve_lost.is_set()
        endpoint = Path(admission['docker']['endpoint'][7:])
        metadata = endpoint.stat()
        assert stat.S_ISSOCK(metadata.st_mode)
        assert dict(device=metadata.st_dev, inode=metadata.st_ino, uid=metadata.st_uid) == admission['docker']['socket_identity']
        info = json.loads(successful(query('info', '--format', '{{json .}}'))['stdout'])
        assert info['ID'] == admission['docker']['daemon_id'] and 'name=rootless' in info['SecurityOptions']
        image = json.loads(successful(query('image', 'inspect', IMAGE))['stdout'])[0]
        assert image['Id'] == IMAGE and not image['Config'].get('Volumes')
        assert image['Architecture'] == 'amd64' and image['Os'] == 'linux'
        encoded = json.dumps(image['Config'], sort_keys=True, separators=(',', ':')).encode()
        assert hashlib.sha256(encoded).hexdigest() == admission['image']['config_sha256']
        prior = query('container', 'inspect', admission['container_name'])
        assert prior['exit_code'] == 1 and 'No such container' in prior['stderr'], 'Do not replace an existing name'
        argv = profile_arguments(admission, bundle, evidence)
        put('create-argv.json', argv)
        create_attempted = True
        created = query(*argv)
        # A lost create acknowledgement cannot license another create. Recover only
        # this already-unique name, then validate its exact label/image/profile.
        if created['exit_code'] == 0:
            cid = created['stdout'].strip()
        else:
            recovered = successful(query('container', 'inspect', admission['container_name']))
            cid = json.loads(recovered['stdout'])[0]['Id']
            failures.append(dict(stage='create', error='Original create acknowledgement failed; recovered exact identity for closure only'))
        assert len(cid) == 64 and all(char in '0123456789abcdef' for char in cid)
        exact_inspection(cid)
        assert not failures, 'Failed original create is not a successful runtime invocation'
        put('immediate-prestart-reserves.json', sample(initial=True))
        assert not reserve_lost.is_set()
        command = [admission['docker']['cli'], '--host', admission['docker']['endpoint'], 'start', '--attach', cid]
        put('original-invocation.json', dict(command=command, at=now(), container_id=cid, source_variant=admission['source_variant'],phase=admission['phase']))
        with (root / 'container.stdout').open('xb') as output, (root / 'container.stderr').open('xb') as error:
            attached = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=output, stderr=error,
                                        env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
            put('original-tool.json', dict(pid=attached.pid, container_id=cid, at=now()))
            while attached.poll() is None:
                if reserve_lost.is_set() or time.monotonic() - started > admission['maximum_seconds']:
                    failures.append(dict(stage='active', error='Reserve lost or admitted total deadline exceeded'))
                    cleanup()
                    break
                reserve_lost.wait(.2)
            attached.wait(timeout=15)
            joined = True
        put('original-tool-join.json', dict(pid=attached.pid, exit_code=attached.returncode, joined_normally=True))
        assert attached.returncode == 0 and not failures
        result = json.loads((evidence / 'consumer-completion.json').read_text())
        assert result['status'] == ('EXPECTED_RED' if admission['phase']=='causal-red' else 'PASS')
        assert [row['case'] for row in result['cases']] == ['P', 'L', 'A', 'C']
        assert result['sourceVariant'] == admission['source_variant']
    except BaseException as error:
        failures.append(dict(stage='qualification', error=repr(error)))
    finally:
        if cid is not None and not closed:
            try:
                cleanup()
            except BaseException as error:
                failures.append(dict(stage='owned_container_cleanup', error=repr(error)))
        if attached is not None and not joined:
            try:
                attached.wait(timeout=15)
                joined = True
                put('late-original-tool-join.json', dict(pid=attached.pid, exit_code=attached.returncode, joined_normally=True))
            except BaseException as error:
                failures.append(dict(stage='original_tool_unjoined', pid=attached.pid, error=repr(error)))
        stop.set()
        watcher.join()
        put('space-completion.json', dict(samples=len(samples), minimum_available_bytes={name:min((row['filesystems'][name]['available_bytes'] for row in samples), default=None) for name in ['/', '/home']}, reserve_lost=reserve_lost.is_set()))
        put('resource-closure.json', dict(container_id=cid, exact_owned_container_absent=closed,
            exact_admitted_name=admission['container_name'], create_attempted=create_attempted,
            allocation_identity_unresolved=create_attempted and cid is None,
            original_tool_joined=joined if attached is not None else None, reserve_sampler_joined=True,
            no_volumes_or_networks_created=True, no_host_uid_or_source_cache_changes=True,
            retained_private_evidence_root=str(root), retained_bundle_and_evidence=True,
            temporary_cleanup='Retained for Root evidence adoption; exact path only may be removed later', failures=failures))
    success = not failures and closed and joined and not reserve_lost.is_set()
    put('runtime-completion.json', dict(status='PASS' if success else 'FAILED', source_variant=admission['source_variant'], phase=admission['phase'],
        scope='ACTUAL_UID0_PRODUCER_TO_NATIVE_UID_CONSUMER_CAUSAL_QUALIFICATION',
        review_status='NOT_STARTED', failures=failures, container_id=cid, original_tool_joined=joined,
        owned_container_absent=closed, all_metadata_calls_joined=all(row['joined'] for row in calls),
        source_compiler_cache_test_lease='HELD_BY_IMPLEMENTER'))
    print(json.dumps(dict(status='PASS' if success else 'FAILED', source_variant=admission['source_variant'], phase=admission['phase'],
        review_status='NOT_STARTED', receipt_sha256=sha(root / 'runtime-completion.json'),
        resource_closure_sha256=sha(root / 'resource-closure.json'), private_evidence_root=str(root))))
    raise SystemExit(0 if success else 1)


if __name__ == '__main__':
    main()
