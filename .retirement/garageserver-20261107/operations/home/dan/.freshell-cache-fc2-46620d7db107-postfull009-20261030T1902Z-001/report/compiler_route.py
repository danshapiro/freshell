"""Invocation-owned compiler selection; never installed or applied globally."""
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys


class Refusal(Exception):
    pass


def one(options, key):
    places = [i for i, item in enumerate(options) if item == key]
    if len(places) != 1 or places[0] + 1 >= len(options):
        raise Refusal("ambiguous fixed sandbox option " + key)
    return options[places[0] + 1]


def target(args, cfg):
    mount = cfg["checkout"] + ":/workspace"
    if not args or args[0] != "run" or cfg["sandboxImageTag"] not in args or mount not in args:
        return None
    # The ordinary Node prerequisite uses the bridge and is deliberately untouched.
    if "--read-only" not in args and not any(
        args[i:i+2] == ["--network", "none"] for i in range(len(args))
    ):
        return None
    images = [i for i, item in enumerate(args) if item == cfg["sandboxImageTag"]]
    if len(images) != 1 or args.count(mount) != 1:
        raise Refusal("ambiguous fixed sandbox image or checkout")
    index = images[0]
    options = args[1:index]
    if args[index+1:index+3] != ["bash", "-c"] or len(args[index+1:]) != 3:
        raise Refusal("fixed sandbox command shape changed")
    if "--read-only" not in options or one(options, "--network") != "none":
        raise Refusal("strict sandbox namespace changed")
    if options.count("--read-only") != 1 or "--rm" not in options or "--init" not in options:
        raise Refusal("strict sandbox lifetime changed")
    if one(options, "--security-opt") != "no-new-privileges":
        raise Refusal("strict sandbox privilege policy changed")
    if one(options, "--pids-limit") != "512" or one(options, "--memory") != "8g":
        raise Refusal("strict sandbox resource policy changed")
    if not any(options[i:i+2] == ["-v", mount] for i in range(len(options))):
        raise Refusal("fixed checkout mount changed")
    if not any(options[i:i+2] == ["-e", "FRESHELL_SANDBOX_MODE=runtime-suite"] for i in range(len(options))):
        raise Refusal("strict sandbox role changed")
    name = one(options, "--name")
    if not re.fullmatch(r"freshell-sandbox-[A-Za-z0-9]{8}", name):
        raise Refusal("fixed sandbox owner name changed")
    cid = Path(one(options, "--cidfile"))
    if cid.name != "container.id" or cid.parent.name != name:
        raise Refusal("fixed sandbox owner CID changed")
    for i, value in enumerate(options):
        selected = value.removeprefix("--env=") if value.startswith("--env=") else None
        if value in ["-e", "--env"] and i + 1 < len(options):
            selected = options[i+1]
        if selected is not None and selected.split("=", 1)[0] in ["PATH", "CARGO", "RUSTC", "RUSTDOC", "RUSTUP_TOOLCHAIN"]:
            raise Refusal("compiler selection is already ambiguous")
    return index, name, cid


def actual_context(cfg, cid):
    parent = Path("/proc") / str(os.getppid())
    cli = cfg["realDockerCli"]
    def read_cli(args):
        try:
            return subprocess.check_output([cli, *args], text=True, timeout=30).strip()
        except (OSError, subprocess.SubprocessError):
            raise Refusal("captured Docker context unavailable") from None
    directory = cid.parent
    metadata = directory.lstat()
    return {
        "cwd": str(Path.cwd().resolve()),
        "parentCwd": str((parent / "cwd").resolve()),
        "parentArguments": (parent / "cmdline").read_bytes().split(b"\0"),
        "parentUid": parent.stat().st_uid,
        "uid": os.getuid(),
        "directoryUid": metadata.st_uid,
        "directoryMode": stat.S_IMODE(metadata.st_mode),
        "directoryIsLink": directory.is_symlink(),
        "ownerName": (directory / "container.name").read_text().strip(),
        "cidNonempty": cid.exists() and cid.stat().st_size != 0,
        "contextEnvironment": {key: os.environ.get(key) for key in cfg["contextEnvironment"]},
        "cliDigest": hashlib.sha256(Path(cli).read_bytes()).hexdigest(),
        "dockerContext": read_cli(["context", "show"]),
        "dockerDaemonId": read_cli(["info", "--format", "{{.ID}}"]),
        "sandboxImageId": read_cli(["image", "inspect", "--format", "{{.Id}}", cfg["sandboxImageTag"]]),
    }


def require_context(cfg, name, ctx):
    root = cfg["checkout"]
    script = str(Path(root) / "scripts/sandbox-test.sh")
    resolved = []
    for item in ctx["parentArguments"]:
        text = os.fsdecode(item)
        if text.endswith("scripts/sandbox-test.sh"):
            resolved.append(str((Path(root) / text).resolve()))
    if ctx["cwd"] != root or ctx["parentCwd"] != root or resolved != [script]:
        raise Refusal("current fixed sandbox parent did not match")
    if ctx["uid"] != cfg["uid"] or ctx["parentUid"] != cfg["uid"]:
        raise Refusal("current fixed sandbox caller owner changed")
    if ctx["directoryUid"] != cfg["uid"] or ctx["directoryMode"] != 0o700 or ctx["directoryIsLink"]:
        raise Refusal("fixed sandbox private owner directory changed")
    if ctx["ownerName"] != name or ctx["cidNonempty"]:
        raise Refusal("fixed sandbox owner is not a new invocation")
    for key, expected in [
        ("contextEnvironment", cfg["contextEnvironment"]),
        ("cliDigest", cfg["realDockerCliSha256"]),
        ("dockerContext", cfg["dockerContext"]),
        ("dockerDaemonId", cfg["dockerDaemonId"]),
        ("sandboxImageId", cfg["sandboxImageId"]),
    ]:
        if ctx[key] != expected:
            raise Refusal("captured Docker context or artifact changed: " + key)


def prepare(args, cfg, context=None):
    selected = target(args, cfg)
    if selected is None:
        return args, None
    index, name, cid = selected
    ctx = actual_context(cfg, cid) if context is None else context
    require_context(cfg, name, ctx)
    compiler = cfg["containerCompiler"]
    expected_prefix = "/workspace/.runtime-build/periodic004-rust196-"
    if not compiler.startswith(expected_prefix) or ".." in Path(compiler).parts:
        raise Refusal("owned compiler artifact does not match")
    variables = {
        "PATH": compiler + "/bin:" + cfg["imagePath"],
        "CARGO": compiler + "/bin/cargo", "RUSTC": compiler + "/bin/rustc",
        "RUSTDOC": compiler + "/bin/rustdoc", "RUSTUP_TOOLCHAIN": "1.96.0",
    }
    prefix = ""
    for binary in ["rustc", "cargo", "rustdoc"]:
        command = shlex.quote(compiler + "/bin/" + binary)
        prefix += f'freshell_owned_version="$({command} --version)" || exit 2\n'
        prefix += f'case "$freshell_owned_version" in "{binary} 1.96.0 "*) printf \'%s\\n\' "$freshell_owned_version";; *) exit 2;; esac\n'
    prefix += f'freshell_owned_sysroot="$({shlex.quote(compiler + "/bin/rustc")} --print sysroot)" || exit 2\n'
    prefix += f'test "$freshell_owned_sysroot" = {shlex.quote(compiler)} || exit 2\n'
    prefix += 'printf \'%s\\n\' "$freshell_owned_sysroot"\nunset freshell_owned_version freshell_owned_sysroot\n'
    extra = [item for key, value in variables.items() for item in ["--env", key + "=" + value]]
    rewritten = [*args[:index], *extra, *args[index:-1], prefix + args[-1]]
    event = {
        "severity": "info", "event": "owned.strict_compiler.selected", "pid": os.getpid(),
        "parentPid": os.getppid(), "containerName": name, "controlDirectory": str(cid.parent),
        "checkout": cfg["checkout"], "imageId": ctx["sandboxImageId"], "daemonId": ctx["dockerDaemonId"],
        "compiler": compiler, "originalCommandSha256": hashlib.sha256(args[-1].encode()).hexdigest(),
        "argumentCountBefore": len(args), "argumentCountAfter": len(rewritten),
    }
    return rewritten, event


def main():
    cfg = json.loads(Path(os.environ["FRESHELL_OWNED_COMPILER_ROUTE_CONFIG"]).read_text())
    try:
        args, event = prepare(sys.argv[1:], cfg)
        if event is not None:
            destination = Path(os.environ["FRESHELL_OWNED_COMPILER_ROUTE_EVENTS"])
            descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                os.write(descriptor, (json.dumps(event) + "\n").encode())
            finally:
                os.close(descriptor)
            sys.stderr.write(json.dumps(event) + "\n")
    except (Refusal, OSError, KeyError, ValueError):
        sys.stderr.write(json.dumps({"severity": "error", "event": "owned.strict_compiler.refused", "reason": "targeted compiler invocation did not match its current owned context"}) + "\n")
        return 2
    os.execv(cfg["realDockerCli"], [cfg["realDockerCli"], *args])


if __name__ == "__main__":
    raise SystemExit(main())
