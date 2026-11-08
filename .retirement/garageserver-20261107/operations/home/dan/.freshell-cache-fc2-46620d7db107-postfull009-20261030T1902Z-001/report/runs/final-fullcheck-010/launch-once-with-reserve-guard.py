"""Actual admitted outer startup guard; preserves canonical Python argv."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib, json, os

D = Path(__file__).resolve().parent
A = D / 'root-execution-admission.json'
assert hashlib.sha256(A.read_bytes()).hexdigest() == 'ac1c69027f501c3a78fb0432bb5d953a8c8337d6bb2c431103bd3ccf8df7b3fd'
auth = json.loads(A.read_text())
assert auth['head'] == '6e7c2641bb0d9113127e93bb57ab0958265b3813'
assert not (D / 'invocation.json').exists(), 'Join the original; never launch another'
observer = json.loads((D / 'observer-start.json').read_text())
assert observer['pid'] == 25116
fields = (Path('/proc') / str(observer['pid']) / 'stat').read_text().rpartition(') ')[2].split()
assert fields[0] != 'Z'
latest = json.loads((D / 'space.jsonl').read_text().splitlines()[-1])
age = (datetime.now(timezone.utc) - datetime.fromisoformat(latest['at'])).total_seconds()
assert age < 3 and not (D / 'capacity-cancellation.json').exists()
space = {}
for name, path in [('/', '/'), ('/home', auth['worktree'])]:
    fs = os.statvfs(path)
    row = dict(path=path, device=os.stat(path).st_dev, available_bytes=fs.f_bavail * fs.f_frsize,
               free_inodes=fs.f_favail, total_inodes=fs.f_files)
    assert row['available_bytes'] >= auth['initial_minimum_bytes'][name]
    assert row['free_inodes'] > auth['available_inode_floor']
    space[name] = row
with (D / 'immediate-launch-reserve-check.json').open('x') as output:
    output.write(json.dumps(dict(at=datetime.now(timezone.utc).isoformat(), head=auth['head'], space=space,
        observer_pid=observer['pid'], observer_start_identity=fields[19], observer_ready_before_launch=True,
        latest_observer_sample_age_seconds=age, canonical_python_argv=auth['command'],
        outer_launcher=['setsid', '--wait'], no_canonical_mutation=True), indent=2) + '\n')
os.environ.pop('CARGO_TARGET_DIR', None)
os.environ.pop('TMPDIR', None)
os.environ.update(GCLOUD_ROBOT_REQUIRE='1', FRESHELL_RUST_TEST_SANDBOX='1',
    GCLOUD_ROBOT_ACCOUNT='gcloud-robot@misc-puttering-project.iam.gserviceaccount.com',
    GCLOUD_IDENT='gcloud-robot@misc-puttering-project.iam.gserviceaccount.com')
os.execvp('setsid', ['setsid', '--wait', *auth['command']])
