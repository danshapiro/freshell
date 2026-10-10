#!/usr/bin/env python3
"""Settle one strict sandbox when its attached owner is forcibly killed."""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time


def identity(pid):
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rpartition(") ")[2].split()
        return None if fields[0] == "Z" else fields[19]
    except FileNotFoundError:
        return None


def record(control, name, value):
    temporary = control / (name + ".tmp")
    temporary.write_text(json.dumps(value) + "\n")
    temporary.replace(control / name)


def join(control):
    guard = json.loads((control / "owner-guard.json").read_text())
    deadline = time.monotonic() + 5
    while identity(guard["pid"]) == guard["identity"]:
        if time.monotonic() >= deadline:
            return 1
        time.sleep(0.025)
    try:
        done = json.loads((control / "owner-guard.done").read_text())
    except (OSError, ValueError):
        return 1
    return 0 if done.get("code") == 0 else 1


def watch(control, owner, owner_identity, wrapper):
    # Reparent before reporting readiness, so a phase-tree snapshot cannot
    # include the guard as a descendant of the attached wrapper.
    os.setsid()
    if os.fork():
        os._exit(0)
    with open(os.devnull, "rb+") as null:
        for descriptor in (0, 1, 2):
            os.dup2(null.fileno(), descriptor)
    record(control, "owner-guard.json", {"pid": os.getpid(), "identity": identity(os.getpid())})
    while identity(owner) == owner_identity:
        if (control / "owner.released").exists():
            record(control, "owner-guard.done", {"severity": "info", "event": "sandbox_owner_guard_finished", "code": 0})
            return
        time.sleep(0.1)
    # No caller command or provider stream enters this cleanup invocation.
    # Reuse the wrapper's exact CID/name checks, including unpublished IDs.
    with (control / "owner-guard.log").open("wb") as log:
        child = subprocess.Popen(["bash", wrapper, "--settle-owned", str(control)], stdout=log, stderr=log, start_new_session=True)
        try:
            code = child.wait(timeout=120)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
            code = 1
    record(control, "owner-guard.done", {"severity": "info" if code == 0 else "error", "event": "sandbox_owner_guard_settled" if code == 0 else "sandbox_owned_container_unsettled", "code": code})
    if code == 0:
        shutil.rmtree(control)


def main():
    if sys.argv[1] == "--join":
        return join(Path(sys.argv[2]))
    control, owner, wrapper = Path(sys.argv[1]), int(sys.argv[2]), os.path.abspath(sys.argv[3])
    owner_identity = identity(owner)
    if owner_identity is None:
        return 1
    child = os.fork()
    if child == 0:
        try:
            watch(control, owner, owner_identity, wrapper)
        except Exception as cause:
            if control.exists():
                record(control, "owner-guard.done", {"severity": "error", "event": "sandbox_owner_guard_failed", "code": 1, "cause": type(cause).__name__})
            os._exit(1)
        os._exit(0)
    _, status = os.waitpid(child, 0)
    if status != 0:
        return 1
    deadline = time.monotonic() + 5
    while not (control / "owner-guard.json").exists():
        if time.monotonic() >= deadline:
            return 1
        time.sleep(0.01)
    print(json.loads((control / "owner-guard.json").read_text())["pid"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
