"""Deferred Root admission validation and fixed distinct-purpose UID profile."""
from pathlib import Path
import hashlib
import re
import json

IMAGE = 'sha256:967627e41734aa903e824e4be22849c7f22ce0e69487ce61bb72004c4817f89c'
LABEL = 'com.freshell.managed-producer-rgr-001'
STAGED = ['container-driver.py', 'producer_cases.py', 'cleanup_binding.py', 'runtime_admission.py', 'launch-runtime.py']


def sha(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def validate(admission, here):
    assert admission['status'] == 'AUTHORIZED_ACTUAL_PRODUCER_PHASE'
    parent=json.loads(Path(admission['parent']['path']).read_text())
    assert sha(admission['parent']['path'])==admission['parent']['sha256']
    assert parent['status']=='AUTHORIZED_SOLE_MANAGED_PRODUCER_CAUSAL_RGR'
    assert parent['runtime_qualification_policy']['max_actual_container_invocations']==3
    assert admission['phase'] in ['causal-red','corrected-green','refactor-final']
    assert admission['binary']['source_variant']==admission['source_variant']==admission['probe']['source_variant']
    assert admission['binary']['abi']==admission['probe']['abi']=='ELF64_LSB_X86_64_LINUX_GNU'
    assert admission['image']['id'] == IMAGE
    assert admission['docker']['cli'] == '/usr/bin/docker'
    assert admission['docker']['endpoint'].startswith('unix:///')
    assert admission['docker']['daemon_id'] and admission['docker']['socket_identity']
    assert re.fullmatch('[0-9a-f]{32}', admission['nonce'])
    name = 'freshell-managed-producer-' + admission['nonce']
    assert admission['container_name'] == name
    assert admission['labels'] == {LABEL: admission['nonce']}
    assert admission['temporary_root'] == '/tmp/' + name
    assert admission['home_reserve_path'] == '/home/dan'
    assert admission['maximum_seconds'] == 180
    for key in ['binary', 'probe']:
        pin = admission[key]['receipt']
        assert re.fullmatch('[0-9a-f]{64}', pin['sha256']) and sha(pin['path']) == pin['sha256']
    for name in STAGED:
        assert sha(here / name) == admission['staged'][name]
    for key in ['binary','probe']:
        assert sha(admission[key]['path']) == admission[key]['sha256']
        with open(admission[key]['path'], 'rb') as binary:
            header = binary.read(20)
        assert header[:6] == b'\x7fELF\x02\x01' and int.from_bytes(header[18:20], 'little') == 62
    assert sha(admission['docker']['cli']) == admission['docker']['sha256']
    for value in [admission['binary']['path'], admission['temporary_root']]:
        assert Path(value).is_absolute() and not any(char in value for char in [',', '\n', '\0'])


def profile_arguments(admission, bundle, evidence):
    args = ['create', '--pull=never', '--name=' + admission['container_name'],
            '--label=' + LABEL + '=' + admission['nonce'], '--network=none', '--read-only',
            '--user=0:0', '--cap-drop=ALL', '--cap-add=CHOWN', '--cap-add=SETGID', '--cap-add=SETUID',
            '--security-opt=no-new-privileges:true', '--ipc=private', '--restart=no',
            '--pids-limit=32', '--memory=134217728', '--memory-swap=134217728', '--cpus=0.5',
            '--log-driver=none', '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777',
            '--mount=type=bind,src=' + admission['binary']['path'] + ',dst=/runtime/freshell-session-host,readonly',
            '--mount=type=bind,src=' + admission['probe']['path'] + ',dst=/runtime/managed-producer-probe,readonly',
            '--mount=type=bind,src=' + str(bundle) + ',dst=/qualification,readonly',
            '--mount=type=bind,src=' + str(evidence) + ',dst=/evidence',
            '--env=PATH=/usr/local/bin:/usr/bin:/bin', '--env=LANG=C.UTF-8',
            '--env=HOME=/tmp/uid-qualification/home', '--env=TMPDIR=/tmp/uid-qualification/tmp',
            '--entrypoint=/usr/bin/python3', IMAGE, '/qualification/container-driver.py',
            '--admission', '/qualification/runtime-admission.json']
    return args


def verify_container(value, admission, bundle, evidence):
    assert value['Image'] == IMAGE and value['Config']['Image'] == IMAGE
    assert value['Name'] == '/' + admission['container_name']
    assert all(value['Config']['Labels'].get(key) == data for key, data in admission['labels'].items())
    assert value['Config']['User'] == '0:0' and value['Config']['Tty'] is False
    assert value['Config']['Entrypoint'] == ['/usr/bin/python3']
    assert value['Config']['Cmd'] == ['/qualification/container-driver.py', '--admission', '/qualification/runtime-admission.json']
    host = value['HostConfig']
    for key, expected in dict(NetworkMode='none', ReadonlyRootfs=True, Privileged=False,
                              PidMode='', IpcMode='private', PidsLimit=32, Memory=134217728,
                              MemorySwap=134217728, NanoCpus=500000000).items():
        assert host[key] == expected, key
    assert host['CapDrop'] == ['ALL'] and sorted(host['CapAdd']) == ['CHOWN', 'SETGID', 'SETUID']
    assert host['SecurityOpt'] == ['no-new-privileges:true']
    assert host['RestartPolicy']['Name'] == 'no'
    assert host['LogConfig']['Type'] == 'none'
    assert host['Tmpfs'] == {'/tmp': 'rw,noexec,nosuid,nodev,size=16m,mode=1777'}
    assert not host.get('PortBindings') and not host.get('ExtraHosts')
    expected = {(admission['binary']['path'], '/runtime/freshell-session-host', False),
                (admission['probe']['path'], '/runtime/managed-producer-probe', False),
                (str(bundle), '/qualification', False), (str(evidence), '/evidence', True)}
    mounts = value['Mounts']
    assert {(row['Source'], row['Destination'], row['RW']) for row in mounts if row['Type'] == 'bind'} == expected
    assert sum(row['Type'] == 'bind' for row in mounts) == 4
    assert all(row['Type'] == 'bind' or (row['Type'] == 'tmpfs' and row['Destination'] == '/tmp') for row in mounts)
