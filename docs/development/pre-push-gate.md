# Local pre-push gate

Every `git push` runs the cheap local checks before anything reaches GitHub. This is the enforcement that catches unformatted or clippy-red code at push time — the class of red that landed via PR #764 while no CI checks were running.

## What runs

Filtered by what the push changes (diff between the remote refs being updated and the pushed commits):

| Push contains | Checks |
|---|---|
| Any `.rs`, `Cargo.toml`/`Cargo.lock`, `rust-toolchain*`, `test/fixtures/**` | `cargo fmt --all --check`, then `cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings`, then **targeted `cargo test` in the disposable Docker sandbox**: the changed crates plus every workspace crate that transitively depends on them (full `--workspace --exclude freshell-tauri` when the change is root-level — `Cargo.lock`, toolchain, `.cargo/` — or the base is unknown). `freshell-tauri` is excluded per clippy parity. Test fixtures are cross-crate rust-test infrastructure, so a `test/fixtures/**` change routes to the whole workspace. |
| Any `.ts`/`.tsx`, `package.json`/`package-lock.json`, `pnpm-lock.yaml`/`pnpm-workspace.yaml`, `.npmrc`, `tsconfig*` | The repo typecheck (client + tools, tsc `--noEmit`), run through the pushing worktree's package manager |
| Only docs/config/other files | Nothing |
| New branch with no merge-base with origin/main | Both gates (full) |

Cost when warm: fmt ~5s, typecheck ~1-2 min, clippy ~2-5 min on a warm target dir (first run in a fresh checkout is a cold build — longer). The test lane adds only the affected crates' tests — e.g. a `freshell-freshagent` change tests freshagent plus its dependents (~3-4 min warm); a client-only push pays nothing.

For a Rust push that needs process isolation, set `FRESHELL_RUST_TEST_SANDBOX=1`. The hook keeps its existing plan and sends only the selected Cargo test command through the pushing worktree's `scripts/sandbox-test.sh --runtime-suite`; fmt, Clippy, and typecheck keep their normal routes. Sandbox or Cargo failures still block the push, with no host-test fallback. The default is unset, so ordinary pushes do not require Docker.

When validating an unmerged hook from a worktree, use command-scoped Git config so the shared hook owner remains untouched:

```bash
FRESHELL_RUST_TEST_SANDBOX=1 git \
  -c "core.hooksPath=$(git rev-parse --show-toplevel)/scripts/hooks" \
  push origin <branch>
```

Routing lives in `scripts/hooks/pre-push`; the crate→package targeting logic is `scripts/hooks/rust-test-targets.ts`, unit-tested in `test/unit/scripts/rust-test-targets.test.ts` (which also exercises the hook end-to-end against real git ranges in debug mode).

**Manager selection (pnpm vs npm):** `core.hooksPath` points at the main checkout's hook copy, so the shared hook runs against pnpm-era and npm-era branches alike. The typecheck manager is selected from the PUSHING worktree (`scripts/hooks/prepush-manager.ts`): the `packageManager` field is authoritative; a legacy npm lock without the field selects npm. pnpm-era trees run `pnpm run --silent typecheck` (pnpm forwards args directly — no npm-style `--` separator); npm-era trees keep `npm run --silent typecheck` and their nvm PATH recovery. The same selection rule feeds the missing-manager remediation: a missing pnpm is reported as `npm install --global pnpm@10.34.5`, a missing npm still triggers the automatic nvm loader.

Server-side, PRs that touch Rust must also pass the required `rust-gate` check (`.github/workflows/rust-tests.yml`) — the merge-time backstop that a `--no-verify` push cannot skip. Its change filter now also counts pnpm inputs (`pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, workspace-member manifests under `crates/`/`packages/`) as Rust-relevant, because the Rust suite spawns Node fixtures whose behavior depends on the installed dependency tree; the independent demo locks are deliberately excluded.

## What it does NOT cover

Vitest/e2e/electron lanes and the real-transport clippy lanes stay with the normal QA gate / PR discipline. Rust unit/integration tests now run at push time (targeted, above), so the uncovered remainder is everything non-Rust.

## Controls

- Bypass (emergencies only): `git push --no-verify`
- Disable for one push: `FRESHELL_PREPUSH=0 git push ...`
- See routing without running checks: `FRESHELL_PREPUSH_DEBUG=1 git push --dry-run ...`
- Bypass the server-side `rust-gate` (merge-time, PRs only): the owner account is a `pull_request`-mode bypass actor on the "Protect Main - No Direct Push" ruleset, so merging with a red or missing `rust-gate` is just `gh pr merge <n> --merge` from that account — GitHub records it as a ruleset bypass with an audit entry. This is the explicit escape hatch for landing on a red base; it does NOT unlock direct pushes to main.
- If a lane's tooling is unavailable it is skipped with an accurate warning (not a failure). The hook self-heals stripped-environment contexts (ssh/agents/IDEs/cron): on npm-era trees it sources `~/.nvm/nvm.sh` when `npm` is missing from PATH, and it adds `~/.cargo/bin` when `cargo` is missing. pnpm has no loader — a missing pnpm is reported with the `npm install --global pnpm@10.34.5` remediation instead. The rust-test lane's `tsx` resolves from the pushing worktree's `node_modules`, the hook's own checkout, or the owning checkout (derived from the git common dir) — so fresh worktrees without `node_modules` still run the full lane. The hook also strips git's hook-env overrides (`GIT_DIR` and friends) before anything runs: unstripped, they leak into cargo-test children and every test-side `git` call resolves against the shared repository instead of the test's tempdir (observed re-initializing the main checkout's config and committing test fixtures onto main's HEAD).

## Setup

Automatic: `pnpm install --frozen-lockfile` runs `postinstall` → `scripts/install-hooks.mjs` → sets `core.hooksPath` to the main checkout's `scripts/hooks` (absolute). On a legacy npm-era checkout, `npm install` does the same. One manual step on clones that already have `node_modules`: run `node scripts/install-hooks.mjs`.

Because `core.hooksPath` points at the main checkout's copy, all linked worktrees (including ones at older commits) get the same current gate; the checks themselves execute in the pushing worktree's tree. Machines without this clone's setup (fresh machines) enforce nothing until a dependency install runs there — the gate is per-machine, it complements (not replaces) GitHub-side rules.
