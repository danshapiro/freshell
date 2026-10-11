# Soul Home Mounts Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

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

## Load-bearing revisions (2026-10-10)

The load-bearing stage falsified the request's proposed mechanism and replaced it with a simpler one that delivers the same requested result. Decisions and consequences (evidence lives in the reports cited, never inline):

1. **The production Docker daemon is rootless** (LB-05, falsified). Under rootless user-namespace mapping the operator's host uid (1000) is container uid 0, which protocol validation forbids for provider children, and any other container uid maps to an unrelated subuid. "Run provider children as the operator's uid" cannot deliver under the production daemon and is dropped. Evidence: `docker info` Security Options, supervisor args (`/run/user/1000/docker.sock`); ledger `load-bearing-ledger.md`.
2. **Provider children keep running as 65534:0 — no identity change anywhere** (consequence of 1). Launch records, the immutable digest, the ~25 uid-hardcoded test sites, and all durable volumes stay byte-identical; pre-upgrade souls need no migration. The earlier tasks 2 (uid change) and 3 (ownership alignment + passwd entry) are deleted — the alignment walk was also independently falsified (LB-01: the session host has no DAC_OVERRIDE and cannot traverse foreign-owned 0700 trees), and the `/etc/passwd` append is impossible under `ReadonlyRootfs` (LB-07) with zero regression since uid 65534 has no passwd entry today either.
3. **The mechanism is group-read, not uid-switch** (LB-12, verified empirically on the live daemon). Under the rootless mapping, container gid 0 — which children already hold — is the operator's own group: a 65534:0 child read a 0644 operator file through a bound home and traversed the 0750 home root, while 0700/0600 operator paths denied it (exactly the incident's failure surface). The referenced files fail today only for lack of group bits. Consequence: the host prep in Global Constraints (one-time chmod; Amplifier writes group-readable keys going forward) is REQUIRED for the requested result; Freshell launch code never enforces or refuses on it — it only reports (Task 2's readiness event). This is the tradeoff the user must ratify (LB-13, `load-bearing-ledger.md`).
4. **tmpfs-over-bind masks work on the production daemon** (LB-04, verified): a read-only home bind plus `--tmpfs <home>/.freshell` yielded an empty `.freshell` inside the container with the rest of the home intact. The masking strategy stands, with `~/.config/gcloud` added to the mask list as zero-cost defense-in-depth for gcloud-robot infrastructure credentials (finder residual, accepted).
5. **Supervisor topology verified** (LB-02): the production supervisor runs as `dan` with `HOME=/home/dan`. The home-mount derivation keeps using the supervisor's HOME env, now guarded by a home-owner check (skip the mount unless the home's st_uid equals the supervisor euid) so no unowned or root-owned home can ever be mounted.
6. **E2e shape verified** (LB-11, `reports/load-bearing-validator-lb11.md`): the rig can express the regression via the `webHomeDir` seam plus supervisor-launch options, with broker allow-list additions (fresh-eyes round 3 superseded the validator's `supervisorEnv` sketch with the explicit `--operator-home` flag, since rig supervisors run as root and the env fallback correctly declines for them); opencode 1.18.21 resolves native provider ids offline (bundled models.dev snapshot; `{file:}` substitution is pre-schema and hard-fails on ENOENT and EACCES); the red reproduces through the `OPENCODE_CONFIG_CONTENT` inline lane; harness-created `testRoot` and `/tmp/f<uid>` are 0700 and the spec must chmod them 0750.
7. **User Request block provenance (2026-10-10):** the dispatcher updated the block's mechanism bullet and tradeoff list to record the user's explicit ratification of the rootless-native group-read design (the "ratify the group-read tradeoff" decision presented with the load-bearing receipt). No other block text changed; the falsified original mechanism is preserved above in this revisions section.

**Goal:** Every fresh-agent and managed-terminal soul launches with a config that fully works — absolute references under the operator's home resolve in-soul — and the ms-runpod `bad file reference` incident class becomes structurally impossible on the production daemon.

**Architecture:** The supervisor bind-mounts the operator's home read-only at its own canonical path into every soul container (guarded: the home must be owned by the supervisor's user) and tmpfs-masks the control-plane subtrees inside it. Provider children keep their current identity (65534:0); under the rootless production daemon their gid 0 is the operator's group, so group-readable operator files — the home root (0750) and group-readable reference targets (0640) — resolve through the mount with no identity change, no migration, and no digest churn. The session host emits a JSONL readiness event describing the mounted home from the child's perspective so missing group bits are observable without any launch refusal. Staging/projection, OneCLI grants, capability mounts, resource limits, and teardown are untouched.

**Tech Stack:** Rust workspace (`freshell-supervisor` raw Docker Engine HTTP-over-socket backend, `freshell-session-host` privileged in-container host), Docker Engine API v1.47 bind+tmpfs mounts, Playwright local-only runtime specs via the managed-runtime rig.

## Global Constraints

- pnpm 10.34.5 exactly; `pnpm run <script> <args>` forwards args directly (no `--` separator). Use `pnpm exec` for installed binaries.
- **Provider children stay 65534:0 everywhere.** No launch-record, protocol, digest, uid-constant, or fixture-identity changes. Any test that currently asserts `65534:0` stays as-is.
- The home mount is derived from an explicit supervisor flag or, only for a non-root supervisor, its `HOME` env: `--operator-home <path>` wins (canonicalized, owner-guarded); otherwise `HOME` is used only when the supervisor's euid is non-zero, its `HOME` canonicalizes, and the home's owner uid equals the supervisor's euid — a containerized or root supervisor (the rig's default) gets NO home mount from the env path, because its `HOME` is not the operator's host home; containerized deployments (the rig's Task 3 spec, compose via Task 4's wiring) pass the flag explicitly. Never refuse a launch over the home mount.
- Mask list (tmpfs, fixed): `<home>/.freshell`, `<home>/.amplifier/onecli`, `<home>/.config/gcloud`, filtered to destinations that exist. The tmpfs-over-bind shape is validated; `verify_inspect_config` must only assert the new mounts/env for containers that carry the additive marker env (pre-upgrade containers must keep passing).
- **Host prep (owned, idempotent, re-runnable — never enforced by launch code):** referenced files under the operator home must be group-readable (0640 keys) under group-traversable directories (0750) — INCLUDING the home root itself and the ancestors of every prep-covered root — per the rootless gid mapping. The owned step is `scripts/prepare-operator-home.sh` (created by Task 4): it makes the home root, `~/.local`, `~/.config`, `~/.local/share` group-traversable and the whole `~/.amplifier` tree group-readable, is safe to re-run (runbook: re-run after any Amplifier key rotation), and has a behavioral vitest harness. Residual, stated precisely: a reference to a deliberately owner-only file (0600/0700 outside the prep-covered roots) does not resolve until the operator extends the prep by one line — the provider CLI's own error names the exact path, and Amplifier must write 0640/0750 going forward (tracked upstream item in Task 4); this is the ratified mode-based boundary, not a defect. On rootful daemons group 0 is not the operator group, so the feature degrades to today's behavior with an observable readiness event — documented, not gated.
- Red-Green-Refactor TDD: every task adds its failing test first, watches it fail for the stated reason, implements minimally, refactors while green, and runs the impacted set.
- Test coordination (AGENTS.md): narrowed `cargo test -p <crate> -- <filters...>` selectors are delegated (no coordinator gate); cargo accepts one positional filter, so multiple filters go after `--` (the libtest harness takes several). Do not kill foreign gate holders. New e2e specs are `LOCAL_ONLY` (register in `test/e2e-browser/playwright.config.ts`, where `LOCAL_ONLY_SPECS` is defined — the cloud config imports it).
- Never restart the production self-hosted server (port 3001) without the user's explicit "APPROVED". Building and running scratch supervisors/souls in the worktree is fine.
- No changes to: `copy_provider_config_references_with_ownership` projection semantics, `provider_secret_resolution.rs` env allow-lists, resource limits, teardown semantics, the `run_as_uid`/`run_as_gid` fields or their validation.
- Commits use `Dan Shapiro <3732858+danshapiro@users.noreply.github.com>` (repo config already provides it; do not override).

---

### Task 1: Supervisor mounts operator home read-only with tmpfs masks

**Files:**
- Modify: `crates/freshell-supervisor/src/backend/docker.rs` (TerminalMounts + workload_mounts, ~line 34-198)
- Modify: `crates/freshell-supervisor/src/backend.rs` (binds assembly ~572-618, runtime_host_environment ~402-497, docker_create_body tmpfs merge, verify_inspect_config ~993-1030)
- Modify: `crates/freshell-supervisor/src/main.rs` (new `--operator-home <path>` CLI flag) and the service/config plumbing that carries it to the backend (follow how `--registry-root` and `--host-binary` flow)
- Test: inline unit tests in both backend files

**Interfaces:**
- Consumes: `TerminalMounts` (docker.rs:34-42), `workload_mounts` (docker.rs:68-198), `runtime_host_environment` (backend.rs:402-497), `runtime_tmpfs(runtime_mode)` (backend.rs:629), `docker_create_body` (backend.rs:640), `verify_inspect_config` (backend.rs:993-1030).
- Produces:
  - `pub struct OperatorHomeMount { pub home: PathBuf, pub mask_rel_paths: Vec<String> }` (new field `pub operator_home: Option<OperatorHomeMount>` on `TerminalMounts`).
  - `fn explicit_operator_home(path: Option<&std::ffi::OsStr>, supervisor_euid: u32) -> Option<OperatorHomeMount>` — the `--operator-home` flag path: canonicalize, require the directory to exist, and apply the home-owner guard (`st_uid == supervisor_euid`). The flag is explicit operator intent, so it is honored for a root supervisor too (the rig's supervisor runs as root inside a container, and under the rootless daemon the operator's files appear container-0-owned, so the guard holds there).
  - `fn operator_home_mount(home_env: Option<&std::ffi::OsStr>, supervisor_euid: u32) -> Option<OperatorHomeMount>` — the env fallback: same canonicalize/owner guards, PLUS `supervisor_euid != 0` (a root or containerized supervisor's `HOME` is not the operator's host home — `/root` must never be mounted; the rig's default supervisors and compose deployments therefore get no home mount and no behavior change).
  - Both constructors: masks are fixed `[".freshell", ".amplifier/onecli", ".config/gcloud"]` FILTERED to destinations that already exist as directories under the home (runc must never have to create a missing mountpoint inside the read-only bind — a home missing one target must still launch).
  - Derivation order in `workload_mounts`: `explicit_operator_home(flag, euid)` falls back to `operator_home_mount(HOME, euid)`, then `effective_operator_mount(..., workspace)`.
  - Contract: `effective_operator_mount(mount: Option<OperatorHomeMount>, workspace: &Path) -> Option<OperatorHomeMount>` returns `None` when the workspace equals the operator home (that is the pre-existing workspace shape; no marker env, no masks, no verification applies to it), so `operator_home: Some(_)` always means: workspace differs from home, the `:ro` bind and all masks are emitted, and the marker env is set.
  - `fn assemble_workload_binds(...) -> (Vec<String>, std::collections::BTreeMap<String, String>)` in backend.rs — extracted from `create_stopped` inline assembly; returns binds plus tmpfs destinations (`"<destination>": ""` merged with `runtime_tmpfs` output; additive keys win, existing tmpfs destinations must never be dropped).
  - Container env set by `runtime_host_environment` when the spec's mounts include `operator_home`: marker `FRESHELL_OPERATOR_HOME_MOUNT=1` plus `FRESHELL_OPERATOR_HOME=<canonical home path>` (consumed by Task 2).

- [ ] **Step 1: Write the failing behavioral test**

In `crates/freshell-supervisor/src/backend/docker.rs` tests module (beside the existing tests around lines 340-390):

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
    assert_eq!(
        mount.mask_rel_paths,
        vec![".freshell", ".amplifier/onecli", ".config/gcloud"]
    );
    // A home owned by a different uid (e.g. root's /) must never mount.
    assert!(operator_home_mount(Some(std::path::Path::new("/").as_os_str()), owner).is_none());
}

#[test]
fn operator_home_mount_filters_masks_to_existing_destinations() {
    // runc cannot create missing mountpoints inside a read-only bind, so a
    // home lacking some mask targets still mounts, with the existing masks.
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
    // workload_mounts nulls the mount for the pre-existing home-as-workspace
    // soul shape: no ro bind, no masks, no marker env, no verification.
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    std::fs::create_dir_all(home.join(".freshell")).unwrap();
    let home = home.canonicalize().unwrap();
    use std::os::unix::fs::MetadataExt;
    let owner = std::fs::metadata(&home).unwrap().uid() as u32;
    let mount = operator_home_mount(Some(home.as_os_str()), owner).unwrap();
    assert!(mount.home == home);
    // The contract under test: workload_mounts applies
    //   .filter(|mount| mount.home != workspace)
    // — assert the resulting TerminalMounts.field is None for the equal case
    //   by exercising the same predicate the wiring uses.
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
    // A containerized or root supervisor's HOME is not the operator's host
    // home (e.g. /root inside the rig's supervisor container); the env
    // fallback must decline so rig defaults and compose are unchanged.
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

In `crates/freshell-supervisor/src/backend.rs` tests module:

```rust
#[test]
fn workload_binds_include_read_only_home_and_mask_tmpfs() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    let workspace = home.join("code").join("repo");
    std::fs::create_dir_all(&workspace).unwrap();
    let home = home.canonicalize().unwrap();
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
                home: home.clone(),
                mask_rel_paths: vec![".freshell".to_string()],
            }),
        }),
    )
    .unwrap();
    assert!(binds.contains(&format!("{}:{}:ro", home.display(), home.display())));
    assert!(binds.contains(&format!("{}:{}:rw", workspace.display(), workspace.display())));
    assert_eq!(tmpfs.get(&format!("{}/.freshell", home.display())).map(String::as_str), Some(""));
}

#[test]
fn workload_binds_emit_home_bind_and_masks_whenever_operator_home_is_some() {
    // The workspace-equals-home shape is filtered out upstream (see the
    // operator_home_mount_is_dropped_when_workspace_equals_home test), so
    // assembly may rely on Some(_) meaning both the ro bind and the masks
    // are present — otherwise verify_inspect_config and reality diverge.
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    std::fs::create_dir_all(home.join(".freshell")).unwrap();
    let home = home.canonicalize().unwrap();
    let (binds, tmpfs) = assemble_workload_binds(
        &tmp.path().join("binary"),
        &tmp.path().join("runtime"),
        "provider-vol",
        None,
        Some(&TerminalMounts {
            workspace: home.join("code").join("repo"),
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
    assert!(binds.iter().any(|b| b == &format!("{}:{}:ro", home.display(), home.display())));
    assert_eq!(tmpfs.get(&format!("{}/.freshell", home.display())).map(String::as_str), Some(""));
}

#[test]
fn home_mount_env_marker_is_set_only_when_mounted() {
    // Construct the launch spec exactly as the existing runtime_host_environment
    // tests do (the CODEX_CMD fixture pattern at backend.rs:1637-1763).
    let spec = fresh_agent_spec_fixture();
    let mounted = runtime_host_environment(None, Some(&spec), Some(std::path::Path::new("/home/op")))
        .unwrap();
    assert!(mounted.iter().any(|e| e == "FRESHELL_OPERATOR_HOME_MOUNT=1"));
    assert!(mounted.iter().any(|e| e == "FRESHELL_OPERATOR_HOME=/home/op"));
    let unmounted = runtime_host_environment(None, Some(&spec), None).unwrap();
    assert!(!unmounted.iter().any(|e| e.starts_with("FRESHELL_OPERATOR_HOME")));
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-supervisor -- operator_home_mount workload_binds home_mount_env_marker`

Expected: FAIL to compile — `operator_home_mount`, `OperatorHomeMount`, and `assemble_workload_binds` do not exist yet (missing behavior, not a syntax accident).

- [ ] **Step 3: Add the minimal production implementation**

In docker.rs:

```rust
/// Read-only operator-home mount for souls. Config files projected into the
/// soul reference absolute host paths under the operator's home; the provider
/// child needs those paths to resolve in-soul. Under the rootless production
/// daemon the child's gid 0 is the operator's group, so group-readable files
/// resolve with no identity change. The mask list hides control-plane
/// authorization material from provider children.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperatorHomeMount {
    pub home: PathBuf,
    pub mask_rel_paths: Vec<String>,
}

pub const OPERATOR_HOME_MASK_REL_PATHS: &[&str] =
    &[".freshell", ".amplifier/onecli", ".config/gcloud"];

pub fn explicit_operator_home(
    path: Option<&std::ffi::OsStr>,
    supervisor_euid: u32,
) -> Option<OperatorHomeMount> {
    derive_operator_mount(path, supervisor_euid)
}

pub fn operator_home_mount(
    home_env: Option<&std::ffi::OsStr>,
    supervisor_euid: u32,
) -> Option<OperatorHomeMount> {
    if supervisor_euid == 0 {
        // A root or containerized supervisor's HOME is not the operator's
        // host home; the env fallback declines (compose deployments and the
        // rig's default supervisors are unchanged).
        return None;
    }
    derive_operator_mount(home_env, supervisor_euid)
}

fn derive_operator_mount(
    raw: Option<&std::ffi::OsStr>,
    supervisor_euid: u32,
) -> Option<OperatorHomeMount> {
    let raw = raw?;
    if raw.is_empty() {
        return None;
    }
    let home = canonical_dir(Path::new(raw), "operator home").ok()?;
    let metadata = std::fs::metadata(&home).ok()?;
    if !metadata.is_dir() {
        return None;
    }
    use std::os::unix::fs::MetadataExt;
    if metadata.uid() != supervisor_euid {
        // Never mount a home the supervisor user does not own (e.g. /root).
        return None;
    }
    // runc cannot create missing mountpoints inside a read-only bind, so
    // only mask destinations that already exist are emitted; a home missing
    // some targets still mounts and launches.
    let mask_rel_paths: Vec<String> = OPERATOR_HOME_MASK_REL_PATHS
        .iter()
        .filter(|rel| home.join(rel).is_dir())
        .map(|s| s.to_string())
        .collect();
    Some(OperatorHomeMount { home, mask_rel_paths })
}

/// The pre-existing home-as-workspace soul shape keeps its legacy behavior:
/// no operator-home mount at all (no ro bind, no masks, no marker env).
fn effective_operator_mount(
    mount: Option<OperatorHomeMount>,
    workspace: &Path,
) -> Option<OperatorHomeMount> {
    mount.filter(|mount| mount.home != workspace)
}
```

Wire it in `workload_mounts` (docker.rs:68-198): derive the mount as `effective_operator_mount(explicit_operator_home(std::env::var_os("FRESHELL_SUPERVISOR_OPERATOR_HOME").as_deref(), unsafe { libc::geteuid() }).or_else(|| operator_home_mount(std::env::var_os("HOME").as_deref(), unsafe { libc::geteuid() })), &workspace)` on the returned `TerminalMounts` — `workspace` is the canonical workspace computed at the top of `workload_mounts` (docker.rs:77). The supervisor's `main.rs` parses the new `--operator-home <path>` flag and publishes it to its own process as `FRESHELL_SUPERVISOR_OPERATOR_HOME` before serving (follow the existing arg-parsing pattern beside `--registry-root`, main.rs:34 area), so no new parameter threads through the backend. `Some(_)` now guarantees workspace differs from home; rig supervisors pass the flag explicitly (Task 3) while default rig/compose supervisors (root, no flag) get no home mount.

In backend.rs, extract the inline binds assembly at lines 572-618 into `assemble_workload_binds` exactly as sketched in the tests, adding after the existing mounts block:

```rust
if let Some(home) = &mounts.operator_home {
    binds.push(format!("{}:{}:ro", home.home.display(), home.home.display()));
    for rel in &home.mask_rel_paths {
        tmpfs.insert(format!("{}/{}", home.home.display(), rel), String::new());
    }
}
```

`create_stopped` calls it and merges the returned tmpfs map with the existing `runtime_tmpfs(runtime_mode)` output in `docker_create_body`. In `runtime_host_environment`, thread a `mounted_home: Option<&Path>` argument from `create_stopped` and emit `FRESHELL_OPERATOR_HOME_MOUNT=1` plus `FRESHELL_OPERATOR_HOME=<path>` when present. In `verify_inspect_config`, assert the home `:ro` bind and mask tmpfs only when the inspected env contains `FRESHELL_OPERATOR_HOME_MOUNT=1` — pre-upgrade containers lack the marker and must keep passing.

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-supervisor -- operator_home_mount workload_binds home_mount_env_marker`

Expected: PASS

- [ ] **Step 5: Refactor while green**

The `create_stopped` extraction is the refactor; no further cleanup needed.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: all `freshell-supervisor` tests (mount assembly, digest, inspect verification) plus `freshell-runtime-protocol` spec tests.

Run: `cargo test -p freshell-supervisor && cargo test -p freshell-runtime-protocol`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-supervisor/src/backend.rs crates/freshell-supervisor/src/backend/docker.rs crates/freshell-supervisor/src/main.rs
git commit -m "feat(supervisor): mount operator home read-only in souls with tmpfs control-plane masks"
```

### Task 2: Session host emits an operator-home readiness event

**Files:**
- Modify: `crates/freshell-session-host/src/main.rs` (startup path, after arg parsing; JSONL event pattern at ~2513)
- Test: inline unit tests in `main.rs`

**Interfaces:**
- Consumes: env `FRESHELL_OPERATOR_HOME` and `FRESHELL_OPERATOR_HOME_MOUNT` (set by Task 1), env `FRESHELL_PROVIDER_RUN_AS_UID`/`FRESHELL_PROVIDER_RUN_AS_GID` (already in `runtime_host_environment`), the existing `append_event_with_secret` journal pattern.
- Produces:
  - `fn child_can_traverse(mode_bits: u32, owner_uid: u32, owner_gid: u32, child_uid: u32, child_gid: u32) -> bool` — pure POSIX DAC evaluation (owner-x / group-x with gid match / other-x).
  - Startup emission: when `FRESHELL_OPERATOR_HOME_MOUNT=1`, stat the home path and append one JSONL event `operator_home_readiness` with `path`, `present`, `uid`, `gid`, `mode` (octal string), and `home_root_traversable_by_child` computed by the pure function against the run-as identity. Never affects launch outcome.

- [ ] **Step 1: Write the failing behavioral test**

```rust
#[test]
fn child_can_traverse_evaluates_dac_classes() {
    // All metadata is the IN-CONTAINER view. Under the rootless daemon an
    // operator-owned file (host uid/gid 1000/1000) appears as container 0:0,
    // and the child's gid 0 then matches the file's group.
    // Owner execute, child is the owner.
    assert!(child_can_traverse(0o700, 1000, 1000, 1000, 0));
    // Group execute with gid match — the rootless production shape:
    // operator-owned file seen as (0,0), child 65534:0 → group r-x applies.
    assert!(child_can_traverse(0o750, 0, 0, 65_534, 0));
    // Group execute but gid mismatch — the rootful shape: the operator's file
    // keeps host gid 1000 in-container, and group 0 is the root group, not the
    // operator's group.
    assert!(!child_can_traverse(0o750, 1000, 1000, 65_534, 0));
    // No group bits (0700 operator dir, child not the owner) — the incident's
    // failure surface under the rootless mapping.
    assert!(!child_can_traverse(0o700, 0, 0, 65_534, 0));
    // POSIX selects the FIRST matching class: a matching group with no
    // execute bit cannot fall through to the other class's execute bit.
    assert!(!child_can_traverse(0o701, 0, 0, 65_534, 0));
    // Other execute applies when neither uid nor gid matches.
    assert!(child_can_traverse(0o701, 1000, 1000, 65_534, 65_534));
}

#[test]
fn readiness_event_reflects_real_home_metadata() {
    // With FRESHELL_OPERATOR_HOME=<temp dir, mode 0750, owned by the test uid>
    // and FRESHELL_OPERATOR_HOME_MOUNT=1 and FRESHELL_PROVIDER_RUN_AS_UID/GID
    // set to 65534/0, the startup emission must produce exactly one
    // operator_home_readiness event whose fields match the stat and whose
    // home_root_traversable_by_child is child_can_traverse(...). Use the existing
    // session-host event-journal test fixture (see the events written near
    // main.rs:2513) with a temp state dir.
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-session-host -- child_can_traverse readiness_event`

Expected: FAIL to compile — `child_can_traverse` and the emission do not exist yet.

- [ ] **Step 3: Add the minimal production implementation**

```rust
fn child_can_traverse(mode_bits: u32, owner_uid: u32, owner_gid: u32, child_uid: u32, child_gid: u32) -> bool {
    // POSIX permission classes select the FIRST match; a matched class with no
    // execute bit denies even when a later class carries it.
    if child_uid == owner_uid {
        mode_bits & 0o100 != 0
    } else if child_gid == owner_gid {
        mode_bits & 0o010 != 0
    } else {
        mode_bits & 0o001 != 0
    }
}
```

At session-host startup, after arg parsing: read the two marker env vars; when both are set, `std::fs::metadata` the home path and append the `operator_home_readiness` event via the existing journal helper (no secret bytes in the payload — only path, present, uid, gid, octal mode, home_root_traversable_by_child — the event reports the HOME ROOT ONLY; per-target group bits are the prep script's and Amplifier's business, documented in Task 4). Run-as identity comes from `FRESHELL_PROVIDER_RUN_AS_UID`/`_GID` (default 65534/0 when unset). Failure to stat logs `present: false` and never fails startup.

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-session-host -- child_can_traverse readiness_event`

Expected: PASS

- [ ] **Step 5: Refactor while green**

None needed; the function is single-purpose.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: all session-host tests (startup, events, projection untouched).

Run: `cargo test -p freshell-session-host`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-session-host/src/main.rs
git commit -m "feat(session-host): emit operator home readiness event for souls"
```

### Task 3: E2E regression — freshopencode soul boots with `{file:}` key references

**Files:**
- Create: `test/e2e-browser/specs/runtime-opencode-home-file-reference-rust.spec.ts`
- Modify: `scripts/testing/runtime-test-broker.ts` (allow-list policy types/arms)
- Modify: `scripts/testing/runtime-sandbox.ts` (`RuntimeHarness.prepare()` — where the broker allow-lists are constructed)
- Modify: `test/e2e-browser/playwright.config.ts` (add the spec to `LOCAL_ONLY_SPECS`, defined here — the cloud config imports it)

**Interfaces:**
- Consumes: the rig pattern of `test/e2e-browser/specs/runtime-fresh-agent-qualification-rust.spec.ts` (fresh-agent pane lifecycle, first-send-then-running-view flow, `runningViewForFreshSession`), `ManagedRuntimeBrowserRig` `webHomeDir` constructor option (managed-runtime.ts:79-106; `start()` runs `runtime.prepare()` at line 118 — which wipes and recreates testRoot — then starts the supervisor at 153), the rig's provider-uid exec helper (`65534:0` exec in `runtime-sandbox.ts`, ~line 896), and the NEW `operatorHome` option this task adds to the rig's supervisor launcher (passed through `startSupervisor` as the `--operator-home` flag). Authoritative seam list: `.worktrees/.the-usual-logs/soul-home-mounts/reports/load-bearing-validator-lb11.md`.
- Produces: a reproducible spec proving the incident class is fixed on the real (rootless) daemon via the FRESH-AGENT launch path (not the terminal picker path), with child-identity negative assertions that the control-plane masks hide their content; the rig's `operatorHome` supervisor option; broker allow-list arms admitting read-only same-path home binds and tmpfs mask destinations.

- [ ] **Step 1: Write the failing behavioral test**

Build the spec by mirroring the fresh-agent qualification spec's real imports/rig calls (read it first; the sketch below names the verified seams, not the final API surface). Lifecycle is load-bearing: `rig.start()` wipes testRoot inside `prepare()`, so the home fixtures are created AFTER `await rig.start()` returns and BEFORE the fresh-agent pane is launched — the server stages the user-provider root per launch at pane creation, so post-start fixtures are picked up:

```ts
// 1. Construct the rig with webHomeDir: <testRoot>/web-home and the new
//    supervisor flag option: operatorHome: <testRoot>/web-home (the rig's
//    startSupervisor gains the option and passes --operator-home; the rig's
//    supervisor runs as root in its container, so the HOME env path is
//    deliberately NOT used — the env fallback declines for root supervisors).
// 2. await rig.start()  // prepare() has now wiped and recreated testRoot
// 3. Create the home fixtures (owned by the test process, i.e. the operator):
//    - <home>/.amplifier/ms-runpod.key  ("e2e-key-not-real", mode 0640)
//    - <home>/.config/opencode/opencode.json:
//      { "$schema": "https://opencode.ai/config.json",
//        "provider": { "openai": { "name": "OpenAI",
//          "options": { "apiKey": "{file:<home>/.amplifier/ms-runpod.key}" } } },
//        "model": "openai/gpt-5.6-luna" }   // native provider id: validates offline
//    - Empty dirs + canary files for EVERY mask destination (they must
//      pre-exist in the home; create all three to exercise the full mask set):
//      <home>/.freshell/            (the rig itself writes config.json here at startup)
//      <home>/.amplifier/onecli/canary
//      <home>/.config/gcloud/canary
//    - chmod 0750 on <testRoot> and /tmp/f<uid> ancestors (harness creates them
//      0700; under the rootless daemon the 65534:0 child needs group traversal).
// 4. Launch a freshopencode fresh-agent pane (the qualification spec's
//    fresh-agent launch helper with provider opencode — NOT the terminal picker).
// Body:
test('freshopencode soul resolves {file:} API key references under the operator home', async () => {
  const info = await rig.start()
  // ...create home fixtures per steps 3 above, using info's testRoot...
  const sessionId = await rig.launchFreshAgentPane('opencode') // exact helper per the qualification spec
  // The composer's ready state renders via its textarea PLACEHOLDER
  // ("Send a message…"), not text content — see FreshAgentComposer.tsx.
  await expect(page.getByPlaceholder('Send a message')).toBeVisible({ timeout: 120_000 })
  // nativeSessionId materializes only after the first send (HostedTransport::start
  // returns None for a new session) — send a first turn like the qualification
  // spec does; the turn may fail auth (the key is fake) but the child must be
  // alive, which is the pre-fix/post-fix distinction: pre-fix, opencode dies at
  // startup with the config error and never reaches this state.
  await rig.sendFreshAgentTurn(sessionId, 'ping') // exact helper per the qualification spec
  const view = await rig.runningViewForFreshSession(sessionId)
  expect(view?.nativeSessionId).toBeTruthy()
  const paneText = await rig.capturePaneText()
  expect(paneText).not.toContain('Configuration is invalid')
  expect(paneText).not.toContain('bad file reference')
  // Control-plane masking proof, from the child's own identity: a WORKING mask
  // makes each canary ABSENT (tmpfs shows an empty root-owned dir), so `cat`
  // exits nonzero — and the rig's provider-uid exec helper (65534:0,
  // runtime-sandbox.ts ~896) takes an ARGUMENT ARRAY and is SYNCHRONOUS,
  // THROWING on nonzero exit (it never returns a rejected promise, so
  // `.rejects` cannot be used). Assert the throw itself — and a readable
  // canary would return a string and not throw, so the red/green semantics
  // hold: the helper throwing IS the mask working.
  for (const secret of [
    `${home}/.freshell/config.json`,
    `${home}/.amplifier/onecli/canary`,
    `${home}/.config/gcloud/canary`,
  ]) {
    expect(() => rig.ownedProviderExec(soulRef, ['cat', secret])).toThrow()
  }
})
```

Allow-list changes in BOTH files: add the policy types/arms in `runtime-test-broker.ts` (an `allowedOperatorHomeRoots` set plus a same-path read-only bind arm `dest === source && mode === 'ro'` and tmpfs allow arms for the three mask destinations, following the existing arm structure at ~lines 330-380), and construct them in `RuntimeHarness.prepare()` in `runtime-sandbox.ts`, which builds the broker's allow lists today — without this the supervisor's home bind is rejected before the pane ever launches.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `pnpm run test:e2e:local test/e2e-browser/specs/runtime-opencode-home-file-reference-rust.spec.ts --project=chromium` (match the qualification spec's canonical invocation if it differs)

Expected: FAIL before Task 1's supervisor change is wired into the rig's supervisor — the freshopencode pane shows `Configuration is invalid ... bad file reference` exactly like the production incident, because the `{file:}` reference rides the `OPENCODE_CONFIG_CONTENT` inline lane and the target is unreadable to the 65534:0 child (the validator confirmed the lane). After Task 1 lands, the same command must PASS. If Tasks 1-2 are already on the branch, temporarily confirm the red by removing the rig's `operatorHome` flag option in a scratch run (NOT the HOME env — the explicit `--operator-home` flag takes precedence over the env fallback, so unsetting HOME cannot remove the mount) and record it in the commit message — never weaken the spec to fabricate a red.

- [ ] **Step 3: Add the minimal production implementation**

No production change: this task is the system-level proof. The broker/sandbox allow-list changes in Step 1 are the implementation.

- [ ] **Step 4: Run the focused test**

Run: `pnpm run test:e2e:local test/e2e-browser/specs/runtime-opencode-home-file-reference-rust.spec.ts --project=chromium`

Expected: PASS — the freshopencode fresh-agent child starts (running view with a native session id), the composer reaches its ready state, and no "Configuration is invalid" text appears — proving the `{file:}` reference resolved in-soul through the mounted, group-readable home.

- [ ] **Step 5: Refactor while green**

Extract the home-fixture builder (key file + config + chmods) into the shared helper beside `managed-runtime.ts` only if the qualification spec would reuse it; otherwise leave.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: the broker unit tests at `test/unit/tooling/testing/runtime-test-broker.test.ts` (and any runtime-sandbox unit tests that cover allow-list construction) and the other LOCAL_ONLY runtime specs that construct the rig.

Run: `pnpm run test:vitest run test/unit/tooling/testing/runtime-test-broker.test.ts --config config/vitest/vitest.config.ts` and `pnpm run test:e2e:local --project=chromium --grep runtime` (match the repo's filtered runtime-spec lane)

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/runtime-opencode-home-file-reference-rust.spec.ts scripts/testing/runtime-test-broker.ts scripts/testing/runtime-sandbox.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): freshopencode soul boots with {file:} operator-home key references"
```

### Task 4: Host-prep script, compose wiring, and posture documentation

**Files:**
- Create: `scripts/prepare-operator-home.sh`
- Create: `test/unit/scripts/prepare-operator-home.test.ts`
- Modify: `docker/runtime/compose.yaml` (supervisor service: operator-home bind + `--operator-home`)
- Modify: `docs/development/managed-runtime.md` (~217, ~220-225, ~329-338)
- Modify: `docs/development/self-hosted-launch-runbook.md` (prep step + re-run-after-rotation note)
- Modify: `docker/runtime/README.md` (~19-30)

**Interfaces:**
- Consumes: Task 1's mount/mask/env contract and `--operator-home` flag, Task 2's readiness event, the load-bearing ledger and validator reports as evidence sources.
- Produces: `scripts/prepare-operator-home.sh` — the OWNED, idempotent host-prep step for the ratified group-read change (behavioral test below); compose-deployment wiring so rootless compose souls get the home mount too; documentation. No server behavior change.

- [ ] **Step 1: Write the failing behavioral test**

The prep script is load-bearing behavior and gets a real test (the repo rule set exempts only pure docs):

```ts
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SCRIPT = join(__dirname, '..', '..', '..', 'scripts', 'prepare-operator-home.sh')

function fixtureHome(): string {
  // mkdtemp creates the home root itself at 0700 — the exact condition that
  // must be prepared (a 0700 home root blocks the child from reaching even a
  // prepared key).
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
  it('makes the home root and known config roots group-traversable and the amplifier tree group-readable', () => {
    const home = fixtureHome()
    run(home)
    expect(statSync(home).mode & 0o050).toBe(0o050)
    expect(statSync(join(home, '.local')).mode & 0o050).toBe(0o050)
    expect(statSync(join(home, '.amplifier')).mode & 0o050).toBe(0o050)
    expect(statSync(join(home, '.amplifier', 'ms-runpod.key')).mode & 0o040).toBe(0o040)
    expect(statSync(join(home, '.config')).mode & 0o050).toBe(0o050)
  })

  it('is idempotent and tolerates an empty home', () => {
    const home = fixtureHome()
    run(home)
    const afterFirst = statSync(join(home, '.amplifier', 'ms-runpod.key')).mode
    run(home)
    const afterSecond = statSync(join(home, '.amplifier', 'ms-runpod.key')).mode
    expect(afterFirst).toBe(afterSecond)
    const empty = mkdtempSync(join(tmpdir(), 'prep-empty-'))
    expect(() => run(empty)).not.toThrow()
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `pnpm run test:vitest run test/unit/scripts/prepare-operator-home.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL — the script does not exist yet.

- [ ] **Step 3: Add the minimal production implementation**

`scripts/prepare-operator-home.sh` (idempotent, exits 0 even when targets are absent; prints what it changed):

```bash
#!/usr/bin/env bash
# Operator-home prep for soul home mounts (see docs/development/managed-runtime.md).
# Under the rootless Docker daemon, provider children run with gid 0, which maps
# to the operator's group — group bits are how in-home config references resolve.
# Safe to re-run at any time; re-run after Amplifier key rotations.
set -euo pipefail
home="${FRESHELL_OPERATOR_HOME:-$HOME}"
changed=0
# Group traversal for the home root itself and every ancestor root a referenced
# config path can sit under — a 0700 home root blocks the child from reaching
# even a prepared ~/.amplifier key.
for dir in "$home" "$home/.local" "$home/.config" "$home/.local/share"; do
  if [ -d "$dir" ]; then
    chmod g+rx "$dir"
    echo "chmod g+rx $dir"
    changed=1
  fi
done
# Whole-tree group read for the known secret-bearing root: dirs traversable,
# files readable (covers keys under ~/.amplifier regardless of naming).
if [ -d "$home/.amplifier" ]; then
  find "$home/.amplifier" -type d -exec chmod g+rx {} +
  find "$home/.amplifier" -type f -exec chmod g+r {} +
  echo "chmod g+rx dirs and g+r files under $home/.amplifier"
  changed=1
fi
if [ "$changed" -eq 0 ]; then
  echo "nothing to prepare (no known config roots present)"
fi
echo "note: Amplifier must write keys 0640 and ~/.amplifier 0750 going forward so rotation preserves this (tracked upstream item)."
```

`docker/runtime/compose.yaml` — the supervisor service gets the operator-home bind and flag so rootless compose deployments deliver the feature too. The bind source is resolved by the daemon on the daemon HOST, so the path inside the supervisor container must be the operator home's canonical host path (mounted at itself, read-only); the flag then carries that same path, whose st_uid appears as container 0 under the rootless mapping — matching the root supervisor's euid and passing the owner guard. The service currently defines no supervisor command (its image defaults to `/bin/bash`), so the change adds a real `command:` block mirroring the supervisor's documented launch (entrypoint with its existing args such as `--registry-root`, etc.) plus the new flag:

```yaml
# supervisor service volumes (add beside the existing binds; substitute the
# operator's actual home — the SAME canonical host path on both sides):
#   - /home/<operator>:/home/<operator>:ro
# supervisor service command (add; include the supervisor's existing documented
# args, then):
#   --operator-home /home/<operator>
```

- [ ] **Step 4: Run the focused test**

Run: `pnpm run test:vitest run test/unit/scripts/prepare-operator-home.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

None needed; the script is single-purpose.

- [ ] **Step 6: Run impacted-test verification**

Run: `bash -n scripts/prepare-operator-home.sh` plus the vitest run above; run the compose config lint the repo uses for docker/runtime if one exists (otherwise note the skip). Docs changes (below) are review-verified.

Docs content:

`docs/development/self-hosted-launch-runbook.md`: add the prep step — after deploying, run `scripts/prepare-operator-home.sh` once as the operator, and re-run it after any Amplifier key rotation (rotation that recreates keys at 0600 would otherwise restore the original failure; this one-command re-run is the ratified tradeoff, not a gap — the failing provider's error names the exact path); the `operator_home_readiness` event confirms the home root's group traversal afterward.

`docs/development/managed-runtime.md`:
- Replace the "no unrelated home" bullet (~220-225) and the rootless uid rationale (~329-338) with the new contract: souls mount the operator home read-only at its canonical path; provider children keep 65534:0; under the rootless production daemon the child's gid 0 is the operator's group, so group-readable reference targets (0750 directories, 0640 key files) resolve with no identity change; the `--operator-home` flag, the compose wiring, and the owner/euid guards (containerized supervisors pass the flag explicitly; rootless-home env fallback works only for non-root host supervisors); the tmpfs mask list (`.freshell`, `.amplifier/onecli`, `.config/gcloud`) and why each entry is control-plane or infrastructure authorization material; the additive `FRESHELL_OPERATOR_HOME_MOUNT`/`FRESHELL_OPERATOR_HOME` env markers and that pre-upgrade running containers lack them; the `operator_home_readiness` event (home-root scope: `home_root_traversable_by_child`) and how to read it when a `{file:}` reference fails; the rootful-degradation note (group 0 is not the operator group, feature degrades to legacy readability, observed via the readiness event, never gated).
- Add the operator prep section referencing `scripts/prepare-operator-home.sh`, the re-run-after-rotation rule, and the tracked upstream Amplifier item (write keys 0640, `~/.amplifier` 0750), with the reasoning that under the rootless mapping group-dan access is effectively "processes running as the operator" on this single-user host.
- State the two accepted residuals precisely: (1) a reference to a deliberately owner-only file outside the prep-covered roots — or a key rotated at 0600 before the prep re-run — needs the one-line prep extension/re-run; the provider CLI's error names the exact path, and this mode-based boundary is the user-ratified tradeoff (repeat the User Request block's boundary bullet verbatim here so doc readers see the same contract); (2) the mask set is computed at container creation, so a control-plane path CREATED AFTER a soul is running is unmasked for that soul until its next incarnation — primary protection is those paths' own owner-only modes (gcloud/onecli create 0700 dirs), and every new incarnation re-derives the masks.

`docker/runtime/README.md` (~19-30): update the uid story (session host uid 0; provider children 65534:0 unchanged; no passwd entry — same as today) and reword the 0600-secret guarantee around the masked-home boundary.

- [ ] **Step 7: Commit the task**

```bash
git add scripts/prepare-operator-home.sh test/unit/scripts/prepare-operator-home.test.ts docker/runtime/compose.yaml docs/development/managed-runtime.md docs/development/self-hosted-launch-runbook.md docker/runtime/README.md
git commit -m "feat(deploy): operator home prep script with behavioral test, compose wiring, and posture docs"
```

## Verification (user-visible outcome)

1. The incident scenario end-to-end: covered by Task 3's spec on the real rootless daemon — a freshopencode fresh-agent pane (fresh-agent launch path) with a `{file:}`-referencing global config starts its child (native session id), reaches the composer's ready state, and shows no "Configuration is invalid" text.
2. Production, after user-approved deploy and one run of `scripts/prepare-operator-home.sh` (Task 4): a freshopencode pane in `/home/dan/code/shapiroserver2` with the real global `~/.config/opencode/opencode.json` boots opencode.
3. Pre-upgrade running souls: untouched by construction — no identity, record, digest, or volume changes; replaced incarnations naturally gain the home mount.
4. Control-plane safety, proven from the child's own identity in Task 3's spec: `~/.freshell`, `~/.amplifier/onecli`, and `~/.config/gcloud` are tmpfs-masked in-soul (the provider-uid exec is denied on each canary); all other operator secrets remain protected by their owner-only modes.
5. Resource bounding and teardown: unchanged (no limits code touched); the full `pnpm run check` gate before any PR proves it.
