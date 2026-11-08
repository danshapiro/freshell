"""Deferred three-case real UID consumer smoke. STAGED ONLY; never run unadmitted."""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time
import uuid
sys.dont_write_bytecode = True
from cleanup_binding import BINARY, PROBE, GID, OWNERSHIP_ENV, PREFIX, UID, decode, helper_argv

DEADLINE = 30
HERE = Path(__file__).resolve().parent
EVIDENCE = Path('/evidence')
OBSERVATIONS = 0


def digest(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def stat(pid):
    try:
        fields = Path(f'/proc/{pid}/stat').read_text().rpartition(') ')[2].split()
    except FileNotFoundError:
        return None
    return dict(pid=pid, start=int(fields[19]), state=fields[0], ppid=int(fields[1]),
                pgid=int(fields[2]), sid=int(fields[3]))


def status(pid):
    fields = dict(line.split(':', 1) for line in Path(f'/proc/{pid}/status').read_text().splitlines() if ':' in line)
    return dict(uids=[int(x) for x in fields['Uid'].split()], gids=[int(x) for x in fields['Gid'].split()],
                caps={key: fields[key].strip() for key in ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']},
                nnp=int(fields['NoNewPrivs']))


def native_status(value):
    assert value['uids'] == [UID] * 4 and value['gids'] == [GID] * 4
    assert value['nnp'] == 1
    assert all(int(value['caps'][key], 16) == 0 for key in ['CapEff', 'CapPrm', 'CapInh', 'CapAmb'])


def emit(value):
    raw = json.dumps(value, separators=(',', ':')).encode() + b'\n'
    assert len(raw) < 4096
    assert os.write(1, raw) == len(raw)


def ready(role):
    native_status(status(os.getpid()))
    emit(dict(event='ready', role=role, dumpable=ctypes.CDLL(None).prctl(3, 0, 0, 0, 0), **stat(os.getpid())))


def writer():
    """Only controlled native writers carry the ownership tag."""
    assert os.environ.get(OWNERSHIP_ENV, '').startswith('codex-sidecar-')
    signals = []
    control = int(os.environ['FIXTURE_CONTROL_FD'])
    ready('root')
    for line in sys.stdin.buffer:
        command = line.strip()
        if command == b'fork':
            pid = os.fork()
            if pid == 0:
                for number in [signal.SIGTERM, signal.SIGINT, signal.SIGHUP]:
                    signal.signal(number, lambda received, frame: signals.append(received))
                ready('later')
                while True:
                    operation = os.read(control, 1)
                    if operation == b'H':
                        assert ctypes.CDLL(None).prctl(4, 0, 0, 0, 0) == 0
                        emit(dict(event='hidden', **stat(os.getpid())))
                    elif operation == b'P':
                        emit(dict(event='heartbeat', signals=signals, **stat(os.getpid())))
                    elif operation == b'X':
                        os._exit(0)
                    else:
                        raise AssertionError('owned control pipe unexpectedly closed')
            emit(dict(event='forked', pid=pid))
        elif command == b'negative-control':
            for number in [signal.SIGTERM, signal.SIGINT, signal.SIGHUP]:
                signal.signal(number, lambda received, frame: signals.append(received))
            emit(dict(event='armed', **stat(os.getpid())))
        elif command == b'ping':
            emit(dict(event='heartbeat', signals=signals, **stat(os.getpid())))
        elif command == b'exit':
            return
        else:
            raise AssertionError('Unknown finite writer operation')
    raise AssertionError('Writer input closed before owned completion')


def peer():
    """Observe the actual target at its native UID, never carry a writer tag."""
    native_status(status(os.getpid()))
    assert OWNERSHIP_ENV not in os.environ
    request = json.load(sys.stdin)
    pid, expected = request['pid'], request['start']
    deadline = time.monotonic() + 5
    while True:
        before = stat(pid)
        assert before and before['start'] == expected and before['state'] not in ['Z', 'X']
        if request['kind'] == 'helper':
            try:
                executable = os.readlink(f'/proc/{pid}/exe')
                if executable != BINARY:
                    assert time.monotonic() < deadline, 'Actual helper exec was not observed'
                    os.sched_yield()
                    continue
                with open(f'/proc/{pid}/exe', 'rb') as stream:
                    actual_inode = os.fstat(stream.fileno())
                    actual_hash = hashlib.file_digest(stream, 'sha256').hexdigest()
                bound_inode = os.stat(BINARY)
                assert (actual_inode.st_dev, actual_inode.st_ino) == (bound_inode.st_dev, bound_inode.st_ino)
                assert actual_hash == request['binarySha256']
                argv = Path(f'/proc/{pid}/cmdline').read_bytes()
                assert argv.split(b'\0')[:-1] == [part.encode() for part in helper_argv()[len(PREFIX):]]
                environment = Path(f'/proc/{pid}/environ').read_bytes()
                assert not any(part.startswith(OWNERSHIP_ENV.encode() + b'=') for part in environment.split(b'\0'))
            except PermissionError:
                assert time.monotonic() < deadline, 'Actual native helper exe proof unavailable'
                os.sched_yield()
                continue
            identity = status(pid)
            native_status(identity)
            extra = dict(exe=executable, binarySha256=actual_hash,
                         executableDevice=actual_inode.st_dev, executableInode=actual_inode.st_ino,
                         commandSha256=hashlib.sha256(argv).hexdigest())
        else:
            identity = status(pid)
            native_status(identity)
            try:
                environment = Path(f'/proc/{pid}/environ').read_bytes()
                readable = True
            except PermissionError:
                environment, readable = b'', False
            if request['kind'] == 'hidden':
                assert not readable, 'The real known member was not hidden from the native fresh read'
            else:
                assert readable and (OWNERSHIP_ENV + '=' + request['tag']).encode() in environment.split(b'\0')
            extra = dict(ownershipEnvironmentReadable=readable)
        after = stat(pid)
        assert after and after['start'] == expected and after['state'] not in ['Z', 'X']
        emit(dict(**after, identity=identity, observerIdentity=status(os.getpid()), **extra))
        return


def put(name, value):
    raw = value if isinstance(value, bytes) else json.dumps(value, indent=2).encode() + b'\n'
    path = EVIDENCE / name
    with path.open('xb') as output:
        output.write(raw)
    return dict(path=path.name, sha256=hashlib.sha256(raw).hexdigest(), bytes=len(raw))


def event(process, wanted):
    deadline = time.monotonic() + DEADLINE
    while True:
        remaining = deadline - time.monotonic()
        assert remaining > 0 and select.select([process.stdout], [], [], remaining)[0], 'Writer readiness deadline'
        raw = process.stdout.readline()
        assert raw and len(raw) < 4096, 'Writer ended before readiness'
        row = json.loads(raw)
        with (EVIDENCE / 'writer-events.jsonl').open('ab') as output:
            output.write(json.dumps(row).encode() + b'\n')
        if row['event'] == wanted:
            return row


def command(process, value):
    process.stdin.write(value.encode() + b'\n')
    process.stdin.flush()


def observe(pid, start, kind, **extra):
    global OBSERVATIONS
    OBSERVATIONS += 1
    request = dict(pid=pid, start=start, kind=kind, **extra)
    put(f'peer-{OBSERVATIONS:03}-request.json', request)
    try:
        result = subprocess.run([*PREFIX, '/usr/bin/python3', str(HERE / 'container-driver.py'), '--peer'],
                                input=json.dumps(request).encode(), capture_output=True, env=clean_env(), timeout=8)
    except subprocess.TimeoutExpired as error:
        put(f'peer-{OBSERVATIONS:03}.stdout', error.stdout or b'')
        put(f'peer-{OBSERVATIONS:03}.stderr', error.stderr or b'')
        raise
    put(f'peer-{OBSERVATIONS:03}.stdout', result.stdout)
    put(f'peer-{OBSERVATIONS:03}.stderr', result.stderr)
    assert result.returncode == 0, 'Native peer observation failed; actual output retained privately'
    return json.loads(result.stdout)


def clean_env(tag=None):
    env = dict(PATH='/usr/local/bin:/usr/bin:/bin', LANG='C.UTF-8', HOME='/tmp/uid-qualification/home', TMPDIR='/tmp/uid-qualification/tmp')
    if tag is not None:
        env[OWNERSHIP_ENV] = tag
    return env


def reap(process, members, exits):
    if process is not None:
        process.poll()
    for row in members:
        if process is not None and row['pid'] == process.pid:
            continue
        current = stat(row['pid'])
        assert current is None or current['start'] == row['start'], 'Owned fixture PID was reused'
        try:
            pid, result = os.waitpid(row['pid'], os.WNOHANG)
            if pid:
                exits[str(pid)] = result
        except ChildProcessError:
            pass  # Still owned by its real native parent, or already reaped there.


def consume(case, payload, process, members, binary_sha):
    input_receipt = put(case + '-original-input.json', payload)
    helper = subprocess.Popen(helper_argv(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, env=clean_env(), bufsize=0)
    output, error, exits = bytearray(), bytearray(), {}
    delivered, joined = False, False
    try:
        start = stat(helper.pid)
        assert start, 'Helper was too short-lived to establish an identity'
        witness = observe(helper.pid, start['start'], 'helper', binarySha256=binary_sha)
        assert helper.poll() is None
        put(case + '-actual-helper-witness.json', witness)
        helper.stdin.write(payload)
        helper.stdin.close()
        delivered = True
        streams = {helper.stdout.fileno(): output, helper.stderr.fileno(): error}
        deadline = time.monotonic() + DEADLINE
        while streams or helper.poll() is None:
            reap(process, members, exits)
            remaining = deadline - time.monotonic()
            assert remaining > 0, 'Actual cleanup helper exceeded admitted case deadline'
            readable, _, _ = select.select(list(streams), [], [], min(remaining, .05))
            for descriptor in readable:
                block = os.read(descriptor, 65536)
                if block:
                    streams[descriptor].extend(block)
                    assert len(streams[descriptor]) <= 1024 * 1024, 'Unexpected helper output bound'
                else:
                    del streams[descriptor]
        helper.wait()
        joined = True
        reap(process, members, exits)
    finally:
        if not delivered:
            helper.stdin.close()
            try:
                helper.wait(timeout=2)  # Empty input reports a real parser failure, never a false success.
                joined = True
                output.extend(helper.stdout.read())
                error.extend(helper.stderr.read())
            except subprocess.TimeoutExpired:
                pass  # Failed/unjoined is retained; exact container closure settles it.
        stdout_receipt = put(case + '-helper.stdout', bytes(output))
        stderr_receipt = put(case + '-helper.stderr', bytes(error))
        put(case + '-helper-join.json', dict(pid=helper.pid, joined_normally=joined, exit_code=helper.poll(), payload_delivered=delivered))
    assert helper.returncode == 0, 'Actual cleanup CLI returned nonzero'
    return dict(confirmed=decode(output), originalInput=input_receipt,
                stdout=stdout_receipt, stderr=stderr_receipt,
                actualHelper=witness, helperExit=helper.returncode, descendantWaitStatuses=exits)




def main():
    os.umask(0o077)
    if sys.argv[1:] == ['--writer']:
        writer()
        return
    if sys.argv[1:] == ['--peer']:
        peer()
        return
    from producer_cases import run
    run(sys.modules[__name__])
    return


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        if sys.argv[1:] not in [['--writer'], ['--peer']]:
            put('consumer-failure.json', dict(status='FAILED', error=repr(error)))
        raise
