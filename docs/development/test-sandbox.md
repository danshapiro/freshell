# Test Sandbox

Destructive and ops-style test suites (process kills, config corruption, restart storms) and
agent verification runs execute inside a disposable Docker container so accidents physically
cannot touch the host's live Rust server, real data (`~/.freshell`, `~/.claude`, `~/.codex`,
`~/.local/share/opencode`), or unrelated processes.

## The one command

```bash
scripts/sandbox-test.sh "cargo test -p freshell-ws"
# or via the package-manager script (pnpm forwards the command as one argument):
pnpm run test:sandbox "cargo test -p freshell-ws"
```

The image builds automatically on first use (`scripts/sandbox-build.sh` runs it directly if you
need to force a rebuild after changing `docker/sandbox/Dockerfile`).

## Build budget and diagnostics

Every ordinary workload, runtime dependency preparation, and runtime workload
has a fixed aggregate CPU quota of 2, 8 GiB of RAM, 16 GiB of total RAM plus
swap (up to 8 GiB of swap), and 512 processes. Cargo's native cgroup-aware
default selects the build concurrency; the wrapper leaves `CARGO_BUILD_JOBS`
absent unless the caller exports a nonempty value. Project `build.jobs`,
exported values, inline assignments, and Cargo's `--jobs` retain their normal
precedence. Higher job counts still share the same two-CPU quota, which can
reduce throughput for highly parallel workloads. The wrapper adds no CPU
quota override.

JSONL receipts on stderr distinguish requested policy from the workload's
observed own-cgroup `cpu.max`, `memory.max`, `memory.swap.max`, and `pids.max`.
The observation runs as the sandbox user immediately before the caller;
unavailable controls stay null and these paths do not describe invisible
ancestor limits. The observer comes from the trusted wrapper and is mounted
read-only, including when the wrapper targets another linked worktree.
Receipts identify the phase, exact command SHA256, published
full container ID when available, attached Docker status, final status, and
cleanup outcome. They omit command text and arbitrary environment values.
Jobs inputs appear as numeric strings, null, or a fixed non-numeric marker.
Workload stdout and stderr keep their original contents.

Each phase also starts with an `unobserved` Cargo jobs receipt. A small
unprivileged observer can then record the `NUM_JOBS` reported to a verified
Cargo build script, associated with that phase and command digest. A
phase-local process number distinguishes witnessed Cargo processes; multiple
reports can have different values. These are samples, not a complete list:
cached, short-lived, inaccessible, or otherwise missed scripts remain unknown.
The reported value is neither the number of processes running simultaneously
nor the capacity of an inherited shared jobserver.

The observer scans at most 512 processes every 200 ms, reads at most 64 KiB of
a qualifying script's environment, and emits at most 64 samples. It never logs
paths, command lines, or environment contents. It shares the existing CPU,
memory, and process limits and does not own or wait for the caller. Observer
failure leaves the unknown receipt and the caller's result unchanged.

Containers retain `--rm`, so their post-exit state is reported as
`not_retained`. Unavailable OOM state remains null; this launcher never
classifies exit 137 as OOM. Synchronous diagnostic helper failures emit a fixed
unavailable event and preserve execution and cleanup statuses. Such a run lacks
required diagnostic evidence even if its workload succeeds.

The self-test includes six-member offline Cargo smokes for the native default,
project, exported, inline, and CLI job settings. Each checks actual build-script
`NUM_JOBS`, overlapping work, kernel limits, and low memory pressure in a fresh
container after a separate dependency warmup. This small smoke does not replace
the isolated cold-build acceptance for substantial compiler workloads.

## The `--corpus` flag

For realistic-data perf tests, mount real session corpora **read-only**:

```bash
scripts/sandbox-test.sh --corpus "cargo test -p freshell-sessions -- --ignored perf"
```

This mounts `~/.codex/sessions` and `~/.claude/projects` read-only at their natural paths inside
the container. Without `--corpus`, no real user data is mounted at all.

## The `--runtime-suite` flag

Managed-runtime lifecycle and reaping tests use the stricter mode:

```bash
scripts/sandbox-test.sh --runtime-suite "cargo test -p freshell-codex <destructive-test-name>"
```

`--runtime-suite` is intentionally incompatible with `--corpus`. It uses `--network none`, a
read-only container root with only explicit tmpfs/bind/volume write locations and enables
`no-new-privileges` for the requested command. Before that container starts, a separate disposable
container on the dedicated bridge prepares the fingerprinted Node dependencies and runs
`cargo fetch --locked` when `Cargo.lock` exists. Only this fixed preparation has networking and
a writable root; it never receives the requested command or mounts provider homes or admin
sockets. Preparation failure stops the run before the requested command starts. The command's
container reuses those volumes with Cargo in offline mode, so a cold cache needs no manual warm-up.
The root entrypoint may initialize cache-volume ownership, but it always drops
to the unprivileged `sandbox` UID before test code and the self-test verifies that test code has zero
effective capabilities. The mode never mounts Docker/admin sockets or real provider homes. The runtime gate's separate trusted broker is the only component allowed to hold the real
Docker socket; this wrapper never grants it to tests.

For the Rust phase of the existing full suite, explicitly select this mode:

```bash
FRESHELL_RUST_TEST_SANDBOX=1 pnpm run test
# Or run the existing standalone Rust launcher with Cargo test arguments:
FRESHELL_RUST_TEST_SANDBOX=1 pnpm run test:rust <filter> -- --exact
```

Only the exact value `1` enables routing; other test backend settings do not.
The Rust launcher runs its unchanged locked server build and workspace tests
inside the strict sandbox, selects the container's server binary, and gives
ordinary temporary files a short owned directory under `/freshell-test-artifacts`
so nested Unix socket paths fit the operating system's limit and temporary
executables can run. Explicit executable fixtures use a separate
owned directory under the sandbox Cargo target volume's `/freshell-test-artifacts`
alias, outside the checkout's Node package lookup scope. Cargo uses three parallel build jobs;
libtest runs four cases at once and default Tokio runtimes use two workers
within the existing container resource limits. Explicit test worker counts
and the complete test workload remain unchanged. The launcher logs its owned
temporary directories and removes both on exit or before awaiting an interrupted
child that might ignore termination. Sandbox,
dependency, and inner-runner failures return failure without host Cargo fallback.
The same exact opt-in routes the source-runtime process suite through the strict
sandbox. Its prebuild guard, client build, tools build, and locked release Rust
build still run natively in that order. The sandbox prepares its separate locked
release binary, then runs the complete runtime suite against the native client
and tools artifacts without rebuilding those bind-mounted files. It owns an
executable temporary directory, transports the checkout commit identity, and
returns failures without host runtime fallback. A direct focused invocation is:

```bash
FRESHELL_RUST_TEST_SANDBOX=1 pnpm run test:source-runtime
```

The client and Electron phases keep their configured backends and coordinator.
The wrapper records its owned container and settles it before returning a
signal failure; stopping the attached Docker client alone is insufficient.
The strict Rust route also starts an independent guard for its exact owned
container. If the phase watchdog kills the launcher, the guard reuses the
wrapper's CID/name settlement checks; unknown daemon state retains the
control directory and an error receipt. Ordinary completion joins the guard
before returning. The coordinator's watchdog limits and kill behavior remain
unchanged.
Strict mode automatically prepares the dependency caches before starting the requested command;
that command keeps its read-only root and no network.

## Fixed P2-G01 external browser route

The P2-G01 web continuity case can use the existing external-target browser
project while keeping the browser test body inside a disposable sandbox:

```bash
FRESHELL_E2E_BACKEND=local FRESHELL_RUNTIME_EXTERNAL_LOCAL_SANDBOX=1 \
  pnpm exec tsx scripts/testing/runtime-external-browser.ts \
  --spec test/e2e-browser/specs/runtime-terminal-continuity-rust.spec.ts \
  --grep 'P2-G01: real browser shell survives ten graceful/abrupt web replacements'
```

This route admits only that exact spec and title. The trusted host owner starts
the managed runtime, broker, web server, and authenticated tunnel, then lists
the selected Playwright case. The browser test runs inside
`scripts/sandbox-test.sh`; the host never executes its test body. The owner
hands the sandbox a private read-only descriptor file, and the browser process
receives only the five target/run identity values plus the fixed spec and title.
The file sits in a host directory with owner-only access; its read-only mode
lets the nonroot sandbox user read the mounted descriptor. The sandbox gets no
Docker socket, provider home, or cloud credential.
The owner also gives the two fixed preparation/execution phases a pnpm store
named for this run ID. After the execution container settles, the wrapper
removes that exact store and reports that it is absent; the shared sandbox store
used by other lanes remains unchanged.

The browser container uses the existing `freshell-sandbox` bridge so it can
reach the owner's HTTPS/WSS tunnel. Its root remains read-only, it runs as the
`sandbox` user with `no-new-privileges` and the existing process/memory limits,
and the wrapper verifies settlement of its owned container before returning.
Dependency and Chromium preparation also uses only that bridge and receives no
external-target descriptor. This fixed route does not change the
networkless behavior of ordinary `--runtime-suite` commands or enable a
general networked shell mode.

The exact stopped-repair selector has a finite managed-runtime route:

```bash
scripts/sandbox-test.sh --runtime-suite "cargo test -p freshell-supervisor stopped_repair_crash_ -- --ignored"
```

For this literal command only, the owner compiles the current supervisor library test
harness with pinned Cargo, selects and copies that executable, and prepares three fresh
historical fixtures through a restricted run-owned broker. The selected harness and its
aborting children execute inside a disposable rootless container with UID0 mapped to
the unprivileged host owner, zero capabilities, no network, a read-only root and only
the private run directory writable. Private build artifacts mount read-only at their
canonical host paths. The actual importer/read helpers still use UID65534:GID0 and
their production permissions. No administrative socket, operator home or provider
grant is mounted. The three parents must reach their named abort boundary, reopen the
same surviving Registry files, and pass all original import/retraction assertions;
compilation or listing alone is insufficient. The owner preserves logs and verifies
exact container/helper/provider-volume cleanup. Every other selector retains the
ordinary sandbox route, and combining this command with `--corpus` remains refused.

## Safety guarantees

| What | Guarantee |
|---|---|
| Network | Ordinary mode and fixed dependency preparation use the dedicated `freshell-sandbox` bridge, never `--network=host`; `--runtime-suite` commands use `--network none`. Binding a port inside either container namespace cannot collide with a host listener. |
| Host processes | Container has its own PID namespace. Killing/crashing anything inside (including something literally named `freshell-server`) cannot reach a host process. |
| `~/.freshell`, `~/.claude`, `~/.codex`, `~/.local/share/opencode` | Not mounted by default. `--corpus` mounts only `~/.codex/sessions` and `~/.claude/projects`, and only **read-only**. |
| Repo | Bind-mounted read-write at `/workspace` so test output/artifacts are inspectable from the host. |
| Container lifetime | `--rm`: disposable, nothing persists in the container filesystem across runs. |
| HOME inside container | The sandbox user's own `/home/sandbox`, never the host's `$HOME`. |
| Mount-point ownership | `scripts/sandbox-test.sh` pre-creates `target/`, `node_modules/`, etc. as you before docker runs, and fails loudly with a `chown` remediation if any root-owned entry ever appears directly under the repo root afterward — so a fresh worktree's `target/`/`node_modules/` never end up root-owned by dockerd. |

## Dependency preparation (dual-manager, fingerprinted)

The container prepares the repo's dependencies on first use and reuses them
while they stay valid. The sandbox serves both pnpm-era trees (this branch:
`packageManager` pin) and legacy npm-era branches, so the manager is selected
per tree — `packageManager` is authoritative; a missing field falls back to
lock presence, npm's `package-lock.json` first so legacy branches keep their
`npm ci` path.

- On a pnpm-era tree the install is `pnpm install --frozen-lockfile` with an
  explicit `--store-dir /home/sandbox/.local/share/pnpm/store`. The explicit
  store dir is load-bearing: pnpm's default store-path resolution probes the
  project root's writability, and the bind-mounted repo is not writable by the
  sandbox user, so the default probe would fail every install. The store uses
  the sandbox-owned `freshell-sandbox-pnpm-store` volume. This keeps it writable
  under `--runtime-suite`'s read-only container root and lets its offline
  dependency install reuse packages prepared by an ordinary sandbox run.
- Install success is recorded in `node_modules/.sandbox-deps-state` — a
  fingerprint over the manager and its version, the install policy flags, the
  root manifest, the selected manager's lock/config files, and the workspace
  member manifests. This replaces the old one-shot `.sandbox-npm-ci-done`
  marker; an old npm marker or npm-era volume never satisfies the pnpm state
  (and vice versa), and any manager/lock/manifest/policy change forces a
  reinstall on the next run.
- Before a reinstall, the previous tree is purged — but only through the
  wrapper's named volume mounts (a direct `docker run` without those volumes
  fails closed on the install instead of ever deleting the bind-mounted
  repo's real `node_modules`).
- The state file lives inside the install volume, so wiping the volume wipes
  the state with it.

## Cache volumes and reset

Named Docker volumes persist across runs to avoid re-fetching dependencies every time (first run
of each is slower — see below):

- `freshell-sandbox-cargo-registry`, `freshell-sandbox-cargo-git` — cargo's package cache
- `freshell-sandbox-pnpm-store` — pnpm's downloaded package store.
- `freshell-sandbox-rust-target-v1-<worktree-hash>` — **sandbox-owned**, not the host's
  `target/`. The hash is derived from the canonical host path of the working copy, so repeat runs
  reuse that copy's Rust build output while different copies get separate volumes. The ordinary
  `/workspace/target` mount and the strict runtime suite's `/freshell-test-artifacts` alias use the
  same volume. Docker applies the owner, purpose, schema, and worktree-hash labels as it creates and
  attaches a fresh volume; an existing volume with mismatched labels is refused. This requires
  Docker support for `docker run --mount` volume labels. If the installed Docker does not support
  that option, the wrapper reports Docker's error and does not fall back to a shared target cache.
- `freshell-sandbox-cargo-target` — the previous shared target cache. New wrapper runs leave it
  untouched; no contents are migrated or removed automatically.
- `freshell-sandbox-node-modules` — **sandbox-owned**, populated by the container's dependency
  preparation (fingerprinted `pnpm install --frozen-lockfile` on pnpm-era trees, `npm ci` on
  legacy npm-era branches) and carrying the `.sandbox-deps-state` fingerprint. The host's
  `node_modules` contains host-specific tooling and should not be shared with the container's
  environment.
- `freshell-sandbox-sidecar-node-modules`, `freshell-sandbox-mcp-node-modules` — sandbox-owned
  `node_modules` for the pnpm workspace members (`crates/freshell-claude-sidecar`,
  `packages/freshell-mcp-runtime`), which have their own dependency trees. On legacy npm-era
  branches these stay mounted but unused.
- `freshell-sandbox-playwright-cache` — downloaded browser binaries.

Set `FRESHELL_SANDBOX_CACHE_PREFIX` to a unique Docker volume name prefix to use an
independent set of the seven dependency and browser caches, including when running
`scripts/sandbox-selftest.sh`. The default prefix is `freshell-sandbox`; paths are rejected
to prevent accidentally mounting host directories. This setting does not change the canonical
per-worktree Rust target volume. The cold-start regression creates and removes its own caches.

Reset shared dependency and browser-download caches (these will re-warm on the next run):

```bash
docker volume rm freshell-sandbox-cargo-registry freshell-sandbox-cargo-git \
  freshell-sandbox-pnpm-store freshell-sandbox-node-modules \
  freshell-sandbox-sidecar-node-modules freshell-sandbox-mcp-node-modules \
  freshell-sandbox-playwright-cache
```

This command does not clear the per-worktree Rust target caches described below. The legacy
`freshell-sandbox-cargo-target` volume is also left untouched.

To reset one working copy's Rust target cache, first find its volume by the
`com.freshell.cache.worktree-sha256` label and inspect all four
`com.freshell.cache.*` labels. Remove only the exact matching volume name with
`docker volume rm <volume-name>`; Docker refuses removal while any running or
stopped container still references it. Do not use force removal. This cache
reset is separate from the shared dependency-cache reset above.

The focused acceptance test for these Rust target volumes is:

```bash
scripts/sandbox-cache-selftest.sh
```

It uses temporary checkouts and labeled volumes, verifies non-root writes,
same-copy reuse, runtime aliasing, cross-copy isolation, concurrent first use,
Docker's running/stopped container reference checks, and recreation after an
explicit scratch-volume removal. It removes only its own labeled volumes after
checking that no container references them. `scripts/sandbox-selftest.sh`
also runs this focused test as Proof 7, followed by cold strict startup as Proof 8.

## Rebuilding the image

```bash
scripts/sandbox-build.sh
```

Rebuild after any change to `docker/sandbox/Dockerfile` or `docker/sandbox/entrypoint.sh`. The
image is tagged `freshell-sandbox:latest` and Docker layer caching keeps rebuilds fast unless a
step earlier in the Dockerfile changed.

The canonical image includes the native development libraries for the whole Rust workspace:
DBus and the Tauri desktop shell's GTK3, WebKit2GTK 4.1 (with libsoup3), and Ayatana
AppIndicator tray dependencies. Rebuild an existing image before running full-workspace tests
after these prerequisites change; an already-present image is not rebuilt automatically.
Tests use these libraries as the unprivileged sandbox user without installing packages at run time.

## When you MUST use it vs may skip it

**Must use the sandbox:**
- Process-kill suites (anything that sends signals to a real or decoy `freshell-server`)
- File-corruption suites (anything that writes/truncates/deletes config or session files as part
  of the test)
- Restart-storm suites (anything that repeatedly starts/stops servers)
- Any test explicitly flagged destructive by `docs/plans/2026-07-17-rust-transition-campaign-status.md`'s
  destructive-test safety contract

**May skip it (run directly on host):**
- Pure unit tests with no process/file-system side effects outside the test's own tempdir
- Anything already using the existing in-code guard-rail pattern (ephemeral `127.0.0.1:0` ports,
  path assertions confined to the test's own tempdir) AND not touching real processes by PID/name

## Verifying isolation

`scripts/sandbox-selftest.sh` is the acceptance test for this whole setup. Run it after any
change to `docker/sandbox/**` or `scripts/sandbox-*.sh`:

```bash
scripts/sandbox-selftest.sh
```

It proves PID isolation, port isolation, filesystem isolation (read-only corpus mounts really are
read-only, host `~/.freshell` isn't visible unmounted), and that a real crate's tests run green
inside the sandbox. It uses exact host-side PID and HTTP sentinels that the self-test itself creates, so concurrent worktree servers may legitimately change without producing a false isolation failure; host `:3001`/`:3002` and Freshell PIDs are recorded as diagnostics only.
