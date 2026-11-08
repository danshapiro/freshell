#!/usr/bin/env python3
"""Durable coordinator launcher; preserves the existing strict verification routes."""
from datetime import datetime, timezone
from pathlib import Path
import argparse
import hashlib
import json
import os
import re
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('mode', choices=['clippy', 'check'])
parser.add_argument('--head', required=True)
parser.add_argument('--run-name')
args = parser.parse_args()
W = Path('/home/dan/code/freshell/.worktrees/freshcodex-complete')
L = W.parent / '.the-usual-logs/freshcodex-complete'
prefix = 'final-lint-' if args.mode == 'clippy' else 'final-fullcheck-'
run_name = args.run_name or prefix + '001'
assert re.fullmatch(re.escape(prefix) + r'\d{3}', run_name), 'Use a unique bounded attempt name'
D = Path(__file__).resolve().parent / 'runs' / run_name

def now():
    return datetime.now(timezone.utc).isoformat()

def git(*parts):
    return subprocess.check_output(['git', '-C', str(W), *parts], text=True).strip()

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def docker(*parts):
    return subprocess.check_output(['/usr/bin/docker', *parts], text=True).strip()

assert git('rev-parse', 'HEAD') == args.head
assert not git('status', '--porcelain'), 'Commit source before final verification'
state = json.loads((L / 'execution-coordinator-state.json').read_text())
assert state['active'].get('implementation_owner_released') is True
assert not state['active'].get('live_checks'), 'Join every existing check before launching'
versions = {}
for tool, prefix in [('node', 'v22.'), ('pnpm', '10.34.5')]:
    versions[tool] = subprocess.check_output([tool, '--version'], text=True).strip()
    assert versions[tool].startswith(prefix), (tool, versions[tool])

env = os.environ.copy()
proxy_keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']
removed = []
preflight = {}
if args.mode == 'check':
    driver = '/home/dan/.freshell-cache-fc2-46620d7db107-postfull009-20261030T1902Z-001/report/strict-fullcheck.mts'
    config_path = Path('/home/dan/.freshell-cache-fc2-46620d7db107-postfull009-20261030T1902Z-001/report/route.json')
    cfg = json.loads(config_path.read_text())
    preflight = {
        'docker_cli_sha256': sha('/usr/bin/docker'),
        'context': docker('context', 'show'),
        'daemon_id': docker('info', '--format', '{{.ID}}'),
        'image_id': docker('image', 'inspect', 'freshell-sandbox:latest', '--format', '{{.Id}}'),
        'context_environment': {k: os.environ.get(k) for k in ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']},
        'configured_backends': {k: os.environ.get(k) for k in ['FRESHELL_VITEST_BACKEND', 'FRESHELL_E2E_BACKEND']},
        'compiler_route_config': str(config_path),
        'compiler_route_config_sha256': sha(config_path),
    }
    assert preflight['docker_cli_sha256'] == cfg['realDockerCliSha256']
    assert preflight['context'] == cfg['dockerContext']
    assert preflight['daemon_id'] == cfg['dockerDaemonId']
    assert preflight['image_id'] == cfg['sandboxImageId']
    assert preflight['context_environment'] == cfg['contextEnvironment']
    assert preflight['configured_backends'] == {'FRESHELL_VITEST_BACKEND': 'cloud', 'FRESHELL_E2E_BACKEND': 'cloud'}
    assert os.environ.get('GCLOUD_IDENT') == 'gcloud-robot@misc-puttering-project.iam.gserviceaccount.com'
    for key in proxy_keys:
        if env.pop(key, None) is not None:
            removed.append(key)
    env.update(GCLOUD_ROBOT_REQUIRE='1', FRESHELL_RUST_TEST_SANDBOX='1',
               GCLOUD_ROBOT_ACCOUNT='gcloud-robot@misc-puttering-project.iam.gserviceaccount.com',
               FRESHELL_TEST_SUMMARY='Complete Freshcodex verification')
    command = ['pnpm', 'exec', 'tsx', str(driver)]
    exact_command = "GCLOUD_ROBOT_REQUIRE=1 FRESHELL_RUST_TEST_SANDBOX=1 FRESHELL_TEST_SUMMARY='Complete Freshcodex verification' pnpm run check"
else:
    driver = L / 'run-final-clippy.py'
    command = ['python3', str(driver)]
    exact_command = 'cargo fmt --all -- --check; cargo clippy --locked --workspace --exclude freshell-tauri --all-targets -- -D warnings (actual1.96 owned strict sandbox)'

disk = os.statvfs(W)
available = disk.f_bavail * disk.f_frsize
D.mkdir(exist_ok=True)
assert not (D / 'invocation.json').exists(), 'Recover/adopt the existing invocation; do not duplicate it'
record = {
    'head': args.head, 'mode': args.mode, 'started_at': now(), 'command': exact_command,
    'launcher_command': command, 'driver': str(driver), 'driver_sha256': sha(driver),
    'source_clean': True, 'implementation_owner_released': True, 'versions': versions,
    'available_bytes_at_preflight': available, 'route_preflight': preflight,
    'private_child_proxy_keys_omitted': removed, 'global_environment_configuration_unchanged': True,
    'log': str(D / 'check.log'), 'completion': str(D / 'completion.json'),
    'source_mutator': 'NONE; frozen through original wrapper and owned resource join',
    'trigger': 'Canonical Task010 final verification before independent task review; exact-HEAD gate may satisfy final/periodic obligation if unchanged',
}
(D / 'invocation.json').write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps({'started_at': record['started_at'], 'mode': args.mode, 'head': args.head, 'log': record['log']}), flush=True)
with (D / 'check.log').open('x') as output:
    result = subprocess.run(command, cwd=W, env=env, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT)
completion = {
    'head': args.head, 'finished_at': now(), 'exit_code': result.returncode,
    'final_head': git('rev-parse', 'HEAD'), 'final_status': git('status', '--porcelain'),
    'log': str(D / 'check.log'), 'log_sha256': sha(D / 'check.log'),
    'driver': str(driver), 'driver_sha256': sha(driver),
    'private_child_proxy_keys_omitted': removed, 'global_environment_configuration_unchanged': True,
}
(D / 'completion.json').write_text(json.dumps(completion, indent=2) + '\n')
print(json.dumps(completion), flush=True)
raise SystemExit(result.returncode)
