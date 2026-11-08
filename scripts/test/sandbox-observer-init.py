#!/usr/bin/env python3
"""Check the observer's real container-init relationship without host access."""
import json
import os
from pathlib import Path
import time


def stat(pid):
    fields = Path(f"/proc/{pid}/stat").read_text().rpartition(") ")[2].split()
    return int(fields[1]), fields[19]


def find_observer():
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            args = (entry / "cmdline").read_bytes().split(b"\0")
            if len(args) > 2 and args[1:3] == [b"/run/freshell-sandbox-diagnostics.mjs", b"observe-watch"]:
                return int(entry.name)
        except (OSError, ValueError):
            continue
    return None


checks = {name: False for name in (
    "unprivileged", "container_init", "observer_adopted", "same_pid_namespace",
    "observer_stdin_closed", "proc_readable", "caller_has_no_children", "child_wait",
)}
stage = "setup"
try:
    checks["unprivileged"] = os.getuid() != 0
    checks["container_init"] = Path("/proc/1/comm").read_text().strip() in {"docker-init", "tini"} and os.getppid() == 1
    deadline = time.monotonic() + 3
    observer = None
    while observer is None and time.monotonic() < deadline:
        observer = find_observer()
        if observer is None:
            time.sleep(0.05)
    if observer is not None:
        stage = "observer_stat"
        before = stat(observer)
        stage = "namespace"
        checks["same_pid_namespace"] = (
            os.readlink("/proc/self/ns/pid") == os.readlink(f"/proc/{observer}/ns/pid")
        )
        stage = "stdin"
        checks["observer_stdin_closed"] = os.readlink(f"/proc/{observer}/fd/0") == "/dev/null"
        stage = "environ"
        with open(f"/proc/{observer}/environ", "rb") as environ:
            environ.read(1)  # Discarded; no environment data is logged.
        checks["proc_readable"] = True
        checks["observer_adopted"] = before[0] == 1 and stat(observer) == before
    stage = "child_wait"
    try:
        os.waitpid(-1, os.WNOHANG)
    except ChildProcessError:
        checks["caller_has_no_children"] = True
    child = os.fork()
    if child == 0:
        os._exit(0)
    waited, status = os.waitpid(-1, 0)
    checks["child_wait"] = waited == child and status == 0
    stage = "done"
except (OSError, ValueError, IndexError):
    pass

passed = all(checks.values())
print(json.dumps({"severity": "info" if passed else "error", "event": "sandbox_observer_init_probe", "stage": stage, **checks}))
raise SystemExit(0 if passed else 1)
