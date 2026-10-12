# Soul Home Mounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every fresh-agent soul launches with a working config — absolute `{file:}` references under the operator's home (e.g. `{file:/home/dan/.amplifier/ms-runpod.key}`) resolve in-soul, killing the "bad file reference" incident class on the rootless production daemon.

**Architecture:** The supervisor bind-mounts the operator's home read-only at its own canonical path into every soul container and tmpfs-masks the control-plane subtrees inside it. Provider children keep their current identity (65534:0); under the rootless daemon their gid 0 is the operator's group, so group-readable operator files resolve through the mount with no identity change, no migration, and no digest churn. The session host emits a JSONL readiness event describing the mounted home from the child's perspective; launch never refuses.

**Tech Stack:** Rust workspace (`freshell-supervisor` raw Docker Engine HTTP backend, `freshell-session-host` in-container host), Docker Engine bind + tmpfs mounts, Playwright local-only runtime specs via the managed-runtime rig, pnpm 10.34.5 / Vitest.

**Spec:** the `## User Request` block in this document (ratified requirements). Provenance: `docs/plans/2026-10-09-soul-home-mounts.md` (superseded plan — load-bearing evidence and six review rounds of history) and `.worktrees/.the-usual-logs/soul-home-mounts/load-bearing-ledger.md` (verified claims). Where this plan and the superseded plan disagree, this plan wins.

## User Request

### Requested result
- Fresh-agent souls (managed-runtime incarnations for opencode, claude, codex, amplifier, kilroy) always launch with fully working configs: any config value referencing an absolute path under the operator's home (e.g. opencode `"apiKey": "{file:/home/dan/.amplifier/ms-runpod.key}"`) resolves inside the soul with no registration and no launch refusal, for every group-readable reference target under group-traversable home directories — the natural state of operator config content, established for the known config roots by the owned prep script (the ratified mechanism's scope; see the accepted-tradeoff boundary below). Regression: a freshopencode soul in `/home/dan/code/shapiroserver2` with the current global `~/.config/opencode/opencode.json` must boot opencode successfully where it dies today with "Configuration is invalid ... bad file reference".

### Explicit constraints
- Primary priority, stated by the user: "it works without bothering the user." No launch refusals, registration steps, approval prompts, or config re-authoring for this reference class.
- Chosen mechanism (ratified by the user 2026-10-10, superseding the original uid:gid proposal that the load-bearing stage falsified under the rootless production daemon): mount the operator's home read-only at its own path into every soul container; provider children KEEP running as 65534:0 — under the rootless daemon their gid 0 is the operator's group, so group-readable reference targets resolve with no identity change. No config scanner/rewriter/classifier machinery.
- The soul's purpose is resource bounding (CPU/memory/swap/pids) and clean process lifecycle, NOT data confidentiality (user ratified). Resource limits and teardown semantics must not change.
- Control-plane authorization material under the operator home (at minimum `~/.freshell`: incarnation secrets, MCP capability grants, server config secrets) must not become readable by provider children through the new mount — mask it inside the container.
- Home mount is read-only; provider writes go to the soul HOME volume and the workspace as today; workspace mounts stay read-write.
- Existing durable souls must keep working across the change (restated per the ratified 2026-10-10 design): with no identity change, launch records, digests, and provider volumes are untouched and nothing migrates.
- Unchanged: config-root staging/projection into the soul HOME volume, OneCLI env grants for `{env:}` references, auth.json provider-file grants, per-incarnation MCP capability mounts.
- Production self-hosted server must not be restarted without the user's explicit "APPROVED"; building and testing in worktrees is fine. Running souls keep their old mounts until natural incarnation replacement.
- TDD per repo rules; work in `.worktrees/soul-home-mounts`; PR to main only after explicit user approval.

### Accepted tradeoffs and residuals
- Ratified 2026-10-10: referenced files under the operator home become group-readable — the owned prep script establishes group traversal on the home root and the known config roots and group read on the `~/.amplifier` tree, and is re-run after Amplifier key rotations; Amplifier writing 0640/0750 going forward (tracked upstream item) makes rotations self-preserving. Rootful deployments degrade to today's behavior, observable via the readiness event, never gated.
- Boundary of the ratified mechanism, stated so the result and the tradeoff do not contradict each other: a config value referencing an in-home file the operator deliberately keeps owner-only (0600 file / 0700 subtree outside the prep-covered roots) — or a key freshly rotated at 0600 before the prep re-run — does not resolve until the operator extends the one-line prep (or re-runs it). The provider CLI's own error names the exact path. This mode-based boundary is the tradeoff the user accepted with the group-read ratification, not an uncovered defect: under the rootless mapping group bits grant exactly "processes running as the operator", which no other mechanism can express without the rejected scanner/copy machinery.
- Accepted posture change: souls can read the operator's home except masked control-plane paths. The "blast radius"/confidentiality concern was explicitly withdrawn by the user.
- `{env:}` references for new custom providers still require allow-list additions in `provider_secret_resolution.rs`; pressure is reduced but the mechanism is unchanged.
- References outside home/workspace/grants (rare) and cross-host drift (referenced file absent on this machine) still fail at runtime exactly as host CLIs would; an optional doctor lint is out of scope.
- If a genuine write-into-home case appears later, flip the mount to read-write then.

## Decided (load-bearing, non-negotiable)

Evidence and falsification history live in the superseded plan and the ledger; these are the surviving decisions an implementer must not re-litigate:

1. **The production Docker daemon is rootless.** Host uid 1000 maps to container uid 0, which protocol validation forbids for provider children; "run children as the operator uid" is impossible in production. Children stay 65534:0.
2. **Group-read is the mechanism.** Container gid 0 — which children already hold — is the operator's group under the rootless mapping. Verified empirically: a 65534:0 child read a 0644 operator file through a bound home and traversed a 0750 home root; 0700/0600 paths denied it (the incident's exact failure surface).
3. **tmpfs-over-bind masks work on the production daemon** (verified): RO home bind + `--tmpfs <home>/.freshell` yields an empty `.freshell` in-container with the rest of the home intact.
4. **runc cannot create missing mountpoints inside a read-only bind** — masks are filtered to destinations that exist at container creation, and the prep script creates the mask destinations so the filter never fires on a prepared host.
5. **No passwd entry, no ownership alignment, no migration**: the alignment walk needs DAC_OVERRIDE the session host lacks; `/etc/passwd` appends are impossible under `ReadonlyRootfs`; uid 65534 has no passwd entry today either.
6. **Rig facts**: rig supervisors run as root in a container (HOME env fallback must decline; the explicit flag is the rig's path); opencode 1.18.21 resolves native provider ids offline from its bundled models.dev snapshot and `{file:}` substitution is pre-schema, hard-failing on ENOENT and EACCES; the red reproduces through the `OPENCODE_CONFIG_CONTENT` inline lane; the harness umask is 0077 and creates `testRoot` and `/tmp/f<uid>` at 0700.

## Global Constraints

- pnpm 10.34.5 exactly; `pnpm run <script> <args>` forwards args directly (no `--` separator). Use `pnpm exec` for installed binaries.
- **Provider children stay 65534:0 everywhere.** No launch-record, protocol, digest, uid-constant, or fixture-identity changes. Any test that currently asserts `65534:0` stays as-is.
- The home mount is derived from an explicit supervisor flag or, only for a non-root supervisor, its `HOME` env: `--operator-home <path>` wins (canonicalized, owner-guarded); otherwise `HOME` is used only when the supervisor's euid is non-zero, its `HOME` canonicalizes, and the home's owner uid equals the supervisor's euid — a containerized or root supervisor (the rig's default) gets NO home mount from the env path; containerized deployments (the rig's Task 4 spec, compose via Task 5's wiring) pass the flag explicitly. Never refuse a launch over the home mount.
- Mask list (tmpfs, fixed): `<home>/.freshell`, `<home>/.amplifier/onecli`, `<home>/.config/gcloud`, filtered to destinations that exist at creation.
- **Host prep (owned, idempotent, re-runnable — never enforced by launch code):** referenced files must be group-readable (0640) under group-traversable directories (0750), including the home root. The owned step is `scripts/prepare-operator-home.sh` (Task 5). On rootful daemons group 0 is not the operator group, so the feature degrades to today's behavior with an observable readiness event — documented, not gated.
- Red-Green-Refactor TDD: every task adds its failing test first, watches it fail for the stated reason, implements minimally, refactors while green, and runs the impacted set.
- Test coordination (AGENTS.md): narrowed `cargo test -p <crate> -- <filters...>` selectors are delegated (no coordinator gate); multiple libtest filters go after `--`. New e2e specs are `LOCAL_ONLY` (register in `test/e2e-browser/playwright.config.ts`, where `LOCAL_ONLY_SPECS` is defined — the cloud config imports it).
- Never restart the production self-hosted server (port 3001) without the user's explicit "APPROVED". Building and running scratch supervisors/souls in the worktree is fine.
- No changes to: `copy_provider_config_references_with_ownership` projection semantics, `provider_secret_resolution.rs` env allow-lists, resource limits, teardown semantics, the `run_as_uid`/`run_as_gid` fields or their validation.
- Commits use `Dan Shapiro <3732858+danshapiro@users.noreply.github.com>` (repo config already provides it; do not override).

## Review Focus

The five uncovered failure modes most likely to bite a person, most likely first. Each is pinned by the named test in the task that owns the code:

1. **Amplifier rotates a key back to 0600** — souls show the named-path `bad file reference` error until the prep is re-run, and the re-run must restore group read. Pinned by the rotation assertion in Task 5's `prepare-operator-home` test.
2. **A home is missing a mask destination at soul creation** — the soul must still launch (filtered masks), and the prep must create the destinations so later souls mount the full set. Pinned by Task 1's `operator_home_mount_filters_masks_to_existing_destinations` and Task 5's mkdir assertions.
3. **Pre-upgrade running souls lack the marker env** — inspection must keep passing for them. Pinned by Task 2's marker-gate verification test.
4. **The session host cannot stat the mounted home** — the readiness event reports `present: false` and startup is unaffected. Pinned by Task 3's stat-failure assertion.
5. **A durable soul is verified after mask dirs appear/disappear on the host** — verification must use the persisted creation-time mask list, so a healthy soul passes. Pinned by Task 2's late-directory test.

(Already covered in-task, not repeated here: root-supervisor HOME never mounts; workspace-equals-home drops the mount; POSIX first-match DAC; umask-0077 fixture modes.)

---

### Task 1: Supervisor derives the operator-home mount (pure functions)

**Files:**
- Modify: `crates/freshell-supervisor/src/backend/docker.rs` (beside `TerminalMounts` ~34-42 and `workload_mounts` ~68-198; tests beside the existing tests ~340-390)

**Interfaces:**
- Consumes: `TerminalMounts` (docker.rs:34-42), `workload_mounts` (docker.rs:68-198) and the canonical `workspace` it computes at the top (docker.rs:77).
- Produces (Task 2 and Task 4 rely on these exact names and shapes):
  - `#[derive(Debug, Clone, PartialEq, Eq)] pub struct OperatorHomeMount { pub home: PathBuf, pub mask_rel_paths: Vec<String> }`, plus a new field `pub operator_home: Option<OperatorHomeMount>` on `TerminalMounts`.
  - `pub const OPERATOR_HOME_MASK_REL_PATHS: &[&str] = &[".freshell", ".amplifier/onecli", ".config/gcloud"];`
  - `pub fn explicit_operator_home(path: Option<&std::ffi::OsStr>, supervisor_euid: u32) -> Option<OperatorHomeMount>` — the `--operator-home` flag path: honored for a root supervisor too (under the rootless daemon the operator's files appear container-0-owned, so the owner guard holds for the rig's root supervisor).
  - `pub fn operator_home_mount(home_env: Option<&std::ffi::OsStr>, supervisor_euid: u32) -> Option<OperatorHomeMount>` — the env fallback: same guards PLUS `supervisor_euid != 0` (a root/containerized supervisor's `HOME` is not the operator's host home; `/root` must never mount).
  - Both: canonicalize, require an existing directory, require `st_uid == supervisor_euid`, and filter `OPERATOR_HOME_MASK_REL_PATHS` to entries that already exist as directories (runc cannot create a mountpoint inside a read-only bind).
  - `fn effective_operator_mount(mount: Option<OperatorHomeMount>, workspace: &Path) -> Option<OperatorHomeMount>` — `.filter(|mount| mount.home != workspace)`: the pre-existing home-as-workspace soul shape keeps its legacy behavior (no bind, no masks, no marker env). `Some(_)` always means: workspace differs from home, bind and all masks emitted, marker env set.

- [ ] **Step 1: Write the failing behavioral test**

In the docker.rs tests module:

```rust
#[test]
fn operator_home_mount_derives_masks_and_requires_operator_ownership() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    for rel in [".freshell", ".amplifier/onecli", ".config/gcloud"] {
        std::fs::create_dir_all(home.join(rel)).unwrap();
    }
    use std::os::unix::fs::MetadataExt;
    let owner = std::fs::metadata(&home).unwrap().uid() as u32;
    let mount = operator_home_mount(Some(home.as_os_str()), owner).expect("owned home mounts");
    assert_eq!(mount.home, home.canonicalize().unwrap());
    assert_eq!(mount.mask_rel_paths, vec![".freshell", ".amplifier/onecli", ".config/gcloud"]);
    // A home owned by a different uid (e.g. root's /) must never mount.
    assert!(operator_home_mount(Some(std::path::Path::new("/").as_os_str()), owner).is_none());
}

#[test]
fn operator_home_mount_filters_masks_to_existing_destinations() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    std::fs::create_dir_all(home.join(".freshell")).unwrap();
    use std::os::unix::fs::MetadataExt;
    let owner = std::fs::metadata(&home).unwrap().uid() as u32;
    let mount = operator_home_mount(Some(home.as_os_str()), owner).expect("owned home mounts");
    assert_eq!(mount.mask_rel_paths, vec![".freshell"]);
}

#[test]
fn operator_home_mount_is_dropped_when_workspace_equals_home() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    std::fs::create_dir_all(home.join(".freshell")).unwrap();
    let home = home.canonicalize().unwrap();
    use std::os::unix::fs::MetadataExt;
    let owner = std::fs::metadata(&home).unwrap().uid() as u32;
    let mount = operator_home_mount(Some(home.as_os_str()), owner).unwrap();
    assert_eq!(effective_operator_mount(Some(mount.clone()), &home), None);
    let workspace = home.join("code").join("repo");
    std::fs::create_dir_all(&workspace).unwrap();
    assert!(effective_operator_mount(Some(mount), &workspace).is_some());
}

#[test]
fn operator_home_mount_skips_unset_or_missing_home() {
    let euid = unsafe { libc::geteuid() };
    assert!(operator_home_mount(None, euid).is_none());
    let tmp = tempfile::tempdir().unwrap();
    assert!(operator_home_mount(Some(tmp.path().join("nope").as_os_str()), euid).is_none());
}

#[test]
fn operator_home_env_path_never_mounts_for_a_root_supervisor() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    assert!(operator_home_mount(Some(home.as_os_str()), 0).is_none());
}

#[test]
fn explicit_operator_home_flag_applies_the_owner_guard() {
    // The rig supervisor runs as root in its container; under the rootless
    // daemon the operator's files appear container-0-owned, so the explicit
    // flag path mounts for it while the owner guard still rejects unowned homes.
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    use std::os::unix::fs::MetadataExt;
    let owner = std::fs::metadata(&home).unwrap().uid() as u32;
    assert_eq!(
        explicit_operator_home(Some(home.as_os_str()), owner).map(|m| m.home),
        Some(home.canonicalize().unwrap())
    );
    assert_eq!(explicit_operator_home(Some(home.as_os_str()), owner + 1), None);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p freshell-supervisor -- operator_home_mount explicit_operator_home`
Expected: FAIL to compile — `OperatorHomeMount`, `operator_home_mount`, `explicit_operator_home`, and `effective_operator_mount` do not exist.

- [ ] **Step 3: Implement in `crates/freshell-supervisor/src/backend/docker.rs`**

Add the struct, the const, and the three functions per the Interfaces block. Shared guard logic may live in one private helper; the env fallback differs from the flag path only by the `supervisor_euid != 0` precondition. Do not wire anything into `workload_mounts` yet — that is Task 2.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p freshell-supervisor -- operator_home_mount explicit_operator_home`
Expected: PASS

- [ ] **Step 5: Refactor while green**

Only if the two constructors share duplicated guard code: extract the shared helper now.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-supervisor`
Expected: PASS (nothing consumes the new functions yet, so all existing behavior is unchanged).

- [ ] **Step 7: Commit**

```bash
git add crates/freshell-supervisor/src/backend/docker.rs
git commit -m "feat(supervisor): operator-home mount derivation with existing-destination mask filter"
```

### Task 2: Supervisor wires the mount into container creation

**Files:**
- Modify: `crates/freshell-supervisor/src/backend/docker.rs` (`workload_mounts` wiring, ~68-198)
- Modify: `crates/freshell-supervisor/src/backend.rs` (binds assembly ~572-618, `runtime_host_environment` ~402-497, `docker_create_body` tmpfs merge, `verify_inspect_config` ~993-1030, terminal mount-record persistence)
- Modify: `crates/freshell-supervisor/src/main.rs` (new `--operator-home <path>` CLI flag, ~34 area)
- Test: inline unit tests in both backend files

**Interfaces:**
- Consumes: Task 1's `OperatorHomeMount`, `explicit_operator_home`, `operator_home_mount`, `effective_operator_mount`; `runtime_host_environment` (backend.rs:402-497), `runtime_tmpfs(runtime_mode)` (backend.rs:629), `docker_create_body` (backend.rs:640), `verify_inspect_config` (backend.rs:993-1030); the `--registry-root`/`--host-binary` arg-parsing pattern in main.rs.
- Produces:
  - `fn assemble_workload_binds(...) -> anyhow::Result<(Vec<String>, std::collections::BTreeMap<String, String>)>` in backend.rs — the existing inline binds/tmpfs assembly at lines 572-618 extracted out of `create_stopped` (preserve its existing parameters; the existing code is authoritative), extended so that when `mounts.operator_home` is `Some(_)` the binds gain `format!("{}:{}:ro", home, home)` and the tmpfs map gains `format!("{home}/{rel}") -> String::new()` for every `mask_rel_paths` entry. Additive keys win; existing tmpfs destinations are never dropped.
  - `TerminalMounts.operator_home` populated by `workload_mounts` as `effective_operator_mount(explicit_operator_home(std::env::var_os("FRESHELL_SUPERVISOR_OPERATOR_HOME").as_deref(), euid).or_else(|| operator_home_mount(std::env::var_os("HOME").as_deref(), euid)), &workspace)` where `workspace` is the canonical workspace from the top of `workload_mounts`.
  - `runtime_host_environment` gains a `mounted_home: Option<&Path>` parameter (threaded from `create_stopped`): when present it emits `FRESHELL_OPERATOR_HOME_MOUNT=1` and `FRESHELL_OPERATOR_HOME=<canonical path>` (consumed by Task 3).
  - main.rs parses `--operator-home <path>` and publishes it to its own process as `FRESHELL_SUPERVISOR_OPERATOR_HOME` before serving; no new parameter threads through the backend.
  - **Time-invariance contract:** the mask set is creation-time state. `verify_inspect_config` must NOT recompute it: persist the resolved `OperatorHomeMount` (home + filtered `mask_rel_paths`) in the terminal's persisted mount record at `create_stopped` (the record inspection reads today; if no mount record is persisted there yet, add the field to whatever durable record `create_stopped`'s caller stores for verification), and compare the container's live tmpfs/bind topology against the STORED list — and only when the inspected env contains `FRESHELL_OPERATOR_HOME_MOUNT=1` (pre-upgrade containers lack the marker and must keep passing).

- [ ] **Step 1: Write the failing behavioral test**

In backend.rs tests (fixture pattern: the `CODEX_CMD` spec fixture at ~1637-1763):

```rust
#[test]
fn workload_binds_include_read_only_home_and_mask_tmpfs() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    let workspace = home.join("code").join("repo");
    std::fs::create_dir_all(&workspace).unwrap();
    let home = home.canonicalize().unwrap();
    let mounts = TerminalMounts {
        workspace: workspace.clone(),
        git_common_dir: None,
        provider_bootstrap_files: vec![],
        provider_secret_files: vec![],
        provider_user_root: None,
        mcp_capability_file: None,
        operator_home: Some(OperatorHomeMount {
            home: home.clone(),
            mask_rel_paths: vec![".freshell".to_string()],
        }),
    };
    let (binds, tmpfs) = assemble_workload_binds(&tmp.path().join("binary"), &tmp.path().join("runtime"), "provider-vol", None, Some(&mounts)).unwrap();
    assert!(binds.contains(&format!("{}:{}:ro", home.display(), home.display())));
    assert!(binds.contains(&format!("{}:{}:rw", workspace.display(), workspace.display())));
    assert_eq!(tmpfs.get(&format!("{}/.freshell", home.display())).map(String::as_str), Some(""));
}

#[test]
fn home_mount_env_marker_is_set_only_when_mounted() {
    let spec = fresh_agent_spec_fixture();
    let mounted = runtime_host_environment(None, Some(&spec), Some(std::path::Path::new("/home/op"))).unwrap();
    assert!(mounted.iter().any(|e| e == "FRESHELL_OPERATOR_HOME_MOUNT=1"));
    assert!(mounted.iter().any(|e| e == "FRESHELL_OPERATOR_HOME=/home/op"));
    let unmounted = runtime_host_environment(None, Some(&spec), None).unwrap();
    assert!(!unmounted.iter().any(|e| e.starts_with("FRESHELL_OPERATOR_HOME")));
}
```

Plus two verification-contract tests (constructing the inspected-container fixture the existing `verify_inspect_config` tests use):

```rust
#[test]
fn verify_inspect_config_ignores_home_mounts_without_the_marker_env() {
    // Pre-upgrade running souls lack FRESHELL_OPERATOR_HOME_MOUNT entirely;
    // inspection must keep passing for them.
    // Env: no marker. Container topology: legacy mounts only.
    // Assert: verify_inspect_config accepts (no home assertions fire).
}

#[test]
fn verify_inspect_config_uses_the_persisted_creation_time_mask_list() {
    // Late-directory case: a soul created with masks [".freshell"] because
    // .config/gcloud was absent, verified AFTER the directory appears on the
    // host, must still PASS against the persisted creation-time list.
    // And a container whose live tmpfs topology no longer matches its own
    // persisted list must FAIL.
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p freshell-supervisor -- workload_binds home_mount_env_marker verify_inspect_config_ignores verify_inspect_config_uses`
Expected: FAIL to compile — `assemble_workload_binds` and the `mounted_home` parameter do not exist; the verification tests fail (no persistence, no marker gate).

- [ ] **Step 3: Implement**

Extract `assemble_workload_binds` per the Interfaces block and add the `operator_home` block to it; wire `workload_mounts` to populate `operator_home` (the exact expression in Interfaces); thread `mounted_home` through `runtime_host_environment`; add the `--operator-home` flag in main.rs; persist the resolved `OperatorHomeMount` at `create_stopped` and gate `verify_inspect_config`'s home assertions on the marker env, comparing against the persisted list.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p freshell-supervisor -- workload_binds home_mount_env_marker verify_inspect_config_ignores verify_inspect_config_uses`
Expected: PASS

- [ ] **Step 5: Refactor while green**

The extraction of binds assembly is itself the refactor; no further cleanup expected.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: all `freshell-supervisor` tests (mount assembly, digest, inspect verification) plus `freshell-runtime-protocol` spec tests.
Run: `cargo test -p freshell-supervisor && cargo test -p freshell-runtime-protocol`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add crates/freshell-supervisor/src/backend.rs crates/freshell-supervisor/src/backend/docker.rs crates/freshell-supervisor/src/main.rs
git commit -m "feat(supervisor): wire operator home bind, masks, env markers, and time-invariant verification"
```

### Task 3: Session host emits an operator-home readiness event

**Files:**
- Modify: `crates/freshell-session-host/src/main.rs` (startup path after arg parsing; the JSONL event pattern at ~2513)
- Test: inline unit tests in `main.rs`

**Interfaces:**
- Consumes: env `FRESHELL_OPERATOR_HOME` and `FRESHELL_OPERATOR_HOME_MOUNT` (Task 2), env `FRESHELL_PROVIDER_RUN_AS_UID`/`FRESHELL_PROVIDER_RUN_AS_GID` (already in `runtime_host_environment`; default 65534/0 when unset), the existing `append_event_with_secret` journal pattern.
- Produces:
  - `fn child_can_traverse(mode_bits: u32, owner_uid: u32, owner_gid: u32, child_uid: u32, child_gid: u32) -> bool` — POSIX DAC, FIRST-match class selection (a matched class with no execute bit denies even when a later class carries it).
  - Startup emission: when both marker env vars are set, `std::fs::metadata` the home path and append exactly one JSONL event `operator_home_readiness` with `path`, `present`, `uid`, `gid`, `mode` (octal string), and `home_root_traversable_by_child` computed by the pure function against the run-as identity. No secret bytes; home-root scope only. Stat failure logs `present: false` and never fails startup. Never affects launch outcome.

- [ ] **Step 1: Write the failing behavioral test**

```rust
#[test]
fn child_can_traverse_evaluates_dac_classes() {
    // All metadata is the IN-CONTAINER view. Under the rootless daemon an
    // operator-owned file (host uid/gid 1000) appears as container 0:0, and
    // the child's gid 0 then matches the file's group.
    assert!(child_can_traverse(0o700, 1000, 1000, 1000, 0));      // owner-x, child is owner
    assert!(child_can_traverse(0o750, 0, 0, 65_534, 0));           // group-x, gid match: the rootless production shape
    assert!(!child_can_traverse(0o750, 1000, 1000, 65_534, 0));    // group-x but gid mismatch: the rootful shape
    assert!(!child_can_traverse(0o700, 0, 0, 65_534, 0));          // the incident's failure surface
    assert!(!child_can_traverse(0o701, 0, 0, 65_534, 0));          // first-match: group with no x cannot fall through to other-x
    assert!(child_can_traverse(0o701, 1000, 1000, 65_534, 65_534)); // other-x applies when neither uid nor gid matches
}

#[test]
fn readiness_event_reflects_real_home_metadata_and_survives_stat_failure() {
    // Case A (metadata): with FRESHELL_OPERATOR_HOME=<temp dir, mode 0750,
    // owned by the test uid>, FRESHELL_OPERATOR_HOME_MOUNT=1, and
    // FRESHELL_PROVIDER_RUN_AS_UID/GID=65534/0, the startup emission must
    // produce exactly one operator_home_readiness event whose fields match
    // the stat and whose home_root_traversable_by_child equals
    // child_can_traverse(...). Use the existing session-host event-journal
    // test fixture (events near main.rs:2513) with a temp state dir.
    // Case B (Review Focus 4): with FRESHELL_OPERATOR_HOME pointing at a
    // path that does not exist, the emission must produce one event with
    // present: false and startup must continue.
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p freshell-session-host -- child_can_traverse readiness_event`
Expected: FAIL to compile — `child_can_traverse` and the emission do not exist.

- [ ] **Step 3: Implement**

Add `child_can_traverse` per Interfaces (first-match class selection) and the startup emission after arg parsing.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p freshell-session-host -- child_can_traverse readiness_event`
Expected: PASS

- [ ] **Step 5: Refactor while green**

None expected; the function is single-purpose.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-session-host`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add crates/freshell-session-host/src/main.rs
git commit -m "feat(session-host): operator home readiness event with stat-failure tolerance"
```

### Task 4: E2E regression — freshopencode soul boots with `{file:}` key references

**Files:**
- Create: `test/e2e-browser/specs/runtime-opencode-home-file-reference-rust.spec.ts`
- Modify: `scripts/testing/runtime-test-broker.ts` (allow-list policy types/arms, ~330-380 structure)
- Modify: `scripts/testing/runtime-sandbox.ts` (`RuntimeHarness.prepare()` — where the broker allow lists are constructed)
- Modify: `test/e2e-browser/playwright.config.ts` (add the spec to `LOCAL_ONLY_SPECS`, defined here — the cloud config imports it)

**Interfaces:**
- Consumes: the rig pattern of `test/e2e-browser/specs/runtime-fresh-agent-qualification-rust.spec.ts` (fresh-agent pane lifecycle, first-send-then-running-view flow, `runningViewForFreshSession`), `ManagedRuntimeBrowserRig`'s `webHomeDir` constructor option (managed-runtime.ts:79-106; `start()` runs `runtime.prepare()` at line 118 — which WIPES and recreates testRoot — then starts the supervisor at 153), the rig's provider-uid exec helper (a SYNCHRONOUS `65534:0` exec in runtime-sandbox.ts ~896 that takes an ARGUMENT ARRAY and THROWS on nonzero exit), and the NEW `operatorHome` option this task adds to the rig's supervisor launcher (passed through `startSupervisor` as the `--operator-home` flag — the rig supervisor runs as root, so the env fallback declines and the flag is the only path). Authoritative seam list: `.worktrees/.the-usual-logs/soul-home-mounts/reports/load-bearing-validator-lb11.md`.
- Produces: a reproducible spec proving the incident class is fixed on the real rootless daemon via the FRESH-AGENT launch path (not the terminal picker); the rig's `operatorHome` supervisor option; broker allow-list arms admitting read-only same-path home binds and tmpfs mask destinations.

- [ ] **Step 1: Write the failing behavioral test**

Mirror the qualification spec's real imports/rig calls (read it first; the sketch names the verified seams, not the final API surface). Fixture lifecycle is load-bearing: create home fixtures AFTER `await rig.start()` (prepare() wipes testRoot) and BEFORE launching the pane (the server stages the user-provider root at pane creation, so post-start fixtures are picked up).

```ts
// Fixture (created after rig.start(), owned by the test process = the operator):
// The harness umask is 0077 — EVERY directory the child must traverse gets an
// EXPLICIT mode (recursive mkdir under 0077 yields 0700 and the 65534:0 child
// cannot reach even the 0640 key):
//   - <home>/ created, then chmod 0750 on <home>, <home>/.amplifier, <home>/.config
//   - <home>/.amplifier/ms-runpod.key ("e2e-key-not-real", mode 0640)
//   - <home>/.config/opencode/opencode.json:
//     { "$schema": "https://opencode.ai/config.json",
//       "provider": { "openai": { "name": "OpenAI",
//         "options": { "apiKey": "{file:<home>/.amplifier/ms-runpod.key}" } } },
//       "model": "openai/gpt-5.6-luna" }   // native provider id: validates offline
//   - Canary files under EVERY mask destination (all three, to exercise the
//     full mask set; <home>/.freshell already exists — the rig writes config.json
//     there at startup): <home>/.amplifier/onecli/canary, <home>/.config/gcloud/canary
//   - chmod 0750 on <testRoot> and /tmp/f<uid> ancestors (harness creates them 0700)
test('freshopencode soul resolves {file:} API key references under the operator home', async () => {
  const info = await rig.start()
  // ...create home fixtures above, using info's testRoot...
  const sessionId = await rig.launchFreshAgentPane('opencode') // fresh-agent helper per the qualification spec
  // The composer's ready state renders via its textarea PLACEHOLDER ("Send a
  // message…"), not text content — see FreshAgentComposer.tsx.
  await expect(page.getByPlaceholder('Send a message')).toBeVisible({ timeout: 120_000 })
  // nativeSessionId materializes only after the first send; the turn may fail
  // auth (the key is fake) but the child must be alive — pre-fix, opencode dies
  // at startup with the config error and never reaches this state.
  await rig.sendFreshAgentTurn(sessionId, 'ping')
  const view = await rig.runningViewForFreshSession(sessionId)
  expect(view?.nativeSessionId).toBeTruthy()
  const paneText = await rig.capturePaneText()
  expect(paneText).not.toContain('Configuration is invalid')
  expect(paneText).not.toContain('bad file reference')
  // POSITIVE CONTROL — the child (65534:0) reads the unmasked 0640 key without
  // throwing: traversal and group-read work, so the canary throws below are
  // attributable ONLY to the masks. The helper is synchronous and throws on
  // nonzero exit, so assert throws — not promise rejections.
  expect(() => rig.ownedProviderExec(soulRef, ['cat', `${home}/.amplifier/ms-runpod.key`])).not.toThrow()
  // Mask proof: a WORKING mask makes each canary ABSENT (empty tmpfs dir), so
  // `cat` exits nonzero and the helper throws. A readable canary would return
  // a string and not throw — red/green semantics hold.
  for (const secret of [`${home}/.freshell/config.json`, `${home}/.amplifier/onecli/canary`, `${home}/.config/gcloud/canary`]) {
    expect(() => rig.ownedProviderExec(soulRef, ['cat', secret])).toThrow()
  }
})
```

Allow-list changes in BOTH files: policy types/arms in `runtime-test-broker.ts` (an `allowedOperatorHomeRoots` set plus a same-path read-only bind arm `dest === source && mode === 'ro'`, and tmpfs allow arms for the three mask destinations, following the existing arm structure ~330-380), constructed in `RuntimeHarness.prepare()` in `runtime-sandbox.ts` — without this the supervisor's home bind is rejected before the pane ever launches.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run test:e2e:local test/e2e-browser/specs/runtime-opencode-home-file-reference-rust.spec.ts --project=chromium` (match the qualification spec's canonical invocation if it differs)
Expected: FAIL before Task 1's supervisor change is wired into the rig — the freshopencode pane shows `Configuration is invalid ... bad file reference` exactly like the production incident (the `{file:}` reference rides the `OPENCODE_CONFIG_CONTENT` inline lane and the target is unreadable to the 65534:0 child). After Tasks 1-2 land, the same command must PASS. If Tasks 1-2 are already on the branch, confirm the red in a scratch run by removing the rig's `operatorHome` option (NOT the HOME env — the flag takes precedence over the env fallback, so unsetting HOME cannot remove the mount) and record it in the commit message; never weaken the spec to fabricate a red.

- [ ] **Step 3: Implement**

No production change: this task is the system-level proof. The rig `operatorHome` option and the broker/sandbox allow-list arms in Step 1 are the implementation.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm run test:e2e:local test/e2e-browser/specs/runtime-opencode-home-file-reference-rust.spec.ts --project=chromium`
Expected: PASS — the freshopencode fresh-agent child starts (running view with a native session id), the composer reaches its ready state, and no "Configuration is invalid" text appears.

- [ ] **Step 5: Refactor while green**

Extract the home-fixture builder into the shared helper beside `managed-runtime.ts` only if the qualification spec would reuse it; otherwise leave.

- [ ] **Step 6: Run impacted-test verification**

Run: `pnpm run test:vitest run test/unit/tooling/testing/runtime-test-broker.test.ts --config config/vitest/vitest.config.ts` and the repo's filtered runtime-spec lane (`pnpm run test:e2e:local --project=chromium --grep runtime`, matching the repo's lane).
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add test/e2e-browser/specs/runtime-opencode-home-file-reference-rust.spec.ts scripts/testing/runtime-test-broker.ts scripts/testing/runtime-sandbox.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): freshopencode soul boots with {file:} operator-home key references"
```

### Task 5: Host-prep script, compose wiring, and posture documentation

**Files:**
- Create: `scripts/prepare-operator-home.sh`
- Create: `test/unit/scripts/prepare-operator-home.test.ts`
- Modify: `docker/runtime/compose.yaml` (supervisor service: operator-home bind + `--operator-home`)
- Modify: `docs/development/managed-runtime.md` (~217, ~220-225, ~329-338)
- Modify: `docs/development/self-hosted-launch-runbook.md` (prep step + re-run-after-rotation note)
- Modify: `docker/runtime/README.md` (~19-30)

**Interfaces:**
- Consumes: Task 2's `--operator-home` flag and env markers, Task 3's readiness event.
- Produces: `scripts/prepare-operator-home.sh` — the OWNED, idempotent host-prep step (behavioral test below); compose wiring so rootless compose deployments deliver the feature; documentation. No server behavior change.

- [ ] **Step 1: Write the failing behavioral test**

```ts
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SCRIPT = join(__dirname, '..', '..', '..', 'scripts', 'prepare-operator-home.sh')

function fixtureHome(): string {
  // mkdtemp creates the home root itself at 0700 — the exact condition that
  // must be prepared (a 0700 home root blocks the child from reaching even a
  // prepared key). The fixture deliberately does NOT create the mask
  // destinations — the script must.
  const home = mkdtempSync(join(tmpdir(), 'prep-home-'))
  mkdirSync(join(home, '.amplifier'), { recursive: true })
  chmodSync(join(home, '.amplifier'), 0o700)
  writeFileSync(join(home, '.amplifier', 'ms-runpod.key'), 'k')
  chmodSync(join(home, '.amplifier', 'ms-runpod.key'), 0o600)
  mkdirSync(join(home, '.config'), { recursive: true })
  chmodSync(join(home, '.config'), 0o700)
  mkdirSync(join(home, '.local', 'share'), { recursive: true })
  chmodSync(join(home, '.local'), 0o700)
  return home
}

function run(home: string): void {
  execFileSync('bash', [SCRIPT], { env: { ...process.env, FRESHELL_OPERATOR_HOME: home } })
}

describe('prepare-operator-home', () => {
  it('makes the home root and known config roots group-traversable, the amplifier tree group-readable, and creates every mask destination', () => {
    const home = fixtureHome()
    run(home)
    expect(statSync(home).mode & 0o050).toBe(0o050)
    expect(statSync(join(home, '.local')).mode & 0o050).toBe(0o050)
    expect(statSync(join(home, '.amplifier')).mode & 0o050).toBe(0o050)
    expect(statSync(join(home, '.amplifier', 'ms-runpod.key')).mode & 0o040).toBe(0o040)
    expect(statSync(join(home, '.config')).mode & 0o050).toBe(0o050)
    // Review Focus 2: the mask destinations must exist after prep so every
    // later soul mounts the full mask set.
    expect(existsSync(join(home, '.freshell'))).toBe(true)
    expect(existsSync(join(home, '.amplifier', 'onecli'))).toBe(true)
    expect(existsSync(join(home, '.config', 'gcloud'))).toBe(true)
  })

  it('is idempotent, tolerates an empty home, and restores group read after a 0600 rotation', () => {
    const home = fixtureHome()
    run(home)
    const afterFirst = statSync(join(home, '.amplifier', 'ms-runpod.key')).mode
    run(home)
    expect(statSync(join(home, '.amplifier', 'ms-runpod.key')).mode).toBe(afterFirst)
    // Review Focus 1: Amplifier rotation recreates the key at 0600; the re-run
    // must restore group read.
    writeFileSync(join(home, '.amplifier', 'ms-runpod.key'), 'k2')
    chmodSync(join(home, '.amplifier', 'ms-runpod.key'), 0o600)
    run(home)
    expect(statSync(join(home, '.amplifier', 'ms-runpod.key')).mode & 0o040).toBe(0o040)
    const empty = mkdtempSync(join(tmpdir(), 'prep-empty-'))
    expect(() => run(empty)).not.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run test:vitest run test/unit/scripts/prepare-operator-home.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — the script does not exist yet.

- [ ] **Step 3: Implement `scripts/prepare-operator-home.sh`**

Behavior pinned by the test and Global Constraints; `set -euo pipefail`; `home="${FRESHELL_OPERATOR_HOME:-$HOME}"`; exits 0 and prints `nothing to prepare` when no targets exist:

1. `mkdir -p` every mask destination that is absent: `$home/.freshell`, `$home/.amplifier/onecli`, `$home/.config/gcloud` (runc cannot mount a tmpfs mask over a missing directory in the read-only bind; a soul created while a destination is absent gets that mask filtered for its whole lifetime — the prep runs at deploy, before new incarnations).
2. `chmod g+rx` the home root and ancestors of the covered roots that exist: `$home`, `$home/.local`, `$home/.config`, `$home/.local/share`.
3. Whole-tree group read for the secret-bearing root: `find "$home/.amplifier" -type d -exec chmod g+rx {} +` and `-type f -exec chmod g+r {} +` (covers keys regardless of naming).
4. Print each change; end with the note that Amplifier must write keys 0640 and `~/.amplifier` 0750 going forward so rotation preserves this (tracked upstream item).

`docker/runtime/compose.yaml` — the supervisor service gets the operator-home bind and flag so rootless compose deployments deliver the feature too. The bind source is resolved by the daemon on the daemon HOST, so the path inside the supervisor container must be the operator home's canonical host path, mounted at itself, read-only; the flag carries the same path (whose `st_uid` appears as container 0 under the rootless mapping — matching the root supervisor's euid and passing the owner guard). The service currently defines no supervisor command (its image defaults to `/bin/bash`), so add a real `command:` block mirroring the supervisor's documented launch (its existing args such as `--registry-root`) plus:

```yaml
# volumes (beside the existing binds; the SAME canonical host path both sides):
#   - /home/<operator>:/home/<operator>:ro
# command args (after the supervisor's existing documented args):
#   --operator-home /home/<operator>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm run test:vitest run test/unit/scripts/prepare-operator-home.test.ts --config config/vitest/vitest.config.ts`
Expected: PASS

- [ ] **Step 5: Refactor while green**

None needed; the script is single-purpose.

- [ ] **Step 6: Run impacted-test verification**

Run: `bash -n scripts/prepare-operator-home.sh` plus the vitest run above; run the compose config lint the repo uses for docker/runtime if one exists (otherwise note the skip). Docs changes are review-verified.

Docs content:

`docs/development/self-hosted-launch-runbook.md`: add the prep step — after deploying, run `scripts/prepare-operator-home.sh` once as the operator, and re-run it after any Amplifier key rotation (rotation that recreates keys at 0600 would otherwise restore the original failure; this one-command re-run is the ratified tradeoff, not a gap — the failing provider's error names the exact path); the `operator_home_readiness` event confirms the home root's group traversal afterward.

`docs/development/managed-runtime.md`:
- Replace the "no unrelated home" bullet (~220-225) and the rootless uid rationale (~329-338) with the new contract: souls mount the operator home read-only at its canonical path; provider children keep 65534:0; under the rootless production daemon the child's gid 0 is the operator's group, so group-readable reference targets (0750 directories, 0640 key files) resolve with no identity change; the `--operator-home` flag, the compose wiring, and the owner/euid guards (containerized supervisors pass the flag explicitly; the HOME env fallback works only for non-root host supervisors); the tmpfs mask list and why each entry is control-plane or infrastructure authorization material; the additive `FRESHELL_OPERATOR_HOME_MOUNT`/`FRESHELL_OPERATOR_HOME` env markers and that pre-upgrade running containers lack them; the `operator_home_readiness` event (home-root scope: `home_root_traversable_by_child`) and how to read it when a `{file:}` reference fails; the rootful-degradation note (group 0 is not the operator group, feature degrades to legacy readability, observed via the readiness event, never gated).
- Add the operator prep section referencing `scripts/prepare-operator-home.sh`, the re-run-after-rotation rule, and the tracked upstream Amplifier item (write keys 0640, `~/.amplifier` 0750), with the reasoning that under the rootless mapping group-dan access is effectively "processes running as the operator" on this single-user host.
- State the two accepted residuals precisely: (1) the mode-based boundary — a deliberately owner-only file outside the prep-covered roots, or a key rotated at 0600 before the re-run, needs the one-line prep extension/re-run, the provider CLI's error names the exact path, and this is the user-ratified tradeoff (repeat the User Request block's boundary bullet verbatim so doc readers see the same contract); (2) the mask set is computed at container creation — a control-plane path created after a soul is running is unmasked for that soul until its next incarnation, primary protection is those paths' own owner-only modes (gcloud/onecli create 0700 dirs), and every new incarnation re-derives the masks. Also state the mask/filter invariant pair that closes the exposure window: the prep mkdir's every mask destination at deploy, so on a prepared host each home-bound soul mounts the FULL mask set for its lifetime and a prep re-run cannot expose a running soul; on an unprepared host the filter can fire, but unprepared content is owner-only (0700/0600), so the unmasked paths expose nothing a child can read. Exposure would require simultaneously group-readable content AND a missing mask destination — the prep creates exactly the opposite pairing; manual partial prep is out of model.

`docker/runtime/README.md` (~19-30): update the uid story (session host uid 0; provider children 65534:0 unchanged; no passwd entry — same as today) and reword the 0600-secret guarantee around the masked-home boundary.

- [ ] **Step 7: Commit**

```bash
git add scripts/prepare-operator-home.sh test/unit/scripts/prepare-operator-home.test.ts docker/runtime/compose.yaml docs/development/managed-runtime.md docs/development/self-hosted-launch-runbook.md docker/runtime/README.md
git commit -m "feat(deploy): operator home prep script with behavioral test, compose wiring, and posture docs"
```

## Verification (user-visible outcome)

1. The incident scenario end-to-end: Task 4's spec on the real rootless daemon — a freshopencode fresh-agent pane (fresh-agent launch path) with a `{file:}`-referencing global config starts its child (native session id), reaches the composer's ready state, and shows no "Configuration is invalid" text.
2. Production, after user-approved deploy and one run of `scripts/prepare-operator-home.sh` (Task 5): a freshopencode pane in `/home/dan/code/shapiroserver2` with the real global `~/.config/opencode/opencode.json` boots opencode.
3. Pre-upgrade running souls: untouched by construction — no identity, record, digest, or volume changes; replaced incarnations naturally gain the home mount.
4. Control-plane safety, proven from the child's own identity in Task 4's spec: `~/.freshell`, `~/.amplifier/onecli`, and `~/.config/gcloud` are tmpfs-masked in-soul (the provider-uid exec throws on each canary, after the positive control proves the unmasked key reads); all other operator secrets remain protected by their owner-only modes.
5. Resource bounding and teardown: unchanged (no limits code touched); the full `pnpm run check` gate before any PR proves it.
