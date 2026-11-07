#!/usr/bin/env python3
"""Actual shell lifecycle only; the nine Docker proofs are omitted, unclaimed.

Called by sandbox-selftest-sentinel.sandbox.ts inside the disposable sandbox.
Uses real GNU sleep and a real 301-second wait, with no timing substitutions.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import select
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
import urllib.request


SOURCE = Path('/workspace/scripts/sandbox-selftest.sh')
MARKER = 'freshell-server-sandbox-host-sentinel'
UNIT = ''
RESULTS = None


def region(source, start, end):
    # Import boundaries, not assertions about implementation text. A refactor
    # must explicitly rebind this fixture rather than silently import less.
    if source.count(start) != 1 or source.count(end) != 1:
        raise ValueError('production lifecycle import boundary changed')
    return start + source.split(start, 1)[1].split(end, 1)[0]


def lifecycle_unit(source):
    options = region(source, 'set -euo pipefail\n', '\nREPO_ROOT=')
    verdict_state = region(source, 'FAILED=0\n', 'echo "=== freshell-sandbox isolation self-test ==="\n')
    setup = region(source, 'HOST_PID_SENTINEL_PID=""\n', '\nBEFORE_3001=')
    http = region(source, 'FINAL_SENTINEL_HTTP="$(host_port_sentinel)"\n', 'echo "=== final host isolation ==="\n')
    final = 'if host_pid_sentinel_alive && [ "${FINAL_SENTINEL_HTTP}" = "host-sandbox-sentinel" ]; then\n'
    if source.count(final) != 1:
        raise ValueError('production final-verdict import boundary changed')
    barrier = r'''
host_pid_sentinel_alive
[ "$(host_port_sentinel)" = "host-sandbox-sentinel" ]
printf '%s\n' "${HOST_PID_SENTINEL_PID}" "${HOST_PORT_SENTINEL_PID}" "${HOST_PORT_FILE}" > "${SENTINEL_CASE_INFO}"
IFS= read -r disposition
if [ "${disposition}" = abort ]; then exit 17; fi
'''
    return options + verdict_state + setup + barrier + http + final + source.split(final, 1)[1]


def identity(pid):
    try:
        fields = Path(f'/proc/{pid}/stat').read_text().rpartition(') ')[2].split()
        return int(fields[1]), fields[19]  # PPID, birth ticks; survives reparenting.
    except FileNotFoundError:
        return None


def capture(pid, owner, handles):
    if pid in handles:
        return
    before = identity(pid)
    if before is None or before[0] != owner.pid:
        raise ProcessLookupError('sentinel is no longer a direct owned child')
    fd = os.pidfd_open(pid)
    if identity(pid) != before:
        os.close(fd)
        raise ProcessLookupError('owned child changed during pidfd acquisition')
    handles[pid] = (before, fd)


def exited(fd):
    poll = select.poll()
    poll.register(fd, select.POLLIN)
    return bool(poll.poll(0))


class SentinelLifecycle(unittest.TestCase):
    def lifecycle(self, expected, delay=0, damage=None, abort=False):
        result = RESULTS / self._testMethodName
        result.mkdir()
        evidence = {'scope': 'sentinel lifecycle only; nine proofs omitted', 'expected_exit': expected}
        owner = witness = None
        handles = {}
        output = error = ''
        scratch = Path(os.environ.get('FRESHELL_SENTINEL_TMP_DIR', '/workspace/.test-tmp')).resolve()
        self.assertTrue(scratch.is_relative_to(Path('/workspace/.test-tmp')), 'temporary root escaped .test-tmp')
        scratch.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='sentinel-', dir=scratch) as directory:
            fixture = Path(directory)
            (result / 'fixture.path').write_text(directory + '\n')
            script = fixture / 'lifecycle.sh'
            script.write_text(UNIT)
            (result / 'lifecycle.sh').write_text(UNIT)
            info_file = fixture / 'owned-processes'
            # No inherited BASH_ENV, proxy, provider, token or operator settings.
            env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'LC_ALL': 'C',
                   'HOME': directory, 'TMPDIR': directory, 'SENTINEL_CASE_INFO': str(info_file)}
            try:
                witness = subprocess.Popen(
                    ['bash', '-c', f'exec -a {MARKER} sleep infinity'], env=env,
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                owner = subprocess.Popen(['bash', str(script)], env=env, text=True,
                                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                deadline = time.monotonic() + 45
                info = []
                while time.monotonic() < deadline:
                    if info_file.exists():
                        info = info_file.read_text().splitlines()
                        if len(info) == 3:
                            break
                    if owner.poll() is not None:
                        output, error = owner.communicate()
                        self.fail(f'production setup exited before initial healthy check: {output}\n{error}')
                    time.sleep(.02)
                self.assertEqual(len(info), 3, 'production setup never reached healthy barrier')
                pids = [int(value) for value in info[:2]]
                for pid in pids:
                    capture(pid, owner, handles)
                self.assertEqual(Path(f'/proc/{pids[0]}/exe').resolve(), Path(shutil.which('sleep')).resolve())
                argv = Path(f'/proc/{pids[0]}/cmdline').read_bytes().split(b'\0')
                self.assertEqual(argv[0].decode(), MARKER)
                port_file = Path(info[2])
                self.assertEqual(port_file.parent, fixture)
                port = int(port_file.read_text())
                client = urllib.request.build_opener(urllib.request.ProxyHandler({}))

                def observe():
                    try:
                        with client.open(f'http://127.0.0.1:{port}/', timeout=3) as response:
                            http = response.read().decode()
                    except OSError:
                        http = None
                    return {'process_alive': not exited(handles[pids[0]][1]),
                            'listener_alive': not exited(handles[pids[1]][1]), 'http': http}

                evidence.update(pids=pids, births=[handles[pid][0][1] for pid in pids],
                                process_argv=[arg.decode() for arg in argv if arg], initial=observe())
                self.assertEqual(evidence['initial'], {'process_alive': True, 'listener_alive': True,
                                                       'http': 'host-sandbox-sentinel'})
                self.assertIsNone(witness.poll(), 'same-name foreign child exited')
                self.assertEqual(Path(f'/proc/{witness.pid}/exe').resolve(), Path(shutil.which('sleep')).resolve())
                self.assertEqual(Path(f'/proc/{witness.pid}/cmdline').read_bytes().split(b'\0')[0].decode(), MARKER)
                started = time.monotonic()
                if delay:
                    time.sleep(delay)
                evidence['elapsed_seconds'] = time.monotonic() - started
                self.assertGreaterEqual(evidence['elapsed_seconds'], delay)
                if damage is not None:
                    fd = handles[pids[damage]][1]
                    signal.pidfd_send_signal(fd, signal.SIGTERM)
                    death = select.poll()
                    death.register(fd, select.POLLIN)
                    self.assertTrue(death.poll(5000), 'killed owned sentinel did not exit')
                evidence['final'] = observe()
                if damage == 1:
                    self.assertTrue(evidence['final']['process_alive'])
                    self.assertFalse(evidence['final']['listener_alive'])
                    self.assertIsNone(evidence['final']['http'])
                else:
                    self.assertTrue(evidence['final']['listener_alive'])
                    self.assertEqual(evidence['final']['http'], 'host-sandbox-sentinel')
                if damage == 0:
                    self.assertFalse(evidence['final']['process_alive'])
                output, error = owner.communicate(input='abort\n' if abort else 'continue\n', timeout=20)
                evidence['actual_exit'] = owner.returncode
                # Before emergency teardown: only production EXIT can pass this.
                for pid, (birth, fd) in handles.items():
                    current = identity(pid)
                    self.assertTrue(exited(fd))
                    self.assertTrue(current is None or current[1] != birth[1], 'owned child or zombie survived EXIT')
                self.assertFalse(port_file.exists(), 'production EXIT left its temporary file')
                self.assertIsNone(witness.poll(), 'production cleanup killed same-name foreign child')
                evidence['cleanup_verified'] = True
                self.assertEqual(owner.returncode, expected, output + error)
                if expected == 1:
                    self.assertIn('FAIL: self-owned host sentinel changed:', output)
                    self.assertIn('=== ONE OR MORE PROOFS FAILED ===', output)
                if expected == 0:
                    self.assertIn('PASS: both exact host sentinels', output)
                    self.assertIn('=== ALL PROOFS PASSED ===', output)
                if abort:
                    self.assertNotIn('=== ALL PROOFS PASSED ===', output)
            finally:
                # Abort asks the actual owning shell to take its normal EXIT.
                # Exceptional setup can precede PID publication; capture only
                # this Popen shell's direct children before any emergency kill.
                try:
                    if owner is not None and owner.poll() is None:
                        try:
                            output, error = owner.communicate(input='abort\n', timeout=20)
                        except (subprocess.TimeoutExpired, ValueError, BrokenPipeError):
                            try:
                                children = Path(f'/proc/{owner.pid}/task/{owner.pid}/children').read_text().split()
                            except FileNotFoundError:
                                children = []
                            for child in children:
                                try:
                                    capture(int(child), owner, handles)
                                except ProcessLookupError:
                                    pass
                            owner.kill()
                            output, error = owner.communicate(timeout=5)
                finally:
                    try:
                        for _pid, (_birth, fd) in handles.items():
                            try:
                                if not exited(fd):
                                    signal.pidfd_send_signal(fd, signal.SIGKILL)
                            except ProcessLookupError:
                                pass
                            finally:
                                os.close(fd)
                    finally:
                        try:
                            if witness is not None:
                                if witness.poll() is None:
                                    witness.kill()
                                witness.wait(timeout=5)
                        finally:
                            (result / 'stdout.txt').write_text(output)
                            (result / 'stderr.txt').write_text(error)
                            (result / 'evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')

    def test_outlives_300_seconds(self):
        self.lifecycle(expected=0, delay=301)

    def test_normal_exit(self):
        self.lifecycle(expected=0)

    def test_killed_process(self):
        self.lifecycle(expected=1, damage=0)

    def test_killed_listener(self):
        self.lifecycle(expected=1, damage=1)

    def test_early_exit(self):
        self.lifecycle(expected=17, abort=True)


def main():
    global UNIT, RESULTS
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--results', required=True, type=Path)
    parser.add_argument('--source-sha256')  # Optional snapshot binding, no whitelist.
    args, tests = parser.parse_known_args()
    if (os.geteuid() == 0 or Path.cwd() != Path('/workspace') or not Path('/.dockerenv').is_file()
            or os.environ.get('FRESHELL_SANDBOX_MODE') != 'runtime-suite'
            or os.environ.get('FRESHELL_VITEST_BACKEND') == 'cloud' or os.environ.get('TEST_MODE') == 'vitest'):
        parser.error('requires non-root scripts/sandbox-test.sh --runtime-suite; refuses ordinary Vitest/cloud')
    if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        parser.error('Linux Python pidfds required; no unsafe fallback')
    RESULTS = args.results.resolve()
    if not RESULTS.is_relative_to(Path('/workspace/test-results')):
        parser.error('results must be below /workspace/test-results')
    RESULTS.mkdir(parents=True, exist_ok=True)
    data = SOURCE.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    (RESULTS / 'source.sha256').write_text(digest + '\n')
    if args.source_sha256 is not None and args.source_sha256 != digest:
        parser.error('caller snapshot changed; review the current source before rebinding')
    UNIT = lifecycle_unit(data.decode())
    print(json.dumps({'severity': 'info', 'event': 'sentinel_lifecycle_source', 'sha256': digest,
                      'scope': 'sentinel lifecycle only; nine proofs omitted'}), flush=True)
    unittest.main(argv=[str(Path(__file__)), *tests], verbosity=2)


if __name__ == '__main__':
    main()
