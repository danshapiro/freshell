# pane_ledger flock-after-drop EWOULDBLOCK: root-cause hardening (H1) + loud load_index (H2) Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Investigate and fix the suspected product race where `crates/freshell-ws/src/pane_ledger_tests.rs` —
`new_locked_degrades_to_disabled_when_another_holder_exists` — observed `errno=Some(11) kind=WouldBlock`
(EWOULDBLOCK) from the private `acquire_store_lock()` probe immediately after the holding `PaneLedger`
was dropped (1 of 10 runs under TMPDIR-isolated `cargo test --workspace` load; panic at
`pane_ledger_tests.rs:190:21`; evidence: `/tmp/deflake-logs/flake4b-10x-run10.log` lines 265-266 and
summary `/tmp/deflake-logs/flake4b-10x.log`; per the deflake lane fence this was escalated as a
suspected real product race, NOT retry-masked). Investigate both hypotheses: (1) a genuine race between
Drop's flock release and the next acquirer under host contention, and (2) another `PaneLedger` instance
in a concurrently-running test/process (cross-process contention on a path that should be test-isolated)
still holding the lock at that moment. Also address companion finding H2: pane_ledger's `load_index()`
swallows I/O errors silently (`pane_ledger.rs` ~299-321), which can compound this failure mode into a
silently-empty/disabled ledger rather than a loud one.

### Explicit constraints
- No retry-masking of the deflake probe test in the test-only lane; diagnostics are the deliverable for recurrences.
- Follow the repository's Red-Green-Refactor TDD discipline and the Darkforge stage gates.
- Server uses NodeNext/ESM for TS; Rust workspace crates under `crates/`; this work is Rust-only.
- Pre-existing baseline failures (`test/unit/vite-config.test.ts > getNetworkHost > *`, 3 identities) are NOT in scope and must not be "repaired to force green".
- Do not restart or otherwise disturb the self-hosted Freshell Rust server on this host.
- Preserve existing explicit behavior contracts: single-writer flock guard, fail-loud-per-row corruption policy, write-through index, boot-scan quarantine loudness.

### Accepted tradeoffs and residuals
- The exact in-flight holder from the original run-10 occurrence is unrecoverable post-hoc; the fix targets the proven mechanism CLASS (transient holder windows) plus failure-mode loudness, and upgrades the probe's diagnostics to name the holder pid on any recurrence (via `/proc/locks`).
- The sibling `CodexSidecarStore::new_locked` (`crates/freshell-codex/src/sidecar_store.rs`) shares the single-shot acquisition shape; it is NOT changed in this work item (recorded as a follow-up candidate) unless review makes parity blocking.
- Baseline remains red for the 3 pre-existing vite-config identities; the full QA gate accepts nonzero only when every parsed failure identity is in the completed baseline ledger.

**Goal:** A transient flock-holder window — the fork→exec open-file-description (OFD) inheritance handoff (in-tree trigger: `git` spawns from `terminal_meta.rs:492` inside the same lib test binary under 96-way libtest parallelism; empirically bounded AT exec by O_CLOEXEC — validator PoC arms a/b1/b2, `reports/validator-poc.md` in logs_dir) — at `PaneLedger::new_locked` acquisition time no longer degrades the ledger to DISABLED for the whole process lifetime, while a genuine second writer still produces exactly today's loud DISABLED outcome; `load_index()` I/O failures (unreadable directories or rows) surface as loud structured ERRORs instead of a silently-empty index; the deflake probe retains its errno evidence and additionally identifies the lock holder's pid from `/proc/locks` on failure.

**Architecture:** Keep the existing design (flock id, `<root>/lock`, DISABLED-on-contention construction, write-through index, boot-scan quarantine). Add a deliberately small, bounded, documented retry **inside** `acquire_store_lock` (only on EWOULDBLOCK; never on other errnos), so the production acquisition path tolerates transient holder windows, and a genuine persistent holder still fails after the fixed budget with the same loud ERROR. Instrument `load_index` to emit structured ERROR logs for directory and per-row I/O failures while keeping parse-error silence (boot-scan quarantines those loudly per the existing documented policy). Upgrade the probe test's panic with holder identification; add deterministic tests that a mid-retry release is absorbed and that persistent contention still degrades within a bounded time.

**Tech Stack:** Rust (workspace crates `freshell-ws`, edition per workspace), `libc::flock`, `tracing` (structured logs), `tracing-subscriber` capture layer (existing `crate::invariants::capture` test facility), `std::os::unix::fs::MetadataExt` (`st_dev`/`st_ino`) for the `/proc/locks` diagnostic, cargo test + the repo QA gate (`npm run check` + `cargo fmt --all --check` + clippy).

## Global Constraints

- Unix-only behavior changes stay behind `#[cfg(unix)]`; the `not(unix)` parity path is byte-for-byte behavior-preserving (constructs normally, no retry loop needed: no flock primitive exists there).
- Do not change on-disk schema, file layout, TTLs, or any `BindingRow`/`PendingMarker` fields; `LEDGER_VERSION` stays 1 (no migration).
- Do not weaken fail-loud-per-row corruption policy: parse errors in `load_index` remain silent (boot-scan quarantine is the loud path, documented) — only I/O errors become loud.
- No new crate dependencies; `libc`, `tracing`, `serde`, `tempfile` (dev) etc. are already in the tree.
- One-responsibility files: production changes in `crates/freshell-ws/src/pane_ledger.rs`; test changes in `crates/freshell-ws/src/pane_ledger_tests.rs` (the ≤1K-lines convention — current sizes: 1027 + 1156 lines; keep each under the 1K-line norm by extending the sibling test file only, and keep `pane_ledger.rs` growth minimal and doc-focused).
- Retry constants are `const` items with rationale comments; no env knobs, no jitter, deterministic.
- `_` Commit messages must be conventional and focused; each task ends in one commit containing exactly that task's files.

---

### Task 1: Bounded-retry flock acquisition in `acquire_store_lock` (H1), plus probe holder diagnostics

**Files:**
- Modify: `crates/freshell-ws/src/pane_ledger.rs:237-284` (`new_locked` rustdoc, `acquire_store_lock` unix impl; module doc "single-writer flock" note at lines 36-43)
- Test: `crates/freshell-ws/src/pane_ledger_tests.rs:146-209` (probe test diagnostics + DEFLAKE comment update; two new `#[cfg(unix)]` tests appended after it)

**Interfaces:**
- Consumes: existing private `fn acquire_store_lock(root: &Path) -> std::io::Result<Option<std::fs::File>>` (unix + non-unix cfg variants), called by `PaneLedger::new_locked` and by the probe test.
- Produces:
  - `#[cfg(unix)] fn flock_once(root: &Path) -> std::io::Result<Option<std::fs::File>>` — the exact current single-shot open+flock body (unchanged semantics).
  - `#[cfg(unix)]` acquisition retry contract on `acquire_store_lock`: loops `flock_once` while the error is `EWOULDBLOCK`, sleeping `LOCK_RETRY_DELAY_MS` between attempts, up to `LOCK_RETRY_MAX_ATTEMPTS` total attempts; returns the last error unchanged once the budget is exhausted; non-EWOULDBLOCK errors return immediately.
  - `const LOCK_RETRY_MAX_ATTEMPTS: u32 = 12;` and `const LOCK_RETRY_DELAY_MS: u64 = 25;` (worst added latency ≈ 275 ms, one-shot boot-time path only).
  - Test-only helper `fn lock_holder_report(lock_path: &Path) -> String` in `pane_ledger_tests.rs` (unix): stats the lock file, extracts matching `/proc/locks` rows (inode match), returns them joined for the panic message, or `"lock-holders unavailable: <err>"`.

- [ ] **Step 1: Write the failing behavioral tests**

Append to `crates/freshell-ws/src/pane_ledger_tests.rs` (directly after the existing probe test):

```rust
#[cfg(unix)]
#[test]
fn acquire_retries_through_a_transient_holder_release() {
    // H1 root-cause class: with LOCK_NB a single-shot acquire fails inside a
    // transient holder window (e.g. a forked child still carrying a dup of
    // the lock fd pre-exec). Production acquisition must ABSORB a window that
    // releases well inside the retry budget: the holder is dropped 50ms after
    // construction starts, far below the worst-case budget (~275ms).
    // Margin math: 50ms dropper vs ~275ms budget tolerates ~225ms of
    // scheduling overshoot (N4, proven structurally) — do NOT "tighten" the
    // 50ms toward the budget; that would reintroduce flakiness.
    let root = temp_root("lock-retry");
    let holder = PaneLedger::new_locked(Some(root.clone()));
    let rehome = root.clone();
    let dropper = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(50));
        drop(holder);
    });
    let started = std::time::Instant::now();
    let candidate = PaneLedger::new_locked(Some(rehome));
    dropper.join().unwrap();
    assert!(
        candidate.is_enabled(),
        "bounded retry must absorb a transient holder window; ledger came up DISABLED"
    );
    assert!(
        started.elapsed() >= std::time::Duration::from_millis(50),
        "acquisition must wait for the real holder release, not race past it"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[cfg(unix)]
#[test]
fn persistent_contention_still_degrades_disabled_within_a_bounded_budget() {
    // The single-writer contract is unchanged: a REAL second writer never
    // acquires. The retry budget only bounds degradation latency (~0.3s),
    // it never masks persistent contention.
    let root = temp_root("lock-persist");
    let _holder = PaneLedger::new_locked(Some(root.clone()));
    let started = std::time::Instant::now();
    let loser = PaneLedger::new_locked(Some(root.clone()));
    assert!(!loser.is_enabled(), "a persistent holder must still degrade");
    assert!(
        started.elapsed() < std::time::Duration::from_secs(3),
        "degradation is bounded by the fixed retry budget, never a spin"
    );
    std::fs::remove_dir_all(&root).ok();
}
```

These are RED before the fix: the first test observes `candidate.is_enabled() == false` because today's single-shot acquire fails EWOULDBLOCK the instant another holder exists; the second passes shape-wise but combined with the first pins the bounded-window contract.

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-ws --lib pane_ledger::tests::acquire_retries_through_a_transient_holder_release -- --exact`

Expected: FAIL at the `assert!(candidate.is_enabled(), ...)` (the missing behavior is retry tolerance), not any compile/setup error. (Note: this exact-name run also confirms the test harness accepts the filter once the code compiles; the failure is behavioral.)

- [ ] **Step 3: Add the minimal production implementation**

In `crates/freshell-ws/src/pane_ledger.rs`:

1. Add constants near `LEDGER_VERSION` (after line 57 block):

```rust
/// H1: a *transient* holder window — the fork→exec open-file-description
/// inheritance handoff (a forked child transiently carries a reference to
/// the lock's OFD; std opens O_CLOEXEC, so the window ends AT exec, proven
/// by validator PoC arm b2 / N6) — can leave `<root>/lock` momentarily held
/// when `new_locked` runs; single-shot `LOCK_NB` then converted a µs-scale
/// window (no-fork release measured ~13µs, PoC arm a) into a process-
/// lifetime DISABLED ledger (deflake kata s52d). Acquisition retries ONLY
/// on EWOULDBLOCK with a fixed budget: generous vs the measured window
/// class, small at the one-shot boot call site, and loud-unchanged for a
/// genuine persistent second writer (same ERROR, ~275ms later).
#[cfg(unix)]
const LOCK_RETRY_MAX_ATTEMPTS: u32 = 12;
#[cfg(unix)]
const LOCK_RETRY_DELAY_MS: u64 = 25;
```

2. Split the current unix `acquire_store_lock` body into `flock_once` (exact current body: `create_dir_all`, open, `flock(EX|NB)`) and give `acquire_store_lock` the retry loop:

```rust
#[cfg(unix)]
fn acquire_store_lock(root: &Path) -> std::io::Result<Option<std::fs::File>> {
    let mut attempt = 0u32;
    loop {
        match Self::flock_once(root) {
            Err(err) if err.raw_os_error() == Some(libc::EWOULDBLOCK) => {
                attempt += 1;
                if attempt >= LOCK_RETRY_MAX_ATTEMPTS {
                    return Err(err);
                }
                // Sync sleep is deliberate: this is the one-shot boot-time
                // constructor path, never a hot path, and the wait only
                // happens while a (transient) holder is actually observed.
                std::thread::sleep(std::time::Duration::from_millis(LOCK_RETRY_DELAY_MS));
            }
            other => return other,
        }
    }
}

#[cfg(unix)]
fn flock_once(root: &Path) -> std::io::Result<Option<std::fs::File>> {
    use std::os::unix::io::AsRawFd;
    std::fs::create_dir_all(root)?;
    // Content irrelevant (only existence + flock state matter);
    // truncate(false) avoids clippy's suspicious_open_options.
    //
    // O_CLOEXEC: `std::fs::File` opens close-on-exec by DEFAULT — KEEP it
    // that way: flock state rides the open file description, so a lock fd
    // carried across exec by a detached child would keep holding the flock
    // after this process dies (sidecar_store.rs V6.md NA-3 precedent).
    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(root.join("lock"))?;
    // SAFETY: `fd` is a valid open descriptor owned by `file` for the
    // duration of the call; flock only mutates kernel lock state.
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if rc == 0 {
        Ok(Some(file))
    } else {
        Err(std::io::Error::last_os_error())
    }
}
```

3. Update the `new_locked` rustdoc (lines 231-236) to state the retry contract: "acquisition retries EWOULDBLOCK-only on a fixed budget (see `LOCK_RETRY_MAX_ATTEMPTS`) so a transient holder window — the fork→exec open-file-description inheritance handoff — cannot downgrade this process to a lifetime-DISABLED ledger; a persistent second writer still degrades loudly". Update the module doc's single-writer mention (lines 36-43) cross-referencing H1 and the inheritance-mediated transient class. The `not(unix)` variant is unchanged.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-ws --lib pane_ledger::tests:: -- --nocapture`

Expected: PASS — the two new tests plus all existing `pane_ledger::tests::*`.

- [ ] **Step 5: Refactor while green**

Upgrade the probe test diagnostics (same red→green cycle within this task, now green by construction): in `new_locked_degrades_to_disabled_when_another_holder_exists`, keep every assertion and extend the failure paths with an ordered resight + holder report. Add the test-only helper near `temp_root`. The `/proc/locks` match is dev+inode hardened (D1/N2): the exact field-6 token format `%02x:%02x:%d` over (`libc::major(dev)`, `libc::minor(dev)`, ino) is evidence-locked by validator PoC arm c (observed verbatim token `fc:00:4213268`; both the simple `:{ino} ` shape and this hardened shape matched the self row — use the hardened shape to kill the cross-device false-positive caveat):

```rust
/// H1 diagnostic: on a lock-acquisition failure, `/proc/locks` names the
/// live holder pid(s) for this lock file (self vs foreign is the only
/// discrimination it can make: the pid column is the LOCKING tgid, so an
/// inheritance-window transient reports THIS test process's own pid, never
/// the forked child's). Match the hardened dev+ino token (format
/// `%02x:%02x:%d`, evidence-locked by validator PoC arm c).
#[cfg(unix)]
fn lock_holder_report(lock_path: &Path) -> String {
    use std::os::unix::fs::MetadataExt;
    let Ok(meta) = std::fs::metadata(lock_path) else {
        return "lock file itself unreadable".into();
    };
    let token = format!(
        "{:02x}:{:02x}:{}",
        libc::major(meta.dev()),
        libc::minor(meta.dev()),
        meta.ino()
    );
    match std::fs::read_to_string("/proc/locks") {
        Ok(body) => {
            let hits: Vec<&str> = body
                .lines()
                .filter(|l| l.split_whitespace().nth(5) == Some(token.as_str()))
                .collect();
            if hits.is_empty() {
                format!("no /proc/locks row for {token}")
            } else {
                hits.join("\n")
            }
        }
        Err(err) => format!("lock-holders unavailable: {err}"),
    }
}
```

Change the probe's panic path to sight the raw single-shot errno FIRST, then read `/proc/locks` (D2 — temporal adjacency distinguishes "transient window outlived the 275ms budget" (the single-shot resight now SUCCEEDS ⇒ released right after the retries gave up) from "genuinely held" (resight still EWOULDBLOCK)):

```rust
match PaneLedger::acquire_store_lock(&root) {
    Ok(lock) => drop(lock), // release before constructing `next`
    Err(err) => {
        // Sight the raw single-shot errno BEFORE reading /proc/locks.
        let resight = match PaneLedger::flock_once(&root) {
            Ok(lock) => {
                drop(lock);
                "single-shot resight now SUCCEEDS (window outlived the retry budget)".to_string()
            }
            Err(e) => format!(
                "single-shot resight still fails: errno={:?} kind={:?} (genuinely held)",
                e.raw_os_error(),
                e.kind()
            ),
        };
        panic!(
            "acquire_store_lock STILL failed after the bounded retry budget: errno={:?} kind={:?}; {}; \
             holder report (/proc/locks names the LOCKING tgid — an inheritance-window transient \
             reports THIS test process's own pid, a foreign holder reports a foreign pid): {}",
            err.raw_os_error(),
            err.kind(),
            resight,
            lock_holder_report(&root.join("lock")),
        )
    }
}
```

Update the DEFLAKE comment block (test lines 153-162) to record the resolution: root-cause CLASS identified as the fork→exec open-file-description inheritance handoff (in-tree trigger: `git` spawns from `terminal_meta.rs:492` in the same lib test binary under parallel libtest), NOT a bare drop→acquire race (proven non-mechanism: no-fork release is ~13µs, PoC arm a); product fix = bounded EWOULDBLOCK-only retry. The comment must state explicitly (N3) that routing the probe through the now-retrying `acquire_store_lock` means the probe SELF-ABSORBS transients by design — the retry is production behavior, not test-lane masking, and persistent contention still panics with the resight + holder pid report. It must ALSO state the C2(a) caveat: `/proc/locks` names the LOCKING tgid; for the inheritance class that is THIS test process (self vs foreign is the only discrimination available; it never names the forked child), so a self-pid report confirms the transient class overshooting budget rather than contradicting the fix. The historical fossil references stay intact.

Also reword the probe's final assertion message (test lines 200-207): the stale "(H2, pane_ledger.rs:299-321 swallows I/O errors)" line reference is post-refactor wrong, and post Task 2 an I/O-failure index is loud-but-unobserved HERE because this test binary installs no tracing subscriber. Reference the Task 2 event names (`pane_ledger_load_index_dir_unreadable`/`pane_ledger_load_index_row_unreadable`) instead of line numbers; do NOT add a capture to the probe test (coupling not worth it).

Refactor check: no duplicate retry logic elsewhere in this crate (sidecar_store is a sibling crate and explicitly out of scope); helper is unix-gated like its callers.

- [ ] **Step 6: Run impacted-test verification**

This task changes `acquire_store_lock`/`new_locked` behavior — the impacted set is every caller/probe of that path: the pane_ledger suite itself, the `freshell-server` recovery-inventory tests that construct `PaneLedger::new_locked` (`crates/freshell-server/src/recovery_inventory_tests.rs:407`), the `freshell-ws` integration target that uses `new_locked` (`crates/freshell-ws/tests/pane_reconcile_freshagent.rs:194`), and the sibling lock-pattern tests in `freshell-codex` (unchanged code, regression safety).

Run: `cargo test -p freshell-ws --lib pane_ledger && cargo test -p freshell-server recovery_inventory && cargo test -p freshell-ws --test pane_reconcile_freshagent && cargo test -p freshell-codex --lib sidecar_store`

Expected: PASS (all four).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ws/src/pane_ledger.rs crates/freshell-ws/src/pane_ledger_tests.rs
git commit -m "fix(pane-ledger): bounded EWOULDBLOCK-only retry on store-lock acquisition (H1)"
```

### Task 2: `load_index` I/O failures are loud (H2), never a silently-empty index

**Files:**
- Modify: `crates/freshell-ws/src/pane_ledger.rs:313-350` (`load_index`; module doc corruption-policy note at lines 26-28/34-43)
- Test: `crates/freshell-ws/src/pane_ledger_tests.rs` (two new tests appended after Task 1's tests)

**Interfaces:**
- Consumes: `crate::invariants::capture::capture()` (existing `#[cfg(test)] pub(crate)` thread-local capturing subscriber: records target/message/fields), `RowLoadError::{Missing, Io, Parse}` (already `Debug`), `Self::{bindings_dir, pending_dir}`.
- Produces: structured ERROR events on target `freshell_ws::pane_ledger` with messages:
  - `pane_ledger_load_index_dir_unreadable` — fields `path`, `error` (non-NotFound `read_dir` failure on the bindings root, a provider subdir, or the pending dir: rows there are absent from the index).
  - `pane_ledger_load_index_row_unreadable` — fields `path`, `error` (`RowLoadError::Io` for one row file: the row is absent from the index and the boot scan cannot repair what it cannot read).
  Behavior change: logging only. Index contents are unchanged for parse/missing-row cases (documented policy preserved).

- [ ] **Step 1: Write the failing behavioral tests**

Append to `pane_ledger_tests.rs`:

```rust
#[cfg(unix)]
#[test]
fn load_index_dir_io_errors_are_loud_not_silently_empty() {
    // H2 (kata s52d companion): an I/O failure while listing the store must
    // NEVER surface as a silently-empty index. `bindings` forged as a
    // REGULAR FILE makes read_dir deterministic-ENOTDIR on any uid (chmod
    // tricks are root-skip-flaky); same for `pending`.
    let root = temp_root("load-loud-dir");
    std::fs::write(root.join("bindings"), b"not a dir").unwrap();
    std::fs::write(root.join("pending"), b"not a dir").unwrap();
    let (events, guard) = crate::invariants::capture::capture();
    let ledger = PaneLedger::new(Some(root.clone()));
    drop(guard);
    let events = events.lock().unwrap();
    let hits: Vec<_> = events
        .iter()
        .filter(|e| {
            e.target == "freshell_ws::pane_ledger"
                && e.message.contains("pane_ledger_load_index_dir_unreadable")
        })
        .collect();
    assert_eq!(
        hits.len(),
        2,
        "one ERROR per unreadable top-level dir (bindings + pending); got: {events:?}"
    );
    assert!(hits.iter().all(|h| h.fields.get("path").is_some()));
    drop(events);
    assert!(!ledger.ever_bound("claude", "anything"), "index correctly empty; loudness is the contract");
    std::fs::remove_dir_all(&root).ok();
}

#[cfg(unix)]
#[test]
fn load_index_row_io_errors_are_loud_per_row() {
    // Same H2 lane, per-ROW: an entry ending in .json that is a DIRECTORY
    // makes the row read deterministic-EISDIR (uid-independent). Parse
    // errors of REAL rows stay silent-by-contract here (boot-scan quarantine
    // owns loudness) — this test must NOT flip that: only Io arms the event.
    let root = temp_root("load-loud-row");
    std::fs::create_dir_all(root.join("bindings").join("claude").join("ghost.json")).unwrap();
    let (events, guard) = crate::invariants::capture::capture();
    let ledger = PaneLedger::new(Some(root.clone()));
    drop(guard);
    let events = events.lock().unwrap();
    let hits: Vec<_> = events
        .iter()
        .filter(|e| {
            e.target == "freshell_ws::pane_ledger"
                && e.message.contains("pane_ledger_load_index_row_unreadable")
        })
        .collect();
    assert_eq!(hits.len(), 1, "one ERROR for the unreadable row; got: {events:?}");
    let want_path = format!(
        "{}",
        root.join("bindings").join("claude").join("ghost.json").display()
    );
    assert_eq!(hits[0].fields.get("path"), Some(&want_path));
    drop(events);
    assert!(ledger.list_bindings().is_empty());
    std::fs::remove_dir_all(&root).ok();
}
```

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-ws --lib pane_ledger::tests::load_index_ -- --nocapture`

Expected: FAIL — zero captured events for both tests (`hits.len()` 0 ≠ 2 / 1), because today's `load_index` silently skips every I/O error; not a setup accident.

- [ ] **Step 3: Add the minimal production implementation**

Rewrite `load_index` in `crates/freshell-ws/src/pane_ledger.rs` so the three `read_dir` sites and both `load_row` sites distinguish error classes, logging ERROR on I/O (and only I/O):

```rust
/// The ONE directory scan — construction-time only (V1.md).
///
/// H2 loudness contract: I/O failures are never silent here. An unreadable
/// directory or row would otherwise present as a silently-EMPTY index —
/// the exact compounding mode behind "came up blind despite the lock being
/// acquirable and rows on disk". Parse/wrong-version skips stay silent BY
/// POLICY: the boot scan (`quarantine_unparsable`) is their loud path.
/// A row that vanishes between listing and read (Missing) is benign TOCTOU
/// residue and stays silent.
fn load_index(root: &Path) -> LedgerIndex {
    fn unreadable_dir(path: &std::path::Path, err: &std::io::Error) {
        tracing::error!(
            target: "freshell_ws::pane_ledger",
            path = %path.display(),
            error = %err,
            "pane_ledger_load_index_dir_unreadable: rows under this directory are ABSENT from the in-memory index"
        );
    }
    fn unreadable_row(path: &std::path::Path, err: &RowLoadError) {
        tracing::error!(
            target: "freshell_ws::pane_ledger",
            path = %path.display(),
            error = %err,
            "pane_ledger_load_index_row_unreadable: this row is ABSENT from the in-memory index (boot-scan quarantine cannot repair an unreadable file)"
        );
    }
    let mut index = LedgerIndex::default();
    match std::fs::read_dir(Self::bindings_dir(root)) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {} // fresh root — normal
        Err(err) => unreadable_dir(&Self::bindings_dir(root), &err),
        Ok(providers) => {
            for provider in providers.flatten() {
                match std::fs::read_dir(provider.path()) {
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                    Err(err) => unreadable_dir(&provider.path(), &err),
                    Ok(files) => {
                        for file in files.flatten() {
                            let path = file.path();
                            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                                continue; // *.tmp-* and *.quarantined-* residue
                            }
                            match load_row::<BindingRow>(&path) {
                                Ok(row) => {
                                    if row.ledger_version == LEDGER_VERSION {
                                        index
                                            .bindings
                                            .insert((row.provider.clone(), row.session_id.clone()), row);
                                    }
                                }
                                Err(RowLoadError::Io(err)) => unreadable_row(
                                    &path,
                                    &RowLoadError::Io(err),
                                ),
                                Err(RowLoadError::Missing) | Err(RowLoadError::Parse(_)) => {}
                            }
                        }
                    }
                }
            }
        }
    }
    match std::fs::read_dir(Self::pending_dir(root)) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => unreadable_dir(&Self::pending_dir(root), &err),
        Ok(files) => {
            for file in files.flatten() {
                let path = file.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                match load_row::<PendingMarker>(&path) {
                    Ok(marker) => {
                        if marker.ledger_version == LEDGER_VERSION {
                            index.pending.insert(marker.terminal_id.clone(), marker);
                        }
                    }
                    Err(RowLoadError::Io(err)) => {
                        unreadable_row(&path, &RowLoadError::Io(err))
                    }
                    Err(RowLoadError::Missing) | Err(RowLoadError::Parse(_)) => {}
                }
            }
        }
    }
    index
}
```

Update the module doc corruption-policy note (lines 26-43 area) with one sentence recording the H2 contract: "load_index logs a structured ERROR (`pane_ledger_load_index_DIR/ROW_unreadable`) for any I/O failure; only parse/wrong-version rows stay silent for the boot scan to quarantine loudly."

Refactor note: `for file in files.flatten()` still swallows per-ENTRY iteration errors (`DirEntry` Err). Extend the same loudness minimally: replace `.flatten()` with a match that logs via `unreadable_dir` on entry error — but ONLY if a deterministic red test can arm it (a `DirEntry` error cannot be forged portably without a failing fs; do NOT add untested code — keep `.flatten()` and record this residue in the plan's limitations instead).

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-ws --lib pane_ledger::tests:: -- --nocapture`

Expected: PASS — both new loudness tests plus every existing `pane_ledger::tests::*` test (including Task 1's).

- [ ] **Step 5: Refactor while green**

Verify the two `unreadable_dir` closures don't duplicate message-shape drift (single nested `fn` definitions, done above). Confirm no other `load_index` caller exists (construction-time only) and that `quarantine_unparsable`'s loud obligations are untouched. Confirm the new code honors fail-loud-per-row by re-reading the module doc contract aloud once.

- [ ] **Step 6: Run impacted-test verification**

`load_index` runs at every `PaneLedger`/`new_locked` construction, so the impacted set is the full pane_ledger suite-plus-callers: everything Task 1 step 6 ran, plus the full `freshell-ws` lib suite (the module is linked crate-wide; loudness events must not break other tests' captured-event assertions — e.g. `invariants.rs` capture-based tests assert their own targets, and construction paths in unrelated tests use fresh temp roots that never I/O-fail, but verify).

Run: `cargo test -p freshell-ws --lib pane_ledger && cargo test -p freshell-server recovery_inventory && cargo test -p freshell-ws --test pane_reconcile_freshagent && cargo test -p freshell-codex --lib sidecar_store && cargo test -p freshell-ws --lib`

Expected: PASS (all).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ws/src/pane_ledger.rs crates/freshell-ws/src/pane_ledger_tests.rs
git commit -m "fix(pane-ledger): loud structured ERRORs for load_index I/O failures (H2)"
```

---

## Final verification (execution-stage, after Task 2)

0. Hypothesis-2 disposition (recorded as load-bearing evidence in `run-state.md`): cross-process contention on the probe's lock path is eliminated by construction — the deflaked suite was TMPDIR-isolated per run and every `temp_root` embeds the test process pid (`pane-ledger-test-<label>-<pid>-<n>`), so a foreign process cannot know that path; stale fossil dirs in shared `/tmp` never hold locks after their process dies. The remaining viable mechanism class is the transient fork→exec open-file-description inheritance handoff (window ends AT exec via O_CLOEXEC, not at child exit). Stage 2 CLOSED this empirically with the grouped validator PoC (`reports/validator-poc.md` in logs_dir, 22/22 assertions PASS, no fallbacks): arm b1/b3 (inherited OFD reference survives the holder's close → fresh acquirer gets EWOULDBLOCK errno 11/WouldBlock — C1/C8 empirical), arm a (no-fork close→fresh-open re-acquire ~13.2µs — the bare race is a non-mechanism, N1), arm b2 (exec'd `/bin/sleep` child still alive yet re-acquire SUCCEEDS; FD_CLOEXEC measured 0x01 — window bounded at exec, N6/D3), arm c (self `/proc/locks` row matched on both the simple `:{ino} ` shape and the hardened `%02x:%02x:%d` dev+ino shape — verbatim token `fc:00:4213268`, C2/D1), arm d (`read_dir` on a regular file → ENOTDIR(20)/NotADirectory; read of a directory → EISDIR(21) — C4 forging exact). This plan is mechanism-agnostic by design for the transient class.
1. Flake-proof the probe shape: 20 consecutive runs of the deflaked suite subset under load-adjacent conditions —
   `for i in $(seq 1 20); do cargo test -p freshell-ws --lib pane_ledger -- --test-threads=8 >/tmp/opencode/s52d-proof-$i.log 2>&1 || { echo "run $i FAILED"; break; }; done; echo "survived: $(ls /tmp/opencode/s52d-proof-*.log | wc -l)"`
   Expected: 20/20 pass (previously ~9/10 on the probe test alone under workspace load).
2. Full crate suite: `cargo test -p freshell-ws` — PASS.
3. Work-source oracle check: `npm run check` — completes; the only permitted failures are the 3 baseline vite-config identities (this command is included in, and never replaces, the full QA gate).
4. Full QA gate via `darkforge qa` — required exit acceptance per the baseline ledger.

## Limitations and follow-ups (explicit)

- The exact transient holder of the original run-10 event cannot be identified retroactively; if the probe EVER fails again, the panic now carries the holder pid(s) from `/proc/locks`.
- Per-`DirEntry` iteration errors inside `read_dir` results remain `.flatten()`-silenced: no deterministic red test can arm them on a healthy fs; recorded, not fixed.
- `CodexSidecarStore` (crates/freshell-codex) keeps the single-shot pattern with its own documented NA-3 CLOEXEC note; a parity retry there is a deliberately separate follow-up. Strategist-verified identical single-shot shape (sidecar_store.rs:115-141, CLOEXEC note at :122-127); its tests construct holder+loser sequentially with NO post-drop probe, so it exposes no flake today (N5).
- Baseline vite-config `getNetworkHost` failures are pre-existing and untouched.
