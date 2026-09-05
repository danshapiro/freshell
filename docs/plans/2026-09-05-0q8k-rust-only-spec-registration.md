# Rust-Only E2E Spec Registration Reconciliation Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
`test/e2e-browser/playwright.config.ts`: rust-only Playwright specs listed in the `rust-chromium` project's `testMatch` but missing from `RUST_ONLY_SPECS` are also collected by the match-all default `chromium` project and run against the legacy Node server, where they fail or diverge. Reconcile the two lists so every rust-only spec runs exactly once, under `rust-chromium`, keeping the per-entry justifying-comment convention.

### Explicit constraints
- Specs on disk matching `*-rust.spec.ts` that are in `rust-chromium` `testMatch` but MISSING from `RUST_ONLY_SPECS`: `amplifier-restore-rust`, `codex-terminal-bounce-rust`, `diag03-rotation-redaction-rust`, `mcp-bridge-rust`, `mcp-qa-smoke-rust`, `opencode-terminal-restore-rust`, `remote-tab-linkage-rust`, `term28-path-shadow-rust`.
- `reconcile-handshake-rust.spec.ts` has ZERO mentions in the config — it is not registered in `rust-chromium` `testMatch` at all (silent false green there) while still running under the default `chromium` project.
- Audit all 9; add each to `RUST_ONLY_SPECS` (and register `reconcile-handshake-rust` in `rust-chromium` `testMatch`), keeping the per-entry justifying comment convention.
- Some nearby comments mention 'KNOWN DIVERGENCE' — check whether any are intentionally matrixed before moving them.

### Accepted tradeoffs and residuals
- (none stated)

**Goal:** Every rust-only e2e spec runs exactly once, under `--project=rust-chromium`; no rust-only spec is collected by the match-all `chromium` project against the legacy Node server; the invariant is pinned by a Vitest consistency test so the hole cannot silently regrow.

**Architecture:** `playwright.config.ts` selects rust-only coverage via two lists that must move in lockstep: `RUST_ONLY_SPECS` (the `chromium`/`firefox`/`webkit` projects' `testIgnore`, also imported by `playwright.gate01.config.ts`) and the `rust-chromium` project's explicit `testMatch`. The reconciliation adds the missing entries from each side, preserves the one intentional chromium double-coverage spec (`sidebar-opencode-rail`), and adds one fast Vitest unit test under `test/unit/` that fails whenever the two lists and the on-disk `*-rust.spec.ts` set drift apart.

**Tech Stack:** Playwright config (regex lists), Vitest (default client config, `jsdom` env), the repo-owned `npm run test:vitest` runner.

## Global Constraints

- E2E specs that own servers must use ephemeral ports only; NEVER touch ports 3001/3002; NEVER restart the user's self-hosted server; no broad kill patterns (`pkill -f`, `pkill node`).
- The QA oracle for this run is the Darkforge full gate: `darkforge qa` running `/home/dan/.local/share/darkforge/sources/freshell-qa.sh` (i.e. `npm run check` + cargo fmt/clippy). The work-source oracle `npm run check` is a strict subset of that gate and is satisfied by it.
- Baseline ledger exception: the full gate exits 1 at base with exactly the three `test/unit/vite-config.test.ts > getNetworkHost` failures; those are pre-existing and out of scope — accept a nonzero gate only when every failure identity matches that list.
- `FRESHELL_E2E_BACKEND` is unset; the repo default is `local`. Any Playwright execution in this plan runs locally against an explicit `FRESHELL_E2E_RUST_SERVER_BIN` override so no implicit cargo build fires inside Playwright workers.
- Config file convention: every entry in both lists carries a short justifying comment; cross-references between the two lists already exist (e.g. `// Lane C2 reconcile completion (see RUST_ONLY_SPECS entry above)`) and must keep resolving.

---

### Task 1: Failing registration-consistency test

**Files:**
- Test: `test/unit/e2e-browser-spec-registration.test.ts` (new; picked up by the default Vitest config `config/vitest/vitest.config.ts` — default include pattern `**/*.test.ts`, and `test/unit/**` is not in its exclude list)
- Modify: none
- Create: `test/unit/e2e-browser-spec-registration.test.ts`

**Interfaces:**
- Consumes: `test/e2e-browser/playwright.config.ts` default export (resolved config; `projects[].name`, `projects[].testIgnore`, `projects[].testMatch`) and named export `RUST_ONLY_SPECS` (already `export const`, config line 176); on-disk `test/e2e-browser/specs/*-rust.spec.ts` filenames.
- Produces: a Vitest suite encoding the two registration invariants; red at base, green after Task 2.

- [ ] **Step 1: Write the failing behavioral test**

```ts
// Pins the playwright.config.ts rust-only registration invariant: every
// rust-only spec runs EXACTLY ONCE, under the `rust-chromium` project.
// Default `chromium` is a match-all project (testIgnore: RUST_ONLY_SPECS);
// a spec in rust-chromium `testMatch` but missing from RUST_ONLY_SPECS is
// also collected by `chromium` and runs against the legacy Node server
// (darkforge job 0q8k / GATE-01 evidence). A spec on disk but unregistered
// collects ZERO tests under rust-chromium -- a silent false green.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import baseConfig, {
  MATRIX_SPECS,
  RUST_ONLY_SPECS,
} from '../../test/e2e-browser/playwright.config'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const specsDir = path.resolve(__dirname, '../../test/e2e-browser/specs')

type Pattern = string | RegExp
function toRegexes(patterns: Pattern | Pattern[] | undefined): RegExp[] {
  const list = Array.isArray(patterns) ? patterns : patterns ? [patterns] : []
  return list.map((p) => (p instanceof RegExp ? p : new RegExp(p)))
}

// rust-chromium `testMatch` entries that are ALSO allowed under the match-all
// `chromium` project (intentional Node/Rust double coverage), each with the
// reason this is NOT a RUST_ONLY_SPECS hole. Keyed by exact regex source.
const INTENTIONAL_CHROMIUM_DOUBLE_COVERAGE: Record<string, string> = {
  [/sidebar-opencode-rail\.spec\.ts$/.source]:
    'Node parity is part of the fix (spec doc comment + testMatch comment).',
  [/harness-01-rust-server\.spec\.ts$/.source]:
    'Server-kind-agnostic owned-fixture self-test; config comment says it only needs to run once, under rust-chromium, but it also passes under chromium (harmless duplicate).',
}

const chromium = baseConfig.projects?.find((p) => p.name === 'chromium')
const rust = baseConfig.projects?.find((p) => p.name === 'rust-chromium')

describe('playwright e2e rust-only spec registration', () => {
  it('chromium testIgnore is exactly the shared RUST_ONLY_SPECS array', () => {
    expect(chromium?.testIgnore).toBe(RUST_ONLY_SPECS)
  })

  it('every on-disk *-rust.spec.ts is registered in BOTH rust-chromium testMatch and RUST_ONLY_SPECS', () => {
    const onDisk = fs
      .readdirSync(specsDir)
      .filter((f) => f.endsWith('-rust.spec.ts'))
    const rustMatch = toRegexes(rust?.testMatch as Pattern | Pattern[] | undefined)
    const unregistered = onDisk.filter(
      (f) =>
        !rustMatch.some((re) => re.test(f)) ||
        !RUST_ONLY_SPECS.some((re) => re.test(f)),
    )
    expect(unregistered).toEqual([])
  })

  it('every rust-chromium testMatch entry is in RUST_ONLY_SPECS or allowlisted for intentional chromium double coverage', () => {
    const rustMatch = toRegexes(rust?.testMatch as Pattern | Pattern[] | undefined)
    const ignoreSources = new Set(RUST_ONLY_SPECS.map((re) => re.source))
    // MATRIX_SPECS are multi-server BY DESIGN (HARNESS-02): they run under
    // legacy-chromium, rust-chromium, AND the match-all chromium project.
    const matrixSources = new Set(MATRIX_SPECS.map((re) => re.source))
    const violators = rustMatch
      .map((re) => re.source)
      .filter((source) => !matrixSources.has(source))
      .filter(
        (source) =>
          !ignoreSources.has(source) &&
          !(source in INTENTIONAL_CHROMIUM_DOUBLE_COVERAGE),
      )
    expect(violators).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/e2e-browser-spec-registration.test.ts`

Expected: FAIL because (a) "every on-disk *-rust.spec.ts is registered…" fails listing exactly nine files — the seven kata-named testMatch-only specs (`amplifier-restore-rust`, `codex-terminal-bounce-rust`, `diag03-rotation-redaction-rust`, `mcp-bridge-rust`, `mcp-qa-smoke-rust`, `opencode-terminal-restore-rust`, `term28-path-shadow-rust`) plus the never-registered `reconcile-handshake-rust` and `sidebar-remote-status-rings-rust` (`remote-tab-linkage-rust` is already registered on both sides at base and must NOT appear), and (b) "every rust-chromium testMatch entry…" fails listing exactly the sources of `amplifier-restore-rust`, `opencode-terminal-restore-rust`, `codex-terminal-bounce-rust`, `mcp-bridge-rust`, `mcp-qa-smoke-rust`, `term28-path-shadow-rust`, `rest-tab-persistence`, and `diag03-rotation-redaction-rust`. Test 1 (identity) passes at base. Verified during load-bearing validation (execution log: the test was run at base and produced exactly this enumeration — see `<logs_dir>/reports/load-bearing-validators.md`).

- [ ] **Step 3: Add the minimal production implementation**

None — this task is the red harness; the production change is Task 2's config reconciliation.

- [ ] **Step 4: Run the focused test**

This step is satisfied by Step 2's red run; green arrives in Task 2 Step 4.

- [ ] **Step 5: Refactor while green**

No refactor: a single new test file with three pure assertions.

- [ ] **Step 6: Run impacted-test verification**

The new file is additive and touches no existing module; the impacted set is the file itself plus the gate01 collator surface that consumes the same exported arrays.

Run: `npm run test:vitest -- run test/unit/e2e-browser-spec-registration.test.ts test/e2e-browser/helpers/gate01-collate.test.ts`

Expected: the new suite FAILS for the stated reasons (gate01-collate may be skipped by the default config exclude `test/e2e-browser/**` — if the run reports zero collected tests for that path, note it and proceed; the new test must still fail for the stated reasons).

- [ ] **Step 7: Commit the task**

```bash
git add test/unit/e2e-browser-spec-registration.test.ts
git commit -m "test(e2e): pin rust-only spec registration invariant (red)"
```

### Task 2: Reconcile RUST_ONLY_SPECS and rust-chromium testMatch

**Files:**
- Modify: `test/e2e-browser/playwright.config.ts` (`RUST_ONLY_SPECS` array, currently ends at line 300; `rust-chromium` project `testMatch`, currently ends at line 545)
- Test: `test/unit/e2e-browser-spec-registration.test.ts` (unchanged; goes green)

**Interfaces:**
- Consumes: the Task 1 invariants; the existing per-entry comment convention in both lists; the spec doc comments (`amplifier-restore-rust`, `opencode-terminal-restore-rust`, `codex-terminal-bounce-rust`, `mcp-bridge-rust`, `mcp-qa-smoke-rust`, `term28-path-shadow-rust`, `diag03-rotation-redaction-rust`, `rest-tab-persistence`, `reconcile-handshake-rust`, `sidebar-remote-status-rings-rust` — all verified "rust-only by design" during planning except `harness-01-rust-server`, which is allowlisted as a harmless server-kind-agnostic chromium duplicate, and `sidebar-opencode-rail`, which is intentionally matrixed).
- Produces: a config whose two lists satisfy the invariants; `playwright.gate01.config.ts` inherits the change automatically (it imports `RUST_ONLY_SPECS`).

- [ ] **Step 1: Append the rust-only entries to RUST_ONLY_SPECS**

Append immediately before the closing `]` (after the `reconnect-revive-rust` entry, currently line 299), preserving the existing comment style:

```ts
  // AMPLIFIER-RESTORE (docs/plans/2026-07-18-amplifier-restore-spec.md):
  // KNOWN DIVERGENCE -- legacy predates upstream #514 and has NO amplifier
  // provider registered; a genuinely rust-only feature (see the spec's doc
  // comment and the rust-chromium testMatch entry).
  /amplifier-restore-rust\.spec\.ts$/,
  // Opencode terminal restore: KNOWN DIVERGENCE -- legacy has no opencode
  // terminal<->session association (see the spec's doc comment).
  /opencode-terminal-restore-rust\.spec\.ts$/,
  // CODEX-BOUNCE (2026-07-22 incident regression): the resume-derivation bug
  // was in the Rust WS create path; the legacy anchor was correct -- rust-only
  // (see the rust-chromium testMatch entry and spec doc comment).
  /codex-terminal-bounce-rust\.spec\.ts$/,
  // MCP bridge pin: the unmodified legacy MCP stdio binary against an owned,
  // ephemeral Rust server; rust-only (see the rust-chromium testMatch entry).
  /mcp-bridge-rust\.spec\.ts$/,
  // MCP QA smoke: the full mode-matrix payoff of the MCP QA lever; rust-only
  // (see the rust-chromium testMatch entry + spec doc comment).
  /mcp-qa-smoke-rust\.spec\.ts$/,
  // TERM-28: Rust portable-pty PATH-only bare-command resolution fix; legacy
  // node-pty is unaffected (see the rust-chromium testMatch entry).
  /term28-path-shadow-rust\.spec\.ts$/,
  // REST-TAB-PERSISTENCE (client tab-poisoning incident evidence): the
  // `amplifier` mode trigger has no legacy provider -- the same KNOWN
  // DIVERGENCE as amplifier-restore-rust above (see the rust-chromium
  // testMatch entry).
  /rest-tab-persistence\.spec\.ts$/,
  // DIAG-03 -- rotation limits are a deliberate Rust-only hardening feature;
  // the frozen legacy server has no equivalent (see the spec's doc comment).
  /diag03-rotation-redaction-rust\.spec\.ts$/,
  // RECONCILE-HANDSHAKE (PW-RUST, design §9.2): raw-WS synthetic-client proof
  // of the reconciliation-on-connect handshake against the REAL Rust server.
  // Was registered in NEITHER list (zero tests collected under rust-chromium;
  // wrongly collected by the match-all chromium project).
  /reconcile-handshake-rust\.spec\.ts$/,
  // Remote status rings Task 5 e2e pin (docs/plans/2026-08-10-remote-status-rings.md):
  // owns a RustServer (ephemeral port) + raw-WS second-device tabs.sync.push.
  // Was registered in NEITHER list. See the spec's doc comment.
  /sidebar-remote-status-rings-rust\.spec\.ts$/,
```

(`remote-tab-linkage-rust` is already present in `RUST_ONLY_SPECS` at base — no edit needed for it; its testMatch entry already exists too.)

- [ ] **Step 2: Register the two never-registered specs in rust-chromium testMatch**

Append after the `reconnect-revive-rust` entry (currently lines 542-544), before the testMatch closing `]`:

```ts
        // Reconcile handshake (PW-RUST design §9.2): synthetic raw-WS client
        // proof of the reconciliation-on-connect handshake against the REAL
        // Rust server (see the RUST_ONLY_SPECS entry + spec doc comment).
        /reconcile-handshake-rust\.spec\.ts$/,
        // Remote status rings Task 5 e2e pin (see the RUST_ONLY_SPECS entry
        // + spec doc comment; owns its RustServer on an ephemeral port).
        /sidebar-remote-status-rings-rust\.spec\.ts$/,
```

- [ ] **Step 3: Run the focused test**

Run: `npm run test:vitest -- run test/unit/e2e-browser-spec-registration.test.ts`

Expected: PASS (all three assertions green).

- [ ] **Step 4: Refactor while green**

No refactor needed: the edit appends to two existing regex lists using the file's established comment convention; no new abstraction, and MATRIX_SPECS/`sidebar-opencode-rail`/`harness-01-rust-server` dispositions are intentionally unchanged.

- [ ] **Step 5: Run impacted-test verification**

The config edit changes e2e spec SELECTION only; no Vitest-covered module is impacted beyond the Task 1 suite. The impacted set is therefore the consistency suite plus a typecheck of the touched config file (TS), plus the Playwright collection controls below.

Run: `npm run test:vitest -- run test/unit/e2e-browser-spec-registration.test.ts && npm run typecheck`

Expected: suite PASS; typecheck clean.

- [ ] **Step 6: Playwright collection controls (no servers booted; `--list` never runs globalSetup)**

Run (from the worktree root):

```bash
# Negative control: the reconciled specs now collect ZERO tests under chromium
npx playwright test --config test/e2e-browser/playwright.config.ts --project=chromium --list \
  test/e2e-browser/specs/amplifier-restore-rust.spec.ts \
  test/e2e-browser/specs/opencode-terminal-restore-rust.spec.ts \
  test/e2e-browser/specs/codex-terminal-bounce-rust.spec.ts \
  test/e2e-browser/specs/mcp-bridge-rust.spec.ts \
  test/e2e-browser/specs/mcp-qa-smoke-rust.spec.ts \
  test/e2e-browser/specs/term28-path-shadow-rust.spec.ts \
  test/e2e-browser/specs/rest-tab-persistence.spec.ts \
  test/e2e-browser/specs/diag03-rotation-redaction-rust.spec.ts \
  test/e2e-browser/specs/reconcile-handshake-rust.spec.ts \
  test/e2e-browser/specs/sidebar-remote-status-rings-rust.spec.ts
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium --list \
  test/e2e-browser/specs/reconcile-handshake-rust.spec.ts \
  test/e2e-browser/specs/sidebar-remote-status-rings-rust.spec.ts
# Positive control: intentional double coverage is untouched
npx playwright test --config test/e2e-browser/playwright.config.ts --project=chromium --list \
  test/e2e-browser/specs/sidebar-opencode-rail.spec.ts test/e2e-browser/specs/harness-01-rust-server.spec.ts
```

Expected: the `--project=chromium` run over the ten reconciled specs reports "Error: No tests found."/"Total: 0 tests in 0 files" (this message shape is the pass condition — observed verbatim at base for an ignored spec, see load-bearing validator log); the `--project=rust-chromium` run over the two newly registered specs lists a NON-ZERO number of tests; the chromium positive-control run lists a non-zero number of tests for `sidebar-opencode-rail` and `harness-01-rust-server`.

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/playwright.config.ts
git commit -m "fix(e2e): register rust-only specs in RUST_ONLY_SPECS and rust-chromium testMatch"
```

### Task 3: Prove the two never-before-run specs pass under rust-chromium

At base, `reconcile-handshake-rust` and `sidebar-remote-status-rings-rust` collected ZERO tests under `rust-chromium`, so they have NO green evidence in their intended project. Registering them without a passing run would trade a silent false green for a real gate red the first time they do run. Execute each once, locally.

**Files:**
- Modify: none expected (contingency: if a spec reveals a product-or-fixture bug, fix forward in the narrowest change and record it in this task; if it cannot be repaired safely, stop and report rather than deregistering the spec to hide the red)
- Test: `test/e2e-browser/specs/reconcile-handshake-rust.spec.ts`, `test/e2e-browser/specs/sidebar-remote-status-rings-rust.spec.ts` (execution only)

**Interfaces:**
- Consumes: the Task 2 registration; `test/e2e-browser/helpers/rust-server.ts` (`RustServer`, `ensureRustServerBuilt`, `FRESHELL_E2E_RUST_SERVER_BIN` fail-closed override seam).
- Produces: evidence that both specs pass under `--project=rust-chromium` at HEAD.

- [ ] **Step 1: Prebuild the Rust server binary**

Run: `cargo build --release -p freshell-server`

Expected: build succeeds; `target/release/freshell-server` exists.

- [ ] **Step 2: Run reconcile-handshake-rust under rust-chromium**

Run: `FRESHELL_E2E_RUST_SERVER_BIN="$PWD/target/release/freshell-server" npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium test/e2e-browser/specs/reconcile-handshake-rust.spec.ts`

Expected: PASS (all tests in the spec green). Uses ephemeral ports only; default local backend.

- [ ] **Step 3: Run sidebar-remote-status-rings-rust under rust-chromium**

Run: `FRESHELL_E2E_RUST_SERVER_BIN="$PWD/target/release/freshell-server" npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium test/e2e-browser/specs/sidebar-remote-status-rings-rust.spec.ts`

Expected: PASS (includes the ≤45s liveness leg; plan for up to several minutes).

- [ ] **Step 4: Refactor while green**

No refactor: execution-only task. If either spec required a repair in the contingency, that repair is committed with this task and the consistency suite is re-run.

- [ ] **Step 5: Run impacted-test verification**

Re-run the consistency suite to confirm the final config state is green after any contingency change:

Run: `npm run test:vitest -- run test/unit/e2e-browser-spec-registration.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the task**

```bash
git add -A
git commit -m "test(e2e): prove newly registered rust-only specs pass under rust-chromium"
```

(If no contingency changes were needed, this commit is empty of code — skip it and note "no changes" in the progress ledger; do not commit an empty commit.)

---

## Final gate (after all tasks, per the Darkforge run contract)

Run `darkforge qa` (full gate: `npm run check` + cargo fmt/clippy) at the prospective landing commit. Accepted outcomes: exit 0, or exit nonzero whose every parsed failure identity is exactly the baseline set (`test/unit/vite-config.test.ts > getNetworkHost` ×3). The work-source oracle `npm run check` is the first half of that same gate, so it is inherently exercised; no separate oracle run is required.
