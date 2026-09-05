# PR699 Integration Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish PR699's Rust-only runtime retirement while preserving main's Host Stats and fresh-agent undo/redo behavior, with executable regression and native-package evidence.

**Architecture:** Keep capability metadata shared by the standalone CLI and MCP, and forward supported options into the existing Rust REST handlers. Exercise metric calculations through the Rust collector's existing fixture roots and explicit sample timestamps; do not restore Node backend code or introduce a second collector. Keep new collector tests in a separate child module rather than expanding the large implementation file.

**Tech Stack:** TypeScript/Node ESM CLI and MCP, Rust/Tokio/Axum, React, Vitest, Playwright, Electron, GitHub Actions.

---

## File map

| Path | Responsibility / planned change |
| --- | --- |
| `tools/freshell-cli/index.ts` | Forward `hostStats` in both creation request bodies. |
| `test/unit/cli/retained-flags.test.ts` | Execute the real source CLI and inspect its HTTP requests for six boolean cases. |
| `crates/freshell-freshagent/src/terminal_tabs.rs` | Strengthen the existing Host Stats creation test with registry and stored-pane assertions. |
| `test/e2e-browser/specs/cli-rust.spec.ts` | Exercise compiled CLI creation and splitting through a real Rust server and browser without creating terminals. |
| `crates/freshell-server/src/host_stats.rs` | Attach the new test-only child module; no collector behavior change is currently justified. |
| `crates/freshell-server/src/host_stats_collection_tests.rs` | New deterministic rate and memory-precedence regression tests. |
| `config/vitest/vitest.runtime.config.ts` and `config/vitest/vitest.electron-runtime.config.ts` | Extend main's ambient environment isolation to PR699's new runtime lanes. |
| `test/unit/config/sanitize-test-env.test.ts` and `test/unit/config/fixtures/sanitize-env-child.ts` | Execute both new configs before a real child fetch; verify inherited environment and stderr. |
| `docs/superpowers/plans/2026-09-04-pr699-integration-repair.md` | Track execution and append commit-specific verification receipts. |
| `AGENTS.md` | Link this agent-facing plan; already done when the plan is committed. |

Read-only dependencies: `tools/node-client-runtime/action-capabilities.ts`, `tools/freshell-mcp/freshell-tool.ts`, `crates/freshell-platform/src/host_stats_readers.rs`, `crates/freshell-freshagent/src/pane_ops_tests.rs`, `test/e2e-browser/helpers/test-harness.ts`, `scripts/sandbox-test.sh`, `docs/development/test-sandbox.md`, and `.github/workflows/electron-build.yml`.

## Starting state and scope

This is a follow-up to the detailed review, not a request to redo completed fixes. Work in the existing dedicated worktree:

~~~text
/home/dan/code/freshell/.worktrees/retire-node-server-v2
branch: the-usual/retire-node-server-v2
PR: https://github.com/danshapiro/freshell/pull/699
~~~

Main at `db8e09cb67e08a1028ab50b71b99b160a2e7f35f` was integrated in merge commit `18ed1e414`. Its first parent is `b6b7152dd`. All 27 conflicts were resolved, preserving Rust-only retirement plus Host Stats and undo/redo. Do not recreate this merge or restore deleted Node code.

Completed review repairs:

| Commit | Repair already implemented |
| --- | --- |
| `925cfc655` | Rust-only build/test routing, client build stamping, and Rust runtime preparation. |
| `eab2efc6d` | Auth bootstrap with actual dotenv semantics and portable npm launching. |
| `3dd301a8a` | Retained CLI flags/aliases and supported agent resumes. |
| `d7db701c0` | Desktop child ownership, log preservation, and bounded shutdown flushing. |
| `918934dc4` | Actual native packaged-runtime verification and platform-specific artifact paths. |
| `0329bccc0` | Windows MCP through WSL, executable/argument conversion, and native Node launching. |
| `b6b7152dd` | Migration performance measured independently of unrelated CPU scheduling. |
| `18ed1e414` | Main integration, combined protocol v8 (33 inbound/55 outbound messages), retained rollback/provider tests, Rust-only browser fixtures, and MCP Host Stats support. |
| `bd1b6c32c` | Second main integration through PR703, retaining test-flakiness fixes and resolving six additional conflicts without restoring retired Node configs. |

Confirmed remaining defect: shared capabilities accept `--hostStats`, but standalone CLI `new-tab` and `split-pane` omit it from their explicit POST bodies. The request can therefore create a terminal instead of the requested Host Stats pane.

While writing this plan, main advanced to PR703's test-flakiness fixes at `5b3851322e0ddc60d6c6c10d9b05a27c490ada2e`. Integration commit `bd1b6c32c` preserves those Rust test changes, their classifier, and environment cleanup without restoring the four retired Node test configs. Task 5 covers a newly identified gap: the two runtime configs added by PR699 also need the environment-cleanup prelude. No Task 1–7 implementation has been executed as part of writing this plan.

Coverage gaps, not demonstrated production bugs: the Rust collector lacks the removed Node suite's exact nonzero rate assertions and memory-source precedence cases. An existing Rust REST Host Stats new-tab test already exists; strengthen it rather than claiming the endpoint is untested.

Integration evidence already obtained at `18ed1e414`: client/tools typechecks, Cargo workspace check, Rust formatting, protocol 45 tests, port-contract 45 tests, runtime-boundary/distribution 58 tests, MCP/Composer/View 324 tests, and retained sidecar/provider/protocol tests. Browser selection found all 13 incoming rollback/Host Stats cases, and four selection-helper tests passed. **Selection is not browser execution.** Earlier full-suite/package/browser results predate the merge and are not a final merged-branch receipt.

The second integration at `bd1b6c32c` passed 82 focused tests (sanitizer 5, classifier 19, runtime boundary 36, distribution 22), all four browser-selection helper tests, both TypeScript checks, and `cargo check --workspace --all-targets --locked`. Independent static review found no additional Rust/classifier integration defect. Logs: `/tmp/freshell-pr699-pr703-typecheck.log`, `/tmp/freshell-pr699-pr703-cargo-check.log`, and `/tmp/freshell-pr699-pr703-selection.log`. Full post-repair verification remains outstanding.

Non-goals: new macOS metric collectors, restoring the retired backend, deleting historical fixture corpora, provider features unrelated to this review, creating another PR, merging PR699, deploying client assets, or restarting production. Existing Rust behavior reports unavailable sections when platform sources are absent; do not reintroduce Node's macOS fallback as an incidental test migration.

## Execution rules and dependencies

- [ ] Read `AGENTS.md` and `docs/development/test-sandbox.md` before execution. Confirm the current worktree is clean and belongs to PR699; do not touch the main checkout's unrelated edits.
- [ ] Inspect `npm run test:status` before broad checks; wait for any foreign holder. Never kill another agent's test process.
- [ ] Preserve the selected test backend. At plan-writing time neither backend preference was persistently configured; local focused review checks did not establish permission for paid cloud runs. Resolve an unset preference before broader execution. Never silently substitute local for a failing configured cloud backend.
- [ ] Run process-kill, config-corruption, restart-storm, and owned-server browser suites only inside the disposable sandbox or a disposable CI runner. Never point tests at port 3001 or real user data.
- [ ] Use explicit GitHub identity on every call, for example `GH_TOKEN="$(gh auth token --user danshapiro)" gh pr view 699 --repo danshapiro/freshell`. Preserve the existing noreply git identity.
- [ ] Use red/green/refactor for Task 1's confirmed defect. Tasks 2–4 add tests of currently implemented behavior and may immediately pass; do not deliberately damage production code to manufacture a red phase. If a new assertion fails, preserve the failure and trace the calculation before changing implementation.
- [ ] Do not write prose/config-content assertions, skip tests, or weaken assertions to obtain green results.
- [ ] Task 1, Tasks 3–4, and Task 5 can be assigned to independent workers with exclusive file ownership. Task 2 follows Task 1. Task 4 follows Task 3. Run broad verification only after all edits are committed.

## Task 1: Forward Host Stats flags in the standalone CLI

**Files:** modify `test/unit/cli/retained-flags.test.ts` and `tools/freshell-cli/index.ts`.

- [ ] Add these six executable cases to `retained-flags.test.ts`, reusing its existing `invoke` helper. That helper starts the real source CLI with a temporary HTTP server; this tests behavior, not help text.

~~~ts
it.each([
  ['new-tab', '--hostStats', true],
  ['new-tab', '--hostStats=true', true],
  ['new-tab', '--hostStats=false', false],
  ['split-pane', '--hostStats', true],
  ['split-pane', '--hostStats=true', true],
  ['split-pane', '--hostStats=false', false],
] as const)('%s forwards Host Stats option %s', async (action, flag, enabled) => {
  const args = action === 'new-tab'
    ? [action, flag]
    : [action, '--target', 'p1', flag]
  const result = await invoke(args)

  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  const request = result.requests.at(-1)
  expect(request).toBeDefined()
  expect(request!.url).toBe(
    action === 'new-tab' ? '/api/tabs' : '/api/panes/p1/split',
  )
  expect((request!.body as Record<string, unknown>).hostStats)
    .toBe(enabled ? true : undefined)
})
~~~

- [ ] Capture the failing test output.

~~~bash
npm run test:vitest -- run test/unit/cli/retained-flags.test.ts -t 'Host Stats'
~~~

Expected: six selected cases execute; the four enabled cases fail because `hostStats` is absent. The two explicit-false cases should pass.

- [ ] In `tools/freshell-cli/index.ts`, add this property spread to **both** the POST `/api/tabs` body in `new-tab` and the POST `/api/panes/:id/split` body in `split-pane`:

~~~ts
...(isTruthy(getFlag(flags, 'hostStats')) ? { hostStats: true } : {}),
~~~

Use the already defined `isTruthy` and `getFlag` functions. No new parser, capability entry, HTTP endpoint, default mode change, or helper abstraction is needed. Keep every existing body field and resume alias intact.

- [ ] Run the complete affected CLI/MCP tests and tools typecheck.

~~~bash
npm run test:vitest -- run test/unit/cli/retained-flags.test.ts test/unit/cli/action-capabilities.test.ts test/unit/mcp/freshell-tool.test.ts
npm run typecheck:tools
~~~

Expected: all selected tests pass, including all six new cases; no TypeScript errors.

- [ ] Refactor review: confirm both request builders use the same boolean conversion and that false omits the option. Two one-line spreads are preferable to a generic request-builder refactor for this change. If no cleanup improves clarity, record that decision without unrelated edits.

- [ ] Commit the fix and its regression tests.

~~~bash
git add tools/freshell-cli/index.ts test/unit/cli/retained-flags.test.ts
git commit -m "fix: forward Host Stats options from standalone CLI"
~~~

## Task 2: Prove Host Stats creation never allocates a terminal

**Files:** modify `crates/freshell-freshagent/src/terminal_tabs.rs` and `test/e2e-browser/specs/cli-rust.spec.ts`. Existing split coverage in `crates/freshell-freshagent/src/pane_ops_tests.rs` stays intact.

- [ ] Replace only the existing `create_host_stats_tab_attaches_host_stats_pane_content_and_no_terminal` test with the following body and attributes:

~~~rust
#[tokio::test]
async fn create_host_stats_tab_attaches_host_stats_pane_content_and_no_terminal() {
    let state = state_with_registry();
    let registry = state.terminal_registry.clone().unwrap();
    assert!(registry.inventory().is_empty());
    let mut rx = state.broadcast_tx.subscribe();

    let (status, body) = post(
        app(state.clone()),
        "/api/tabs",
        json!({ "hostStats": true }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["data"]["tabId"].as_str().is_some());
    let pane_id = body["data"]["paneId"].as_str().expect("created pane id");
    assert!(body["data"].get("terminalId").is_none());
    assert!(registry.inventory().is_empty());

    let pane = state.layout.get_pane_snapshot(pane_id).expect("stored pane");
    assert_eq!(pane.kind.as_deref(), Some("host-stats"));
    assert!(pane.terminal_id.is_none());

    let frame = rx.recv().await.expect("ui.command frame broadcast");
    let msg: Value = serde_json::from_str(&frame).unwrap();
    assert_eq!(msg["command"], json!("tab.create"));
    assert_eq!(msg["payload"]["paneContent"]["kind"], json!("host-stats"));
}
~~~

- [ ] Run the test and the existing split Host Stats regression inside the sandbox.

~~~bash
scripts/sandbox-test.sh "cargo test -p freshell-freshagent --lib --locked host_stats"
~~~

Expected: the creation and split tests execute and pass, with no terminal added by either Host Stats operation. These are coverage additions, not expected production failures.

- [ ] Add this import to `cli-rust.spec.ts`:

~~~ts
import { TestHarness } from '../helpers/test-harness.js'
~~~

- [ ] Add the following test inside the existing `standalone CLI -- Rust server replacement` describe block. Reuse the file's actual `runCliJson` and `ActionResult` helpers.

~~~ts
test('creates and splits Host Stats panes without allocating terminals', async ({ page }) => {
  const server = new RustServer({ verbose: false })
  const info = await server.start()

  try {
    ensureMcpServerBuilt(REPO_ROOT)
    await page.goto(info.baseUrl + '/?token=' + info.token + '&e2e=1')
    const harness = new TestHarness(page)
    await harness.waitForHarness()
    await harness.waitForConnection()

    const inventory = () => runCliJson<unknown[]>(
      info.baseUrl, info.token, ['list-terminals'],
    )
    expect(await inventory()).toEqual([])

    const created = await runCliJson<ActionResult<{
      tabId: string
      paneId: string
      terminalId?: string
    }>>(
      info.baseUrl, info.token,
      ['new-tab', '--hostStats', '--name', 'CLI Host Stats'],
    )
    expect(created.status).toBe('ok')
    expect(created.data.terminalId).toBeUndefined()
    const regions = page.getByRole('region', { name: 'Host stats' })
    await expect(regions).toHaveCount(1)
    await expect(regions.first()).toBeVisible()
    expect(await inventory()).toEqual([])

    const split = await runCliJson<ActionResult<{
      paneId: string
      terminalId?: string
    }>>(
      info.baseUrl, info.token,
      ['split-pane', '--target', created.data.paneId, '--hostStats=true'],
    )
    expect(split.status).toBe('ok')
    expect(split.data.paneId).not.toBe(created.data.paneId)
    expect(split.data.terminalId).toBeUndefined()
    await expect(regions).toHaveCount(2)
    await expect(regions.nth(1)).toBeVisible()
    expect(await inventory()).toEqual([])
  } finally {
    await server.stop()
  }
})
~~~

- [ ] Execute the focused browser test using the configured backend, in a disposable runtime. For an approved local backend:

~~~bash
scripts/sandbox-test.sh "FRESHELL_E2E_BACKEND=local npm run test:e2e -- --project=chromium test/e2e-browser/specs/cli-rust.spec.ts --grep 'Host Stats'"
~~~

Expected: exactly one real browser test passes; it creates two visible Host Stats panes and observes an empty terminal inventory before and after. A `--list` result or a skipped test does not count.

- [ ] Refactor review: keep the ownership/cleanup in the existing test helper pattern and preserve the original broad CLI acceptance test. Do not replace the browser assertions with mocked REST success.

- [ ] Format and commit.

~~~bash
cargo fmt --all
git add crates/freshell-freshagent/src/terminal_tabs.rs test/e2e-browser/specs/cli-rust.spec.ts
git commit -m "test: cover terminal-free Host Stats CLI orchestration"
~~~

## Task 3: Restore deterministic nonzero collector-rate coverage

**Files:** create `crates/freshell-server/src/host_stats_collection_tests.rs`; modify `crates/freshell-server/src/host_stats.rs`.

The existing `CollectorCtx` methods accept explicit millisecond sample timestamps and read fixture roots. Use that seam without sleeping or activating background sampling.

- [ ] Add the following complete child-module declaration at the end of `host_stats.rs`:

~~~rust
#[cfg(test)]
#[path = "host_stats_collection_tests.rs"]
mod collection_tests;
~~~

- [ ] Create `host_stats_collection_tests.rs` with these helpers and four tests:

~~~rust
use super::*;
use std::path::Path;

fn write_fixture(root: &Path, relative: &str, text: &str) {
    let file = root.join(relative);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, text).unwrap();
}

fn fixture_collector(root: &Path) -> HostStatsCollectorService {
    HostStatsCollectorService::new(
        HostStatsCollectorConfig {
            proc_root: root.join("proc"),
            sys_root: root.join("sys"),
            ..Default::default()
        },
        freshell_terminal::TerminalRegistry::new(),
        HostStatsInterestRegistry::default(),
        Instant::now(),
    )
}

#[test]
fn cpu_rates_use_deltas_for_aggregate_steal_and_each_core() {
    let root = tempfile::tempdir().unwrap();
    let proc_root = root.path().join("proc");
    write_fixture(
        &proc_root,
        "stat",
        "cpu 100 0 0 900 0 0 0 0\n\
         cpu0 25 0 0 225 0 0 0 0\n\
         cpu1 25 0 0 225 0 0 0 0\n\
         cpu2 25 0 0 225 0 0 0 0\n\
         cpu3 25 0 0 225 0 0 0 0\n",
    );
    let collector = fixture_collector(root.path());
    let first = collector.ctx.read_cpu_section(1_000);
    assert!(first.available);
    assert_eq!(first.usage_pct, 0.0);
    assert_eq!(first.steal_pct, Some(0.0));
    assert_eq!(first.per_core_pct, vec![0.0; 4]);

    write_fixture(
        &proc_root,
        "stat",
        "cpu 280 0 0 1700 0 0 0 20\n\
         cpu0 100 0 0 400 0 0 0 0\n\
         cpu1 100 0 0 400 0 0 0 0\n\
         cpu2 100 0 0 400 0 0 0 0\n\
         cpu3 100 0 0 400 0 0 0 0\n",
    );
    let next = collector.ctx.read_cpu_section(3_000);
    assert!(next.available);
    assert_eq!(next.usage_pct, 20.0);
    assert_eq!(next.steal_pct, Some(2.0));
    assert_eq!(next.per_core_pct, vec![30.0; 4]);
}

#[test]
fn paging_rates_convert_page_deltas_over_elapsed_seconds() {
    let root = tempfile::tempdir().unwrap();
    let proc_root = root.path().join("proc");
    write_fixture(
        &proc_root,
        "vmstat",
        "pswpin 100\npswpout 40\npgmajfault 50\noom_kill 2\n",
    );
    let collector = fixture_collector(root.path());
    let first = collector.ctx.read_paging_section(1_000);
    assert!(first.available);
    assert_eq!(first.swap_in_kbps, 0.0);
    assert_eq!(first.swap_out_kbps, 0.0);
    assert_eq!(first.maj_faults_per_sec, 0.0);
    assert_eq!(first.oom_kills_delta, 0);
    assert_eq!(first.oom_kills_total, 2);

    write_fixture(
        &proc_root,
        "vmstat",
        "pswpin 108\npswpout 44\npgmajfault 70\noom_kill 5\n",
    );
    let next = collector.ctx.read_paging_section(3_000);
    assert!(next.available);
    assert_eq!(next.swap_in_kbps, 16.0);
    assert_eq!(next.swap_out_kbps, 8.0);
    assert_eq!(next.maj_faults_per_sec, 10.0);
    assert_eq!(next.oom_kills_delta, 3);
    assert_eq!(next.oom_kills_total, 5);
}

#[test]
fn disk_rates_convert_sectors_and_compute_utilization_and_await() {
    let root = tempfile::tempdir().unwrap();
    let proc_root = root.path().join("proc");
    write_fixture(
        &proc_root,
        "diskstats",
        "8 0 sda 1000 0 100000 4000 2000 0 400000 8000 0 500 0\n",
    );
    let collector = fixture_collector(root.path());
    let first = collector.ctx.read_disk_io_section(5_000);
    assert!(first.available);
    assert_eq!(first.read_bps, 0.0);
    assert_eq!(first.write_bps, 0.0);
    assert_eq!(first.util_pct, None);
    assert_eq!(first.weighted_await_ms, None);

    write_fixture(
        &proc_root,
        "diskstats",
        "8 0 sda 1100 0 151200 6000 2400 0 502400 10000 0 1500 0\n",
    );
    let next = collector.ctx.read_disk_io_section(10_000);
    assert!(next.available);
    assert_eq!(next.read_bps, 5_242_880.0);
    assert_eq!(next.write_bps, 10_485_760.0);
    assert_eq!(next.util_pct, Some(20.0));
    assert_eq!(next.weighted_await_ms, Some(8.0));
}

#[test]
fn network_rates_keep_error_and_drop_totals_and_deltas_distinct() {
    let root = tempfile::tempdir().unwrap();
    let proc_root = root.path().join("proc");
    write_fixture(
        &proc_root,
        "net/dev",
        "eth0: 1000000 0 3 2 0 0 0 0 500000 0 1 4 0 0 0 0\n",
    );
    let collector = fixture_collector(root.path());
    let first = collector.ctx.read_network_section(5_000);
    assert!(first.available);
    assert_eq!(first.rx_bps, 0.0);
    assert_eq!(first.tx_bps, 0.0);
    assert_eq!(first.rx_errors_delta, 0);
    assert_eq!(first.tx_errors_delta, 0);
    assert_eq!(first.rx_dropped_delta, 0);
    assert_eq!(first.tx_dropped_delta, 0);

    write_fixture(
        &proc_root,
        "net/dev",
        "eth0: 1500000 0 5 3 0 0 0 0 600000 0 3 5 0 0 0 0\n",
    );
    let next = collector.ctx.read_network_section(10_000);
    assert!(next.available);
    assert_eq!(next.rx_bps, 100_000.0);
    assert_eq!(next.tx_bps, 20_000.0);
    assert_eq!(next.rx_errors_total, 5);
    assert_eq!(next.tx_errors_total, 3);
    assert_eq!(next.rx_dropped_total, 3);
    assert_eq!(next.tx_dropped_total, 5);
    assert_eq!(next.rx_errors_delta, 2);
    assert_eq!(next.tx_errors_delta, 2);
    assert_eq!(next.rx_dropped_delta, 1);
    assert_eq!(next.tx_dropped_delta, 1);
}
~~~

- [ ] Run the new tests.

~~~bash
cargo test -p freshell-server --bin freshell-server --locked host_stats::collection_tests
~~~

Expected: exactly four tests execute and pass. This narrow module creates fixture files only and does not start a server or background collector.

- [ ] Refactor review: keep fixture writing and collector construction shared; keep every metric's input and exact expected result beside its assertion. Do not introduce sleeps, fake clocks in production, or platform-specific collector mechanisms.

- [ ] Format and commit.

~~~bash
cargo fmt --all
git add crates/freshell-server/src/host_stats.rs crates/freshell-server/src/host_stats_collection_tests.rs
git commit -m "test: cover nonzero Rust Host Stats metric rates"
~~~

## Task 4: Preserve memory-source precedence and degraded behavior

**File:** append to `crates/freshell-server/src/host_stats_collection_tests.rs`. Depends on Task 3's existing `write_fixture` and `fixture_collector` helpers.

- [ ] Add the following complete tests. Every case uses its own temporary proc/sys roots; nothing reads real cgroup state as the memory source.

~~~rust
fn write_host_memory(root: &Path) {
    write_fixture(
        &root.join("proc"),
        "meminfo",
        "MemTotal: 64000000 kB\n\
         MemAvailable: 32000000 kB\n\
         SwapTotal: 8000000 kB\n\
         SwapFree: 8000000 kB\n",
    );
}

#[test]
fn finite_cgroup_memory_wins_without_mixing_host_totals() {
    let root = tempfile::tempdir().unwrap();
    write_host_memory(root.path());
    write_fixture(&root.path().join("proc"), "self/cgroup", "0::/freshell-test\n");
    let cgroup = root.path().join("sys/fs/cgroup/freshell-test");
    write_fixture(&cgroup, "memory.max", "8000000000\n");
    write_fixture(&cgroup, "memory.current", "500000000\n");

    let memory = fixture_collector(root.path()).ctx.read_memory_section();
    assert!(memory.available);
    assert_eq!(memory.source, "cgroup");
    assert_eq!(memory.total_bytes, 8_000_000_000);
    assert_eq!(memory.used_bytes, 500_000_000);
    assert_eq!(memory.available_bytes, 7_500_000_000);
    assert_eq!(memory.cgroup_limit_bytes, Some(8_000_000_000));
    assert_eq!(memory.swap_total_bytes, Some(8_000_000 * 1024));
    assert_eq!(memory.swap_used_bytes, Some(0));
}

#[test]
fn unlimited_cgroup_memory_uses_host_used_and_available_values() {
    let root = tempfile::tempdir().unwrap();
    write_host_memory(root.path());
    write_fixture(&root.path().join("proc"), "self/cgroup", "0::/freshell-test\n");
    let cgroup = root.path().join("sys/fs/cgroup/freshell-test");
    write_fixture(&cgroup, "memory.max", "max\n");
    write_fixture(&cgroup, "memory.current", "500000000\n");

    let memory = fixture_collector(root.path()).ctx.read_memory_section();
    assert!(memory.available);
    assert_eq!(memory.source, "host");
    assert_eq!(memory.total_bytes, 64_000_000 * 1024);
    assert_eq!(memory.used_bytes, 32_000_000 * 1024);
    assert_eq!(memory.available_bytes, 32_000_000 * 1024);
    assert_eq!(memory.cgroup_limit_bytes, None);
    assert_eq!(memory.swap_total_bytes, Some(8_000_000 * 1024));
    assert_eq!(memory.swap_used_bytes, Some(0));
}

#[test]
fn absent_cgroup_memory_uses_host_meminfo() {
    let root = tempfile::tempdir().unwrap();
    write_host_memory(root.path());

    let memory = fixture_collector(root.path()).ctx.read_memory_section();
    assert!(memory.available);
    assert_eq!(memory.source, "host");
    assert_eq!(memory.total_bytes, 64_000_000 * 1024);
    assert_eq!(memory.used_bytes, 32_000_000 * 1024);
    assert_eq!(memory.available_bytes, 32_000_000 * 1024);
    assert_eq!(memory.cgroup_limit_bytes, None);
    assert_eq!(memory.swap_total_bytes, Some(8_000_000 * 1024));
    assert_eq!(memory.swap_used_bytes, Some(0));
}

#[test]
fn missing_memory_sources_produce_an_unavailable_full_shape() {
    let root = tempfile::tempdir().unwrap();
    let memory = fixture_collector(root.path()).ctx.read_memory_section();

    assert!(!memory.available);
    assert_eq!(memory.total_bytes, 0);
    assert_eq!(memory.used_bytes, 0);
    assert_eq!(memory.available_bytes, 0);
    assert_eq!(memory.cgroup_limit_bytes, None);
    assert_eq!(memory.swap_total_bytes, None);
    assert_eq!(memory.swap_used_bytes, None);
}
~~~

- [ ] Run the complete new module and the existing platform readers.

~~~bash
cargo test -p freshell-server --bin freshell-server --locked host_stats::collection_tests
cargo test -p freshell-platform --lib --locked host_stats_readers
~~~

Expected: eight collector tests and the existing selected reader tests execute and pass. If a collector assertion fails, investigate `read_memory_section` and `read_cgroup_memory`; do not substitute host-dependent assertions.

- [ ] Refactor review: retain separate named tests for finite, unlimited, absent, and unavailable sources. Keep swap assertions host-scoped. No production refactor is required when the established behavior passes.

- [ ] Format and commit.

~~~bash
cargo fmt --all
git add crates/freshell-server/src/host_stats_collection_tests.rs
git commit -m "test: preserve Rust Host Stats memory precedence"
~~~

## Task 5: Apply main's environment isolation to the two new runtime lanes

**Files:** modify `config/vitest/vitest.runtime.config.ts`, `config/vitest/vitest.electron-runtime.config.ts`, `test/unit/config/sanitize-test-env.test.ts`, `test/unit/config/fixtures/sanitize-env-child.ts`, and the environment-isolation note in `AGENTS.md`.

PR703 introduced `sanitize-test-env.ts` while this plan was being written. Its original configs receive the prelude, but PR699's new source-runtime and packaged-runtime configs do not. Importing those configs therefore still passes ambient proxy/bind settings into their child processes. This is a distinct integration gap; keep the main implementation and extend its real-child regression harness.

- [ ] In `sanitize-env-child.ts`, change its first comment to:

~~~ts
// Fixture for sanitize-test-env.test.ts. argv[2] = plain, clean, or config.
~~~

Add this import beside the existing child-process import:

~~~ts
import { pathToFileURL } from 'node:url'
~~~

Replace only the existing mode-selection block with:

~~~ts
const mode = process.argv[2]
if (mode === 'clean') {
  const { stripAmbientEnvPoisons } = await import('../../../../config/vitest/sanitize-test-env.js')
  stripAmbientEnvPoisons(process.env)
} else if (mode === 'config') {
  const configPath = process.argv[3]
  if (!configPath) throw new Error('config mode requires an absolute config path')
  await import(pathToFileURL(configPath).href)
}
~~~

Keep the existing inner-child fetch, pinned Node environment flags, and JSON report unchanged.

- [ ] Add these behavioral cases to `sanitize-test-env.test.ts`. Reuse its existing imports, `POISONED_ENV`, `fixture`, `tsxCli`, and `execFileAsync`.

~~~ts
it.each([
  'vitest.runtime.config.ts',
  'vitest.electron-runtime.config.ts',
])('%s sanitizes the environment inherited by child processes', async (configName) => {
  const env = { ...process.env, ...POISONED_ENV }
  delete env.FRESHELL_RUN_REAL_PROVIDER_CONTRACTS
  const configPath = path.resolve(process.cwd(), 'config/vitest', configName)
  const { stdout } = await execFileAsync(
    process.execPath,
    [tsxCli, fixture, 'config', configPath],
    { env, maxBuffer: 1024 * 1024 },
  )
  const result = JSON.parse(stdout) as {
    innerStderr: string
    envReport: Record<string, string | undefined>
  }
  expect(result.innerStderr).toBe('')
  for (const key of AMBIENT_ENV_POISONS) {
    expect(result.envReport[key]).toBeUndefined()
  }
})
~~~

- [ ] Run the new config-load regressions.

~~~bash
npm run test:vitest -- run test/unit/config/sanitize-test-env.test.ts
~~~

Expected: five existing tests pass; the two new cases fail because the loaded configs do not remove the poisoned environment. The test executes config loading and child inheritance; it does not search config text.

- [ ] Add this first import to both `vitest.runtime.config.ts` and `vitest.electron-runtime.config.ts`:

~~~ts
import './sanitize-test-env.js'
~~~

Do not duplicate sanitizer logic or alter its real-provider escape hatch.

- [ ] Replace the temporary environment-isolation note in `AGENTS.md` with this completed description:

~~~text
- Ambient proxy vars (HTTP(S)_PROXY, either case) and FRESHELL_BIND_HOST are stripped by config/vitest/sanitize-test-env.ts at Vitest config load, including source-runtime and packaged-runtime lanes. The exact FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 escape hatch preserves proxy egress but still removes FRESHELL_BIND_HOST.
~~~

- [ ] Run the regression and tools typecheck.

~~~bash
npm run test:vitest -- run test/unit/config/sanitize-test-env.test.ts
npm run typecheck:tools
~~~

Expected: all seven tests pass and no type errors. Full source/packaged-runtime execution follows in Tasks 6–7.

- [ ] Refactor review: keep one shared sanitizer and the existing behavioral fixture. No new environment global, duplicate sanitizer, or source-text test is needed.

- [ ] Commit the integration repair.

~~~bash
git add config/vitest/vitest.runtime.config.ts config/vitest/vitest.electron-runtime.config.ts test/unit/config/sanitize-test-env.test.ts test/unit/config/fixtures/sanitize-env-child.ts AGENTS.md
git commit -m "fix: isolate new runtime test lanes from ambient environment"
~~~

## Task 6: Verify the repaired merge, including real browser execution

**Files:** no planned production edits. Update this plan's receipt after verification. Temporary scripts/bundles below are ignored test artifacts, not new product tooling.

- [ ] Confirm clean committed inputs, inspect the shared gate, and capture the exact tested SHA.

~~~bash
git status --short
git rev-parse HEAD
npm run test:status
~~~

Expected: no uncommitted task changes; no foreign holder before starting a broad run.

- [ ] Run non-destructive static checks on the worktree.

~~~bash
npm run typecheck
cargo fmt --all --check
cargo check --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
npm run lint
npm run contract:generate
git diff --exit-code -- port/contract
~~~

Expected: all commands exit zero; contract regeneration produces no diff. Record pre-existing lint warnings separately, never as new failures or as warning-free output.

- [ ] Prepare a committed-source, git-aware sandbox run for the approved local backend. A host worktree's `.git` points outside `/workspace`; mounting it alone can make build IDs `unknown`. The recipe below carries a Git bundle into a disposable repository and worktree **inside** the container, so build-mismatch tests exercise real stamps without mounting the host's Git internals or user data.

Run on the host from the PR worktree, after confirming these two artifact names are not owned by another task:

~~~bash
mkdir -p dist
git bundle create dist/pr699-review.bundle HEAD
~~~

Use `apply_patch` to create the ignored `dist/pr699-review-gate.sh` with this complete content:

~~~bash
#!/usr/bin/env bash
set -euo pipefail

review_root="$(mktemp -d /tmp/pr699-review.XXXXXX)"
git clone --bare /workspace/dist/pr699-review.bundle "$review_root/repository.git"
git --git-dir="$review_root/repository.git" worktree add --detach "$review_root/.worktrees/verification" HEAD
cd "$review_root/.worktrees/verification"
ln -s /workspace/node_modules node_modules
ln -s /workspace/target target

export FRESHELL_VITEST_BACKEND=local
export FRESHELL_E2E_BACKEND=local
export FRESHELL_TEST_SUMMARY="PR699 repaired merge verification"
export RUST_TEST_THREADS=1
export CARGO_BUILD_JOBS=4

git rev-parse HEAD
npm run test:status
npm run check
npm run test:vitest -- run --config config/vitest/vitest.port.config.ts
npm run test:e2e:helpers -- helpers/selection-nonvacuity.test.ts
npm exec -- playwright install chromium
npm run test:e2e -- --project=chromium --workers=2 \
  test/e2e-browser/specs/cli-rust.spec.ts \
  test/e2e-browser/specs/mcp-bridge-rust.spec.ts \
  test/e2e-browser/specs/mcp-qa-smoke-rust.spec.ts \
  test/e2e-browser/specs/fresh-agent-control-rust.spec.ts \
  test/e2e-browser/specs/fresh-agent-rollback-rust.spec.ts \
  test/e2e-browser/specs/host-stats-pane.spec.ts \
  test/e2e-browser/specs/server-build-mismatch-rust.spec.ts
~~~

Then run:

~~~bash
scripts/sandbox-test.sh "bash /workspace/dist/pr699-review-gate.sh"
~~~

Expected: exact bundled SHA printed, `npm run check` completes all default JavaScript, source-runtime, Rust, and Electron lanes, port contracts pass, helper selection passes, and every selected browser spec actually executes. In particular require eight rollback tests, five Host Stats tests, both CLI tests after Task 2, and non-skipped build-mismatch tests. Keep the full logs and the actual counts instead of copying pre-merge counts. The container owns all started/stopped servers.

If dependencies in the reused sandbox cache no longer match the committed lockfile, run `scripts/sandbox-test.sh "npm ci --no-audit --no-fund"` before retrying; do not alter the lockfile to fit a stale cache. If container resource limits cause failure, diagnose that limit rather than rerunning destructive tests on the host.

- [ ] If the chosen backend is cloud instead, run the repo's configured cloud Vitest/browser paths and record actual shard results. Do not run the local recipe as an unannounced fallback:

~~~bash
FRESHELL_VITEST_BACKEND=cloud npm run test:vitest -- run --config config/vitest/vitest.config.ts
FRESHELL_E2E_BACKEND=cloud npm run test:e2e -- --project=chromium test/e2e-browser/specs/cli-rust.spec.ts test/e2e-browser/specs/mcp-bridge-rust.spec.ts test/e2e-browser/specs/mcp-qa-smoke-rust.spec.ts test/e2e-browser/specs/fresh-agent-control-rust.spec.ts test/e2e-browser/specs/fresh-agent-rollback-rust.spec.ts test/e2e-browser/specs/host-stats-pane.spec.ts
~~~

The cloud path does not replace native Cargo/source-runtime/Electron evidence. Use PR CI for those lanes. Check `test/e2e-browser/playwright.cloud.config.ts` for every selected spec: a cloud-skipped case is still uncovered. `server-build-mismatch-rust.spec.ts` specifically needs git-aware local/disposable-CI execution; obtain an explicit supplemental local choice if cloud is selected, then run the git-aware sandbox recipe. Do not claim the browser requirement complete while any affected spec remains unexecuted.

- [ ] If a new regression fails, preserve command, SHA, log, and failing assertion; use the debugging/TDD workflow to correct the specific cause before rerunning both its focused test and the affected broad lane. Do not weaken coverage, add retries to conceal a race, or silently mark existing failures unrelated.

- [ ] Append an execution receipt here containing: tested SHA, backend, commands, pass/fail/skip counts, log locations or CI links, documented existing exclusions, and any still-blocked native platform. Commit the receipt only after it accurately reflects observed results.

## Task 7: Verify native packages and hand off a clean branch

**Read-only workflow:** `.github/workflows/electron-build.yml`; four native environments: Intel macOS, ARM macOS, Linux, and Windows. Do not trigger the release/publishing workflow.

- [ ] Push the focused repair commits and receipt to the existing PR branch without force.

~~~bash
GH_TOKEN="$(gh auth token --user danshapiro)" git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push origin HEAD:the-usual/retire-node-server-v2
~~~

- [ ] Read PR state and CI for the exact pushed head.

~~~bash
GH_TOKEN="$(gh auth token --user danshapiro)" gh pr view 699 --repo danshapiro/freshell --json headRefOid,mergeable,statusCheckRollup,url
GH_TOKEN="$(gh auth token --user danshapiro)" gh run list --repo danshapiro/freshell --branch the-usual/retire-node-server-v2 --limit 20
GH_TOKEN="$(gh auth token --user danshapiro)" gh pr checks 699 --repo danshapiro/freshell
~~~

Expected: PR is mergeable against current main; required checks succeed. A new main conflict requires a separate reviewed integration checkpoint, not force-pushing main or reusing stale check results.

- [ ] Inspect each Electron Build job's logs. Require all of: native Rust build, Electron unit tests, installer build, `verify:electron-artifact`, and `test:electron:runtime` with the job's actual packaged resources path:

| Runner | Runtime acceptance path |
| --- | --- |
| Intel macOS | `release/mac/Freshell.app/Contents/Resources` |
| ARM macOS | `release/mac-arm64/Freshell.app/Contents/Resources` |
| Linux | `release/linux-unpacked/resources` |
| Windows | `release/win-unpacked/resources` |

A green installer build alone is insufficient. Acceptance must launch the packaged runtime without depending on checkout source, and Windows must use a native Windows build, not Linux binaries copied into a Windows archive.

- [ ] Confirm the remaining PR jobs cover client typecheck/default Vitest, Rust formatting/clippy/workspace/source runtime, browser selection, and protocol drift. Browser selection alone is not a substitute for Task 6's actual scenarios.

- [ ] Append exact native run URLs/results to the receipt. If a platform fails, investigate its real log and leave the plan incomplete until the failure is resolved or a concrete external blocker is reported. Do not label local Linux success as macOS/Windows verification.

- [ ] Perform a final scoped review of new commits against `bd1b6c32c`. Verify no Node listener was restored, rollback handling remains present, Host Stats works through both CLI and MCP, and no unrelated work was changed. Request an independent code review of the implementation before claiming completion.

- [ ] Commit the final receipt, push it, and confirm the worktree is clean. Report the implemented findings, test evidence, remaining caveats, and PR link. Stop before merging PR699 or deploying anything; this plan does not grant that authority.

## Completion criteria

- [ ] Both CLI creation commands forward enabled Host Stats options and treat explicit false correctly.
- [ ] Compiled CLI + Rust + browser show two Host Stats panes with no terminal allocation.
- [ ] Rust tests protect exact nonzero CPU, paging, disk, and network calculations.
- [ ] Rust tests protect finite/unlimited/absent memory precedence and unavailable full-shape output.
- [ ] Both new runtime test configurations apply the shared environment sanitizer, proved through actual config loading and child execution.
- [ ] Fresh-agent rollback, protocol v8, and Rust-only runtime boundaries remain passing after the repairs.
- [ ] Full merged-branch regression and actual affected browser scenarios have current receipts.
- [ ] All four native packaged-runtime jobs have current passing receipts.
- [ ] Branch is committed/pushed and clean; main, production, and unrelated agents' files remain untouched.

## Execution receipt

Not executed yet. The integration evidence in “Starting state and scope” is the only post-merge evidence available when this plan was written; it is not a substitute for Tasks 1–7.
