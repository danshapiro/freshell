# host-stats CPU guest-time double-count fix — Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result

`server/host-stats/readers.ts:171–177` (`parseProcStatCpuFields`) and its Rust mirror
`crates/freshell-platform/src/host_stats_readers.rs:179–187` (`parse_proc_stat_cpu_fields`)
build the cumulative CPU `total` by summing every `/proc/stat` cpu-line field, including
`guest` and `guest_nice`. Linux already charges guest execution to `user`/`nice` while also
incrementing the guest fields (kernel `account_guest_time`), so guest time is counted twice
and CPU status can read falsely busy on hosts running VMs. Exclude `guest` and `guest_nice`
from the total; add a fixture row with nonzero guest time proving the exclusion; mirror the
fix and the fixture in Rust. Surfaced by an independent review round during the
sidebar-status-sort run (PR #710 review cycle).

### Explicit constraints

- Exclude `guest` and `guest_nice` from the CPU total in BOTH the TypeScript reader and the
  Rust reader; the two implementations must stay semantically identical.
- Add a fixture row with nonzero guest time, mirrored in both committed fixture trees:
  `test/fixtures/host-stats/proc/stat` (Node suite) and
  `crates/freshell-server/tests/fixtures/host-stats/proc/stat` (Rust suite; an intentional
  byte-for-byte duplication per the header comment at
  `crates/freshell-server/src/host_stats.rs:1464`).
- Red/green/refactor TDD: the fixture mutation must fail against the existing exact-value
  assertions before the parser fix lands, and pass after.
- Keep the public surface unchanged: `readCpuTimes` / `read_cpu_times` signatures and the
  `CpuTimes` shapes stay exactly as-is; `busy` = `total − idle − iowait` semantics and
  `steal` = field 7 are unchanged.

### Accepted tradeoffs and residuals

- On hosts actually running VMs, displayed CPU usage may read slightly lower after the fix;
  that correction is the intent, not a regression.
- The repo full QA gate (`npm run check` + cargo fmt/clippy) does not run `cargo test`;
  Rust behavioral verification happens as an explicit task-level gate in this plan.
- No end-user documentation change: this is an internal correctness fix to cumulative
  counters, not a new user-facing behavior (per AGENTS.md, `docs/index.html` only tracks
  major changes).

**Goal:** Host CPU totals no longer double-count Linux guest time, proven by a nonzero-guest
fixture row with unchanged expected totals in both the Node and Rust suites.

**Architecture:** Both platforms parse one `/proc/stat` cpu line into fields
`user nice system idle iowait irq softirq steal [guest guest_nice]` and compute
`total`/`busy` cumulative counters; services derive percentages from counter deltas. The fix
narrows the summed window to the first 8 fields in both parsers, and the committed fixture
rows gain nonzero guest fields so the exact-value tests pin the exclusion. One atomic change
touching both mirrors; no service-layer changes (consumers are delta-based and already guard
zero/negative deltas).

**Tech Stack:** TypeScript (Node reader, Vitest behavioral tests), Rust (`freshell-platform`
reader, `freshell-server` unit tests), committed text fixtures under `test/fixtures/…` and
`crates/freshell-server/tests/fixtures/…`.

## Global Constraints

- Red/green/refactor TDD: write/run the failing test first, confirm it fails for the intended
  reason, then implement, then run impacted tests, then commit. Never skip the refactor step.
- Server uses NodeNext/ESM: relative imports must include `.js` extensions (n/a here — no new
  imports; the readers are pure functions).
- Readers never throw on read/parse failure — return `null`/`None` instead (existing contract,
  unchanged by this fix).
- Fixture trees are committed exact bytes: `test/fixtures/host-stats/` is the Node suite's
  tree; `crates/freshell-server/tests/fixtures/host-stats/` is the intentional duplication
  (ports drift independently) — both must receive the identical `stat` edit.
- Never reduce test coverage or weaken assertions to get green; assertion values in the
  existing tests stay exactly as they are (that invariance IS the regression proof).
- Conventional commit messages, one focused commit per task.
- Final gate: full QA via `darkforge qa` (npm run check + cargo fmt/clippy), accepted per the
  run's baseline ledger (three pre-existing codex-adapter failures are the allowed set).

---

### Task 1: Exclude guest/guest_nice from host-stats CPU totals in both mirrored parsers

**Files:**
- Modify: `test/fixtures/host-stats/proc/stat:1` — aggregate `cpu` row gains `guest guest_nice`
  = `900 45` (the intent: this guest time is *already* inside `user=4705`/`nice=356`, so the
  parsed total must not grow).
- Modify: `crates/freshell-server/tests/fixtures/host-stats/proc/stat:1` — identical edit.
- Modify: `server/host-stats/readers.ts:171–177` — `parseProcStatCpuFields` sums fields 0–7 only.
- Modify: `crates/freshell-platform/src/host_stats_readers.rs:179–187` —
  `parse_proc_stat_cpu_fields` sums fields 0–7 only.
- Test: `test/unit/server/host-stats/readers.test.ts:278–294` — existing exact-value
  `readCpuTimes` assertions become the regression guard; update the inline comment to record
  the guest-on-the-row semantics.
- Test: `crates/freshell-server/src/host_stats.rs:1567–1581` —
  `host_stats_fixture_cpu_times_parse_exact` unchanged numerically; extend the comment.

**Interfaces:**
- Consumes: `parseProcStatCpuFields(fields: number[])` / `parse_proc_stat_cpu_fields(fields: &[f64])`
  — private helpers reachable only via `readCpuTimes(procRoot)` / `read_cpu_times(proc_root)`;
  no caller changes.
- Produces: unchanged shapes — `CpuTimes { total, busy, steal, perCore[] }` /
  `CpuTimes { total, busy, steal, per_core }`. From this commit on, `total` means
  "sum of fields 0–7" (guest fields excluded) on both platforms.

- [ ] **Step 1: Write the failing behavioral test (fixture mutation + comment)**

Edit the aggregate cpu row in both fixture trees, exact byte change on line 1:

```text
# before
cpu  4705 356 1622 164331 2020 80 345 777 0 0
# after — guest=900 guest_nice=45; the kernel already charges these to user/nice
cpu  4705 356 1622 164331 2020 80 345 777 900 45
```

Update the comment inside `test/unit/server/host-stats/readers.test.ts` (currently lines
282–285) to record the exclusion semantics — assertions stay numerically identical:

```ts
    // aggregate: total = 4705+356+1622+164331+2020+80+345+777, busy = total - idle(164331) - iowait(2020)
    // fixture row carries guest=900 guest_nice=45: Linux already charges guest execution to
    // user/nice (kernel account_guest_time), so the total must EXCLUDE the guest fields
    // (summing them would read 175181 / busy 8830).
    expect(times!.total).toBe(174236)
    expect(times!.busy).toBe(7885)
    expect(times!.steal).toBe(777) // steal>0 is a fixture requirement
```

Extend the comment in `crates/freshell-server/src/host_stats.rs` test
`host_stats_fixture_cpu_times_parse_exact`:

```rust
        let times = readers::read_cpu_times(&proc_fixture()).expect("fixture stat parses");
        // Aggregate fixture row carries guest=900 guest_nice=45; the kernel already
        // charges guest execution to user/nice (account_guest_time), so the total must
        // EXCLUDE the guest fields (summing them would read 175181.0 / busy 8830.0).
        assert_eq!(times.total, 174236.0);
        assert_eq!(times.busy, 7885.0);
        assert_eq!(times.steal, 777.0); // steal>0 is a fixture requirement
```

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/server/host-stats/readers.test.ts`

Expected: FAIL because the current parser sums all 10 fields — the aggregate row with
nonzero guest parses to `total=175181, busy=8830` while the (correct) assertions still
expect `174236`/`7885`. The failure must be an assertion mismatch on `times.total` (and
`times.busy`), not a setup/import error.

Run: `cargo test -p freshell-server host_stats_fixture_cpu_times_parse_exact`

Expected: FAIL for the same reason (`times.total` is `175181.0`, asserted `174236.0`).

- [ ] **Step 3: Add the minimal production implementation**

`server/host-stats/readers.ts:171–177`:

```ts
function parseProcStatCpuFields(fields: number[]): { total: number; busy: number; steal: number } | null {
  // user nice system idle iowait irq softirq steal [guest guest_nice]
  // guest/guest_nice are EXCLUDED from the total: the kernel already charges guest
  // execution to user/nice (account_guest_time), so summing them double-counts that time.
  if (fields.length < 8 || fields.some((f) => !Number.isFinite(f))) return null
  const total = fields.slice(0, 8).reduce((sum, value) => sum + value, 0)
  const busy = total - fields[3] - fields[4] // idle + iowait
  return { total, busy, steal: fields[7] }
}
```

`crates/freshell-platform/src/host_stats_readers.rs:179–187`:

```rust
fn parse_proc_stat_cpu_fields(fields: &[f64]) -> Option<(f64, f64, f64)> {
    // user nice system idle iowait irq softirq steal [guest guest_nice]
    // guest/guest_nice are EXCLUDED from the total: the kernel already charges guest
    // execution to user/nice (account_guest_time), so summing them double-counts that time.
    if fields.len() < 8 || fields.iter().any(|f| !f.is_finite()) {
        return None;
    }
    let total: f64 = fields[..8].iter().sum();
    let busy = total - fields[3] - fields[4]; // idle + iowait
    Some((total, busy, fields[7]))
}
```

- [ ] **Step 4: Run the focused tests**

Run: `npm run test:vitest -- run test/unit/server/host-stats/readers.test.ts`

Expected: PASS

Run: `cargo test -p freshell-server host_stats_fixture_cpu_times_parse_exact`

Expected: PASS

- [ ] **Step 5: Refactor while green**

No refactor needed: the `slice(0, 8)` / `fields[..8]` window is the direct expression of the
kernel ABI contract (fields 0–7 are independently accounted; 8–9 duplicate user/nice), the
comment records the provenance, and both mirrors now match line-for-line. Renaming the helper
or restructuring the parse would add diff without clarifying the contract.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: everything consuming `readCpuTimes`/`read_cpu_times` output. All Node
consumers read via the service with delta-guarded rates (`server/host-stats/service.ts`
`readCpuSection` returns zeros when `dTotal <= 0`), and the service suites mock
`readCpuTimes` — but the full host-stats suites still run to pin no drift: the whole
`test/unit/server/host-stats/` directory plus the client status lib
(`test/unit/client/lib/host-stats-status.test.ts`), and on the Rust side every
`freshell-server` test mentioning host_stats (the parse-exact test above, the service-level
fixture tests asserting first-tick zero deltas, and the platform crate's unit tests).

Run: `npm run test:vitest -- run test/unit/server/host-stats/ test/unit/client/lib/host-stats-status.test.ts`

Expected: PASS

Run: `cargo test -p freshell-server host_stats && cargo test -p freshell-platform`

Expected: PASS (freshell-server's host_stats module + integration tests; freshell-platform's
reader unit tests)

- [ ] **Step 7: Commit the task**

```bash
git add \
  test/fixtures/host-stats/proc/stat \
  crates/freshell-server/tests/fixtures/host-stats/proc/stat \
  server/host-stats/readers.ts \
  crates/freshell-platform/src/host_stats_readers.rs \
  test/unit/server/host-stats/readers.test.ts \
  crates/freshell-server/src/host_stats.rs
git commit -m "fix(host-stats): exclude guest/guest_nice from cpu totals (already charged to user/nice)"
```

---

## Final gate (after all tasks)

- Full QA gate: `darkforge qa` — zero exit, or nonzero only when every parsed failure
  identity is one of the three baseline codex-adapter failures recorded in run-state.md.
- The work source's candidate verification (`npm run check`) is a strict subset of the QA
  gate and is covered by it; no separate run required.
