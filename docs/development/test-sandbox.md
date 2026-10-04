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
`no-new-privileges`. The root entrypoint may initialize cache-volume ownership, but it always drops
to the unprivileged `sandbox` UID before test code and the self-test verifies that test code has zero
effective capabilities. The mode never mounts Docker/admin sockets or real provider homes. The runtime gate's separate trusted broker is the only component allowed to hold the real
Docker socket; this wrapper never grants it to tests.

## Safety guarantees

| What | Guarantee |
|---|---|
| Network | Ordinary mode uses the dedicated `freshell-sandbox` bridge, never `--network=host`; `--runtime-suite` uses `--network none`. Binding a port inside either container namespace cannot collide with a host listener. |
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
  sandbox user, so the default probe would fail every install. The store lives
  inside the container at the same per-user location pnpm would pick itself.
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
- `freshell-sandbox-cargo-target` — **sandbox-owned**, not the host's `target/`. Sharing the host
  target directory would cause lock contention with concurrent host builds.
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

Reset everything (forces a clean re-warm on next run):

```bash
docker volume rm freshell-sandbox-cargo-registry freshell-sandbox-cargo-git \
  freshell-sandbox-cargo-target freshell-sandbox-node-modules \
  freshell-sandbox-sidecar-node-modules freshell-sandbox-mcp-node-modules \
  freshell-sandbox-playwright-cache
```

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
