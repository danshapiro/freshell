#!/usr/bin/env python3
"""Exercise the production refresh helper in an owned rootless runtime container."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import uuid
import socket
import struct
import time


def docker(*args, check=True):
    return subprocess.run(
        ["docker", *args], check=check, text=True, capture_output=True, timeout=60
    )


def indexed_inputs_probe(image, binary, binary_sha256, receipt_directory):
    """Closed synthetic publisher/file-subpath fixture; permissions run in Docker."""
    expected_image = "sha256:967627e41734aa903e824e4be22849c7f22ce0e69487ce61bb72004c4817f89c"
    if image != expected_image:
        raise RuntimeError("indexed input fixture requires the pinned already-present runtime image")
    run_id = "freshell-indexed-probe-" + uuid.uuid4().hex
    label_key = "com.freshell.indexed-input-probe"
    labels = {label_key: run_id}
    volume = run_id + "-volume"
    containers = []
    payload = b"synthetic-indexed-source\n"
    expected_digest = hashlib.sha256(payload).hexdigest()
    receipt = {"image": image, "binarySha256": binary_sha256, "rootless": True, "runId": run_id}

    def remove_owned(name):
        result = docker("container", "inspect", name, check=False)
        if result.returncode != 0:
            return
        value = json.loads(result.stdout)[0]
        if value["Config"].get("Labels", {}).get(label_key) != run_id:
            raise RuntimeError("indexed fixture cleanup ownership changed")
        docker("rm", "--force", value["Id"])

    with tempfile.TemporaryDirectory(prefix=run_id) as temporary:
        exchange = Path(temporary)
        # This fresh directory contains only IPC/receipts. Setup and every
        # chmod/chown/denial fixture executes inside the owned namespace.
        stream = None
        listener = None
        volume_attempted = False
        try:
            setup = run_id + "-setup"
            containers.append(setup)
            docker("create", "--name", setup, "--label", f"{label_key}={run_id}",
                   "--network", "none", "--read-only", "--cap-drop", "ALL",
                   "--security-opt", "no-new-privileges:true", "--pids-limit", "32", "--memory", "64m",
                   "--mount", f"type=bind,src={exchange},dst=/fixture-exchange",
                   "--entrypoint", "/bin/sh", image, "-ceu", "chmod 710 /fixture-exchange")
            setup_result = docker("start", "--attach", setup, check=False)
            if setup_result.returncode != 0:
                raise RuntimeError("indexed fixture namespace setup failed")
            remove_owned(setup)
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            listener.settimeout(20)
            socket_path = exchange / "reply.sock"
            listener.bind(str(socket_path))
            listener.listen(1)
            mode_setup = run_id + "-socket-mode"
            containers.append(mode_setup)
            docker("create", "--name", mode_setup, "--label", f"{label_key}={run_id}",
                   "--network", "none", "--read-only", "--cap-drop", "ALL",
                   "--security-opt", "no-new-privileges:true", "--pids-limit", "32", "--memory", "64m",
                   "--mount", f"type=bind,src={exchange},dst=/fixture-exchange",
                   "--entrypoint", "/bin/sh", image, "-ceu", "chmod 660 /fixture-exchange/reply.sock")
            if docker("start", "--attach", mode_setup, check=False).returncode != 0:
                raise RuntimeError("indexed fixture socket setup failed")
            remove_owned(mode_setup)
            volume_attempted = True
            docker("volume", "create", "--label", f"{label_key}={run_id}", "--driver", "local",
                   "--opt", "type=tmpfs", "--opt", "device=tmpfs", "--opt",
                   "o=size=64m,mode=0700,uid=65534,gid=0,nr_inodes=1024,nosuid,nodev,noexec", volume)
            publisher = run_id + "-publisher"
            containers.append(publisher)
            docker("create", "--name", publisher, "--label", f"{label_key}={run_id}",
                   "--user", "65534:0", "--network", "none", "--read-only", "--cap-drop", "ALL",
                   "--security-opt", "no-new-privileges:true", "--log-driver", "none",
                   "--pids-limit", "32", "--memory", "128m", "--cpus", ".5",
                   "--mount", f"type=bind,src={binary},dst=/runtime/freshell-session-host,readonly",
                   "--mount", f"type=volume,src={volume},dst=/run/freshell-input-files,volume-nocopy",
                   "--mount", f"type=bind,src={exchange},dst=/run/freshell-input-exchange,readonly",
                   "--entrypoint", "/runtime/freshell-session-host", image, "publish-provider-inputs")
            docker("start", publisher)
            stream, _ = listener.accept()
            stream.settimeout(20)

            def receive_exact(length):
                result = bytearray()
                while len(result) < length:
                    chunk = stream.recv(length - len(result))
                    if not chunk:
                        raise RuntimeError("indexed publisher private acknowledgement incomplete")
                    result.extend(chunk)
                return bytes(result)

            def send(request, expected):
                frame = json.dumps(request, separators=(",", ":")).encode()
                if len(frame) >= 1024 * 1024:
                    raise RuntimeError("indexed fixture private frame exceeds profile")
                stream.sendall(struct.pack(">I", len(frame)) + frame)
                length = struct.unpack(">I", receive_exact(4))[0]
                if length >= 1024 * 1024 or json.loads(receive_exact(length)) != expected:
                    raise RuntimeError("indexed publisher acknowledgement phase changed")

            send({"operation": "begin", "source_ids": [0]}, "begun")
            send({"operation": "open", "source_id": 0}, "opened")
            send({"operation": "chunk", "bytes": list(payload)}, "written")
            send({"operation": "finish"}, "finished")
            send({"operation": "seal"}, "populated")
            consumer = run_id + "-consumer"
            containers.append(consumer)
            probe = r'''
const fs=require('fs'), crypto=require('crypto');
const file='/fixture/selected';
const stat=fs.lstatSync(file);
let writable=true;try{fs.writeFileSync(file,'forbidden-write')}catch{writable=false}
const status=fs.readFileSync('/proc/self/status','utf8');
console.log(JSON.stringify({regular:stat.isFile(),symlink:stat.isSymbolicLink(),uid:process.getuid(),gid:process.getgid(),fileUid:stat.uid,fileGid:stat.gid,mode:stat.mode&511,writable,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),capEff:status.match(/^CapEff:\s*(\w+)/m)?.[1],uidMap:fs.readFileSync('/proc/self/uid_map','utf8').trim(),gidMap:fs.readFileSync('/proc/self/gid_map','utf8').trim()}));
setInterval(()=>{},1000);
'''
            docker("create", "--name", consumer, "--label", f"{label_key}={run_id}",
                   "--user", "65534:0", "--network", "none", "--read-only", "--cap-drop", "ALL",
                   "--security-opt", "no-new-privileges:true", "--pids-limit", "32", "--memory", "128m",
                   "--mount", f"type=volume,src={volume},dst=/fixture/selected,volume-subpath=files/source-0,volume-nocopy,readonly",
                   "--entrypoint", "/usr/local/bin/node", image, "-e", probe)
            inspected = json.loads(docker("inspect", consumer).stdout)[0]
            mount = inspected["HostConfig"]["Mounts"][0]
            assert mount["Type"] == "volume" and mount["Source"] == volume and mount["ReadOnly"]
            assert mount["VolumeOptions"]["NoCopy"] and mount["VolumeOptions"]["Subpath"] == "files/source-0"
            docker("start", consumer)
            active = json.loads(docker("inspect", consumer).stdout)[0]
            flattened = active["Mounts"]
            volume_metadata = json.loads(docker("volume", "inspect", volume).stdout)[0]
            assert len(flattened) == 1
            assert flattened[0]["Type"] == "volume" and flattened[0]["Name"] == volume
            assert flattened[0]["Destination"] == "/fixture/selected" and not flattened[0]["RW"]
            assert flattened[0]["Source"] == volume_metadata["Mountpoint"]
            deadline = time.monotonic() + 20
            observed = None
            while time.monotonic() < deadline:
                output = docker("logs", consumer).stdout.strip()
                if output:
                    observed = json.loads(output.splitlines()[0])
                    break
                time.sleep(.1)
            if observed is None:
                raise RuntimeError("indexed consumer produced no bounded receipt")
            assert observed["regular"] and not observed["symlink"] and not observed["writable"]
            assert observed["uid"] == 65534 and observed["gid"] == 0
            assert observed["fileUid"] == 65534 and observed["fileGid"] == 0 and observed["mode"] == 0o600
            assert observed["capEff"] == "0000000000000000" and observed["sha256"] == expected_digest
            assert observed["uidMap"] and observed["gidMap"]
            assert json.loads(docker("inspect", publisher).stdout)[0]["State"]["Running"]
            send({"operation": "release"}, "released")
            remove_owned(publisher)
            assert json.loads(docker("inspect", consumer).stdout)[0]["State"]["Running"]
            post_release = docker("exec", "--user", "65534:0", consumer, "/usr/local/bin/node", "-e",
                                  "process.stdout.write(require('crypto').createHash('sha256').update(require('fs').readFileSync('/fixture/selected')).digest('hex'))").stdout
            assert post_release == expected_digest
            receipt.update({"consumer": observed, "subpath": mount["VolumeOptions"]["Subpath"], "flattenedMountAgreement": True, "publisherConsumerOverlap": True})
            remove_owned(consumer)
            stream.close()
            stream = None
            # After the last active mount goes away, the local tmpfs is empty.
            # Repopulate the same exact owned volume before any cold consumer.
            cold_publisher = run_id + "-cold-publisher"
            containers.append(cold_publisher)
            docker("create", "--name", cold_publisher, "--label", f"{label_key}={run_id}",
                   "--user", "65534:0", "--network", "none", "--read-only", "--cap-drop", "ALL",
                   "--security-opt", "no-new-privileges:true", "--log-driver", "none",
                   "--pids-limit", "32", "--memory", "128m", "--cpus", ".5",
                   "--mount", f"type=bind,src={binary},dst=/runtime/freshell-session-host,readonly",
                   "--mount", f"type=volume,src={volume},dst=/run/freshell-input-files,volume-nocopy",
                   "--mount", f"type=bind,src={exchange},dst=/run/freshell-input-exchange,readonly",
                   "--entrypoint", "/runtime/freshell-session-host", image, "publish-provider-inputs")
            docker("start", cold_publisher)
            stream, _ = listener.accept()
            stream.settimeout(20)
            cold_payload = b"synthetic-cold-repopulation\n"
            send({"operation": "begin", "source_ids": [0]}, "begun")
            send({"operation": "open", "source_id": 0}, "opened")
            send({"operation": "chunk", "bytes": list(cold_payload)}, "written")
            send({"operation": "finish"}, "finished")
            send({"operation": "seal"}, "populated")
            cold_consumer = run_id + "-cold-consumer"
            containers.append(cold_consumer)
            docker("create", "--name", cold_consumer, "--label", f"{label_key}={run_id}",
                   "--user", "65534:0", "--network", "none", "--read-only", "--cap-drop", "ALL",
                   "--security-opt", "no-new-privileges:true", "--pids-limit", "32", "--memory", "128m",
                   "--mount", f"type=volume,src={volume},dst=/fixture/selected,volume-subpath=files/source-0,volume-nocopy,readonly",
                   "--entrypoint", "/usr/local/bin/node", image, "-e",
                   "process.stdout.write(require('crypto').createHash('sha256').update(require('fs').readFileSync('/fixture/selected')).digest('hex'))")
            cold = docker("start", "--attach", cold_consumer, check=False)
            assert cold.returncode == 0 and cold.stdout == hashlib.sha256(cold_payload).hexdigest()
            send({"operation": "release"}, "released")
            receipt["postReleaseRead"] = True
            receipt["coldLastUnmountRepopulated"] = True
        finally:
            if stream is not None:
                stream.close()
            if listener is not None:
                listener.close()
            for container in reversed(containers):
                remove_owned(container)
            volume_state = docker("volume", "inspect", volume, check=False)
            if volume_attempted and volume_state.returncode == 0:
                metadata = json.loads(volume_state.stdout)[0]
                if metadata.get("Labels", {}).get(label_key) != run_id:
                    raise RuntimeError("indexed fixture volume cleanup ownership changed")
                docker("volume", "rm", volume)
            receipt["ownedCleanup"] = all(docker("container", "inspect", name, check=False).returncode != 0 for name in containers)
            receipt["ownedCleanup"] &= docker("volume", "inspect", volume, check=False).returncode != 0
        output = receipt_directory / "task002-indexed-provider-inputs.json"
        output.write_text(json.dumps(receipt, sort_keys=True) + "\n")
        print(json.dumps(receipt, sort_keys=True), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--indexed-inputs", action="store_true")
    parser.add_argument("--receipt-dir", type=Path)
    args = parser.parse_args()
    security = json.loads(docker("info", "--format", "{{json .SecurityOptions}}").stdout)
    if "name=rootless" not in security:
        raise RuntimeError("This probe requires the supported rootless Docker backend")
    image = docker("image", "inspect", "--format", "{{.Id}}", args.image).stdout.strip()
    binary = args.binary.resolve(strict=True)
    with binary.open("rb") as reader:
        binary_sha256 = hashlib.file_digest(reader, "sha256").hexdigest()
    if args.indexed_inputs:
        if not args.receipt_dir or not args.receipt_dir.is_dir():
            raise RuntimeError("indexed fixture requires an existing receipt directory")
        indexed_inputs_probe(image, binary, binary_sha256, args.receipt_dir)
        return
    owned_name = "freshell-config-probe-" + uuid.uuid4().hex
    label = "com.freshell.provider-config-probe=" + owned_name
    with tempfile.TemporaryDirectory(prefix=owned_name) as temporary:
        stage = Path(temporary)
        stage.chmod(0o750)
        skills = stage / "projection/skills"
        skills.mkdir(parents=True)
        (skills / "new.sh").write_text('#!/bin/sh\ncat "$(dirname "$0")/resource"\n')
        (skills / "new.sh").chmod(0o750)
        (skills / "resource").write_text("resource-nonce\n")
        (stage / "manifest.json").write_text('["skills"]')
        (stage / "provider.json").write_text('"codex"')
        (stage / "projection/.freshell-config-projection.json").write_text(
            '["skills","skills/new.sh","skills/resource"]'
        )
        broken = stage / "broken/projection/skills"
        broken.mkdir(parents=True)
        (broken / "bad").symlink_to("missing-resource")
        (stage / "broken/manifest.json").write_text('["skills"]')
        (stage / "broken/provider.json").write_text('"codex"')
        (stage / "broken/projection/.freshell-config-projection.json").write_text(
            '["skills","skills/bad"]'
        )
        aliases = stage / "aliases/projection"
        for name in ["skill-root", "discovered-root"]:
            resource = aliases / ".freshell/resources" / name
            resource.mkdir(parents=True)
            (resource / "resource").write_text(name + "-nonce\n")
            (resource / "run").write_text('#!/bin/sh\ncat "$(dirname "$0")/resource"\n')
            (resource / "run").chmod(0o750)
        (aliases / ".codex").mkdir()
        (aliases / ".codex/skills").symlink_to("../.freshell/resources/skill-root")
        (aliases / ".freshell/resources/skill-root/freshell-discovered-agents").symlink_to("../discovered-root")
        (stage / "aliases/provider.json").write_text('"codex"')
        (stage / "aliases/manifest.json").write_text(json.dumps([
            ".codex/skills", ".codex/skills/freshell-discovered-agents", ".freshell/resources"
        ]))
        (aliases / ".freshell-config-projection.json").write_text(json.dumps([
            path.relative_to(aliases).as_posix() for path in aliases.rglob("*")
        ]))
        for path in stage.rglob("*"):
            if path.is_symlink():
                continue
            if path.is_dir():
                path.chmod(0o750)
            elif not os.access(path, os.X_OK):
                path.chmod(0o640)
        docker("volume", "create", "--label", label, owned_name)
        try:
            docker(
                "create", "--name", owned_name, "--label", label,
                "--network", "none", "--read-only", "--cap-drop", "ALL",
                "--cap-add", "CHOWN", "--cap-add", "SETUID", "--cap-add", "SETGID",
                "--security-opt", "no-new-privileges:true", "--pids-limit", "64",
                "--memory", "256m", "--cpus", "1",
                "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777",
                "--mount", f"type=volume,src={owned_name},dst=/home/freshell/provider",
                "--mount", f"type=bind,src={stage},dst=/probe-stage,readonly",
                "--mount", f"type=bind,src={binary},dst=/runtime/freshell-session-host,readonly",
                "--entrypoint", "/bin/sh", image, "-ceu", r'''
home=/home/freshell/provider
mkdir "$home/skills"
printf prior-nonce > "$home/skills/old.sh"
printf sibling-nonce > "$home/skills/provider-sibling"
printf '["skills","skills/old.sh"]' > "$home/.freshell-config-projection.json"
chmod 700 "$home" "$home/skills"
chmod 640 "$home/skills/provider-sibling"
chown -R 65534:0 "$home"
setpriv --reuid 65534 --regid 0 --clear-groups --no-new-privs -- /bin/sh -ceu '
home=/home/freshell/provider
test "$(id -u)" = 65534
test "$(id -g)" = 0
test "$(sed -n "s/^CapEff:[[:space:]]*//p" /proc/self/status)" = 0000000000000000
before_home=$(stat -c "%i:%u:%g:%a" "$home")
before_sibling=$(stat -c "%i:%u:%g:%a" "$home/skills/provider-sibling")
/runtime/freshell-session-host refresh-provider-config /probe-stage "$home"
test "$("$home/skills/new.sh")" = resource-nonce
test "$before_home" = "$(stat -c "%i:%u:%g:%a" "$home")"
test "$before_sibling" = "$(stat -c "%i:%u:%g:%a" "$home/skills/provider-sibling")"
test "$(cat "$home/skills/provider-sibling")" = sibling-nonce
test ! -e "$home/skills/old.sh"
before_manifest=$(cat "$home/.freshell-config-projection.json")
before_new=$(stat -c "%i:%u:%g:%a" "$home/skills/new.sh")
if /runtime/freshell-session-host refresh-provider-config /probe-stage/broken "$home"; then
  echo "missing selected resource incorrectly succeeded" >&2
  exit 1
fi
test "$before_manifest" = "$(cat "$home/.freshell-config-projection.json")"
test "$before_new" = "$(stat -c "%i:%u:%g:%a" "$home/skills/new.sh")"
test "$("$home/skills/new.sh")" = resource-nonce
test "$before_sibling" = "$(stat -c "%i:%u:%g:%a" "$home/skills/provider-sibling")"
/runtime/freshell-session-host refresh-provider-config /probe-stage "$home"
test "$("$home/skills/new.sh")" = resource-nonce
test "$before_home" = "$(stat -c "%i:%u:%g:%a" "$home")"
test "$before_sibling" = "$(stat -c "%i:%u:%g:%a" "$home/skills/provider-sibling")"
test -z "$(find "$home" -maxdepth 1 -name ".freshell-copy-*" -print)"
/runtime/freshell-session-host refresh-provider-config /probe-stage/aliases "$home"
printf alias-sibling-nonce > "$home/.codex/skills/provider-sibling"
before_alias_sibling=$(stat -c "%i:%u:%g:%a" "$home/.codex/skills/provider-sibling")
for attempt in 1 2 3; do
  /runtime/freshell-session-host refresh-provider-config /probe-stage/aliases "$home"
  test "$("$home/.codex/skills/run")" = skill-root-nonce
  test "$("$home/.codex/skills/freshell-discovered-agents/run")" = discovered-root-nonce
  test "$before_alias_sibling" = "$(stat -c "%i:%u:%g:%a" "$home/.codex/skills/provider-sibling")"
  test "$(cat "$home/.codex/skills/provider-sibling")" = alias-sibling-nonce
  test "$before_home" = "$(stat -c "%i:%u:%g:%a" "$home")"
done
test -z "$(find "$home" -maxdepth 1 -name ".freshell-copy-*" -print)"
'
printf 'readonly-home-provider-helper PASS uid=65534 gid=0 caps=0 stable-home retained-sibling executable-resource stale-removed failed-refresh-preserved retry nested-codex-alias-three-resumes\n'
'''
            )
            inspection = json.loads(docker("inspect", owned_name).stdout)[0]
            assert inspection["HostConfig"]["ReadonlyRootfs"]
            assert not inspection["HostConfig"]["Privileged"]
            assert inspection["HostConfig"]["CapDrop"] == ["ALL"]
            assert {cap.removeprefix("CAP_") for cap in inspection["HostConfig"]["CapAdd"]} == {"CHOWN", "SETUID", "SETGID"}
            assert len(inspection["Mounts"]) == 3
            assert all("docker.sock" not in mount["Destination"] for mount in inspection["Mounts"])
            print(json.dumps({"probe": owned_name, "image": image, "binarySha256": binary_sha256, "rootless": True,
                              "readOnlyRootfs": True, "capAdd": inspection["HostConfig"]["CapAdd"], "mounts": inspection["Mounts"]}), flush=True)
            outcome = docker("start", "--attach", owned_name, check=False)
            print(outcome.stdout, end="", flush=True)
            print(outcome.stderr, end="", flush=True)
            state = json.loads(docker("inspect", owned_name).stdout)[0]["State"]
            if state["ExitCode"] != 0:
                raise RuntimeError(f"Provider helper container exited {state['ExitCode']}")
        finally:
            docker("rm", "--force", owned_name, check=False)
            docker("volume", "rm", owned_name)
            assert docker("container", "inspect", owned_name, check=False).returncode != 0
            assert docker("volume", "inspect", owned_name, check=False).returncode != 0
            print(json.dumps({"probe": owned_name, "ownedContainerRemoved": True,
                              "ownedVolumeRemoved": True}), flush=True)


if __name__ == "__main__":
    main()
