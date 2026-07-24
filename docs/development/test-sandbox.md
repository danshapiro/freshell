# Test Sandbox

Destructive and ops-style test suites (process kills, config corruption, restart storms) and
agent verification runs execute inside a disposable Docker container so accidents physically
cannot touch the host's live servers, real data (`~/.freshell`, `~/.claude`, `~/.codex`,
`~/.local/share/opencode`), or unrelated processes.

## The one command

```bash
scripts/sandbox-test.sh "cargo test -p freshell-ws"
# or via npm:
npm run test:sandbox -- "cargo test -p freshell-ws"
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

## Safety guarantees

| What | Guarantee |
|---|---|
| Network | Dedicated bridge network (`freshell-sandbox`), never `--network=host`. Binding port 3001/3002/etc. inside the container binds in its own namespace — the host's real dev servers on those ports are untouched. |
| Host processes | Container has its own PID namespace. Killing/crashing anything inside (including something literally named `freshell-server`) cannot reach a host process. |
| `~/.freshell`, `~/.claude`, `~/.codex`, `~/.local/share/opencode` | Not mounted by default. `--corpus` mounts only `~/.codex/sessions` and `~/.claude/projects`, and only **read-only**. |
| Repo | Bind-mounted read-write at `/workspace` so test output/artifacts are inspectable from the host. |
| Container lifetime | `--rm`: disposable, nothing persists in the container filesystem across runs. |
| HOME inside container | The sandbox user's own `/home/sandbox`, never the host's `$HOME`. |
| Mount-point ownership | `scripts/sandbox-test.sh` pre-creates `target/`, `node_modules/`, etc. as you before docker runs, and fails loudly with a `chown` remediation if any root-owned entry ever appears directly under the repo root afterward — so a fresh worktree's `target/`/`node_modules/` never end up root-owned by dockerd. |

## Cache volumes and reset

Named Docker volumes persist across runs to avoid re-fetching dependencies every time (first run
of each is slower — see below):

- `freshell-sandbox-cargo-registry`, `freshell-sandbox-cargo-git` — cargo's package cache
- `freshell-sandbox-cargo-target` — **sandbox-owned**, not the host's `target/`. Sharing the host
  target directory would cause lock contention with concurrent host builds.
- `freshell-sandbox-node-modules` — **sandbox-owned**, populated via `npm ci` inside the
  container on first use. The host's `node_modules` has host-built native modules (e.g.
  `node-pty`) that won't run inside the container's different environment.
- `freshell-sandbox-playwright-cache` — downloaded browser binaries.

Reset everything (forces a clean re-warm on next run):

```bash
docker volume rm freshell-sandbox-cargo-registry freshell-sandbox-cargo-git \
  freshell-sandbox-cargo-target freshell-sandbox-node-modules freshell-sandbox-playwright-cache
```

## Rebuilding the image

```bash
scripts/sandbox-build.sh
```

Rebuild after any change to `docker/sandbox/Dockerfile` or `docker/sandbox/entrypoint.sh`. The
image is tagged `freshell-sandbox:latest` and Docker layer caching keeps rebuilds fast unless a
step earlier in the Dockerfile changed.

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
inside the sandbox — while checking host `:3001`/`:3002` health before and after the entire run.
