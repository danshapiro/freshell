#!/usr/bin/env python3
"""Closed pinned-provider source consumer in an owned rootless container."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import uuid

IMAGE = "sha256:967627e41734aa903e824e4be22849c7f22ce0e69487ce61bb72004c4817f89c"
TEST = "managed_mcp_capability::tests::managed_provider_amplifier_native_local_bundle_survives_transport"
LABEL = "com.freshell.provider-source-probe"


def docker(*args, check=True):
    return subprocess.run(["docker", *args], text=True, capture_output=True,
                          timeout=180, check=check)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--test-binary", type=Path, required=True)
    parser.add_argument("--receipt-dir", type=Path, required=True)
    args = parser.parse_args()
    binary = args.test_binary.resolve(strict=True)
    if not binary.is_file() or not re.fullmatch(r"freshell_server-[0-9a-f]{16}", binary.name):
        raise RuntimeError("source fixture requires its compiled server test artifact")
    expected_directory = Path(__file__).resolve().parents[2] / "target/debug/deps"
    if binary.parent != expected_directory.resolve():
        raise RuntimeError("source fixture test artifact must belong to this worktree")
    listing = subprocess.run([str(binary), "--exact", TEST, "--list"],
                             env={"PATH": "/usr/bin:/bin"}, text=True,
                             capture_output=True, timeout=20, check=True)
    if f"{TEST}: test" not in listing.stdout.splitlines():
        raise RuntimeError("source fixture compiled artifact contains no exact selected test")
    if not args.receipt_dir.is_dir():
        raise RuntimeError("source fixture receipt directory must already exist")
    if "name=rootless" not in json.loads(docker("info", "--format", "{{json .SecurityOptions}}").stdout):
        raise RuntimeError("source fixture requires the qualified rootless daemon")
    if docker("image", "inspect", "--format", "{{.Id}}", IMAGE).stdout.strip() != IMAGE:
        raise RuntimeError("source fixture requires its exact already-present provider image")
    with binary.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    name = "freshell-source-probe-" + uuid.uuid4().hex
    created = False
    receipt = {"image": IMAGE, "testArtifactSha256": digest, "test": TEST,
               "runId": name, "rootless": True}
    try:
        docker("create", "--name", name, "--label", f"{LABEL}={name}",
               "--network", "none", "--read-only", "--user", "65534:0", "--cap-drop", "ALL",
               "--security-opt", "no-new-privileges:true", "--pids-limit", "128", "--memory", "2g",
               "--mount", f"type=bind,src={binary},dst=/runtime/source-consumer-tests,readonly",
               "--tmpfs", "/fixture:rw,exec,nosuid,nodev,size=512m,uid=65534,gid=0,mode=0700",
               "--tmpfs", "/home/freshell/provider:rw,nosuid,nodev,size=512m,uid=65534,gid=0,mode=0700",
               "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=256m,uid=65534,gid=0,mode=0700",
               "--env", "HOME=/home/freshell/provider",
               "--env", "AMPLIFIER_HOME=/home/freshell/provider/.amplifier",
               "--env", "FRESHELL_TEST_EXECUTABLE_TMP_DIR=/fixture",
               "--entrypoint", "/runtime/source-consumer-tests", IMAGE,
               "--exact", TEST, "--nocapture", "--test-threads", "1")
        created = True
        result = docker("start", "--attach", name, check=False)
        receipt["exitCode"] = result.returncode
        cases = []
        for line in result.stdout.splitlines():
            marker = "provider_source_consumer "
            if marker in line:
                value = json.loads(line.split(marker, 1)[1])
                cases.append({"provider": value["provider"], "case": value["case"], "digest": value["digest"]})
        receipt["consumedCases"] = cases
        if result.returncode == 0 and (len(cases) != 18 or "test result: ok. 1 passed;" not in result.stdout):
            receipt["exitCode"] = 2
            receipt["failureClass"] = "native_consumer_count_mismatch"
        # Only the Rust fixture's classified assertion/digest receipt is emitted.
        # The native provider's raw streams stay inside its test process.
        print(result.stdout, end="", flush=True)
        print(result.stderr, end="", flush=True)
    finally:
        observed = docker("container", "inspect", name, check=False)
        if observed.returncode == 0:
            value = json.loads(observed.stdout)[0]
            if value["Config"].get("Labels", {}).get(LABEL) != name:
                raise RuntimeError("source fixture cleanup ownership changed")
            docker("rm", "--force", value["Id"])
        receipt["ownedCleanup"] = docker("container", "inspect", name, check=False).returncode != 0
        (args.receipt_dir / "task002-native-source-consumers.json").write_text(json.dumps(receipt, sort_keys=True) + "\n")
    if not created or not receipt["ownedCleanup"]:
        raise RuntimeError("source fixture failed its owned cleanup proof")
    raise SystemExit(receipt["exitCode"])


if __name__ == "__main__":
    main()
