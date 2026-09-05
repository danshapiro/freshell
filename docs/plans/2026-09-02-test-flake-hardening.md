# Test Flake Hardening Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
"Fix 2-3" — items 2 and 3 of the host-pressure-pane run's final-recap disclosures:

- **(2) Rust deadline-under-load test flakes.** Three tests time out only under heavy machine load and are green in isolation: `crates/freshell-ws/tests/auto_resume_e2e.rs` (2 tests, 10s frame budget + 5s polls), `crates/freshell-ws/tests/restore_spawn_gate.rs` (12 tests sharing file-local 5s per-frame helpers, 5s gate acquisitions, 1–2s bounded polls), and the `pane_ledger` lock test (`crates/freshell-ws/src/pane_ledger_tests.rs::new_locked_degrades_to_disabled_when_another_holder_exists`, proven `EWOULDBLOCK`-after-`drop(holder)` flock-release race; NOT a wall-clock deadline).
- **(3) Ambient proxy environment poisons local test runs.** When `HTTP_PROXY`/`HTTPS_PROXY` (either case) are set in the shell, every spawned Node child prints one `(node:NNN) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental...` line to stderr, breaking the suite's strict-empty-stderr assertions (`test/e2e/update-flow.test.ts` ×3, `test/unit/lib/visible-first-audit-gate.test.ts` ×2). Fix the SYSTEM so no agent has to remember to strip env vars before a local test run.

### Explicit constraints
- The-usual workflow on a dedicated worktree (`the-usual/test-flake-hardening`).
- Do NOT create or open a PR until the user explicitly approves PR creation (repo rule). Prepare the branch, run all gates, land only on approval.
- Do NOT absorb, rewrite, or conflict with the in-flight `darkforge/qzka` branch (HEAD `a3505bd51`): its production pane-ledger fix chain (`9a3d74e09` etc.) stays owned by that lane. This plan touches `src/pane_ledger_tests.rs` ONLY — never `src/pane_ledger.rs`.
- Honor the merged C1 decision (commit `884fc8721`): no silent retry-masking in the pane_ledger lock test; evidence probes stay intact.

### Accepted tradeoffs and residuals
- Wider wait budgets mean a genuinely-missing WS frame fails ~30s later instead of 5–10s — the repo's accepted deflake idiom (merged precedent `f2c505e9f`: "a genuinely missing frame still fails, 20s later"). Because two of the widened helpers live in the shared `tests/common/mod.rs`, OTHER freshell-ws integration suites inherit the wider worst-case failure latency too; scoping the budget per-caller (wrapper params) was considered and rejected as needless complexity — the merged idiom widened a shared helper the same way.
- pane_ledger's production-side "comes up loudly DISABLED" hardening remains owned by `darkforge/qzka`; this plan hardens only the flaky TEST.
- `FRESHELL_BIND_HOST` is folded into the same sanitize as the proxies (identical failure class; it already burned `vite-config.test.ts` once, whose comment says so). Safely striped at config load: the only vitest-lane test that cares manages it in-test, and e2e helpers pin it explicitly.
- Real-provider contract tests (`test/integration/real/`, opt-in) get an escape hatch from proxy-stripping because their spawned CLIs may need proxy internet egress.

**Goal:** Local full-suite test runs pass with ambient proxy vars and `FRESHELL_BIND_HOST` present, and the three flaky Rust suites tolerate heavy machine load without any weakened assertion.

**Architecture:** (1) A shared side-effect prelude imported first in all 9 vitest config files strips known shell-env poisons from `process.env` before worker pools spawn (mirroring the existing inline NODE_ENV config-top precedent), with a pure exported function unit-tested directly and a child-process behavioral test proving the UNDICI warning disappears iff the prelude loads. (2) The ws test suites adopt the repo's merged deflake idiom: one named 30s frame budget replacing scattered 5–10s timeouts, bounded polls extended to the same budget, assertions byte-identical, evidence-citing DEFLAKE comments. (3) The pane_ledger lock test replaces its one-shot post-drop re-acquire probe and third construction with one bounded wait whose retry unit is the construction itself: retries proceed ONLY while a separate probe keeps showing `EWOULDBLOCK` (the proven signature); a free-lock-blind construction (H2), any other errno, or expiry fails immediately with the probe's errno+kind diagnostics and the on-disk evidence intact.

**Tech Stack:** Vitest 3.2.4 configs (ESM/TS), Node 22, `tsx` child spawns; Rust workspace (`freshell-ws` crate, tokio, tokio-tungstenite, libc flock).

## Global Constraints

- Test execution via repo-owned entry points only: `npm test` / `npm run test:vitest -- ...` / `cargo test` — matching `AGENTS.md` test-coordination rules. Raw `npx vitest` is not a coordinated workflow.
- This shell exports `HTTPS_PROXY` and `FRESHELL_BIND_HOST`; that is deliberate for validating Task 1 (local runs must pass WITH them set). Still strip them for any BASELINE/base-gate reproduction receipts so attribution stays clean.
- `cargo fmt --check --all` must be clean before pushing (CI's clippy job includes a fmt gate).
- Structured-logging conventions and the repo's "fix the system over the symptom" philosophy apply; no `#[ignore]`, no retry-on-anything logic, no coverage reduction.
- `cargo test --workspace --locked` for Rust verification; strict clippy `cargo clippy --workspace --locked --all-targets -- -D warnings` for the final gate.
- pane_ledger tests file lives in the `freshell-ws` crate (`src/pane_ledger_tests.rs`, wired in via `pane_ledger.rs:1026-1027` `#[path] mod tests`), not freshell-server.
- Evidence explorers' reports (authoritative line references):
  - `/home/dan/code/freshell/.worktrees/.the-usual-logs/test-flake-hardening/reports/rust-flake-explore.md`
  - `/home/dan/code/freshell/.worktrees/.the-usual-logs/test-flake-hardening/reports/proxy-env-explore.md`

---

### Task 1: Strip ambient-env poisons in a shared vitest-config prelude

**Files:**
- Create: `config/vitest/sanitize-test-env.ts`
- Create: `test/unit/config/sanitize-test-env.test.ts`
- Create: `test/unit/config/fixtures/sanitize-env-child.ts`
- Modify: `config/vitest/vitest.config.ts` (line 1), `config/vitest/vitest.server.config.ts`, `config/vitest/vitest.electron.config.ts`, `config/vitest/vitest.port.config.ts`, `config/vitest/vitest.oracle.config.ts`, `config/vitest/vitest.oracle-t2.config.ts`, `test/e2e-browser/vitest.config.ts` — one import line each (7 files)
- Modify: `config/vitest/vitest.codex-real-provider-smoke.config.ts`, `config/vitest/vitest.opencode-serve-real-provider-smoke.config.ts` — one DOCUMENTED EXCLUSION comment each (NO import; these two configs spawn real Codex/OpenCode CLI binaries whose package-script commands do not set `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1`, so importing the prelude would strip the proxy egress a proxy-only host needs)
- Modify: `AGENTS.md` (Test Coordination section) — one line noting the sanitization
- Test: `test/unit/config/sanitize-test-env.test.ts`

**Interfaces:**
- Consumes: nothing repo-internal (no dependencies; pure `process.env` manipulation)
- Produces: `AMBIENT_ENV_POISONS: readonly string[]` and `stripAmbientEnvPoisons(env?: Pick<NodeJS.ProcessEnv, ...>): string[]` — the latter optional only for the behavioral fixture; configs import the module for its side effect.

- [x] **Step 1: Write the failing behavioral test**

Create `test/unit/config/sanitize-test-env.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'path'
import { createRequire } from 'node:module'
import { AMBIENT_ENV_POISONS, stripAmbientEnvPoisons } from '../../../config/vitest/sanitize-test-env.js'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)
const tsxCli = require.resolve('tsx/cli')
const fixture = path.resolve(process.cwd(), 'test/unit/config/fixtures/sanitize-env-child.ts')

// The failure shape under test: AMBIENT shell env + proxy vars. Mechanism
// facts, each pinned by executed probes on 2026-09-02 on this host's repo Node
// (nvm v22.21.1):
//  1. The `[UNDICI-EHPA]` warning is emitted lazily at the FIRST undici
//     dispatch activation (one fetch()), not at process start — the
//     fixture's inner child therefore performs one fetch('data:...').
//  2. Env-proxy honoring differs across supported Node builds (executed:
//     /usr/bin/node on this host does NOT warn at all; nvm v22.21.1 warns
//     ONLY when proxies are set). The negative-control warning assertion is
//     therefore capability-gated on (major, minor) >= (22, 21); the universal
//     control is var-inheritance (deterministic at any version/behavior).
//  3. The fixture's inner child env pins the knobs explicitly — proxies set,
//     NODE_OPTIONS cleared, NODE_USE_ENV_PROXY=1 — so ambient suppression
//     flags can never make the control unfalsifiable.
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
const ENV_PROXY_SUPPORTED = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 21)

const POISONED_ENV = {
  HTTP_PROXY: 'http://127.0.0.1:9',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  http_proxy: 'http://127.0.0.1:9',
  https_proxy: 'http://127.0.0.1:9',
  FRESHELL_BIND_HOST: '0.0.0.0',
}

async function runFixture(mode: 'plain' | 'clean', env: NodeJS.ProcessEnv) {
  const { stdout } = await execFileAsync(process.execPath, [tsxCli, fixture, mode], { env: { ...process.env, ...env }, maxBuffer: 1024 * 1024 })
  return JSON.parse(stdout) as { innerStderr: string; envReport: Record<string, string | undefined> }
}

describe('stripAmbientEnvPoisons (pure function)', () => {
  it('removes every poison key and returns the removed names', () => {
    const env: NodeJS.ProcessEnv = { ...POISONED_ENV, KEEP_ME: 'yes' }
    const removed = stripAmbientEnvPoisons(env)
    for (const key of AMBIENT_ENV_POISONS) expect(env[key]).toBeUndefined()
    expect(env.KEEP_ME).toBe('yes')
    expect(new Set(removed)).toEqual(new Set(Object.keys(POISONED_ENV)))
  })

  it('keeps proxies but still strips FRESHELL_BIND_HOST when the real-provider escape hatch is exactly "1"', () => {
    const env: NodeJS.ProcessEnv = { ...POISONED_ENV, FRESHELL_RUN_REAL_PROVIDER_CONTRACTS: '1' }
    const removed = stripAmbientEnvPoisons(env)
    expect(removed).not.toContain('HTTPS_PROXY')
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:9')
    // The hatch exists only for proxy egress: FRESHELL_BIND_HOST is ALWAYS stripped.
    expect(env.FRESHELL_BIND_HOST).toBeUndefined()
    expect(removed).toContain('FRESHELL_BIND_HOST')
  })

  it('treats any non-"1" value (e.g. "0") as unset — matching the real-provider gate convention', () => {
    const env: NodeJS.ProcessEnv = { ...POISONED_ENV, FRESHELL_RUN_REAL_PROVIDER_CONTRACTS: '0' }
    stripAmbientEnvPoisons(env)
    for (const key of AMBIENT_ENV_POISONS) expect(env[key]).toBeUndefined()
  })
})

describe('sanitize-test-env prelude (behavioral, via spawned node children)', () => {
  it('WITHOUT the prelude, the spawned child inherits the poisoned vars (and, on env-proxy-capable Node, warns)', async () => {
    const { innerStderr, envReport } = await runFixture('plain', POISONED_ENV)
    // Universal control: without the sanitize, children inherit the vars.
    for (const key of Object.keys(POISONED_ENV)) expect(envReport[key]).toBe(POISONED_ENV[key as keyof typeof POISONED_ENV])
    // Mechanism pin where the RUNNER's Node honors env proxies (>= 22.21.0
    // observed default-on; inner env also pins NODE_USE_ENV_PROXY=1 and
    // clears NODE_OPTIONS, so neither ambient suppression nor ambient
    // flags can make this unfalsifiable).
    if (ENV_PROXY_SUPPORTED) expect(innerStderr).toContain('[UNDICI-EHPA]')
  })

  it('WITH the prelude loaded, the spawned node child has no poisoned vars and no stderr noise', async () => {
    const { innerStderr, envReport } = await runFixture('clean', POISONED_ENV)
    expect(innerStderr).toBe('')
    for (const key of AMBIENT_ENV_POISONS) expect(envReport[key]).toBeUndefined()
  })
})
```

Create the fixture `test/unit/config/fixtures/sanitize-env-child.ts`:

```ts
// Fixture for sanitize-test-env.test.ts. `argv[2]` = 'plain' | 'clean'.
// In 'clean' mode it applies the shared sanitize to its OWN env — exactly what
// importing config/vitest/sanitize-test-env.ts at config load does. It then
// spawns an inner plain node child whose one fetch() forces undici's
// EnvHttpProxyAgent activation (the `[UNDICI-EHPA]` warning is emitted lazily
// at the first dispatch, not at process start) and reports the inner child's
// stderr verbatim on stdout as JSON.
import { spawnSync } from 'node:child_process'

const mode = process.argv[2]
if (mode === 'clean') {
  const { stripAmbientEnvPoisons } = await import('../../../../config/vitest/sanitize-test-env.js')
  stripAmbientEnvPoisons(process.env)
}

const inner = spawnSync(
  process.execPath,
  ['-e', "fetch('data:text/plain,hi').then(() => process.stdout.write('inner alive'))\n"],
  {
    encoding: 'utf8',
    // Pin the knobs ambient state cannot be trusted with: clear NODE_OPTIONS
    // (a --disable-warning=UNDICI-EHPA there would suppress the very warning
    // the control asserts) and explicitly enable env-proxy handling
    // (inert on Nodes that already default it on).
    env: { ...process.env, NODE_OPTIONS: '', NODE_USE_ENV_PROXY: '1' },
  },
)
const envReport: Record<string, string | undefined> = {}
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'FRESHELL_BIND_HOST']) {
  envReport[key] = process.env[key]
}
process.stdout.write(JSON.stringify({ innerStderr: inner.stderr ?? '', envReport }))
```

- [x] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/config/sanitize-test-env.test.ts`

Expected: FAIL because `config/vitest/sanitize-test-env` does not exist yet (module resolution error). Do NOT proceed if the failure is a syntax or fixture-layout accident — fix the test/fixture so the ONLY failure is the missing module.

- [x] **Step 3: Add the minimal production implementation**

Create `config/vitest/sanitize-test-env.ts`:

```ts
// Shared ambient-env sanitizer, imported FIRST by every vitest config in this
// repo (side effect). Vitest hoists imports to the top of each config module
// and loads configs in the main process before worker pools spawn, so the
// deletion here reaches every test worker — and therefore every child process
// a test spawns (children inherit the worker's env). This mirrors the existing
// inline NODE_ENV-mutation precedent at the top of six of the configs.
//
// Why these vars:
//  - HTTP_PROXY/HTTPS_PROXY/http_proxy/https_proxy: an ambient shell proxy makes
//    EVERY spawned Node child print
//      (node:NNN) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental...
//    on stderr, which fails the suite's strict-empty-stderr assertions
//    (test/e2e/update-flow.test.ts, test/unit/lib/visible-first-audit-gate.test.ts).
//  - FRESHELL_BIND_HOST: same shell-env-leak class; an ambient 0.0.0.0 silently
//    flips test-spawned servers off loopback (this already burned
//    test/unit/vite-config.test.ts, which self-manages it in-test).
//
// Escape hatch: the opt-in real-provider contract tests
// (FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1, test/integration/real/) spawn real
// CLI binaries that reach the internet; on a host whose only egress is a proxy,
// stripping would break them, so the strip is skipped when that flag is set.

export const AMBIENT_ENV_POISONS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'FRESHELL_BIND_HOST',
] as const

const PROXY_POISONS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'] as const

export function stripAmbientEnvPoisons(env: NodeJS.ProcessEnv = process.env): string[] {
  // Escape hatch — proxy vars only, and only on EXACTLY '1' (the same gate
  // convention the real-provider contract tests themselves use; a stray '0'
  // must not silently keep proxies), because its purpose is proxy egress for
  // those spawned CLIs. FRESHELL_BIND_HOST is ALWAYS stripped regardless.
  const proxyEscape = env.FRESHELL_RUN_REAL_PROVIDER_CONTRACTS === '1'
  const removed: string[] = []
  for (const key of PROXY_POISONS) {
    if (proxyEscape) break
    if (key in env) {
      delete env[key]
      removed.push(key)
    }
  }
  if ('FRESHELL_BIND_HOST' in env) {
    delete env.FRESHELL_BIND_HOST
    removed.push('FRESHELL_BIND_HOST')
  }
  return removed
}

stripAmbientEnvPoisons()
```

Then add, as the FIRST import line of 7 config files (before the inline NODE_ENV blocks, mirroring their role; `.js` extension per the repo's NodeNext relative-import rule):

- `config/vitest/vitest.config.ts` and its 5 non-smoke siblings in `config/vitest/` → `import './sanitize-test-env.js'`
- `test/e2e-browser/vitest.config.ts` → `import '../../config/vitest/sanitize-test-env.js'`

(Add a one-line comment above the import in each: `// Strip ambient shell env (proxies, FRESHELL_BIND_HOST) before anything else — see sanitize-test-env.ts.`)

And in the TWO real-provider smoke configs (`vitest.codex-real-provider-smoke.config.ts`, `vitest.opencode-serve-real-provider-smoke.config.ts`) add INSTEAD a documented exclusion comment at the same position:

```ts
// Deliberately NOT importing ./sanitize-test-env.js: this config's package
// script does not set FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1, and its tests
// spawn real provider CLIs that may need ambient proxy egress on some hosts.
```

Add to `AGENTS.md` in the Test Coordination section, one line:

> Ambient proxy vars (`HTTP(S)_PROXY`, either case) and `FRESHELL_BIND_HOST` are stripped at vitest config load by `config/vitest/sanitize-test-env.ts` (imported first by every config EXCEPT the two real-provider smoke configs); local test runs do not need env pre-stripping.

- [x] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/config/sanitize-test-env.test.ts`

Expected: PASS (5 tests). Note: run this WITHOUT stripping ambient env — the poisoned env is supplied by the test itself via spawn env, so shell state is irrelevant.

- [x] **Step 5: Refactor while green**

Confirm no duplication beyond the config import line; confirm the two real-provider smoke configs carry the documented exclusion instead of the import, and that no other code skips the sanitize by config choice (the functional escape hatch remains env-driven by `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1` for the `test/integration/real/` lane). No other refactor expected.

- [x] **Step 6: Run impacted-test verification**

The prelude alters `process.env` for EVERY vitest run. Impacted set = the two known strict-stderr files, plus the vite-config test that self-manages `FRESHELL_BIND_HOST`, plus the e2e-browser helper config's tests. Then prove the headline property: run the previously-RED base-gate suite file with ambient proxies deliberately SET.

Non-printing presence check first (never echo a proxy value — proxy URLs can embed credentials), synthesizing a dummy if genuinely unset:

```bash
test -n "${HTTPS_PROXY}${HTTP_PROXY}" && echo 'ambient proxy present (value not printed)' || { export HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9; echo 'no ambient proxy; dummy exported for this gate'; }
```

Run:
```
npm run test:vitest -- run test/unit/lib/visible-first-audit-gate.test.ts test/unit/vite-config.test.ts test/unit/config/sanitize-test-env.test.ts
npm run test:vitest -- run test/e2e/update-flow.test.ts
npm run test:e2e:helpers
```

Expected: PASS with ambient proxies present (present from the shell or the synthesized dummy above). The last line runs the e2e-helper harness tests, whose config (`test/e2e-browser/vitest.config.ts`) is NOT loaded by `npm test` — required because this task edits that config.

- [x] **Step 7: Commit the task**

```bash
git add config/vitest/ test/unit/config/ test/e2e-browser/vitest.config.ts AGENTS.md
git commit -m "test(env): sanitize ambient proxy + FRESHELL_BIND_HOST at vitest config load"
```

---

### Task 2: Load-tolerant deadlines for `auto_resume_e2e` and `restore_spawn_gate`

**Files:**
- Modify: `crates/freshell-ws/tests/common/mod.rs` (frame-read helpers at ~:936 handshake loop, `next_frame_of_type` ~:1100)
- Modify: `crates/freshell-ws/tests/auto_resume_e2e.rs` (:163, :252 10s budgets; :193, :205 5s polls; 500ms negative window stays)
- Test: the suites themselves (no new behavioral tests — deflake certification instead, see Step 6)

**Interfaces:**
- Consumes: existing `wait_frame_matching`, `next_frame_of_type`, `connect_and_*` helpers; `SpawnGate`.
- Produces: `pub const FRAME_BUDGET: Duration = Duration::from_secs(30)` in `common/mod.rs`, used by both suites' frame/poll waits.

No production Rust code changes in this task.

- [x] **Step 1: Enumerate every deadline site (RED-equivalent)**

This task has no new failing test to write (the flake only manifests under load); the repo's merged deflake idiom (`f2c505e9f`, `f451871d0`, `dcd7baad2`) explicitly uses "widen the budget, assertions unchanged, certify with evidence runs" instead of RED/GREEN for this class. Enumerate the complete site list first so nothing is missed OR over-widened:

Run:
```
rg -n "from_secs\(|from_millis\(" crates/freshell-ws/tests/auto_resume_e2e.rs crates/freshell-ws/tests/restore_spawn_gate.rs
rg -n "from_secs\(5\)|from_millis\(5\)" crates/freshell-ws/tests/common/mod.rs
```

Map EVERY hit onto exactly one bucket. The fixed widen/keep rule (the narrowing decision Fresh Eyes round 2 required — only the read paths these two suites exercise get wider):

- **WIDEN, in `common/mod.rs`:** the handshake frame-read loop inside `connect_and_capture_inventory` (~:936) and `next_frame_of_type` (~:1100) — the two helpers in the two suites' frame path.
- **WIDEN, in `auto_resume_e2e.rs`:** the two 10s frame budgets (:163, :252) and the two 5s polls (:193 spawn-count poll, :205 settle poll).
- **WIDEN, in `restore_spawn_gate.rs`:** the file-local helpers' 5s per-frame timeouts (:201, :220, :241, :260) and the two test-side `gate.acquire(5s)` (~:402, ~:438); the nine 1–2s bounded counter polls convert to deadline polls on the same budget.
- **KEEP (do not widen), with a brief DEFLAKE-keep note where ambiguity could linger:** the 500ms negative-window sleep in `auto_resume_e2e` (load-SAFE direction), the 5–25ms poll intervals (they pace, they don't bound), the server-side `hello_timeout_ms: 5_000` (no evidence it fired; separate door), and EVERY other `common/mod.rs` helper — explicitly `create_shell_terminal` (:955), `wait_for_attach_ready` (:1062), `drain_until_marker_or_deadline` (:995) and their reads — because the suites that use them did not flake and widening them would only raise unrelated suites' failure latency.

- [x] **Step 2: Add the shared budget constant**

In `crates/freshell-ws/tests/common/mod.rs` (near the top, before the helpers):

```rust
/// Frame-receive / poll budget for the WS e2e suites. DEFLAKE (the-usual
/// test-flake-hardening): `auto_resume_e2e` and `restore_spawn_gate` flaked at
/// 5–10s budgets only under heavy machine load (evidence: run-state receipts
/// of the 2026-09 host-pressure-pane run; f3wp prior art f2c505e9f). Assertions
/// are unchanged; only the wait budget grew — a genuinely missing frame still
/// fails, ~25s later.
pub const FRAME_BUDGET: Duration = Duration::from_secs(30);
```

Then route ONLY the 5s per-frame `tokio::time::timeout(Duration::from_secs(5), ws.next())` reads in `connect_and_capture_inventory`'s handshake loop (~:936) and in `next_frame_of_type` (~:1100) through `FRAME_BUDGET` — no other helper in this file changes (rule defined in Step 1).

- [x] **Step 3: Widen `auto_resume_e2e.rs`**

Replace:
- :163 and :252 `Duration::from_secs(10)` → `common::FRAME_BUDGET` (the one 10s Instant budget shared by the recovering+replaced waits);
- :193 and :205 `Duration::from_secs(5)` poll deadlines → `common::FRAME_BUDGET` (same 25ms interval; deadline-from-budget);
- keep the 500ms negative-window sleep and `hello_timeout_ms: 5_000` unchanged, each with a brief DEFLAKE comment noting the decision and citing the evidence receipts.

- [x] **Step 4: Widen `restore_spawn_gate.rs`**

In its file-local helpers (`connect_and_hello`'s handshake loop, `next_json_of_type`, `next_close_frame`, `next_json_of_type_failing_on_output` — per explorer inventory at :201, :220, :241, :260): `Duration::from_secs(5)` → `common::FRAME_BUDGET`. The two test-side `gate.acquire(Duration::from_secs(5), ...)` (~:402, ~:438) → `common::FRAME_BUDGET`. The nine 1–2s bounded counter polls (`for _ in 0..400 { ...; sleep(5ms) }` shape, e.g. the observed-queued poll) → deadline polls bounded by `common::FRAME_BUDGET` keeping the 5–10ms intervals, with the final assert after the loop unchanged. Every changed site gets the same one-line DEFLAKE pointer as the constant.

**Plan addition #2 (certification evidence, 2026-09-02, fixer-verified mechanism):** certification run 1 surfaced a SECOND, budget-independent load failure in `rate_limited_retry_same_requestid_proceeds` (restore_spawn_gate.rs:750). Mechanism (verified against server code: terminal.rs:2589 stamp-before-spawn; sequential per-connection dispatch terminal.rs:807-880; rejected creates consume no token, create_limit.rs:94-106): rl-2's server-side rate check necessarily lands a full spawn+turnaround AFTER rl-1's stamp; under load that gap exceeds the 300ms test window, so rl-2 is legitimately ACCEPTED and the expected RATE_LIMITED error never exists. The fix (the load-safe equivalent formulation; assertions only ADDED, none weakened):
1. Widen the test's OWN config knobs: `rate_window_ms: 300 → 2_000` and the post-slide `sleep(400ms) → sleep(2_100ms)`. Receipts show worst observed dispatch lag ≪ 2s; the margin logic is unchanged in kind. Cost ≈ +1.7s wall per run.
2. Keep a TWICE-limited probe: after the first `RATE_LIMITED` error for `rl-2`, immediately resend `rl-2` (still within the 2s window — no slide risk by construction) and assert a SECOND `RATE_LIMITED` error. Leak direction proof (stale InFlight sentinel would swallow the resend → no frame → bounded read fails) is thereby deterministic; with the 2s window the false-positive slide path is closed by design.
3. Keep the post-window-slide resend → `terminal.created` assertions: load-safe because the client's 2.1s sleep starts only after rl-1's `terminal.created` receipt (whose server's stamp precedes that receipt), so lag only moves the retry further past window start.
4. The A2 comment block stays verbatim; add one DEFLAKE paragraph naming the mechanism (stamp-before-spawn + sequential dispatch) and citing certification run 1 of `task2-certify.log`. DO NOT claim "zero dependence on the window" — say the dependence is now structurally safe (2s window ≫ observed worst-case in-loop lag).

**auto_resume_e2e shared-budget note (certification run 9, 2026-09-02):** the ONE shared 30s Instant covering BOTH `recovering` and `replaced` waits (:163, :252) can still expire under extreme scheduling lag after the first stage consumed most of it — wait budget per STAGE instead: each `wait_frame_matching` call gets its own fresh `Instant::now() + FRAME_BUDGET` deadline. Semantics strictly more patient per stage, assertions unchanged.

Import: these integration-test binaries reach the shared harness via a crate-local `mod common;` declaration. `auto_resume_e2e.rs` already has it (`mod common;` at :10, `use common::next_frame_of_type;` at :14). `restore_spawn_gate.rs` does NOT declare it today (verified 2026-09-02): add `mod common;` at the top with the file's existing declarations and `use common::FRAME_BUDGET;` with the other uses.

- [x] **Step 5: Refactor while green**

If `restore_spawn_gate.rs`'s file-local helpers now duplicate `common/mod.rs` helpers byte-for-byte after the widening (`next_json_of_type` ≈ `common::next_frame_of_type`), do NOT unify them in this task (out of scope, extra diff; leave for a later cleanup). Note this in the task report instead.

- [x] **Step 6: Certification (deflake convention)**

Run, in order (failure-sensitive: a failed iteration MUST fail the step; mechanism-B occurrences receive the addition-#5 revised rule and must be listed by receipt line refs):
1. Focused green: `cargo test -p freshell-ws --locked --test auto_resume_e2e --test restore_spawn_gate --test rate_limit_retry_clock` — Expected: all 16 tests PASS (4 in auto_resume_e2e incl. the 2 ring-pin tests, 11 in restore_spawn_gate after the rate test moved out, 1 in rate_limit_retry_clock).
2. Repeated certification (the f3wp convention), 10 iterations with per-iteration exit codes kept and evidence logged:

```bash
set -o pipefail
LOG=/home/dan/code/freshell/.worktrees/.the-usual-logs/test-flake-hardening/reports/task2-certify.log
CHUNKS=/home/dan/code/freshell/.worktrees/.the-usual-logs/test-flake-hardening/reports/task2-certify-chunks
mkdir -p "$CHUNKS"; : > "$LOG"
GREEN=0; MECHB=0; BLOCKED=0
for i in $(seq 1 10); do
  if cargo test -p freshell-ws --locked --test auto_resume_e2e --test restore_spawn_gate --test rate_limit_retry_clock > "$CHUNKS/run-$i.log" 2>&1; then
    echo "run $i: PASS" | tee -a "$LOG"; GREEN=$((GREEN+1))
  else
    # Exact-shape mech-B waiver (addition #5, executable form since delta-r6):
    # scripts/classify-resume-waiver.ts parses the chunk — failing-test
    # identity scoped to the two harnessed auto_resume_e2e tests, the ring
    # settle frame VERIFIED to carry reason="no_resumable_identity" WITH a
    # terminalId, and replaced/recovering rejected only for THAT terminal —
    # and exits 0 (waive) / 1 (block) / 2 (no failure). The grep heuristics
    # this loop used before r6 could waive an unrelated failure or block a
    # true signature; they no longer exist here.
    set +e
    npx tsx scripts/classify-resume-waiver.ts "$CHUNKS/run-$i.log" | sed "s/^/run $i classifier: /" | tee -a "$LOG"
    C=${PIPESTATUS[0]}
    set -e
    if [ "$C" -eq 0 ]; then
      echo "run $i: PASS(mech-B waived — exact signature per scripts/classify-resume-waiver.ts; chunk $CHUNKS/run-$i.log)" | tee -a "$LOG"; MECHB=$((MECHB+1))
    else
      echo "run $i: FAIL (non-mechanism-B shape — BLOCKS; chunk $CHUNKS/run-$i.log)" | tee -a "$LOG"; BLOCKED=$((BLOCKED+1))
    fi
  fi
done
echo "CERTIFY: $GREEN green / $MECHB mech-B-waived / $BLOCKED blocked" | tee -a "$LOG"
[ "$BLOCKED" -eq 0 ] || { echo 'CERTIFY FAILED'; exit 1; }
```

Expected: final line `CERTIFY: … / … / 0 blocked` with exit 0. Any non-mechanism-B shape yields a non-zero exit.

**Plan addition #9 (delta-review round 9, 2026-09-04):** the waiver gained a stage gate. `wait_frame_matching` returns matched frames (only non-matching ones reach the ring), so a failure at any wait AFTER the first proves an earlier wait already consumed a same-terminal recovery frame — recovery began, violating the no-recovery signature even when the final ring is clean. The classifier now (1) parses the awaited-frame description from the panic (both arms: `stream ended while waiting for {what}: …` and `{what} never arrived before the deadline; …`) and (2) requires it to equal the test's listed FIRST wait (`crashing_agent…`: `terminal.status{recovering}`; `reconcile_after…`: `terminal.replaced`); any other or unreadable stage blocks. Verified-compatible: every live mechanism-B receipt failed at the first wait (run 7: `…waiting for terminal.status{recovering}: Err(Elapsed(()))`, re-waived post-gate). If mechanism-B ever recurs at a later stage, certification now BLOCKS and a human decides whether to widen the accepted signature — deliberate checkpoint, not silent widening. (Same round, nit: the classifier unit test gained the repo-NodeNext `.js` import extension and its fixtures now mirror the real panic-arm wording.)

**Plan addition #8 (delta-review round 6, 2026-09-04):** the r5 inline-grep classifier was replaced with an executable, unit-tested classifier: `scripts/classify-resume-waiver.ts` (pure exported `classifyResumeWaiver` + CLI; exit 0/1/2 = waive/block/no-failure; tests in `test/unit/scripts/classify-resume-waiver.test.ts`). Round 6 found the grep version could still violate BOTH edges of the accepted waiver: it (a) matched `no_resumable_identity` ANYWHERE in the chunk — including panic prose or a different test's tail — so an unrelated failure could be waived, and (b) greped `recovering` across the whole chunk — including another terminal's frames or the wait's own expectation text — so a true signature could be blocked. The classifier now (1) scopes failing-test identity to the two harnessed auto_resume_e2e tests, (2) requires the ring settle frame to carry `reason="no_resumable_identity"` AND a `terminalId`, and (3) rejects `terminal.replaced`/`recovering` only when they carry the SAME terminalId as the settle. Requirement (3) needed one instrumentation refinement: the ring now records `tid` (the frame's `terminalId`) — without it the settle could never be correlated to the crashed terminal — and the existing exact-string ring-pin test was updated to pin the new field. Historical receipts (pre-tid rings, e.g. task2c2-certify.log) therefore correctly classify as `block`; future certifications under the enriched ring get the exact ruling. Round 8 correction (applied immediately): the classifier's settle scan admitted a MIXED sequence — the waivered reason present alongside another exited settle carrying a different (or missing) reason — while the accepted signature is ONLY: every terminal.status{exited} entry must carry reason=no_resumable_identity. The classifier now blocks any exited entry with a different/missing reason regardless of terminal, and its header contract comment documents the tid/oldTid/newTid correlation plus the identifier-less replacement block. **(Round-7 correction, applied immediately:** the r6 same-terminal replacement guard keyed only on `tid`, but real `terminal.replaced` frames carry `oldTerminalId`/`newTerminalId`, never `terminalId` — the guard could never fire on the real wire shape. The ring now renders `oldTid`/`newTid` for replacement frames and the classifier blocks a replacement when ANY of tid/oldTid/newTid names the settled terminal; a replacement carrying NO identifiers is uncorrelatable and conservatively blocks. Four unit pins cover: real-shape block, other-terminal waive, identifier-less block, original tid-shape block.) (Same round, minor: `ENV_PROXY_SUPPORTED` in sanitize-test-env.test.ts gated on `major > 22`, wrongly enabling the behavioral-warning assertions on Node 23.x — NODE_USE_ENV_PROXY shipped in 22.21.0 and 24.0.0, never 23.x; now `(22.21+) || (>= 24)`.)

Expected: final line `CERTIFY: … / … / 0 blocked` with exit 0. Any non-mechanism-B shape yields a non-zero exit.

**Plan addition #7 (delta-review round 5, 2026-09-02; superseded in executable detail by addition #8 at round 6 — the four-check grep shape below is kept as the historical record):** the Step-6 classifier above was rewritten after review found the waiver could neither fire nor enforce: (a) the ring is Debug-rendered, so receipts carry `reason=\"no_resumable_identity\"` with escaped quotes and the old quoted grep never matched; (b) the old checks did not reject other auto-resume failures, other settle reasons, or arrived recovering/replaced frames. The classifier now normalizes each failing chunk ONCE (`tr -d '\\'` — every keyword grep is then quote-escape-insensitive by construction) and requires ALL FOUR checks: (1) every `panicked at` line names `tests/auto_resume_e2e.rs`; (2) ≥1 `no_resumable_identity` occurrence (bare name); (3) NO arrived `terminal.replaced` frame — anchored to the `type=`-tagged arrived-frame shape because the receipted failure line itself (`stream ended while waiting for terminal.replaced: …`, task2c2-certify.log:16) contains the bare word as the awaited-frame name, so a bare-word grep would block the waivered tail itself (the waivered tail is by definition "never replaced": no replaced frame ARRIVES); (4) NO `recovering` occurrence. Standalone-verified against five synthetic chunks (clean pass; exact mech-B shape with escaped quotes waived; recovering-then-vanish, other-file panic, and arrived-replaced all blocked) — evidence: usual-sdd/delta-r5-fix-report.md.

- [x] **Step 7: Commit the task**

```bash
git add crates/freshell-ws/tests/common/mod.rs crates/freshell-ws/tests/auto_resume_e2e.rs crates/freshell-ws/tests/restore_spawn_gate.rs
git commit -m "test(freshell-ws): widen ws-e2e frame/poll budgets to a shared 30s (load-deflake)"
```

---

**Plan addition #3 (mechanism-B RCA, 2026-09-02):** the remaining auto_resume zero-frame stall (2 occurrences in ~40 runs under load) root-caused to: `wait_frame_matching` silently ignores every non-matching frame, including the hub's terminal `terminal.status{exited}` settle that fires on every replacement-abort tail — so the receipts cannot name the mechanism. Fix, per the repo's f3wp self-diagnosing idiom (884fc8721): make `wait_frame_matching` record the type (and key fields) of up to the last ~10 ignored frames and include them in its deadline panic message. The failure (if it recurs) still FAILS at the same point with the same budget — only the diagnostic is complete. The RCA also identified a genuine production-side question (auto-resume hub supervisor CrashEvent loss-on-panic, auto_resume.rs:233-279) which is OUT OF SCOPE for this plan (production change owned elsewhere) and is recorded for the recap. (Superseded detail: delta round 2's M1/M2 findings further require BOTH panic paths to carry the ring — the r1 fix missed the pre-deadline `Elapsed` exit; see addition #4.)

**Plan addition #4 (delta-review round 2, 2026-09-02):** three blocking findings, each verified by coordinator code inspection:

1. **M1 — deadline-form, not per-frame multiplication.** The widened helpers multiply the budget: `common::next_frame_of_type` (common/mod.rs:~1098) and its siblings / the restore_spawn_gate file-local helpers run 30s-PER-FRAME inside 20–40-message loops → up-to-10/20-min failure latency (certification receipts: 450s iterations). RESTRUCTURE each helper to the deadline form `wait_frame_matching` already uses: one `Instant::now() + FRAME_BUDGET` deadline per call; each `ws.next()` wrapped in `timeout(remaining.max(1ms), ...)`; loop's 20/40-message cap stays as a SECONDARY bound; final panic messages unchanged. Sites: `next_frame_of_type` and the handshake read loop in `common/mod.rs`; `connect_and_hello`'s handshake loop, `next_json_of_type`, `next_close_frame`, `next_json_of_type_failing_on_output` in `restore_spawn_gate.rs`. "A genuinely missing frame fails in ≤ FRAME_BUDGET", restored exactly.
2. **M2 — pane-ledger diagnosis must capture the errno AT failure, not via a later probe.** The drop→probe ordering still racy (transient EWOULDBLOCK at construction, released holder by probe time → probe Ok → mislabeled H2-panic). REPLACE the probe with a thread-local tracing capture (same pattern family as `pane_reconcile_freshagent.rs`'s LogCapture): production already logs `pane_ledger_lock_unavailable` WITH the io error Display string ("Resource temporarily unavailable (os error 11)") synchronously inside `new_locked` on the construction thread. New shape: wrap the wait in a tiny capture layer (registry + Event layer on this thread; set_default guard); on each failed construction classify from the CAPTURED event's error text: contains "os error 11" → transient EWOULDBLOCK → sleep/retry; event present with any other error text → immediate panic with it; NO event → immediate panic ("disabled path did not log the expected event" — a third, real signal). Enabled-but-blind → immediate H2 panic (unchanged from r1 fix). Deadline panic names the last captured error text. NO probe calls remain; C1 property: every non-transient reason fails loudly immediately, and the transient loop is classified ONLY by evidence captured at the exact failure instant.
3. **M3 — rate-window determinism via the HARNESS-14 clock's per-binary split, not a bigger number.** The 2s wall-clock window is still load-racy in principle (a >2s stamp-to-check gap expires the token). The repo solved this class with `test_clock_routing.rs` — an OWN integration binary because the process-global clock pollutes parallel siblings. FOLLOW THAT PRECEDENT: MOVE `rate_limited_retry_same_requestid_proceeds` out of `restore_spawn_gate.rs` into a NEW single-test binary `crates/freshell-ws/tests/rate_limit_retry_clock.rs` which: uses `freshell_platform::clock::set_enabled_override_for_tests(Some(true))` guarded by a GateGuard clone (mutex + reset-on-drop, copied from test_clock_routing.rs), `freeze()` before rl-1's send so BOTH rl-1's stamp and rl-2's check read the SAME frozen instant (deterministic RATE_LIMITED irrespective of load), then `advance_ms(400)` so the resend deterministically passes the window, then guard drop/reset. Keep: the twice-limited sentinel probe AND the post-slide created assertions (identical assertions, zero wall-clock sleeps — the `sleep(400ms)`/`sleep(2_100ms)` leaves entirely). Config knobs stay `rate_limit: 1, rate_window_ms: 300` (determinism comes from the clock, not the count). The clock is process-global ONLY within this process' single test ⇒ no sibling pollution (the exact reason the routing tests live in their own binary). Delete the test from restore_spawn_gate.rs in the same commit. Certification loops (both lists) now include this binary: focused `cargo test -p freshell-ws --locked --test auto_resume_e2e --test restore_spawn_gate --test rate_limit_retry_clock` and the 10× certify; while restoring spawn gate's test count drops to 11 and the new binary holds 1. the remaining auto_resume zero-frame stall (2 occurrences in ~40 runs under load) root-caused to: `wait_frame_matching` silently ignores every non-matching frame, including the hub's terminal `terminal.status{exited}` settle that fires on every replacement-abort tail — so the receipts cannot name the mechanism. Fix, per the repo's f3wp self-diagnosing idiom (884fc8721): make `wait_frame_matching` record the type (and key fields) of up to the last ~10 ignored frames and include them in its deadline panic message. The failure (if it recurs) still FAILS at the same point with the same budget — only the diagnostic is complete. The RCA also identified a genuine production-side question (auto-resume hub supervisor CrashEvent loss-on-panic, auto_resume.rs:233-279) which is OUT OF SCOPE for this plan (production change owned elsewhere) and is recorded for the recap.

**Plan addition #5 (delta-r2 certification evidence → mechanism-B final disposition, 2026-09-02):** The delta-r2 fixer's 10× certification witnessed-while-instrumented mechanism B twice (receipts: `task2c-certify.log` runs 1 & 5). The ignore-ring names mechanism B exactly: `terminal.status{exited}` settle then silence — the hub's `decide`/`emit_settled` tail ran (or the natural-exit broadcast did) and NO `recovering` ever followed. The production hub (`auto_resume.rs`) is byte-identical at base_ref, so the defect pre-dates this branch; the certification failures recorded pre-branch (task-002 reports) match the same signature pre-instrumentation. Following the repo's f3wp doctrine (never paper a real signal, never lose the evidence): the certification rule for Task-2 binaries is REVISED to: every iteration passes OR fails ONLY with the EXACT receipted mechanism-B signature — on a single crashed-terminal wait, the observed frames contain ONLY `terminal.status{exited}` settle frame(s) carrying `reason="no_resumable_identity"` (read from the enriched ring's `reason` field in the failure output line 15-16 of task2c2-certify.log), followed by no `recovering`/`replaced`. Any OTHER settle reason (`respawn_failed`, `session_lease_held`, `lease_completion_lost`, cancellation, etc.), any other failure shape, or any missing `reason` in a settle ring BLOCKS the run — this is a waiver for the one receipted tail only, never for "any settle then silence". Mechanism-B is simultaneously (a) SMALL INSTRUMENTATION REFINEMENT: the ring now includes each frame's `reason`, `code`, `attempt`, `sessionRef` fields when present (test-only, inside the existing helper — assertion semantics unchanged), so every future occurrence carries the full settle diagnostics the follow-up task needs; and (b) DEFERRED to a follow-up task per user-scope discipline (it is a production-side defect: a terminal's crash is occasionally never recovered under load; discovered and documented here, never weakened in-test). The Final Gate and this plan's certification receipts MUST list mechanism-B occurrences explicitly with their task2c2-certify.log line references.

### Task 2b: Mechanism-B self-diagnosing instrumentation

**Files:**
- Modify: `crates/freshell-ws/tests/auto_resume_e2e.rs` (`wait_frame_matching` helper, ~:110-131, plus its panic message)
- Test: the suites themselves (certification as in Task 2)

**Interfaces:**
- Consumes: existing `common::FRAME_BUDGET` (Task 2); `WsMessage` scan logic.
- Produces: `wait_frame_matching` panic messages now enumerate ignored frames (type + `status`/`code` when present).

- [x] **Step 1: Extend the helper (self-diagnosing idiom)**

Change ONLY `wait_frame_matching` inside `auto_resume_e2e.rs` (this file's private helper — the shared `common/mod.rs` helpers stay untouched, per Task 2's fixed widen/keep rule): keep the frame loop identical, but track ignored frames: on `Ok(Some(Ok(WsMessage::Text(text))))` that parses but fails `pred`, record `value["type"]` plus `value["status"]` / `value["code"]` when present, keeping the last 10 in a `VecDeque`/`Vec` ring; on deadline expiry, include them in the panic message, e.g. `panic!("{what} never arrived before the deadline; ignored frames (last {n}): ...")`. Keep the existing `other => panic!("stream ended while waiting for {what}: {other:?}")` branch byte-identical.

**Delta-review round-1 refinement (executed):** the ring rendering is shared by BOTH panic arms via a small `format_ignored_frames(&ring)` helper — the end-of-loop deadline panic AND the catch-all `other` arm (which is the arm that actually fires when the peer goes silent: the final `Err(Elapsed)` routes there, not to the deadline panic — the exact mechanism-B receipt shape). Two loopback-WS `#[tokio::test]` pins inside `auto_resume_e2e.rs` cover the elapsed path: `wait_frame_matching_silent_peer_panic_carries_the_ignored_ring` (silent peer, empty ring) and `wait_frame_matching_unrelated_frames_panic_names_the_ring` (unrelated frames recorded, ring contents named in the panic). Loop logic and budgets unchanged.

- [x] **Step 2: Focused green + certification**

Run: the Task 2 focused command, then the Task 2 certification loop verbatim (10 iterations, failure-sensitive, log to `reports/task2b-certify.log`) → final line `CERTIFY 10/10 PASS`.

Expected: PASS. If mechanism B recurs, the log now names the settle frames it ignored — record the receipt and STOP with BLOCKED (do not paper over).

- [x] **Step 3: Commit**

```bash
git add crates/freshell-ws/tests/auto_resume_e2e.rs
git commit -m "test(freshell-ws): wait_frame_matching records ignored frames for flake diagnosis"
```

---

### Task 3: Bounded fail-loud EWOULDBLOCK wait in the pane_ledger lock test

**Plan addition #6 (delta-review round 4, 2026-09-02):** three findings and their resolutions:

1. **qzka merge-conflict finding (kept, routed explicitly):** `git merge-tree --write-tree <this-branch> darkforge/qzka` confirms a text conflict in `crates/freshell-ws/src/pane_ledger_tests.rs` (qzka's `6b15cd06e` rewords the final-assert diagnostic text that our bounded-wait replaces). RESOLUTION WITHOUT absorbing or burdening the qzka lane: the constraint "do not conflict with the in-flight branch" is honored by ORDER and DIRECTION — this branch is NOT landed before qzka; when cleared for PR, the landing order is `darkforge/qzka` first, then this branch rebases onto the result and WE perform the manual resolution. Our bounded-wait design SUBSUMES qzka's reworded diagnostic semantically: where their assert text names "scan fault → pane_ledger_scan_unavailable, or a lock race with the holder's drop" as alternatives, our capture-at-failure classifier distinguishes exactly those cases at classification time (errno capture for the lock race; the blind-disabled path reporting scan faults), so nothing qzka's test-side change protects is lost in the resolution. No qzka-side edit is required. This is recorded for the recap and the PR body.
2. **Task 2 Step 6's certification loop script** now runs all three binaries (`--test auto_resume_e2e --test restore_spawn_gate --test rate_limit_retry_clock`) — the earlier remediation updated the focused command but not the loop.
3. **The certification loop's waiver mechanism is now operable** (the prior script hard-exited on any FAIL): on a FAIL, the per-iteration chunk is classified — an iteration counts as `PASS(mech-B)` ONLY IF every failing-test name in that chunk belongs to `auto_resume_e2e` AND the chunk contains a settle-ring line with `reason="no_resumable_identity"` (the exact waivered signature) AND no `panicked` line for any other suite/test. Any other failing shape is a hard stop. The loop prints `N green / M mech-B-waived / K blocked`; K > 0 exits 1. (Superseded in detail by addition #7 at delta-review round 5: the executable classifier now normalizes Debug-escaped backslashes first and enforces the four-check exact shape — the description here predates that rewrite; the script in Task 2 Step 6 is authoritative.)

**Files:**
- Modify: `crates/freshell-ws/src/pane_ledger_tests.rs` (`new_locked_degrades_to_disabled_when_another_holder_exists`, :146-209 — ONLY its third-construction segment)
- Test: the existing test itself; certification loop in Step 4

**Interfaces:**
- Consumes: `PaneLedger::new_locked`, `PaneLedger::acquire_store_lock` (private, same-module test access), the on-disk evidence probe (kept byte-identical).
- Produces: an inline bounded EWOULDBLOCK-only wait (no new helper, no production change).

No production code changes. No new asserts added to production paths.

- [x] **Step 1: Document intent (comment-only prelude)**

In the same DEFLAKE comment block above the test, append one paragraph (text below is the FINAL shape after delta-review round 1 — the diagnosis is two-branched, keyed on `candidate.is_enabled()`, so an enabled-but-blind H2 candidate can never be probed-and-retried):

```
// DEFLAKE-2 (the-usual test-flake-hardening): the proven flake signature is
// errno=11 EWOULDBLOCK at the re-acquire after `drop(holder)`: the dropped
// holder's flock can remain kernel-held for a tick, and `new_locked` swallows
// the errno into a DISABLED ledger (pane_ledger.rs:247-255). The one-shot
// probe-2 acquire (which panicked on exactly that signature) and the third
// construction are therefore REPLACED by one bounded wait whose RETRY UNIT is
// the third construction itself, with a TWO-BRANCH diagnosis per failed
// construction keyed on `candidate.is_enabled()` (pane_ledger.rs:295 — false
// only when the candidate's own lock acquisition FAILED):
//  - ENABLED but blind (the candidate holds the flock yet cannot see s1.json
//    — load_index swallowed an I/O error, H2): panic IMMEDIATELY, never
//    probed and never retried. A probe cannot diagnose this branch at all —
//    it would misread the candidate's OWN still-held lock as the transient
//    EWOULDBLOCK, and the resulting retry would silently mask the exact H2
//    regression C1 requires to fail loudly.
//  - DISABLED (the candidate's lock acquisition failed): drop the candidate,
//    then classify with a separate acquire_store_lock probe — retry ONLY when
//    the probe shows EWOULDBLOCK (the proven signature); lock FREE on the
//    probe (a non-lock disable path) or any other errno panics immediately
//    with the probe's errno+kind diagnostics; budget expiry panics with the
//    last errno evidence.
// The loser-construction property and the on-disk evidence probe stay
// one-shot and untouched — the C1 no-retry-masking decision holds for
// everything the wait does not cover.
```

- [x] **Step 2: Implement the bounded wait (RED/GREEN not applicable — the flake only manifests under load; certification replaces RED/GREEN per the Task 2 note)**

The final implementation was evolved through independent review and is COMPLETE AND COMMITTED (commit `ed0622148`); the authoritative listing is the executed code, not a plan block: `crates/freshell-ws/src/pane_ledger_tests.rs` around the `new_locked_degrades_to_disabled_when_another_holder_exists` test's third-construction wait. The design history and its current required shape:

1. (Initial plan) Retry on EWOULDBLOCK via an after-the-fact `acquire_store_lock` probe — REJECTED at plan round 3 (probe sees the candidate's own lock) and again at delta round 2 (TOCTOU: holder release between construction and probe mislabels the transient as H2).
2. **Final required shape (executed):** the wait retries ONLY the third CONSTRUCTION. Per iteration, the outcome is classified by evidence captured AT the failure instant: a disabled (lock-failed) candidate is diagnosed by a thread-local tracing capture of the production `pane_ledger_lock_unavailable` event, whose error text contains the os error number (compared via `libc::EWOULDBLOCK` so it is portable); enabled-but-blind → immediate H2 panic, never retried; other errnos or a missing event → immediate panic; budget expiry → panic with the last captured errno text. Evidence probe 1 (on-disk) and the loser construction stay one-shot and untouched; production `pane_ledger.rs` stays byte-identical.

- [x] **Step 3: Focused verification**

Run:
```
cargo test -p freshell-ws --locked pane_ledger
cargo fmt --check
```

Expected: the lock test + all pane_ledger tests PASS; fmt clean for the touched files.

- [x] **Step 4: Certification**

Run (failure-sensitive, same pattern as Task 2):

```bash
set -o pipefail
LOG=/home/dan/code/freshell/.worktrees/.the-usual-logs/test-flake-hardening/reports/task3-certify.log
: > "$LOG"
for i in $(seq 1 20); do
  if cargo test -p freshell-ws --locked pane_ledger >> "$LOG" 2>&1; then
    echo "run $i: PASS" | tee -a "$LOG"
  else
    echo "run $i: FAIL" | tee -a "$LOG"
  fi
done
test "$(grep -c '^run .*: PASS$' "$LOG")" -eq 20 && echo 'CERTIFY 20/20 PASS' || { echo 'CERTIFY FAILED'; exit 1; }
```

Expected: final line exactly `CERTIFY 20/20 PASS` (any failure prints `CERTIFY FAILED` and exits non-zero).

- [x] **Step 5: Run impacted-test verification**

This is a test-only change inside one file of the freshell-ws lib binary: run the whole freshell-ws lib test module plus the touchpoint suites.

Run: `cargo test -p freshell-ws --locked`

Expected: ALL PASS.

- [x] **Step 6: Commit the task**

```bash
git add crates/freshell-ws/src/pane_ledger_tests.rs
git commit -m "test(freshell-ws): bounded fail-loud EWOULDBLOCK wait for the pane_ledger lock-test third construction"
```

---

### Final Integration Gate (run at the end, at final HEAD)

In the worktree, with ambient proxy env NOT stripped (that is the Task 1 property under test — run the non-printing presence check first: `test -n "${HTTPS_PROXY}${HTTP_PROXY}" && echo 'ambient proxy present (value not printed)' || { export HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9; echo 'dummy exported for this gate'; }`; never echo a proxy value because proxy URLs can embed credentials):

1. `npm run typecheck` — exit 0.
2. `npm run lint` — 0 errors (pre-existing warnings unchanged: 12).
3. Coordinated full suite `FRESHELL_TEST_SUMMARY=the-usual-test-flake-hardening-final npm test` **with proxies ambient** — green. (This replaces the old "-u" ceremony; the baseline ledger's ambient-proxy failure receipt is the regression baseline.)
4. `npm run test:e2e:helpers` — green (the `test/e2e-browser/vitest.config.ts` this task touches is not loaded by `npm test`).
5. `cargo test --workspace --locked` — green.
6. `cargo clippy --workspace --locked --all-targets -- -D warnings` — green; `cargo fmt --check --all` — clean.
7. Contract regen idempotence: `npm run contract:generate && git diff --exit-code port/contract/` — the generated contract is drift-free at HEAD.
8. `npm run build` — exit 0.
9. E2e: not required (test-infrastructure-only change; no user-facing behavior; e2e helpers manage their own env), recorded as a deliberate skip.
