# Soul Home Mounts Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
- Fresh-agent souls (managed-runtime incarnations for opencode, claude, codex, amplifier, kilroy) always launch with fully working configs: any config value referencing an absolute path under the operator's home (e.g. opencode `"apiKey": "{file:/home/dan/.amplifier/ms-runpod.key}"`) resolves inside the soul with zero user action, no registration, and no launch refusal. Regression: a freshopencode soul in `/home/dan/code/shapiroserver2` with the current global `~/.config/opencode/opencode.json` must boot opencode successfully where it dies today with "Configuration is invalid ... bad file reference".

### Explicit constraints
- Primary priority, stated by the user: "it works without bothering the user." No launch refusals, registration steps, approval prompts, or config re-authoring for this reference class.
- Chosen mechanism: mount the operator's home read-only at its own path into every soul container and run provider children as the operator's uid:gid instead of 65534 (`nobody`). No config scanner/rewriter/classifier machinery.
- The soul's purpose is resource bounding (CPU/memory/swap/pids) and clean process lifecycle, NOT data confidentiality (user ratified). Resource limits and teardown semantics must not change.
- Control-plane authorization material under the operator home (at minimum `~/.freshell`: incarnation secrets, MCP capability grants, server config secrets) must not become readable by provider children through the new mount — mask it inside the container.
- Home mount is read-only; provider writes go to the soul HOME volume and the workspace as today; workspace mounts stay read-write.
- Existing durable souls must keep working across the uid change: provider-home state ownership (old uid 65534) migrates to the operator uid at incarnation start, with no user intervention and no loss of provider state.
- Unchanged: config-root staging/projection into the soul HOME volume, OneCLI env grants for `{env:}` references, auth.json provider-file grants, per-incarnation MCP capability mounts.
- Production self-hosted server must not be restarted without the user's explicit "APPROVED"; building and testing in worktrees is fine. Running souls keep their old mounts until natural incarnation replacement.
- TDD per repo rules; work in `.worktrees/soul-home-mounts`; PR to main only after explicit user approval.

### Accepted tradeoffs and residuals
- Accepted posture change: souls can read the operator's home except masked control-plane paths. The "blast radius"/confidentiality concern was explicitly withdrawn by the user.
- `{env:}` references for new custom providers still require allow-list additions in `provider_secret_resolution.rs`; pressure is reduced but the mechanism is unchanged.
- References outside home/workspace/grants (rare) and cross-host drift (referenced file absent on this machine) still fail at runtime exactly as host CLIs would; an optional doctor lint is out of scope.
- If a genuine write-into-home case appears later, flip the mount to read-write then.

**Goal:** Every fresh-agent and managed-terminal soul launches with a config that fully works — absolute references under the operator's home resolve in-soul — and the ms-runpod `bad file reference` incident class becomes structurally impossible.

**Architecture:** The supervisor bind-mounts the operator's home directory read-only at its own canonical path into every soul container and masks the Freshell control-plane subtree inside it with tmpfs mounts. The freshell-server stops hardcoding provider uid 65534 and instead records the operator's own euid (gid stays 0), so provider children — spawned via `setpriv` by the session host — hold the same uid the mounted home files are owned by. The session host aligns the durable provider-home volume's ownership to each launch record's `run_as` at every incarnation start (generalizing the existing `transfer_owned_tree` children-first chown) and writes an `/etc/passwd` entry for the uid. Staging/projection, OneCLI grants, capability mounts, and resource limits are untouched.

**Tech Stack:** Rust workspace (`freshell-supervisor` raw Docker Engine HTTP-over-socket backend, `freshell-server` launch-record producers, `freshell-session-host` privileged in-container host, `freshell-runtime-protocol` launch specs), Docker Engine API v1.47 bind+tmpfs mounts, Playwright local-only runtime specs via the managed-runtime rig.

## Global Constraints

- pnpm 10.34.5 exactly; `pnpm run <script> <args>` forwards args directly (no `--` separator). Use `pnpm exec` for installed binaries.
- TypeScript tooling uses NodeNext/ESM; relative TS imports need `.js` extensions (not applicable to Rust tasks).
- Red-Green-Refactor TDD: every task adds its failing test first, watches it fail for the stated reason, implements minimally, refactors while green, and runs the impacted set.
- Test coordination (AGENTS.md): narrowed `cargo test -p <crate> <filter>` selectors are delegated (no coordinator gate). Zero-argument/broad `--run` server/integration invocations are coordinated. `pnpm run test:runtime` always holds the gate. Do not kill foreign gate holders.
- Root-ownership/chown-dependent unit tests run inside the disposable sandbox: `scripts/sandbox-test.sh "cargo test -p freshell-session-host <filter>"` (root inside the sandbox). Logic tests that only need chown-to-self run directly.
- New e2e specs are `LOCAL_ONLY` (the rig drives the real host Docker daemon); register the spec in `LOCAL_ONLY_SPECS` (test/e2e-browser/playwright.cloud.config.ts) — cloud-skipped specs don't count as coverage.
- Never restart the production self-hosted server (port 3001) without the user's explicit "APPROVED". Building and running scratch supervisors/souls in the worktree is fine.
- `reject_management_path` (crates/freshell-supervisor/src/backend/docker.rs:299) is substring-based (`docker.sock`, `/var/lib/freshell-supervisor`, `/run/freshell-supervisor`): no new bind source may contain those substrings.
- The launch `run_as_uid` participates in the immutable launch digest (crates/freshell-supervisor/src/backend.rs:928-929): never rewrite a durable record's uid; alignment always targets the record's uid, not a global constant.
- `verify_inspect_config` (backend.rs:993-1030) re-verifies container env on every inspect: every new assertion must be gated on an additive env marker so pre-upgrade running containers keep passing.
- No changes to: `copy_provider_config_references_with_ownership` projection semantics, `provider_secret_resolution.rs` env allow-lists, `TerminalMounts` existing field behavior, resource limits, or teardown semantics.
- Commits use `Dan Shapiro <3732858+danshapiro@users.noreply.github.com>` (repo config already provides it; do not override).

---

### Task 1: Supervisor mounts operator home read-only with control-plane masks

**Files:**
- Modify: `crates/freshell-supervisor/src/backend/docker.rs` (TerminalMounts + workload_mounts, ~line 34-198)
- Modify: `crates/freshell-supervisor/src/backend.rs` (binds assembly ~572-618, runtime_host_environment ~402-497, docker_create_body tmpfs, verify_inspect_config ~993-1030)
- Test: `crates/freshell-supervisor/src/backend/docker.rs` (unit tests inline), `crates/freshell-supervisor/src/backend.rs` (unit tests inline)

**Interfaces:**
- Consumes: `TerminalMounts` (docker.rs:34-42), `workload_mounts` (docker.rs:68-198), `runtime_host_environment` (backend.rs:402-497), `runtime_tmpfs(runtime_mode)` (backend.rs:629), `docker_create_body` (backend.rs:640).
- Produces:
  - `pub struct OperatorHomeMount { pub home: PathBuf, pub mask_rel_paths: Vec<String> }` (new field `pub operator_home: Option<OperatorHomeMount>` on `TerminalMounts`).
  - `fn operator_home_mount(home_env: Option<&std::ffi::OsStr>) -> Option<OperatorHomeMount>` in docker.rs — pure derivation from a HOME value; masks are fixed: `[".freshell", ".amplifier/onecli"]`.
  - `fn assemble_workload_binds(...) -> (Vec<String>, std::collections::BTreeMap<String, String>)` in backend.rs — extracted from `create_stopped` inline assembly; returns binds plus additional tmpfs destinations (`"<destination>": ""` map entries merged with `runtime_tmpfs` output).
    - Container env set by `runtime_host_environment` when the spec's mounts include `operator_home`: marker `FRESHELL_OPERATOR_HOME_MOUNT=1` plus the canonical home path in `FRESHELL_OPERATOR_HOME=<path>` (consumed by Task 3 for the rootless-degrade observation).

- [ ] **Step 1: Write the failing behavioral test**

In `crates/freshell-supervisor/src/backend/docker.rs` tests module (beside the existing `user_provider_config_referenced` tests around line 340-390):

```rust
#[test]
fn operator_home_mount_derives_masks_from_home_env() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    std::fs::create_dir_all(home.join(".freshell")).unwrap();
    std::fs::create_dir_all(home.join(".amplifier").join("onecli")).unwrap();
    let mount = operator_home_mount(Some(home.as_os_str())).expect("home mount derives");
    assert_eq!(mount.home, home.canonicalize().unwrap());
    assert_eq!(mount.mask_rel_paths, vec![".freshell", ".amplifier/onecli"]);
}

#[test]
fn operator_home_mount_skips_unset_or_missing_home() {
    assert!(operator_home_mount(None).is_none());
    let tmp = tempfile::tempdir().unwrap();
    assert!(operator_home_mount(Some(tmp.path().join("nope").as_os_str())).is_none());
}
```

In `crates/freshell-supervisor/src/backend.rs` tests module:

```rust
#[test]
fn workload_binds_include_read_only_home_and_masks() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    let workspace = home.join("code").join("repo");
    std::fs::create_dir_all(&workspace).unwrap();
    let (binds, tmpfs) = assemble_workload_binds(
        &tmp.path().join("binary"),
        &tmp.path().join("runtime"),
        "provider-vol",
        None,
        Some(&TerminalMounts {
            workspace: workspace.clone(),
            git_common_dir: None,
            provider_bootstrap_files: vec![],
            provider_secret_files: vec![],
            provider_user_root: None,
            mcp_capability_file: None,
            operator_home: Some(OperatorHomeMount {
                home: home.canonicalize().unwrap(),
                mask_rel_paths: vec![".freshell".to_string()],
            }),
        }),
    )
    .unwrap();
    assert!(binds.contains(&format!("{}:{}:ro", home.display(), home.display())));
    assert!(binds.contains(&format!("{}:{}:rw", workspace.display(), workspace.display())));
    assert_eq!(tmpfs.get(format!("{}/.freshell", home.display().to_string())).map(String::as_str), Some(""));
    // RO home must not swallow the deeper RW workspace bind intent: both are present.
    assert_eq!(binds.iter().filter(|b| *b == &format!("{}:{}:rw", workspace.display(), workspace.display())).count(), 1);
}

#[test]
fn workload_binds_skip_home_when_workspace_equals_home() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let home = home.canonicalize().unwrap();
    let (binds, tmpfs) = assemble_workload_binds(
        &tmp.path().join("binary"),
        &tmp.path().join("runtime"),
        "provider-vol",
        None,
        Some(&TerminalMounts {
            workspace: home.clone(),
            git_common_dir: None,
            provider_bootstrap_files: vec![],
            provider_secret_files: vec![],
            provider_user_root: None,
            mcp_capability_file: None,
            operator_home: Some(OperatorHomeMount {
                home: home.clone(),
                mask_rel_paths: vec![".freshell".to_string()],
            }),
        }),
    )
    .unwrap();
    assert!(!binds.iter().any(|b| b == &format!("{}:{}:ro", home.display(), home.display())));
    assert_eq!(tmpfs.get(format!("{}/.freshell", home.display().to_string())).map(String::as_str), Some(""));
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-supervisor operator_home_mount workload_binds`

Expected: FAIL to compile — `operator_home_mount`, `OperatorHomeMount`, and `assemble_workload_binds` do not exist yet (the missing behavior is the mount derivation and bind assembly, not a syntax accident).

- [ ] **Step 3: Add the minimal production implementation**

In docker.rs:

```rust
/// Read-only operator-home mount for souls. Config files projected into the
/// soul reference absolute host paths under the operator's home; the provider
/// child needs those paths to resolve in-soul. The mask list hides
/// control-plane authorization material (host command secrets, MCP grants,
/// OneCLI's own grant credential) from provider children.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperatorHomeMount {
    pub home: PathBuf,
    pub mask_rel_paths: Vec<String>,
}

pub const OPERATOR_HOME_MASK_REL_PATHS: &[&str] = &[".freshell", ".amplifier/onecli"];

pub fn operator_home_mount(home_env: Option<&std::ffi::OsStr>) -> Option<OperatorHomeMount> {
    let raw = home_env?;
    if raw.is_empty() {
        return None;
    }
    let home = canonical_dir(Path::new(raw), "operator HOME").ok()?;
    let exists = OPERATOR_HOME_MASK_REL_PATHS.iter().any(|rel| home.join(rel).is_dir())
        || home.is_dir();
    if !exists {
        return None;
    }
    Some(OperatorHomeMount {
        mask_rel_paths: OPERATOR_HOME_MASK_REL_PATHS.iter().map(|s| s.to_string()).collect(),
        home,
    })
}
```

Wire it in `workload_mounts` (docker.rs:68-198): add `operator_home: operator_home_mount(std::env::var_os("HOME").as_deref())` to the returned `TerminalMounts` (the function already falls back to `std::env::var_os("HOME")` at line 141 for user roots — keep both using the same env value; read it once at the top of `workload_mounts`).

In backend.rs, extract the inline binds assembly at lines 572-618 into:

```rust
fn assemble_workload_binds(
    binary: &std::path::Path,
    runtime_dir: &std::path::Path,
    provider_volume_name: &str,
    actor_state_dir: Option<&std::path::Path>,
    terminal_mounts: Option<&TerminalMounts>,
) -> Result<(Vec<String>, std::collections::BTreeMap<String, String>), BackendError> {
    let mut binds = vec![
        format!("{}:/runtime/freshell-session-host:ro", binary.display()),
        format!("{}:/run/freshell:rw", runtime_dir.display()),
        format!("{}:/home/freshell/provider:rw", provider_volume_name),
    ];
    let mut tmpfs = std::collections::BTreeMap::new();
    if let Some(actor_state_dir) = actor_state_dir {
        binds.push(format!("{}:{HOST_ACTOR_STATE_MOUNT}:rw", actor_state_dir.display()));
    }
    if let Some(mounts) = terminal_mounts {
        binds.push(format!("{}:{}:rw", mounts.workspace.display(), mounts.workspace.display()));
        if let Some(git) = &mounts.git_common_dir {
            if !git.starts_with(&mounts.workspace) {
                binds.push(format!("{}:{}:rw", git.display(), git.display()));
            }
        }
        for (index, source) in mounts.provider_bootstrap_files.iter().enumerate() {
            binds.push(format!("{}:/run/freshell-bootstrap/provider-{index}:ro", source.display()));
        }
        for (index, source) in mounts.provider_secret_files.iter().enumerate() {
            binds.push(format!("{}:/run/freshell-secrets/provider-{index}:ro", source.display()));
        }
        if let Some(source) = &mounts.provider_user_root {
            binds.push(format!("{}:/run/freshell-private/user-provider:ro", source.display()));
        }
        if let Some(source) = &mounts.mcp_capability_file {
            binds.push(format!("{}:/run/freshell/mcp-capability.json:ro", source.display()));
        }
        if let Some(home) = &mounts.operator_home {
            if home.home != mounts.workspace {
                binds.push(format!("{}:{}:ro", home.home.display(), home.home.display()));
            }
            for rel in &home.mask_rel_paths {
                tmpfs.insert(format!("{}/{}", home.home.display(), rel), String::new());
            }
        }
    }
    Ok((binds, tmpfs))
}
```

`create_stopped` calls it and merges the returned tmpfs map into the existing `runtime_tmpfs(runtime_mode)` configuration in `docker_create_body` (additive keys win; the existing tmpfs destinations must not be dropped). In `runtime_host_environment`, add `FRESHELL_OPERATOR_HOME_MOUNT=1` to the env when the spec's mounts contain `operator_home` (thread the flag from `create_stopped`, which already computed the mounts). In `verify_inspect_config`, only assert the home `:ro` bind and mask tmpfs presence when the inspected env contains `FRESHELL_OPERATOR_HOME_MOUNT=1` — pre-upgrade containers lack the marker and must keep passing.

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-supervisor operator_home_mount workload_binds`

Expected: PASS

- [ ] **Step 5: Refactor while green**

None needed beyond the `create_stopped` extraction already performed in Step 3 (the extraction IS the refactor; the inline block it replaces was the pre-refactor shape).

- [ ] **Step 6: Run impacted-test verification**

Impacted set: all `freshell-supervisor` tests (mount assembly, digest, inspect verification) plus `freshell-runtime-protocol` spec tests that serialize these structs.

Run: `cargo test -p freshell-supervisor && cargo test -p freshell-runtime-protocol`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-supervisor/src/backend.rs crates/freshell-supervisor/src/backend/docker.rs
git commit -m "feat(supervisor): mount operator home read-only in souls with control-plane tmpfs masks"
```

### Task 2: Server records the operator's uid for provider children

**Files:**
- Create: `crates/freshell-server/src/provider_identity.rs`
- Modify: `crates/freshell-server/src/managed_runtime.rs:161,833-834`
- Modify: `crates/freshell-server/src/fresh_agent_proxy.rs:40-41,502-503`
- Modify: `crates/freshell-server/src/lib.rs` (module registration)
- Test: `crates/freshell-server/src/provider_identity.rs` (inline unit tests)

**Interfaces:**
- Consumes: protocol `run_as_uid`/`run_as_gid` fields (crates/freshell-runtime-protocol/src/lib.rs:1630-1631, 1833-1834) and the `run_as_uid == 0` rejection (lib.rs:1676, 1872).
- Produces: `pub fn provider_uid_for_operator(euid: u32) -> u32` (pure; returns the operator euid, or 65_534 when it is 0/root — the protocol forbids root provider children) and `pub fn operator_provider_uid() -> u32` (thin `libc::geteuid()` wrapper). Both managed-terminal and fresh-agent launch records call it instead of the `MANAGED_PROVIDER_UID`/`PROVIDER_UID` constants. Gid stays `0` (unchanged `*_GID` constants).

- [ ] **Step 1: Write the failing behavioral test**

In the new `provider_identity.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_uid_follows_operator_euid() {
        assert_eq!(provider_uid_for_operator(1000), 1000);
        assert_eq!(provider_uid_for_operator(42), 42);
    }

    #[test]
    fn provider_uid_falls_back_when_server_runs_as_root() {
        // Protocol validation rejects run_as_uid == 0 (runtime-protocol lib.rs:1676, 1872).
        assert_eq!(provider_uid_for_operator(0), 65_534);
    }
}
```

And in `fresh_agent_proxy.rs` tests (or the nearest existing launch-record test around line 502): assert the built record's `run_as_uid == provider_uid_for_operator(test_operator_euid)` instead of the hardcoded `65_534` (inject the euid through the new pure function; do not assert a machine-specific uid).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-server provider_uid`

Expected: FAIL to compile — `provider_uid_for_operator` does not exist, and the launch-record call sites still read the hardcoded constants.

- [ ] **Step 3: Add the minimal production implementation**

`crates/freshell-server/src/provider_identity.rs`:

```rust
//! Provider-child identity for managed-runtime souls.
//!
//! Provider children run as the operator's own uid so that read-only
//! operator-home mounts are readable by them: config files projected into the
//! soul reference absolute host paths (opencode `{file:...}` API keys) that
//! resolve only when the child holds the operator's uid. Root is rejected by
//! protocol validation, so a root-owned server falls back to the legacy uid.

pub fn provider_uid_for_operator(euid: u32) -> u32 {
    if euid == 0 {
        65_534
    } else {
        euid
    }
}

pub fn operator_provider_uid() -> u32 {
    // SAFETY: geteuid performs no allocation and cannot race process identity.
    provider_uid_for_operator(unsafe { libc::geteuid() })
}
```

Replace both constant uses: `managed_runtime.rs:161` uses `operator_provider_uid()` (delete `MANAGED_PROVIDER_UID` at 833; keep the gid constant), `fresh_agent_proxy.rs:502` uses `operator_provider_uid()` (delete `PROVIDER_UID` at 40). Register the module in `lib.rs`. Add `libc` to `freshell-server`'s dependencies in its Cargo.toml if not already present (it is already a workspace dependency of the session host).

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-server provider_uid`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Audit every `65_534` remaining in `crates/freshell-server` (grep) and confirm each is either the root-fallback constant inside `provider_identity.rs` or an explicit legacy-fallback test fixture — no launch producer may hardcode it anymore.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: all `freshell-server` tests (launch-record fixtures assert uid fields), plus the protocol tests that validate `run_as_uid` (lib.rs:3295, 3335 fixtures are protocol-side and unchanged).

Run: `cargo test -p freshell-server && cargo test -p freshell-runtime-protocol`

Expected: PASS — any test that hardcoded `65_534` as the produced uid must be updated to assert `provider_uid_for_operator(<fixture euid>)` (behavior change is the point; fixtures must express the new rule, not special-case the dev box).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-server/src/provider_identity.rs crates/freshell-server/src/managed_runtime.rs crates/freshell-server/src/fresh_agent_proxy.rs crates/freshell-server/src/lib.rs crates/freshell-server/Cargo.toml crates/freshell-server/Cargo.lock
git commit -m "feat(server): run provider children as the operator uid instead of 65534"
```

### Task 3: Session host aligns provider-home ownership and adds a passwd entry

**Files:**
- Modify: `crates/freshell-session-host/src/main.rs` (grant_execution ~745, transfer_owned_tree ~1130-1172 and its caller ~1120-1128, set_owner)
- Test: `crates/freshell-session-host/src/main.rs` (inline tests; chown-dependent cases run in the sandbox)

**Interfaces:**
- Consumes: `transfer_owned_tree(root, uid, gid, max_entries)` (main.rs:1130-1172), `set_owner` (main.rs), launch-record `run_as_uid`/`run_as_gid`, the fsuid-adoption precedent (pty.rs:547-558), CAP set CHOWN/SETGID/SETUID.
- Produces:
  - `fn align_provider_home_ownership(home: &Path, run_as_uid: u32, run_as_gid: u32) -> std::collections::BTreeMap<PathBuf, String>` — walk bounded (100_000 entries), chown entries whose uid differs from `run_as_uid` to `run_as_uid:run_as_gid`, per-entry error collection (never abort the launch), returning failed paths for JSONL logging.
  - `fn ensure_provider_passwd_entry_at(passwd_path: &Path, uid: u32, gid: u32, home: &str) -> Result<(), String>` — idempotent passwd append: `freshell-provider:x:<uid>:<gid>::<home>:/bin/false` when the file has no entry for that uid (numerically-run CLIs get stable `id` output; git identity fallbacks stop degrading); thin wrapper `ensure_provider_passwd_entry(uid, gid, home)` targets `/etc/passwd`.

- [ ] **Step 1: Write the failing behavioral test**

```rust
#[test]
fn align_provider_home_ownership_chowns_foreign_files_to_run_as() {
    // Runs as the dev user: chown-to-self is permitted without capabilities.
    let euid = unsafe { libc::geteuid() };
    let dir = std::env::temp_dir().join(format!("align-test-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("sessions/old")).unwrap();
    std::fs::write(dir.join("sessions/old/state.json"), b"{}").unwrap();
    std::fs::write(dir.join("opencode.json"), b"{}").unwrap();
    let failures = align_provider_home_ownership(&dir, euid, 0);
    assert!(failures.is_empty(), "{failures:?}");
    // Re-aligning an already-aligned tree is a no-op that still succeeds.
    let failures = align_provider_home_ownership(&dir, euid, 0);
    assert!(failures.is_empty());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn align_provider_home_ownership_never_aborts_on_unreadable_entries() {
    let euid = unsafe { libc::geteuid() };
    let dir = std::env::temp_dir().join(format!("align-unreadable-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let _ = std::fs::write(dir.join("a"), b"x");
    // A root-owned 0600 file (if present on the dev box fixtures) must be skipped, not fatal:
    // simulate via a path that cannot be chowned (root-owned) only when running under root in the sandbox.
    if euid != 0 {
        // As non-root we cannot manufacture a foreign-owned file; the invariant
        // "collect and continue" is exercised by the sandbox run below.
        std::fs::remove_dir_all(&dir).unwrap();
        return;
    }
    let foreign = dir.join("foreign");
    std::fs::write(&foreign, b"x").unwrap();
    set_owner(&foreign, 65_534, 0).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&foreign, std::fs::Permissions::from_mode(0o600)).unwrap();
    let failures = align_provider_home_ownership(&dir, euid, 0);
    assert!(failures.contains_key(&foreign) || failures.is_empty()); // root CAN chown it; the assertion is: no panic, no abort
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn ensure_provider_passwd_entry_is_idempotent() {
    let euid = unsafe { libc::geteuid() };
    let tmp = tempfile::tempdir().unwrap();
    let passwd = tmp.path().join("passwd");
    std::fs::write(&passwd, "root:x:0:0::/root:/bin/bash\n").unwrap();
    ensure_provider_passwd_entry_at(&passwd, euid, 0, "/home/freshell/provider").unwrap();
    let after_first = std::fs::read_to_string(&passwd).unwrap();
    ensure_provider_passwd_entry_at(&passwd, euid, 0, "/home/freshell/provider").unwrap();
    let after_second = std::fs::read_to_string(&passwd).unwrap();
    assert!(after_first.contains(&format!("freshell-provider:x:{euid}:0::/home/freshell/provider:/bin/false")));
    assert_eq!(after_first, after_second, "second call must not append again");
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-session-host align_provider_home ensure_provider_passwd`

Expected: FAIL to compile — the two functions do not exist yet.

- [ ] **Step 3: Add the minimal production implementation**

Generalize the amplifier-only transfer into the alignment helper (keep `transfer_owned_tree` untouched for its existing caller; `align_provider_home_ownership` reuses it with a from-uid filter and a no-abort policy):

```rust
fn align_provider_home_ownership(
    home: &Path,
    run_as_uid: u32,
    run_as_gid: u32,
) -> std::collections::BTreeMap<PathBuf, String> {
    let mut failures = std::collections::BTreeMap::new();
    let Ok(root) = std::fs::canonicalize(home) else {
        failures.insert(home.to_path_buf(), "canonicalize failed".into());
        return failures;
    };
    let mut stack = vec![root.clone()];
    let mut paths = Vec::new();
    while let Some(path) = stack.pop() {
        if paths.len() >= 100_000 {
            failures.insert(path, "ownership alignment bound exceeded".into());
            break;
        }
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                continue; // symlinks carry no ownership obligation
            }
            Ok(metadata) => {
                if metadata.is_dir() {
                    match std::fs::read_dir(&path) {
                        Ok(entries) => {
                            for entry in entries.flatten() {
                                stack.push(entry.path());
                            }
                        }
                        Err(error) => {
                            failures.insert(path.clone(), format!("read_dir: {error}"));
                            continue;
                        }
                    }
                }
                paths.push((path, metadata));
            }
            Err(error) => {
                failures.insert(path, format!("metadata: {error}"));
                continue;
            }
        }
    }
    paths.sort_by_key(|(path, _)| std::cmp::Reverse(path.components().count()));
    for (path, metadata) in paths {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != run_as_uid {
            if let Err(error) = set_owner(&path, run_as_uid, run_as_gid) {
                failures.insert(path, error);
            }
        }
    }
    failures
}

fn ensure_provider_passwd_entry_at(
    passwd_path: &Path,
    uid: u32,
    gid: u32,
    home: &str,
) -> Result<(), String> {
    let passwd = std::fs::read_to_string(passwd_path).map_err(|e| e.to_string())?;
    if passwd.lines().any(|line| {
        let mut fields = line.split(':');
        fields.nth(2) == Some(&uid.to_string())
    }) {
        return Ok(());
    }
    std::fs::OpenOptions::new()
        .append(true)
        .open(passwd_path)
        .and_then(|mut file| {
            use std::io::Write;
            file.write_all(format!("freshell-provider:x:{uid}:{gid}::{home}:/bin/false\n").as_bytes())
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn ensure_provider_passwd_entry(uid: u32, gid: u32, home: &str) -> Result<(), String> {
    ensure_provider_passwd_entry_at(Path::new("/etc/passwd"), uid, gid, home)
}
```

Call both in `grant_execution` (main.rs:745) before the fresh/resume provider-state branches (~866-878, ~960-995): `align_provider_home_ownership(Path::new("/home/freshell/provider"), record_run_as_uid, record_run_as_gid)` — always from the LAUNCH RECORD's uid, never from a global constant, so resumed pre-upgrade records (uid 65534) stay self-consistent. Emit a JSONL host event `provider_home_ownership_aligned` with counts and failure paths when non-empty (follow the existing `append_event_with_secret` event pattern at main.rs:2513, without secrets in the payload). Call `ensure_provider_passwd_entry` once at session-host start (`main` after parsing args) for the record's uid. Also at session-host start, emit the rootless-degrade observation: when the env carries `FRESHELL_OPERATOR_HOME=<path>` and `std::fs::metadata(path).uid() == 0` while the record's `run_as_uid != 0`, append host event `operator_home_uid_mismatch` (the mounted home is container-root-owned, so operator-uid children cannot read it — a rootless-Docker deployment; the launch proceeds, never refuses). Note: the session host runs with CAP_CHOWN/SETGID/SETUID and no DAC_OVERRIDE — chown(2) on traversable paths works; foreign-owned 0700 directories are collected as failures (their in-soul consumers get a typed log entry, and the next session-host revision can adopt the fsuid-stepping precedent from pty.rs:547-558 if the bound proof in Task 4 shows real-world 0700 trees — do not add fsuid stepping speculatively in this task).

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-session-host align_provider_home ensure_provider_passwd`

Expected: PASS locally for the logic cases; the root-uid branch additionally passes in the sandbox.

- [ ] **Step 5: Refactor while green**

If the amplifier-only caller (main.rs:1120-1128) now reduces to a thin wrapper over the shared alignment logic, unify it; otherwise leave it — do not change amplifier behavior.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: all session-host tests (ownership, projection, bootstrap preparation) plus the supervisor backend tests.

Run: `cargo test -p freshell-session-host && cargo test -p freshell-supervisor && scripts/sandbox-test.sh "cargo test -p freshell-session-host align_provider_home"`

Expected: PASS (the sandbox rerun proves the root branches)

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-session-host/src/main.rs
git commit -m "feat(session-host): align provider home ownership to the launch record uid and add provider passwd entry"
```

### Task 4: E2E regression — soul boots with `{file:}` key references

**Files:**
- Create: `test/e2e-browser/specs/runtime-opencode-home-file-reference-rust.spec.ts`
- Modify: `test/e2e-browser/helpers/managed-runtime.ts` (~line 332 hardcoded `65534:0`)
- Modify: `scripts/testing/runtime-sandbox.ts` (~line 896 hardcoded `65534:0`)
- Modify: `scripts/testing/runtime-test-broker.ts` (~lines 330-380 bind allow-list, ~404)
- Modify: `test/e2e-browser/playwright.cloud.config.ts` (add the new spec to `LOCAL_ONLY_SPECS`)

**Interfaces:**
- Consumes: the rig pattern of `test/e2e-browser/specs/runtime-terminal-continuity-rust.spec.ts` (P2-G04: construct rig → open an OpenCode pane via the picker → wait for `Ask anything` prompt text), `ManagedRuntimeBrowserRig` with its parameterizable `webHomeDir` (the Rust server's isolated HOME), the broker's bind allow-list, `startSupervisor` env option.
- Produces: a reproducible spec proving the incident class is fixed; rig helpers parameterized by the launch record's uid instead of `65534:0`.

- [ ] **Step 1: Write the failing behavioral test**

The spec (follow the continuity spec's setup verbatim; only the body differs):

```ts
import { test, expect } from './runtime-helpers' // use the exact import path the continuity spec uses
// Setup (copy the P2-G04 rig construction):
// 1. webHomeDir = <rig temp>/web-home, containing:
//    - .amplifier/ms-runpod.key  ("e2e-key-not-a-real-secret")
//    - .config/opencode/opencode.json with:
//      { "$schema": "https://opencode.ai/config.json",
//        "provider": { "ms-runpod": { "npm": "@ai-sdk/openai-compatible",
//          "options": { "baseURL": "https://runpod.invalid/v1",
//                       "apiKey": "{file:<webHomeDir>/.amplifier/ms-runpod.key}" } } },
//        "model": "ms-runpod/e2e-model" }
//    - .freshell/ managed-runtime control tree (existing webHomeDir wiring already creates this)
// 2. Construct the rig with webHomeDir set, supervisor env HOME=<webHomeDir> (add if missing),
//    broker allow-list entries for <webHomeDir> binds (workspace + home:ro).
// 3. Open a freshopencode pane in a workspace under the rig root.
// Body:
test('soul resolves {file:} API key references under the operator home', async ({ rig, page }) => {
  await rig.openTerminalPane('opencode')
  await expect(page.getByText('Ask anything')).toBeVisible({ timeout: 120_000 })
  const paneText = await rig.capturePaneText()
  expect(paneText).not.toContain('Configuration is invalid')
  expect(paneText).not.toContain('bad file reference')
})
```

Write the real file by mirroring the continuity spec's actual imports/rig calls (read it first — the sketch above names the right seams but must match the spec's real helper API), including its `test.describe.configure`/serial and rig-teardown blocks. If the `ms-runpod` provider needs `npm` availability inside the image, prefer configuring `model` on a provider shape the image already supports (the projected config only needs to VALIDATE and let opencode boot; no model call is made — the baseURL is `.invalid` on purpose).

Also update the three hardcoded `65534:0` rig sites (`managed-runtime.ts:332`, `runtime-sandbox.ts:896`, `runtime-test-broker.ts:404`) to read the uid from the launch record/environment the rig already carries (`FRESHELL_PROVIDER_RUN_AS_UID` style), and add the home-bind + workspace-bind allow-list entries to the broker (`runtime-test-broker.ts:330-380` — same shape as existing entries).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `pnpm run test:e2e:local test/e2e-browser/specs/runtime-opencode-home-file-reference-rust.spec.ts --project=chromium`

(match the continuity spec's actual invocation from package.json/playwright config if this spelling differs)

Expected: FAIL — the pane shows `Configuration is invalid ... bad file reference ... does not exist` exactly like the production incident, because pre-Task-1 supervisors mount no home. (Run this once BEFORE rebasing the worktree supervisor onto Task 1-3 code — i.e., author the spec at this task's start with Tasks 1-3 complete so the failure demonstrably requires the full chain; if Tasks 1-3 are already merged into the branch, temporarily confirm the red by running the spec with `FRESHELL_SUPPRESS_HOME_MOUNT=1` if implemented, or assert the red history in the commit message — the intent is that the spec is the regression proof, not that red must be replayable.)

- [ ] **Step 3: Add the minimal production implementation**

No production change: this task is the system-level proof. The rig changes in Step 1 (uid parameterization, broker allow-list, HOME wiring) are the implementation. If the supervisor test lane needs a build step (`pnpm run build:rust` or the rig's supervisor build), follow how the continuity spec builds its supervisor.

- [ ] **Step 4: Run the focused test**

Run: `pnpm run test:e2e:local test/e2e-browser/specs/runtime-opencode-home-file-reference-rust.spec.ts --project=chromium`

Expected: PASS — opencode boots to its prompt, proving the `{file:}` reference resolved in-soul.

- [ ] **Step 5: Refactor while green**

Extract any duplicated rig plumbing (webHomeDir fixture, key-file writer) into the shared helper module next to `managed-runtime.ts` if the continuity spec would reuse it; otherwise leave.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: all LOCAL_ONLY runtime specs that construct the rig (they share the 65534:0 call sites just parameterized) — at minimum `runtime-terminal-continuity-rust.spec.ts` and `runtime-opencode-provider-qualification-rust.spec.ts`.

Run: `pnpm run test:e2e:local --project=chromium --grep @runtime` (or the repo's canonical filtered runtime-spec invocation — match AGENTS.md e2e lanes; never a broad zero-arg coordinated run without the gate)

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/runtime-opencode-home-file-reference-rust.spec.ts test/e2e-browser/helpers/managed-runtime.ts test/e2e-browser/playwright.cloud.config.ts scripts/testing/runtime-sandbox.ts scripts/testing/runtime-test-broker.ts
git commit -m "test(e2e): soul boots opencode with {file:} operator-home key references"
```

### Task 5: Test-site sweep and posture documentation

**Files:**
- Modify: `crates/freshell-supervisor/src/backend.rs` (~1637-1763 CODEX_CMD assertions), `crates/freshell-supervisor/src/native_history.rs` (~47, ~328), `crates/freshell-supervisor/src/recovery.rs` (~192-217), `crates/freshell-runtime-protocol/src/lib.rs` (~3295, ~3335 fixtures)
- Modify: `test/e2e-browser/…/phase-2.test.ts` (~506-510 SECURITY regex), `scripts/testing/runtime-soak*.ts` (~256), remaining `65534` sites found by `rg '65534|65_534' crates scripts test`
- Modify: `docs/development/managed-runtime.md` (~217, ~220-225, ~329-338), `docker/runtime/README.md` (~19-30)

**Interfaces:**
- Consumes: Task 2's `provider_uid_for_operator`.
- Produces: no runtime behavior change — fixtures express the record-derived uid, and docs state the new mount/uid posture.

- [ ] **Step 1: Write the failing behavioral test**

For the sweep there is one new assertion (in the supervisor tests, beside the CODEX_CMD assertions):

```rust
#[test]
fn codex_command_env_carries_record_run_as_uid() {
    // The CODEX_CMD env template must carry the launch record's run_as uid,
    // whatever it is — not a constant. Parameterize the existing fixture at
    // backend.rs:1637-1763 to build the record with run_as_uid = 4242 and
    // assert the env contains "setpriv --reuid 4242".
}
```

(Extend the existing CODEX_CMD fixture tests to a non-65534 uid — if they already pass through the record field, this is the red-then-green; if they hardcode, they fail first.)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-supervisor codex_command_env_carries_record_run_as_uid`

Expected: FAIL if any assertion path still hardcodes 65_534; otherwise PASS immediately — in that case record the finding in the commit message instead of fabricating a red (repo rule: never weaken a test to produce one).

- [ ] **Step 3: Add the minimal production implementation**

Sweep every remaining `65_534`/`65534` in `crates`, `scripts`, and `test` (except the root-fallback constant in `provider_identity.rs` and explicit legacy-fallback fixtures): parameterize to the record/derived value. Docs:

- `docs/development/managed-runtime.md`: replace the "no unrelated home" bullet (~220-225) and rootless rationale (~329-338) with the new contract: souls mount the operator home read-only at its canonical path; provider children run as the operator uid (gid 0); `~/.freshell` and `~/.amplifier/onecli` are tmpfs-masked in-soul; pre-upgrade containers (no `FRESHELL_OPERATOR_HOME_MOUNT` env marker) are not expected to have the mounts; under rootless Docker the operator's host files appear container-root-owned so the feature degrades to legacy readability — logged as a host JSONL event, never a launch refusal.
- `docker/runtime/README.md` (~19-30): update the uid story (session host still uid 0; provider children = operator uid via `setpriv`, `freshell-provider` passwd entry written at host start) and reword the 0600-secret guarantee to state the masked-home boundary.

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-supervisor && cargo test -p freshell-session-host && cargo test -p freshell-server`

Expected: PASS

- [ ] **Step 5: Refactor while green**

None — the sweep is the cleanup.

- [ ] **Step 6: Run impacted-test verification**

This touches fixtures across the Rust workspace; run the Rust workspace suite via the coordinated lane (it holds the coordinator gate — check `pnpm run test:status` first and wait for the current holder):

Run: `pnpm run test:integration`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-supervisor/src/backend.rs crates/freshell-supervisor/src/native_history.rs crates/freshell-supervisor/src/recovery.rs crates/freshell-runtime-protocol/src/lib.rs test scripts docs/development/managed-runtime.md docker/runtime/README.md
git commit -m "chore: parameterize run_as uid fixtures and document the operator-home soul posture"
```

## Verification (user-visible outcome)

1. The incident scenario end-to-end: with the operator's real global `~/.config/opencode/opencode.json` (which references `{file:/home/dan/.amplifier/ms-runpod.key}`), a freshopencode pane in `/home/dan/code/shapiroserver2` boots opencode to its prompt with no "Configuration is invalid" text — covered by Task 4's spec (synthetic home) and, after user-approved deploy, by the live pane.
2. Pre-upgrade running souls: supervisor restart/replacement tolerates containers without the new mounts (Task 1's marker-gated verification), and their launch records keep spawning children at their recorded uid with aligned home ownership (Task 3).
3. Resource bounding and teardown: unchanged (no limits code touched; the full `pnpm run check` gate before any PR proves it).
4. Resumed durable souls keep their state readable: alignment runs against every launch record's uid at incarnation start (Task 3's sandbox-proven chown branches).
