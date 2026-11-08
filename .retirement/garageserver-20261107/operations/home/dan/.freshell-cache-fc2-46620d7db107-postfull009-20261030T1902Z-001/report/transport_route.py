"""V1 cache transport around the byte-identical frozen compiler selector."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
sys.dont_write_bytecode = True
from compiler_route import Refusal, prepare as compiler_prepare, target

LABELS = {'com.freshell.cache.owner': 'freshell', 'com.freshell.cache.purpose': 'rust-target',
          'com.freshell.cache.schema': '1'}

def labels(cfg):
    return {**LABELS, 'com.freshell.cache.worktree-sha256': cfg['cacheWorktreeSha256']}

def metadata_allowed(args, cfg):
    volume = cfg['cacheVolume']
    return args in [
        ['volume', 'ls', '--format', '{{.Name}}', '--filter', 'name=' + volume],
        ['volume', 'inspect', '--format', '{{json .Labels}}', volume],
    ]

def push_allowed(args, cfg):
    old = bool(args) and (args[0] in ['ps','wait','stop','kill','rm']
        or args[:2] in [['image','inspect'],['container','inspect']])
    return old or metadata_allowed(args, cfg) or (args[:1] == ['run'] and target(args, cfg) is not None)

def cache_mounts(args, cfg):
    selected = target(args, cfg)
    if selected is None:
        return None
    options = args[1:selected[0]]
    actual = [options[i+1] for i,x in enumerate(options) if x == '--mount' and i+1 < len(options)]
    expected = []
    for destination in ['/workspace/target', '/freshell-test-artifacts']:
        expected.append(','.join(['type=volume','src=' + cfg['cacheVolume'],'dst=' + destination,
            *['volume-label=' + key + '=' + value for key,value in labels(cfg).items()]]))
    if sorted(actual) != sorted(expected):
        raise Refusal('exact labeled target aliases changed')
    for i,x in enumerate(options):
        if x == '-v' and i+1 < len(options):
            destination = options[i+1].split(':')[1:2]
            if destination and destination[0] in ['/workspace/target','/freshell-test-artifacts']:
                raise Refusal('ambiguous target alias')
    return selected

def retarget(body, cfg):
    old = '/freshell-test-artifacts/targets/' + cfg['cacheWorktreeSha256'][:12]
    declaration = "export CARGO_TARGET_DIR='" + old + "'\n"
    if old not in body:
        return body, False
    if body.count(declaration) != 1 or body.count(old) != 1:
        raise Refusal('worktree target declaration changed')
    return body.replace(declaration, 'export CARGO_TARGET_DIR=/freshell-test-artifacts\n'), True

def verify_cache(cfg):
    data = json.loads(subprocess.check_output([cfg['realDockerCli'],'volume','inspect',cfg['cacheVolume']], text=True, timeout=30))[0]
    if data['Driver'] != 'local' or data['Options'] != {'device':cfg['cacheDevice'],'o':'bind','type':'none'} or data['Labels'] != labels(cfg):
        raise Refusal('exact labeled local backing changed')
    st = Path(cfg['cacheDevice']).stat()
    if (st.st_dev,st.st_ino,st.st_uid,st.st_gid) != (cfg['cacheBackingDevice'],cfg['cacheBackingInode'],100999,100999):
        raise Refusal('retained namespace identity changed')

def prepare(args, cfg, context=None):
    if cache_mounts(args,cfg) is None:
        return args, None
    if context is None:
        verify_cache(cfg)
    original = args[-1]
    command, changed = retarget(original,cfg)
    rewritten,event = compiler_prepare([*args[:-1],command],cfg,context)
    event.update({'transportVersion':cfg['transportVersion'], 'cacheVolume':cfg['cacheVolume'],
        'cacheBackingInode':cfg['cacheBackingInode'], 'runtimeTargetRootAdjusted':changed,
        'originalCommandSha256':hashlib.sha256(original.encode()).hexdigest(),
        'transportCommandSha256':hashlib.sha256(command.encode()).hexdigest(),
        'cargoArgumentsAndProfilesUnchanged':True})
    return rewritten,event

def main(push=False):
    try:
        cfg = json.loads(Path(os.environ['FRESHELL_OWNED_COMPILER_ROUTE_CONFIG']).read_text())
        args = sys.argv[1:]
        if push and not push_allowed(args,cfg):
            raise Refusal('unsupported push Docker command')
        args,event = prepare(args,cfg)
        if event is not None:
            fd = os.open(os.environ['FRESHELL_OWNED_COMPILER_ROUTE_EVENTS'],os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)
            try:
                os.write(fd,(json.dumps(event)+'\n').encode())
            finally:
                os.close(fd)
            sys.stderr.write(json.dumps(event)+'\n')
    except (Refusal,OSError,KeyError,ValueError,subprocess.SubprocessError):
        sys.stderr.write(json.dumps({'severity':'error','event':'owned.cache_transport.refused'})+'\n')
        return 2
    os.execv(cfg['realDockerCli'],[cfg['realDockerCli'],*args])

if __name__ == '__main__':
    raise SystemExit(main())
