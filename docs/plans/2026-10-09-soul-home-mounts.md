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

## Load-bearing revisions (2026-10-10)

The load-bearing stage falsified the request's proposed mechanism and replaced it with a simpler one that delivers the same requested result. Decisions and consequences (evidence lives in the reports cited, never inline):

1. **The production Docker daemon is rootless** (LB-05, falsified). Under rootless user-namespace mapping the operator's host uid (1000) is container uid 0, which protocol validation forbids for provider children, and any other container uid maps to an unrelated subuid. "Run provider children as the operator's uid" cannot deliver under the production daemon and is dropped. Evidence: `docker info` Security Options, supervisor args (`/run/user/1000/docker.sock`); ledger `load-bearing-ledger.md`.
2. **Provider children keep running as 65534:0 — no identity change anywhere** (consequence of 1). Launch records, the immutable digest, the ~25 uid-hardcoded test sites, and all durable volumes stay byte-identical; pre-upgrade souls need no migration. The earlier tasks 2 (uid change) and 3 (ownership alignment + passwd entry) are deleted — the alignment walk was also independently falsified (LB-01: the session host has no DAC_OVERRIDE and cannot traverse foreign-owned 0700 trees), and the `/etc/passwd` append is impossible under `ReadonlyRootfs` (LB-07) with zero regression since uid 65534 has no passwd entry today either.
3. **The mechanism is group-read, not uid-switch** (LB-12, verified empirically on the live daemon). Under the rootless mapping, container gid 0 — which children already hold — is the operator's own group: a 65534:0 child read a 0644 operator file through a bound home and traversed the 0750 home root, while 0700/0600 operator paths denied it (exactly the incident's failure surface). The referenced files fail today only for lack of group bits. Consequence: the host prep in Global Constraints (one-time chmod; Amplifier writes group-readable keys going forward) is REQUIRED for the requested result; Freshell launch code never enforces or refuses on it — it only reports (Task 2's readiness event). This is the tradeoff the user must ratify (LB-13, `load-bearing-ledger.md`).
4. **tmpfs-over-bind masks work on the production daemon** (LB-04, verified): a read-only home bind plus `--tmpfs <home>/.freshell` yielded an empty `.freshell` inside the container with the rest of the home intact. The masking strategy stands, with `~/.config/gcloud` added to the mask list as zero-cost defense-in-depth for gcloud-robot infrastructure credentials (finder residual, accepted).
5. **Supervisor topology verified** (LB-02): the production supervisor runs as `dan` with `HOME=/home/dan`. The home-mount derivation keeps using the supervisor's HOME env, now guarded by a home-owner check (skip the mount unless the home's st_uid equals the supervisor euid) so no unowned or root-owned home can ever be mounted.
6. **E2e shape verified** (LB-11, `reports/load-bearing-validator-lb11.md`): the rig can express the regression via the existing `webHomeDir` + `supervisorEnv` seams with broker allow-list additions; opencode 1.18.21 resolves native provider ids offline (bundled models.dev snapshot; `{file:}` substitution is pre-schema and hard-fails on ENOENT and EACCES); the red reproduces through the `OPENCODE_CONFIG_CONTENT` inline lane; harness-created `testRoot` and `/tmp/f<uid>` are 0700 and the spec must chmod them 0750.

**Goal:** Every fresh-agent and managed-terminal soul launches with a config that fully works — absolute references under the operator's home resolve in-soul — and the ms-runpod `bad file reference` incident class becomes structurally impossible on the production daemon.

**Architecture:** The supervisor bind-mounts the operator's home read-only at its own canonical path into every soul container (guarded: the home must be owned by the supervisor's user) and tmpfs-masks the control-plane subtrees inside it. Provider children keep their current identity (65534:0); under the rootless production daemon their gid 0 is the operator's group, so group-readable operator files — the home root (0750) and group-readable reference targets (0640) — resolve through the mount with no identity change, no migration, and no digest churn. The session host emits a JSONL readiness event describing the mounted home from the child's perspective so missing group bits are observable without any launch refusal. Staging/projection, OneCLI grants, capability mounts, resource limits, and teardown are untouched.

**Tech Stack:** Rust workspace (`freshell-supervisor` raw Docker Engine HTTP-over-socket backend, `freshell-session-host` privileged in-container host), Docker Engine API v1.47 bind+tmpfs mounts, Playwright local-only runtime specs via the managed-runtime rig.

## Global Constraints

- pnpm 10.34.5 exactly; `pnpm run <script> <args>` forwards args directly (no `--` separator). Use `pnpm exec` for installed binaries.
- **Provider children stay 65534:0 everywhere.** No launch-record, protocol, digest, uid-constant, or fixture-identity changes. Any test that currently asserts `65534:0` stays as-is.
- The home mount is derived from the supervisor process's `HOME` env, canonicalized, mounted read-only at its own path, and **skipped silently** when HOME is unset, does not canonicalize, or the home's owner uid ≠ the supervisor's euid. Never refuse a launch over the home mount.
- Mask list (tmpfs, fixed): `<home>/.freshell`, `<home>/.amplifier/onecli`, `<home>/.config/gcloud`. The tmpfs-over-bind shape is validated; `verify_inspect_config` must only assert the new mounts/env for containers that carry the additive marker env (pre-upgrade containers must keep passing).
- **Host prep (documented, never enforced by launch code):** referenced files under the operator home must be group-readable (0640 keys) under group-traversable directories (0750), per the rootless gid mapping. One-time remediation: `chmod g+rx ~/.amplifier && chmod g+r ~/.amplifier/*.key`; Amplifier should write 0640/0750 going forward. On rootful daemons group 0 is not the operator group, so the feature degrades to today's behavior with an observable readiness event — documented, not gated.
- Red-Green-Refactor TDD: every task adds its failing test first, watches it fail for the stated reason, implements minimally, refactors while green, and runs the impacted set.
- Test coordination (AGENTS.md): narrowed `cargo test -p <crate> <filter>` selectors are delegated (no coordinator gate). Do not kill foreign gate holders. New e2e specs are `LOCAL_ONLY` (register in `test/e2e-browser/playwright.cloud.config.ts`).
- Never restart the production self-hosted server (port 3001) without the user's explicit "APPROVED". Building and running scratch supervisors/souls in the worktree is fine.
- No changes to: `copy_provider_config_references_with_ownership` projection semantics, `provider_secret_resolution.rs` env allow-lists, resource limits, teardown semantics, the `run_as_uid`/`run_as_gid` fields or their validation.
- Commits use `Dan Shapiro <3732858+danshapiro@users.noreply.github.com>` (repo config already provides it; do not override).

---

### Task 1: Supervisor mounts operator home read-only with tmpfs masks

**Files:**
- Modify: `crates/freshell-supervisor/src/backend/docker.rs` (TerminalMounts + workload_mounts, ~line 34-198)
- Modify: `crates/freshell-supervisor/src/backend.rs` (binds assembly ~572-618, runtime_host_environment ~402-497, docker_create_body tmpfs merge, verify_inspect_config ~993-1030)
- Test: inline unit tests in both files

**Interfaces:**
- Consumes: `TerminalMounts` (docker.rs:34-42), `workload_mounts` (docker.rs:68-198), `runtime_host_environment` (backend.rs:402-497), `runtime_tmpfs(runtime_mode)` (backend.rs:629), `docker_create_body` (backend.rs:640), `verify_inspect_config` (backend.rs:993-1030).
- Produces:
  - `pub struct OperatorHomeMount { pub home: PathBuf, pub mask_rel_paths: Vec<String> }` (new field `pub operator_home: Option<OperatorHomeMount>` on `TerminalMounts`).
  - `fn operator_home_mount(home_env: Option<&std::ffi::OsStr>, supervisor_euid: u32) -> Option<OperatorHomeMount>` in docker.rs — canonicalize HOME, require the home directory to exist and its `st_uid` to equal `supervisor_euid` (the home-owner guard); masks are fixed: `[".freshell", ".amplifier/onecli", ".config/gcloud"]`.
  - `fn assemble_workload_binds(...) -> (Vec<String>, std::collections::BTreeMap<String, String>)` in backend.rs — extracted from `create_stopped` inline assembly; returns binds plus tmpfs destinations (`"<destination>": ""` merged with `runtime_tmpfs` output; additive keys win, existing tmpfs destinations must never be dropped).
  - Container env set by `runtime_host_environment` when the spec's mounts include `operator_home`: marker `FRESHELL_OPERATOR_HOME_MOUNT=1` plus `FRESHELL_OPERATOR_HOME=<canonical home path>` (consumed by Task 2).

- [ ] **Step 1: Write the failing behavioral test**

In `crates/freshell-supervisor/src/backend/docker.rs` tests module (beside the existing tests around lines 340-390):

```rust
#[test]
fn operator_home_mount_derives_masks_and_requires_operator_ownership() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
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
fn operator_home_mount_skips_unset_or_missing_home() {
    let euid = unsafe { libc::geteuid() };
    assert!(operator_home_mount(None, euid).is_none());
    let tmp = tempfile::tempdir().unwrap();
    assert!(operator_home_mount(Some(tmp.path().join("nope").as_os_str()), euid).is_none());
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
fn workload_binds_skip_home_bind_when_workspace_equals_home() {
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

Run: `cargo test -p freshell-supervisor operator_home_mount workload_binds home_mount_env_marker`

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

pub fn operator_home_mount(
    home_env: Option<&std::ffi::OsStr>,
    supervisor_euid: u32,
) -> Option<OperatorHomeMount> {
    let raw = home_env?;
    if raw.is_empty() {
        return None;
    }
    let home = canonical_dir(Path::new(raw), "operator HOME").ok()?;
    let metadata = std::fs::metadata(&home).ok()?;
    if !metadata.is_dir() {
        return None;
    }
    use std::os::unix::fs::MetadataExt;
    if metadata.uid() != supervisor_euid {
        // Never mount a home the supervisor user does not own (e.g. /root).
        return None;
    }
    Some(OperatorHomeMount {
        home,
        mask_rel_paths: OPERATOR_HOME_MASK_REL_PATHS.iter().map(|s| s.to_string()).collect(),
    })
}
```

Wire it in `workload_mounts` (docker.rs:68-198): read `let supervisor_home = std::env::var_os("HOME");` once at the top (the user-root branch at line 141 reuses the same value) and set `operator_home: operator_home_mount(supervisor_home.as_deref(), unsafe { libc::geteuid() })` on the returned `TerminalMounts` (add `libc` to the crate if absent).

In backend.rs, extract the inline binds assembly at lines 572-618 into `assemble_workload_binds` exactly as sketched in the tests, adding after the existing mounts block:

```rust
if let Some(home) = &mounts.operator_home {
    if home.home != mounts.workspace {
        binds.push(format!("{}:{}:ro", home.home.display(), home.home.display()));
    }
    for rel in &home.mask_rel_paths {
        tmpfs.insert(format!("{}/{}", home.home.display(), rel), String::new());
    }
}
```

`create_stopped` calls it and merges the returned tmpfs map with the existing `runtime_tmpfs(runtime_mode)` output in `docker_create_body`. In `runtime_host_environment`, thread a `mounted_home: Option<&Path>` argument from `create_stopped` and emit `FRESHELL_OPERATOR_HOME_MOUNT=1` plus `FRESHELL_OPERATOR_HOME=<path>` when present. In `verify_inspect_config`, assert the home `:ro` bind and mask tmpfs only when the inspected env contains `FRESHELL_OPERATOR_HOME_MOUNT=1` — pre-upgrade containers lack the marker and must keep passing.

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-supervisor operator_home_mount workload_binds home_mount_env_marker`

Expected: PASS

- [ ] **Step 5: Refactor while green**

The `create_stopped` extraction is the refactor; no further cleanup needed.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: all `freshell-supervisor` tests (mount assembly, digest, inspect verification) plus `freshell-runtime-protocol` spec tests.

Run: `cargo test -p freshell-supervisor && cargo test -p freshell-runtime-protocol`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-supervisor/src/backend.rs crates/freshell-supervisor/src/backend/docker.rs crates/freshell-supervisor/Cargo.toml
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
  - Startup emission: when `FRESHELL_OPERATOR_HOME_MOUNT=1`, stat the home path and append one JSONL event `operator_home_readiness` with `path`, `present`, `uid`, `gid`, `mode` (octal string), and `traversable_by_child` computed by the pure function against the run-as identity. Never affects launch outcome.

- [ ] **Step 1: Write the failing behavioral test**

```rust
#[test]
fn child_can_traverse_evaluates_dac_classes() {
    // Owner execute (0700, child is owner).
    assert!(child_can_traverse(0o700, 1000, 1000, 1000, 0));
    // Group execute with gid match (0750, child gid 0 = operator group under rootless).
    assert!(child_can_traverse(0o750, 1000, 1000, 65_534, 0));
    // Group execute but gid mismatch (rootful daemon: group 0 is not the operator group).
    assert!(!child_can_traverse(0o750, 1000, 1000, 65_534, 65_534));
    // No group bits (0700 home, child not owner) — the incident's failure surface.
    assert!(!child_can_traverse(0o700, 1000, 1000, 65_534, 0));
    // Other execute always passes.
    assert!(child_can_traverse(0o701, 1000, 1000, 65_534, 65_534));
}

#[test]
fn readiness_event_reflects_real_home_metadata() {
    // With FRESHELL_OPERATOR_HOME=<temp dir, mode 0750, owned by the test uid>
    // and FRESHELL_OPERATOR_HOME_MOUNT=1 and FRESHELL_PROVIDER_RUN_AS_UID/GID
    // set to 65534/0, the startup emission must produce exactly one
    // operator_home_readiness event whose fields match the stat and whose
    // traversable_by_child is child_can_traverse(...). Use the existing
    // session-host event-journal test fixture (see the events written near
    // main.rs:2513) with a temp state dir.
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-session-host child_can_traverse readiness_event`

Expected: FAIL to compile — `child_can_traverse` and the emission do not exist yet.

- [ ] **Step 3: Add the minimal production implementation**

```rust
fn child_can_traverse(mode_bits: u32, owner_uid: u32, owner_gid: u32, child_uid: u32, child_gid: u32) -> bool {
    let owner_exec = mode_bits & 0o100 != 0;
    let group_exec = mode_bits & 0o010 != 0;
    let other_exec = mode_bits & 0o001 != 0;
    (child_uid == owner_uid && owner_exec)
        || (child_gid == owner_gid && group_exec)
        || other_exec
}
```

At session-host startup, after arg parsing: read the two marker env vars; when both are set, `std::fs::metadata` the home path and append the `operator_home_readiness` event via the existing journal helper (no secret bytes in the payload — only path, present, uid, gid, octal mode, traversable_by_child). Run-as identity comes from `FRESHELL_PROVIDER_RUN_AS_UID`/`_GID` (default 65534/0 when unset). Failure to stat logs `present: false` and never fails startup.

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-session-host child_can_traverse readiness_event`

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

### Task 3: E2E regression — soul boots with `{file:}` key references

**Files:**
- Create: `test/e2e-browser/specs/runtime-opencode-home-file-reference-rust.spec.ts`
- Modify: `scripts/testing/runtime-test-broker.ts` (~lines 330-380 bind allow-list; tmpfs allow arms)
- Modify: `test/e2e-browser/playwright.cloud.config.ts` (add the spec to `LOCAL_ONLY_SPECS`)

**Interfaces:**
- Consumes: the rig pattern of `test/e2e-browser/specs/runtime-terminal-continuity-rust.spec.ts` (P2-G04: construct rig → open an OpenCode pane via the picker → wait for `Ask anything`), `ManagedRuntimeBrowserRig` `webHomeDir`, `startSupervisor({ env })` (`supervisorEnv`), the broker allow-list. Authoritative seam list: `.worktrees/.the-usual-logs/soul-home-mounts/reports/load-bearing-validator-lb11.md`.
- Produces: a reproducible spec proving the incident class is fixed on the real (rootless) daemon; broker arms admitting read-only same-path home binds and tmpfs mask destinations.

- [ ] **Step 1: Write the failing behavioral test**

Build the spec by mirroring the continuity spec's real imports/rig calls (read it first; the sketch below names the verified seams, not the final API surface):

```ts
// Setup, before rig construction:
// 1. home = <testRoot>/web-home (create AFTER prepare(), per the validator):
//    - .amplifier/ms-runpod.key  ("e2e-key-not-real", mode 0640, group = operator)
//    - .config/opencode/opencode.json:
//      { "$schema": "https://opencode.ai/config.json",
//        "provider": { "openai": { "name": "OpenAI",
//          "options": { "apiKey": "{file:<home>/.amplifier/ms-runpod.key}" } } },
//        "model": "openai/gpt-5.6-luna" }   // native provider id: validates offline
// 2. chmod 0750 on <testRoot> and /tmp/f<uid> ancestors (harness creates them 0700;
//    under the rootless daemon the 65534:0 child needs group traversal).
// 3. supervisorEnv: { HOME: home }  (existing parameter; no rig code change)
// 4. webHomeDir: home (existing parameter)
// Body:
test('soul resolves {file:} API key references under the operator home', async () => {
  await rig.openOpenCodePane() // exact helper per the continuity spec
  await expect(page.getByText('Ask anything')).toBeVisible({ timeout: 120_000 })
  const paneText = await rig.capturePaneText()
  expect(paneText).not.toContain('Configuration is invalid')
  expect(paneText).not.toContain('bad file reference')
})
```

Broker changes: add an `allowedOperatorHomeRoots` policy set plus a same-path read-only bind arm (`dest === source && mode === 'ro'`) and tmpfs allow arms for the three mask destinations, following the existing arm structure at `runtime-test-broker.ts:330-380`.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `pnpm run test:e2e:local test/e2e-browser/specs/runtime-opencode-home-file-reference-rust.spec.ts --project=chromium` (match the continuity spec's canonical invocation if it differs)

Expected: FAIL before Task 1's supervisor change is wired into the rig's supervisor — the pane shows `Configuration is invalid ... bad file reference` exactly like the production incident, because the `{file:}` reference rides the `OPENCODE_CONFIG_CONTENT` inline lane and the target is unreadable to the 65534:0 child (the validator confirmed the lane). After Task 1 lands, the same command must PASS. If Tasks 1-2 are already on the branch, temporarily confirm the red by unsetting the supervisor HOME env override in a scratch run and record it in the commit message — never weaken the spec to fabricate a red.

- [ ] **Step 3: Add the minimal production implementation**

No production change: this task is the system-level proof. The rig/broker changes in Step 1 are the implementation.

- [ ] **Step 4: Run the focused test**

Run: `pnpm run test:e2e:local test/e2e-browser/specs/runtime-opencode-home-file-reference-rust.spec.ts --project=chromium`

Expected: PASS — opencode boots to its prompt, proving the `{file:}` reference resolved in-soul through the mounted, group-readable home.

- [ ] **Step 5: Refactor while green**

Extract the home-fixture builder (key file + config + chmods) into the shared helper beside `managed-runtime.ts` only if the continuity spec would reuse it; otherwise leave.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: the broker unit tests (`scripts/testing` vitest suite covering the allow-list) and the other LOCAL_ONLY runtime specs that construct the rig — at minimum `runtime-terminal-continuity-rust.spec.ts`.

Run: `pnpm run test:vitest run test/unit/scripts --config config/vitest/vitest.config.ts` (or the suite owning the broker tests — locate by grepping for `runtime-test-broker` under `test/`) and `pnpm run test:e2e:local --project=chromium --grep runtime` (match the repo's filtered runtime-spec lane)

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/runtime-opencode-home-file-reference-rust.spec.ts scripts/testing/runtime-test-broker.ts test/e2e-browser/playwright.cloud.config.ts
git commit -m "test(e2e): soul boots opencode with {file:} operator-home key references"
```

### Task 4: Posture documentation

**Files:**
- Modify: `docs/development/managed-runtime.md` (~217, ~220-225, ~329-338)
- Modify: `docker/runtime/README.md` (~19-30)

**Interfaces:**
- Consumes: Task 1's mount/mask/env contract, Task 2's readiness event, the load-bearing ledger and validator reports as evidence sources.
- Produces: documentation only — no behavior change.

- [ ] **Step 1: Write the failing behavioral test**

Docs task: no test. The repo's rule set exempts doc changes from TDD; verification is review. (State this explicitly in the commit message.)

- [ ] **Step 2: N/A**

- [ ] **Step 3: Add the minimal production implementation**

`docs/development/managed-runtime.md`:
- Replace the "no unrelated home" bullet (~220-225) and the rootless uid rationale (~329-338) with the new contract: souls mount the operator home read-only at its canonical path; provider children keep 65534:0; under the rootless production daemon the child's gid 0 is the operator's group, so group-readable reference targets (0750 directories, 0640 key files) resolve with no identity change; the home-owner guard; the tmpfs mask list (`.freshell`, `.amplifier/onecli`, `.config/gcloud`) and why each entry is control-plane or infrastructure authorization material; the additive `FRESHELL_OPERATOR_HOME_MOUNT`/`FRESHELL_OPERATOR_HOME` env markers and that pre-upgrade running containers lack them; the `operator_home_readiness` event and how to read it when a `{file:}` reference fails; the rootful-degradation note (group 0 is not the operator group, feature degrades to legacy readability, observed via the readiness event, never gated).
- Add the operator prep section: the one-time `chmod g+rx ~/.amplifier && chmod g+r ~/.amplifier/*.key` remediation and the Amplifier-going-forward requirement (0640 keys, 0750 dirs), with the reasoning that under the rootless mapping group-dan access is effectively "processes running as the operator" on this single-user host.

`docker/runtime/README.md` (~19-30): update the uid story (session host uid 0; provider children 65534:0 unchanged; no passwd entry — same as today) and reword the 0600-secret guarantee around the masked-home boundary.

- [ ] **Step 4: N/A**

- [ ] **Step 5: N/A**

- [ ] **Step 6: Run impacted-test verification**

Docs only; run the repo's doc-link/docs lint if one exists (`grep -r "managed-runtime.md" package.json` for a docs check script; otherwise skip with a note).

- [ ] **Step 7: Commit the task**

```bash
git add docs/development/managed-runtime.md docker/runtime/README.md
git commit -m "docs(managed-runtime): operator home mounts, masks, and group-read posture"
```

## Verification (user-visible outcome)

1. The incident scenario end-to-end: covered by Task 3's spec on the real rootless daemon — an opencode pane with a `{file:}`-referencing global config boots to its prompt with no "Configuration is invalid" text.
2. Production, after user-approved deploy and the one-time host prep from Task 4: a freshopencode pane in `/home/dan/code/shapiroserver2` with the real global `~/.config/opencode/opencode.json` boots opencode.
3. Pre-upgrade running souls: untouched by construction — no identity, record, digest, or volume changes; replaced incarnations naturally gain the home mount.
4. Control-plane safety: `~/.freshell`, `~/.amplifier/onecli`, and `~/.config/gcloud` are tmpfs-masked in-soul; all other operator secrets remain protected by their owner-only modes.
5. Resource bounding and teardown: unchanged (no limits code touched); the full `pnpm run check` gate before any PR proves it.
