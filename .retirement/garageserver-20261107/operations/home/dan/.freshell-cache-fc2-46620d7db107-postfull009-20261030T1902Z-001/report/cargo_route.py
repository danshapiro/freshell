"""NOT_ADOPTED: one-push Cargo adapter; no hook/config/default modification."""
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = '/home/dan/code/freshell/.worktrees/freshcodex-complete'
COMPILER_SHIM = str(HERE)
CONFIG = {
    'root': ROOT,
    'hostCompiler': '/home/dan/.rustup/toolchains/1.96.0-x86_64-unknown-linux-gnu/bin',
    'compilerShim': str(HERE / 'push-cli'),
    'compilerConfig': COMPILER_SHIM + '/route.json',
    'routeDirectory': str(HERE),
    'events': str(HERE / 'future-push-compiler-events.jsonl'),
}
MARKER = 'node --import tsx /workspace/scripts/testing/run-rust-tests.ts  &'


class Refusal(Exception):
    pass


def validate_test(args):
    # Only current hook forms; package names come from its live planner.
    # New filters, manifests, toolchains, config or libtest args require review.
    locked = workspace = packages = exclusions = 0
    index = 1
    while index < len(args):
        value = args[index]
        if value == '--locked':
            locked += 1
        elif value == '--workspace':
            workspace += 1
        elif value in ['-p', '--package', '--exclude']:
            index += 1
            if index >= len(args) or not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_-]*', args[index]):
                raise Refusal('unsupported package selector')
            if value == '--exclude':
                exclusions += 1
            else:
                packages += 1
        else:
            raise Refusal('unsupported Cargo test form')
        index += 1
    if locked != 1 or workspace > 1 or bool(workspace) == bool(packages) or (exclusions and not workspace):
        raise Refusal('ambiguous or unlocked Cargo test form')


def replace_runner(template, args):
    if template.count(MARKER) != 1:
        raise Refusal('supported Rust sandbox generator changed')
    # Retain its owned temps, traps, worktree-specific target and worker caps.
    # Match the standard runner's locked server fixture, then exec exact argv.
    inner = 'set -e\ncargo build -p freshell-server --locked\nexport FRESHELL_SERVER_BIN="$CARGO_TARGET_DIR/debug/freshell-server"\nexec cargo "$@"'
    runner = shlex.join(['bash', '-c', inner, 'freshcodex-push-hook', *args]) + ' &'
    return template.replace(MARKER, runner)


def plan(args, cfg, template):
    if args and args[0] in ['metadata', 'fmt', 'clippy']:
        return [cfg['hostCompiler'] + '/cargo', *args]
    if not args or args[0] != 'test':
        raise Refusal('unsupported Cargo command')
    validate_test(args)
    return [cfg['root'] + '/scripts/sandbox-test.sh', '--runtime-suite', replace_runner(template(), args)]


def execution_environment(cfg, inherited):
    env = dict(inherited)
    paths = [entry for entry in env.get('PATH', '').split(':')
             if entry not in [cfg['routeDirectory'], cfg['compilerShim'], cfg['hostCompiler']]]
    env['PATH'] = ':'.join([cfg['compilerShim'], cfg['hostCompiler'], *paths])
    for name, binary in [('CARGO', 'cargo'), ('RUSTC', 'rustc'), ('RUSTDOC', 'rustdoc')]:
        env[name] = cfg['hostCompiler'] + '/' + binary
    env.update({
        'RUSTUP_TOOLCHAIN': '1.96.0',
        'FRESHELL_SANDBOX_OWNER_GUARD': '1',
        'FRESHELL_OWNED_COMPILER_ROUTE_CONFIG': cfg['compilerConfig'],
        'FRESHELL_OWNED_COMPILER_ROUTE_EVENTS': cfg['events'],
    })
    env.pop('FRESHELL_SERVER_BIN', None)
    return env


def execute(args, cfg, inherited, template, executor=os.execve):
    command = plan(args, cfg, template)
    # exec transfers the original PID/status and leaves no adapter child.
    executor(command[0], command, execution_environment(cfg, inherited))


def main():
    try:
        if Path.cwd().resolve() != Path(ROOT) or os.environ.get('FRESHELL_PUSH_HOOK_ROUTE_ACTIVE') != '1':
            raise Refusal('private one-push context not selected')
        def template():
            return subprocess.check_output(['node', '--import', 'tsx', str(HERE / 'sandbox-template.mts')],
                                           cwd=ROOT, text=True, timeout=30)
        execute(sys.argv[1:], CONFIG, os.environ, template)
    except (Refusal, OSError, subprocess.SubprocessError) as error:
        sys.stderr.write(json.dumps({'severity': 'error', 'event': 'private.push_hook_cargo.refused',
                                     'reason': str(error) if isinstance(error, Refusal) else type(error).__name__}) + '\n')
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
