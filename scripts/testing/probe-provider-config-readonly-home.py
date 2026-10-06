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


def docker(*args, check=True):
    return subprocess.run(
        ["docker", *args], check=check, text=True, capture_output=True, timeout=60
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--binary", required=True, type=Path)
    args = parser.parse_args()
    security = json.loads(docker("info", "--format", "{{json .SecurityOptions}}").stdout)
    if "name=rootless" not in security:
        raise RuntimeError("This probe requires the supported rootless Docker backend")
    image = docker("image", "inspect", "--format", "{{.Id}}", args.image).stdout.strip()
    binary = args.binary.resolve(strict=True)
    with binary.open("rb") as reader:
        binary_sha256 = hashlib.file_digest(reader, "sha256").hexdigest()
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
