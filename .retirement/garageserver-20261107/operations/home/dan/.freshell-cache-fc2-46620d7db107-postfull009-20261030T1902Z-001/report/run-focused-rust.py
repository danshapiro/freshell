#!/usr/bin/env python3
"""Run a package-selected Rust test in this run's disposable runtime sandbox."""
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys

repo = Path("/home/dan/code/freshell/.worktrees/freshcodex-complete")
args = sys.argv[1:]
if not args or args == ["--help"]:
    print("usage: run-focused-rust.py [--build-server] [--checkpoint-fixture] -p PACKAGE [cargo test selectors/options]")
    raise SystemExit(0 if args else 2)
build_server = False
checkpoint_fixture = False
while args and args[0] in {"--build-server", "--checkpoint-fixture"}:
    build_server |= args[0] == "--build-server"
    checkpoint_fixture |= args[0] == "--checkpoint-fixture"
    args = args[1:]
if "--workspace" in args or not any(arg in {"-p", "--package"} or arg.startswith("--package=") for arg in args):
    raise SystemExit("A focused package selector is required; use the standard coordinated gate for workspace tests.")
target = "/freshell-test-artifacts"
toolchain_receipt = repo.parent / ".the-usual-logs/freshcodex-complete/reports/periodic-gate-004-fix-001-owned-toolchain.json"
toolchain = Path(json.loads(toolchain_receipt.read_text())["stage"])
if not toolchain.is_relative_to(repo / ".runtime-build"):
    raise SystemExit("Strict compiler must be this run's owned worktree artifact.")
container_toolchain = Path("/workspace") / toolchain.relative_to(repo)
body = """set -eu
owned_exec_tmp="$(mktemp -d /freshell-test-artifacts/.freshcodex-exec-XXXXXXXX)"
owned_runtime_tmp="$(mktemp -d /freshell-test-artifacts/XXX)"
cleanup() {
  status=$?
  trap - EXIT
  rm -rf -- "$owned_exec_tmp" "$owned_runtime_tmp"
  exit "$status"
}
trap cleanup EXIT
export FRESHELL_RUST_TEST_SANDBOX=0 CARGO_BUILD_JOBS=3 RUST_TEST_THREADS=4 TOKIO_WORKER_THREADS=2
export TMPDIR="$owned_runtime_tmp" FRESHELL_TEST_EXECUTABLE_TMP_DIR="$owned_exec_tmp"
"""
body += "export CARGO_TARGET_DIR=" + shlex.quote(target) + "\n"
body += "export FRESHELL_SERVER_BIN=" + shlex.quote(target + "/debug/freshell-server") + "\n"
body += "export PATH=" + shlex.quote(str(container_toolchain / "bin")) + ':"$PATH"\n'
for name, binary in [("RUSTC", "rustc"), ("RUSTDOC", "rustdoc"), ("CARGO", "cargo")]:
    body += "export " + name + "=" + shlex.quote(str(container_toolchain / "bin" / binary)) + "\n"
body += "export RUSTUP_TOOLCHAIN=1.96.0\n"
for name in ["rustc", "cargo", "rustdoc"]:
    body += name + ' --version | grep -E "^' + name + ' 1[.]96[.]0 "\n'
body += "rustc --print sysroot\n"
if build_server:
    feature_args = []
    for index, arg in enumerate(args):
        if arg == "--features":
            feature_args.extend([arg, args[index + 1]])
        elif arg.startswith("--features=") or arg == "--no-default-features":
            feature_args.append(arg)
    body += shlex.join(["cargo", "build", "-p", "freshell-server", "--locked", *feature_args]) + "\n"
body += shlex.join(["cargo", "test", "--locked", *args]) + "\n"
env = os.environ.copy()
env["FRESHELL_SANDBOX_OWNER_GUARD"] = "1"
env["PATH"] = '/home/dan/.freshell-cache-fc2-46620d7db107-postfull009-20261030T1902Z-001/report/generic-cli' + ":" + env["PATH"]
env["FRESHELL_OWNED_COMPILER_ROUTE_CONFIG"] = '/home/dan/.freshell-cache-fc2-46620d7db107-postfull009-20261030T1902Z-001/report/route.json'
env["FRESHELL_OWNED_COMPILER_ROUTE_EVENTS"] = '/home/dan/.freshell-cache-fc2-46620d7db107-postfull009-20261030T1902Z-001/report/focused-compiler-events.jsonl'
wrapper_args = [str(repo / "scripts/sandbox-test.sh"), "--runtime-suite"]
if checkpoint_fixture:
    wrapper_args.append("--checkpoint-fixture")
raise SystemExit(subprocess.run([*wrapper_args, body], cwd=repo, env=env).returncode)
