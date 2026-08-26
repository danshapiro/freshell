# Pane-Ledger Scan-Fault Loudness Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result

Fix `crates/freshell-ws/src/pane_ledger.rs` `load_index()` (lines ~299-321 of
the file at discovery time) so it no longer silently swallows I/O errors when
reading the on-disk binding index. Today a transient I/O error during the
construction scan — while a real, durably-written index exists on disk —
makes the ledger come up either completely blind (empty, silently) or
DISABLED, with no loud signal that a restarted server has effectively lost
its pane→session lineage. `load_index()` should propagate I/O errors (or at
minimum log loudly at error level) rather than silently degrading to an empty
index; `new_locked()` should distinguish "no index file yet" (expected on
first boot) from "index file exists but failed to read" (a real fault).

### Explicit constraints

- The fix is a production-code change to `crates/freshell-ws/src/pane_ledger.rs`
  (this run is NOT the f3wp test-only lane that discovered the gap).
- Keep the existing fail-loud-PER-ROW policy intact: unparsable or
  wrong-version row files are skipped by `load_index` and quarantined loudly
  by the boot scan (`pane_ledger_scan.rs`); that per-row contract must not be
  replaced by per-store fatality.
- Keep the single-writer flock contract of `new_locked` (V2.md): a lock held
  by another process still maps to a loudly-logged DISABLED ledger.
- First boot must keep working: a store whose scan directories are simply
  absent is the expected empty shape, not a fault. `new_locked` (and the
  lock-free `new`) must come up ENABLED with an empty index in that case.
- The DISABLED failure mode is the SAFE one (verified:
  `crates/freshell-ws/src/auto_resume.rs:629` consults
  `bound_session_ref_for_terminal` only under `is_enabled()`, precisely
  because a disabled ledger's `None` is uninformative). A blind
  ENABLED-but-empty ledger is the dangerous mode; the fix must make blind
  ENABLED impossible to construct.

### Accepted tradeoffs and residuals

- Row-level faults remain load-then-boot-scan territory: an unparsable row is
  skipped by `load_index` without a log line at construction and quarantined
  loudly by the boot scan moments later (`quarantine_unparsable`). This plan
  does not add construction-time row-level logging; it closes the
  DIRECTORY/scan-level hole only.
- Entry-error and provider-subdir faults during the scan are store-level
  faults and get the same propagate/record treatment as top-level directory
  faults; there is no portable way to fault-inject an errored directory entry
  from a unit test, so that propagation is covered by code review and by the
  directory-level tests, not by a dedicated entry-fault test.
- The lock-free `PaneLedger::new` (tests and the integration harness) gets the
  same ENABLED⟹complete-scan guarantee as `new_locked`: on a scan fault it
  logs loudly at ERROR and comes up DISABLED. No production caller uses
  `new()` (grep-verified: production is `main.rs`'s `new_locked`), so this
  parity change touches only test/harness ergonomics.

**Goal:** A restarted Freshell server can never come up with a silently blind
pane→session ledger: any scan-level I/O fault turns into a loudly-logged
DISABLED ledger, while a genuinely absent (first-boot) store still comes up
ENABLED and empty.

**Architecture:** `load_index` becomes
`std::io::Result<LedgerIndex>`: `NotFound` on the scan directories maps to
"absent" (empty contribution), and every other directory-read or entry error
propagates. Both constructors route the scan through one policy:
`Ok` → ENABLED with that index; `Err` → a structured ERROR log
(`pane_ledger_scan_unavailable`, includes the faulted path and the OS error)
plus the DISABLED construction. The boot-scan quarantine walk
(`quarantine_unparsable`) gets the same never-silent treatment one notch
weaker (per its "fail loud per-row, never per-store" contract): a scan fault
is ERROR-logged and recorded on a new `BootScanReport.scan_errors` field,
then the walk continues; `main.rs` aggregates a boot-level ERROR when any
scan fault was recorded.

**Tech Stack:** Rust 1.96.0 (repo-pinned toolchain), `tracing` structured
logging, cargo test / clippy / fmt per `.github/workflows/rust-clippy.yml`;
repo file layout keeps ledger code in `crates/freshell-ws/src/pane_ledger.rs`
(child module `pane_ledger_scan.rs`) and unit tests in
`crates/freshell-ws/src/pane_ledger_tests.rs` (the `tabs_persist_tests.rs`
≤1K-lines convention).

## Global Constraints

- Rust toolchain 1.96.0 (`cargo --version` == 1.96.0 on this host; CI pins
  the same in `.github/workflows/rust-clippy.yml`). Gates per task:
  `cargo fmt --all --check`, `cargo clippy -p freshell-ws --all-targets -- -D warnings`;
  final whole-branch gate additionally runs the host-valid workspace clippy
  form `cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings`
  (the bare `--workspace` form cannot run on this host: `freshell-tauri`'s
  WRY build needs GTK/WebKit system libraries that are not installed —
  `pkg-config --exists webkit2gtk-4.1` is absent — which is why the repo's
  own QA gate excludes that crate; CI installs the apt deps, so the exclude
  form plus unchanged CI is the parity story) and `cargo test -p freshell-server`.
- `crates/freshell-ws/src/pane_ledger.rs` is at 1027 lines against a repo
  ≤1K-lines convention: the change must not grow that file materially
  (doc edits and small refactors only; the scan-fault helper is shared,
  not duplicated).
- Test-fault injection must be uid-independent (tests may run as any user):
  simulate an unreadable directory by replacing it with a regular FILE
  (`read_dir` → `ENOTDIR`), never by chmod.
- Every `ERROR`/`WARN` log line follows the file's existing
  `tracing::...(target: "freshell_ws::pane_ledger", <fields>, "<msg>")`
  structured style, and the OS error (including errno text) must survive
  into the log — the f3wp flake investigation lesson was that a dropped
  errno made the mechanism undiagnosable.
- No changes to the on-disk schema, `LEDGER_VERSION`, file layout, or any
  public row type. The only API additions: `load_index` (private) changes
  signature, and `BootScanReport` gains one additive field.
- This change is internal reliability hardening: no user-facing UI, so no
  `docs/index.html` update; no `README.md` update (repo rule: README is the
  only end-user doc, and this is not end-user-facing).

---

### Task 1: `load_index` propagates scan faults; constructors can never come up blind

**Files:**
- Modify: `crates/freshell-ws/src/pane_ledger.rs` (module doc ~L26-28,
  `LedgerIndex` doc ~L184-188, `PaneLedger::new` ~L218-229,
  `PaneLedger::new_locked` doc ~L231-236, `load_index` ~L313-350)
- Test: `crates/freshell-ws/src/pane_ledger_tests.rs`

**Interfaces:**
- Consumes: existing `LedgerIndex`, `BindingRow`, `PendingMarker`,
  `LEDGER_VERSION`, `load_row`, `PaneLedger::{new,new_locked,disabled,
  is_enabled,ever_bound,record_binding,list_bindings}`, test helpers
  `temp_root(label)` and `write(provider,session_id,terminal_id,now_ms)` in
  `pane_ledger_tests.rs`.
- Produces:
  - `fn read_dir_existing(dir: &Path) -> std::io::Result<Option<std::fs::ReadDir>>`
    (private, module level in `pane_ledger.rs`; child module
    `pane_ledger_scan` sees it via `use super::*`). `Ok(Some(rd))` when the
    dir reads; `Ok(None)` iff `ErrorKind::NotFound` (absent store region);
    `Err` otherwise, wrapped as
    `std::io::Error::new(err.kind(), format!("read {}: {err}", dir.display()))`
    so the faulted path AND the original OS-error text (errno included in
    `std::io::Error`'s `Display`, e.g. "Permission denied (os error 13)")
    both survive, while `kind()` stays programmatic.
  - `fn PaneLedger::load_index(root: &Path) -> std::io::Result<LedgerIndex>`
    (signature change from `-> LedgerIndex`).
  - Guarantee: any constructed `PaneLedger` with `is_enabled() == true`
    completed a full scan of every scan directory that existed at
    construction.

- [ ] **Step 1: Write the failing behavioral tests**

Append to `crates/freshell-ws/src/pane_ledger_tests.rs`:

```rust
#[test]
fn new_comes_up_disabled_when_bindings_dir_is_unreadable() {
    // kata qzka: a scan-level fault must NEVER yield a blind ENABLED
    // ledger. `bindings` as a regular FILE fails read_dir with ENOTDIR on
    // every platform — uid-independent, no chmod.
    let root = temp_root("new-blind");
    std::fs::write(root.join("bindings"), b"not a directory").unwrap();
    let ledger = PaneLedger::new(Some(root.clone()));
    assert!(
        !ledger.is_enabled(),
        "a store whose bindings dir cannot be read must come up DISABLED, \
         never ENABLED-and-blind"
    );
    assert!(
        !ledger.ever_bound("claude", "s1"),
        "a disabled ledger's reads answer empty"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn new_locked_comes_up_disabled_when_bindings_dir_is_unreadable() {
    // The kata's headline scenario: a REAL, durably-written store exists;
    // the restarted process cannot read it. Today the restart comes up
    // ENABLED and blind to s1; after the fix it comes up DISABLED (loud).
    // gen1 uses the lock-free constructor so this test performs exactly ONE
    // flock acquisition (gen2) — no drop/re-acquire ordering involved
    // (f3wp flake lesson).
    let root = temp_root("locked-blind");
    let gen1 = PaneLedger::new(Some(root.clone()));
    gen1.record_binding(&write("claude", "s1", "t1", 1)).unwrap();
    assert!(gen1.ever_bound("claude", "s1"));
    let bindings = root.join("bindings");
    let stash = root.join("bindings.stash");
    std::fs::rename(&bindings, &stash).unwrap();
    std::fs::write(&bindings, b"not a directory").unwrap();
    let gen2 = PaneLedger::new_locked(Some(root.clone()));
    assert!(
        !gen2.is_enabled(),
        "restart over an unreadable bindings dir must come up DISABLED \
         (loud), not ENABLED-and-blind to the durably-written s1"
    );
    assert!(!gen2.ever_bound("claude", "s1"));
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn new_comes_up_disabled_when_pending_dir_is_unreadable() {
    let root = temp_root("new-blind-pending");
    std::fs::write(root.join("pending"), b"not a directory").unwrap();
    let ledger = PaneLedger::new(Some(root.clone()));
    assert!(
        !ledger.is_enabled(),
        "an unreadable pending dir is a scan-level fault: DISABLED, never blind"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn new_locked_first_boot_absent_dirs_is_enabled_and_empty() {
    // The other half of the kata's distinction: "no index yet" (first boot —
    // the scan dirs are simply absent) is NOT a fault. NotFound must map to
    // an ENABLED empty index, or every first boot would self-disable.
    let root = temp_root("first-boot");
    let ledger = PaneLedger::new_locked(Some(root.clone()));
    assert!(
        ledger.is_enabled(),
        "absent bindings/pending dirs (first boot) is not a fault"
    );
    assert!(ledger.list_bindings().is_empty());
    assert!(!ledger.ever_bound("claude", "s1"));
    // ...and the ENABLED first-boot ledger is fully functional.
    ledger.record_binding(&write("claude", "s1", "t1", 1)).unwrap();
    assert!(ledger.ever_bound("claude", "s1"));
    std::fs::remove_dir_all(&root).ok();
}
```

(The fourth test is a regression pin: it passes before AND after the change,
guarding the NotFound→empty-enabled mapping so the fault path cannot
accidentally swallow first boot.)

- [ ] **Step 2: Run the tests and verify the intended failures**

Run: `cargo test -p freshell-ws --lib pane_ledger::tests`
(the unit-test file is included as `#[path] mod tests` inside `pane_ledger`,
so test paths are `pane_ledger::tests::<name>`)

Expected: FAIL — `new_comes_up_disabled_when_bindings_dir_is_unreadable`,
`new_locked_comes_up_disabled_when_bindings_dir_is_unreadable`, and
`new_comes_up_disabled_when_pending_dir_is_unreadable` each fail on their
`!is_enabled()` assertion because today's `load_index` swallows the `ENOTDIR`
and the constructors come up ENABLED-and-empty (the exact blind mode being
removed). `new_locked_first_boot_absent_dirs_is_enabled_and_empty` PASSES
(regression pin). No compile errors and no failures for any other reason.

- [ ] **Step 3: Add the minimal production implementation**

In `crates/freshell-ws/src/pane_ledger.rs`:

1. Add the shared scan helper at module level (private; `pane_ledger_scan`
   is a `#[path]` child module and reaches it through `use super::*`):

```rust
/// Read a scan directory, mapping `NotFound` to "absent" (`Ok(None)`) and
/// propagating every other error with the faulted path attached. The
/// `std::io::Error` `Display` already carries the errno text (f3wp lesson:
/// the errno is what names the mechanism), so both `kind()` and the OS
/// detail survive the wrap. Shared by `load_index` (propagates) and the
/// boot-scan quarantine walk (records + continues).
fn read_dir_existing(dir: &Path) -> std::io::Result<Option<std::fs::ReadDir>> {
    match std::fs::read_dir(dir) {
        Ok(rd) => Ok(Some(rd)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(std::io::Error::new(
            err.kind(),
            format!("read {}: {err}", dir.display()),
        )),
    }
}
```

2. Rewrite `PaneLedger::new` so ENABLED requires a complete scan (any scan
   `Err` → loud structured ERROR + the DISABLED construction), keeping the
   `None`-root and `disabled()` behavior byte-identical:

```rust
    /// Lock-free construction — tests and the integration harness use this
    /// (verification handles over a live server's dir must not fight the
    /// server's flock). Production uses [`PaneLedger::new_locked`].
    ///
    /// An ENABLED ledger guarantees its index reflects a COMPLETE
    /// construction scan of the on-disk store: a store region that exists
    /// but cannot be fully read (I/O error, unreadable subdir, errored
    /// entry) logs a loud structured ERROR and comes up DISABLED — never
    /// silently ENABLED-but-blind (kata qzka; a blind `None` from
    /// `bound_session_ref_for_terminal` is indistinguishable from
    /// "retired", which is why [`PaneLedger::is_enabled`] gates the
    /// auto-resume guard). A store whose scan dirs are simply ABSENT is the
    /// expected first-boot shape: ENABLED with an empty index.
    pub fn new(root: Option<PathBuf>) -> Self {
        let Some(r) = root else {
            return Self {
                root: None,
                index: Mutex::new(LedgerIndex::default()),
                lock_file: None,
                quarantined: RwLock::new(Vec::new()),
            };
        };
        match Self::load_index(&r) {
            Ok(index) => Self {
                root: Some(r),
                index: Mutex::new(index),
                lock_file: None,
                quarantined: RwLock::new(Vec::new()),
            },
            Err(err) => {
                tracing::error!(
                    target: "freshell_ws::pane_ledger",
                    root = %r.display(),
                    error = %err,
                    "pane_ledger_scan_unavailable: store exists but could not \
                     be fully read; ledger DISABLED (never a blind ledger)"
                );
                Self::disabled()
            }
        }
    }
```

3. Extend the `new_locked` doc comment with the second DISABLED cause (body
   unchanged — it already routes the scan through `Self::new`):

```rust
    /// Production construction (V2.md single-writer guard): acquire an
    /// exclusive advisory `flock(2)` on `<root>/lock` (the `ConfigLock`
    /// pattern, `settings_store.rs:385-417`). If another process holds it,
    /// log a loud structured ERROR and come up DISABLED (no-op) — never two
    /// writers on one store. The scan then runs under [`PaneLedger::new`]'s
    /// completeness guarantee: a store that EXISTS but cannot be fully read
    /// also comes up DISABLED with a loud structured ERROR
    /// (`pane_ledger_scan_unavailable`), while an absent (first-boot) store
    /// comes up ENABLED and empty — absence is not a fault. Non-unix: no
    /// flock primitive is wired; construct normally (ConfigLock's non-unix
    /// parity).
```

4. Rewrite `load_index` to return `std::io::Result<LedgerIndex>` using
   `read_dir_existing`, and to propagate entry-level iteration errors
   (replacing the `.flatten()`s). Row-level skips (unparsable / wrong
   version) are unchanged — the boot scan quarantines those loudly:

```rust
    /// The ONE directory scan — construction-time only (V1.md).
    ///
    /// Scan-level fault policy (kata qzka): a scan directory that exists
    /// but cannot be read, a provider subdirectory that cannot be read, or
    /// an entry that errors mid-iteration is a STORE-LEVEL fault and
    /// propagates as `Err`; the constructors turn it into a loudly-logged
    /// DISABLED ledger, never a blind ENABLED one. `NotFound` maps to
    /// "absent" — the expected first-boot shape — and contributes nothing.
    /// Anything under `bindings/` that is not a readable directory of row
    /// files is therefore also a fault. ROW-level faults stay per-row:
    /// unparsable / wrong-version files are skipped here, and the boot scan
    /// quarantines them loudly (module doc, fail-loud-per-row).
    fn load_index(root: &Path) -> std::io::Result<LedgerIndex> {
        fn entry_err(err: std::io::Error, dir: &Path) -> std::io::Error {
            std::io::Error::new(err.kind(), format!("list {}: {err}", dir.display()))
        }
        let mut index = LedgerIndex::default();
        if let Some(providers) = read_dir_existing(&Self::bindings_dir(root))? {
            for provider in providers {
                let provider =
                    provider.map_err(|err| entry_err(err, &Self::bindings_dir(root)))?;
                let provider_dir = provider.path();
                let Some(files) = read_dir_existing(&provider_dir)? else {
                    continue; // provider dir vanished mid-scan — absent
                };
                for file in files {
                    let file = file.map_err(|err| entry_err(err, &provider_dir))?;
                    let path = file.path();
                    if path.extension().and_then(|e| e.to_str()) != Some("json") {
                        continue; // *.tmp-* and *.quarantined-* residue
                    }
                    if let Ok(row) = load_row::<BindingRow>(&path) {
                        if row.ledger_version == LEDGER_VERSION {
                            index
                                .bindings
                                .insert((row.provider.clone(), row.session_id.clone()), row);
                        }
                    }
                }
            }
        }
        if let Some(files) = read_dir_existing(&Self::pending_dir(root))? {
            for file in files {
                let file = file.map_err(|err| entry_err(err, &Self::pending_dir(root)))?;
                let path = file.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                if let Ok(marker) = load_row::<PendingMarker>(&path) {
                    if marker.ledger_version == LEDGER_VERSION {
                        index.pending.insert(marker.terminal_id.clone(), marker);
                    }
                }
            }
        }
        Ok(index)
    }
```

5. Update the module doc's corruption-policy paragraph (after the existing
   per-row sentences, ~L26-28) and the `LedgerIndex` field doc (~L184-188):

```rust
//! Corruption policy: fail loud PER-ROW, never per-store — an unparsable row
//! is quarantined (renamed aside + logged), never silently dropped, and never
//! causes healthy rows to be skipped. STORE-level faults are the mirror
//! image (kata qzka): a scan directory that exists but cannot be read
//! disables the ledger loudly at construction
//! (`pane_ledger_scan_unavailable`) — an ENABLED ledger ALWAYS guarantees a
//! complete construction scan, and a blind ENABLED ledger is never
//! constructed. First boot is not a fault: absent scan dirs map to an
//! ENABLED empty index.
```

and

```rust
/// The in-memory write-through index (V1.md / A15). Loaded ONCE at
/// construction by a single directory scan; every successful file write
/// updates it in the same locked section. Unparsable / wrong-version files
/// are skipped here silently — the boot scan (Task 4) is what quarantines
/// them loudly. Scan-level I/O faults (unreadable dir, errored entry) are
/// NOT skipped: they propagate out of `load_index` and disable the ledger.
```

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-ws --lib pane_ledger::tests`

Expected: PASS (all four new tests plus every pre-existing test in the
module).

- [ ] **Step 5: Refactor while green**

Confirm the `entry_err` closures and `read_dir_existing` read cleanly;
confirm `pane_ledger.rs` net line growth is ≈40 lines and stays near the
≤1K convention (justify in the commit body if it crosses); no other
refactor is needed — the change intentionally leaves row-level handling
untouched.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: every Rust consumer of `PaneLedger` constructors and every
ledger-touching integration test — `pane_ledger_triggers.rs`,
`rest_locator_identity.rs`, `resume_validation_gate.rs`,
`auto_resume_respawn.rs`, `codex_candidate_inert.rs`,
`opencode_switch_rebind.rs`, `rest_claude_identity.rs`,
`pane_reconcile_freshagent.rs` (all in the `freshell-ws` test target), plus
`pane_identity_binder`'s cfg(test) helpers (lib tests). The
`freshell-server` consumer of `new_locked` is
`recovery_inventory_tests.rs` (server lib tests).

Run: `cargo test -p freshell-ws && cargo test -p freshell-server --lib && cargo clippy -p freshell-ws --all-targets -- -D warnings && cargo fmt --all --check`

Expected: PASS (all four commands, zero exit).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ws/src/pane_ledger.rs crates/freshell-ws/src/pane_ledger_tests.rs
git commit -m "fix(pane-ledger): propagate scan faults — constructors never come up blind

load_index swallowed every directory-scan I/O error, so a restarted
server with an unreadable pane-ledger store came up ENABLED and silently
blind to its durably-written pane->session bindings (kata qzka; the
unconfirmed H2 mechanism in f3wp's lock-test flake analysis).
load_index now maps NotFound to the expected first-boot empty shape and
propagates every other scan-level fault; both constructors turn such a
fault into a loudly-logged DISABLED ledger (pane_ledger_scan_unavailable),
which is the safe mode the auto-resume guard already handles explicitly."
```

### Task 2: Quarantine walk never silently skips a store region; boot reports scan faults

**Files:**
- Modify: `crates/freshell-ws/src/pane_ledger_scan.rs` (`BootScanReport`
  ~L37-46, `quarantine_unparsable` ~L428-439)
- Modify: `crates/freshell-server/src/main.rs` (boot-scan report aggregation
  ~L1096-1100)
- Test: `crates/freshell-ws/src/pane_ledger_tests.rs`

**Interfaces:**
- Consumes: Task 1's `read_dir_existing` (via `use super::*`),
  `BootScanReport`, `PaneLedger::boot_scan(now_ms, transcript_absent)`,
  test helpers `temp_root`/`write`.
- Produces:
  - `BootScanReport.scan_errors: Vec<String>` — one `"<path>: <os error
    text>"` entry per directory-walk fault hit by the quarantine rescan,
    each also `tracing::error!`-logged at fault time. Additive field on a
    `#[derive(Default)]` struct; every existing construction site
    (`BootScanReport::default()` callers, report-consumers in
    `main.rs:1096`) compiles unchanged.

- [ ] **Step 1: Add the (unpopulated) field and write the failing behavioral test**

In `crates/freshell-ws/src/pane_ledger_scan.rs`, extend `BootScanReport`:

```rust
/// What one boot scan / GC pass did — every field is also loudly logged.
#[derive(Debug, Default)]
pub struct BootScanReport {
    pub quarantined: Vec<QuarantinedRow>,
    pub stale_markers_removed: Vec<String>,
    /// (retired old ref, winning new ref) pairs from the crash-window repair.
    pub supersession_repairs: Vec<(SessionLocator, SessionLocator)>,
    pub gc_tombstoned: Vec<SessionLocator>,
    pub tombstones_deleted: Vec<SessionLocator>,
    /// Directory-walk faults hit by the quarantine rescan (`"<path>: <os
    /// error>"`, each already ERROR-logged at fault time). An ENABLED
    /// ledger's store was fully readable at construction (kata qzka), so any
    /// entry here means the store DEGRADED between construction and this
    /// pass — always loud, never silently skipped.
    pub scan_errors: Vec<String>,
}
```

Append to `crates/freshell-ws/src/pane_ledger_tests.rs`:

```rust
#[test]
fn boot_scan_records_scan_faults_and_still_quarantines_each_bad_row() {
    // kata qzka: the quarantine walk must never silently skip a store
    // region — a region that turned unreadable AFTER construction is
    // recorded in the report (and ERROR-logged), while healthy regions
    // still get their per-row quarantine (never per-store).
    let root = temp_root("scan-fault-report");
    let ledger = PaneLedger::new(Some(root.clone()));
    assert!(ledger.is_enabled());
    // Healthy region: a corrupt PENDING row to quarantine.
    let pending_dir = root.join("pending");
    std::fs::create_dir_all(&pending_dir).unwrap();
    std::fs::write(pending_dir.join("t-bad.json"), b"not json").unwrap();
    // Faulted region: bindings becomes unreadable after construction.
    std::fs::write(root.join("bindings"), b"not a directory").unwrap();
    let never_absent = |_: &str, _: &str| false;
    let report = ledger.boot_scan(2_000, &never_absent);
    assert!(
        report.scan_errors.iter().any(|e| e.contains("bindings")),
        "scan_errors must name the faulted bindings dir, got: {:?}",
        report.scan_errors
    );
    assert_eq!(
        report.quarantined.len(),
        1,
        "the healthy pending region's corrupt row must still be quarantined"
    );
    assert!(
        !pending_dir.join("t-bad.json").exists(),
        "the corrupt row was renamed aside"
    );
    std::fs::remove_dir_all(&root).ok();
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-ws --lib pane_ledger::tests::boot_scan_records_scan_faults`

Expected: FAIL — the first assertion fails because the walk still swallows
the `ENOTDIR` on `bindings` and `scan_errors` comes back empty (the
quarantine assertions already pass, proving the failure is the missing
loudness, not a setup accident).

- [ ] **Step 3: Add the minimal production implementation**

Rewrite the candidate-collection front of
`PaneLedger::quarantine_unparsable` in
`crates/freshell-ws/src/pane_ledger_scan.rs` (the per-row body after it is
unchanged), same policy as `load_index` one notch weaker — record + log +
continue, never die per-store:

```rust
    fn quarantine_unparsable(&self, root: &Path, now_ms: i64, report: &mut BootScanReport) {
        // Scan-level fault policy, one notch weaker than `load_index`'s
        // (kata qzka): the walk never dies per-store — a fault is
        // ERROR-logged and recorded on the report (the OS-error text
        // carries the errno), then the walk continues. `NotFound` = absent
        // = not a fault (a first-boot store writes nothing before the boot
        // scan runs).
        fn scan_fault(what: &Path, err: &std::io::Error, report: &mut BootScanReport) {
            tracing::error!(
                target: "freshell_ws::pane_ledger",
                path = %what.display(),
                error = %err,
                "pane_ledger_scan_fault: quarantine walk could not fully read the store"
            );
            report.scan_errors.push(format!("{}: {err}", what.display()));
        }
        let mut candidates: Vec<PathBuf> = Vec::new();
        match read_dir_existing(&Self::bindings_dir(root)) {
            Ok(Some(providers)) => {
                for provider in providers {
                    let provider = match provider {
                        Ok(p) => p,
                        Err(err) => {
                            scan_fault(&Self::bindings_dir(root), &err, report);
                            continue;
                        }
                    };
                    match read_dir_existing(&provider.path()) {
                        Ok(Some(files)) => {
                            for file in files {
                                match file {
                                    Ok(f) => candidates.push(f.path()),
                                    Err(err) => scan_fault(&provider.path(), &err, report),
                                }
                            }
                        }
                        Ok(None) => {} // provider dir vanished mid-scan — absent
                        Err(err) => scan_fault(&provider.path(), &err, report),
                    }
                }
            }
            Ok(None) => {} // no bindings dir — nothing to scan
            Err(err) => scan_fault(&Self::bindings_dir(root), &err, report),
        }
        match read_dir_existing(&Self::pending_dir(root)) {
            Ok(Some(files)) => {
                for file in files {
                    match file {
                        Ok(f) => candidates.push(f.path()),
                        Err(err) => scan_fault(&Self::pending_dir(root), &err, report),
                    }
                }
            }
            Ok(None) => {} // no pending dir — nothing to scan
            Err(err) => scan_fault(&Self::pending_dir(root), &err, report),
        }
        for path in candidates {
            // ... existing per-row body (orphan-tmp reap, quarantine rename)
            // is unchanged ...
        }
    }
```

And in `crates/freshell-server/src/main.rs`, extend the boot aggregation
immediately after the existing `report.quarantined` block (~L1096):

```rust
        if !report.scan_errors.is_empty() {
            tracing::error!(
                count = report.scan_errors.len(),
                "pane_ledger_boot: store scan faults during boot hygiene \
                 (see per-path pane_ledger_scan_fault errors above)"
            );
        }
```

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-ws --lib pane_ledger::tests`

Expected: PASS (the new test plus the whole module).

- [ ] **Step 5: Refactor while green**

Confirm no duplication of the NotFound mapping remains (both scans route
through `read_dir_existing`); confirm the `main.rs` addition sits adjacent
to the quarantined aggregate with matching style. No further refactor.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: `BootScanReport` consumers (`boot_scan`/`gc` callers across
`pane_ledger_tests.rs`, `main.rs`) and the same ledger-touching integration
tests as Task 1; `main.rs` changed, so the `freshell-server` crate must
recompile cleanly and its lib tests pass.

Run: `cargo test -p freshell-ws && cargo test -p freshell-server --lib && cargo clippy -p freshell-ws --all-targets -- -D warnings && cargo clippy -p freshell-server --all-targets -- -D warnings && cargo fmt --all --check`

Expected: PASS (all five commands, zero exit).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ws/src/pane_ledger_scan.rs crates/freshell-server/src/main.rs crates/freshell-ws/src/pane_ledger_tests.rs
git commit -m "fix(pane-ledger): record quarantine-walk scan faults instead of skipping silently

The boot-scan quarantine walk used the same if-let-Ok swallow pattern as
the old load_index: a store region that turned unreadable after
construction was skipped with no signal. Faults are now ERROR-logged
(pane_ledger_scan_fault, with the faulted path and OS error), recorded on
BootScanReport.scan_errors, and aggregated once at boot in main.rs; the
walk itself still never dies per-store."
```

---

## Whole-branch verification (after both tasks, before the delta review)

1. `cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings` —
   the host-valid workspace clippy gate (see Global Constraints for the
   GTK/WebKit rationale; `freshell-tauri` is untouched by this change).
2. `cargo test -p freshell-server` — full server crate: the per-task
   `--lib` runs already cover the `recovery_inventory` `new_locked` consumer
   (a `#[cfg(test)] #[path]` lib-test module); the unfiltered run adds the
   crate's remaining targets (bins/doc-tests) for the final state.
3. Full repository QA gate: `darkforge qa --repo '/home/dan/code/freshell' --id 'qzka'`
   (runs the assigned `/home/dan/.local/share/darkforge/sources/freshell-qa.sh`
   in this worktree and records an exact-commit observation). Accept zero
   exit, or nonzero only when every parsed failure identity is in the
   completed baseline ledger (the three pre-existing
   `test/unit/vite-config.test.ts > getNetworkHost` failures).
4. Work-source oracle `npm run check`: the QA gate script itself drives
   `npm run check` (visible in the kernel's baseline evidence log), so the
   gate run IS the oracle run for this item; note the equivalence in the
   recap rather than double-running the coordinated suite. The oracle does
   not exercise Rust; the cargo gates above carry the Rust evidence.

## Dispatch notes

- Subagent delegation for implementation is OPTIONAL for this plan: both
  tasks are small, single-file-cluster Rust changes with full code above;
  if delegated, the delegate receives this plan's path and the exact task
  boundaries. Task-level review after each task is not optional.
- Do not modify any behavior outside the two named tasks; do not "repair"
  the three pre-existing `getNetworkHost` baseline failures.
