# Visible-First Performance Audit Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Build a repeatable, production-mode performance audit for the current Freshell app that runs six fixed scenarios in Chromium, captures exactly one `desktop_local` sample and one `mobile_restricted` sample per scenario, and writes one schema-validated JSON artifact to `artifacts/perf/visible-first-audit.json`.

**Architecture:** Add a dedicated audit pipeline under `test/e2e-browser/perf/` instead of stretching the normal Playwright test runner into a perf harness. Reuse the existing isolated `TestServer`, use Chromium CDP as the source of truth for HTTP and WebSocket transport, add only the minimum runtime-gated app milestones needed to define visible readiness, parse the existing server JSONL logs for server-side work, and merge everything into one strict artifact contract plus a small compare tool.

**Tech Stack:** TypeScript, Node.js, Playwright Chromium library API, existing `test/e2e-browser/helpers/TestServer`, Zod, Vitest, existing client/server perf loggers, pino JSONL logs, Chromium CDP `Network` domain.

---

## Strategy Gate

The accepted direction is correct, but the prior plan was not excellent enough to execute unchanged.

The right problem is not “add perf tests.” The right problem is “produce one trustworthy characterization artifact for the current transport so the later visible-first transport work can be judged mechanically against the same scenarios.” That yields these non-negotiable decisions:

1. The canonical deliverable is the JSON artifact. Traces, screenshots, and raw logs are optional debugging side effects, not the product.
2. Transport truth comes from Chromium CDP, not app-side counters. HTTP timings/bytes and WebSocket frame counts/bytes must be captured outside the app.
3. Visible readiness comes from explicit app milestones because transport alone cannot safely infer “user can use the focused surface now.”
4. Server-side work comes from existing JSONL logs and existing perf logging. The audit must not invent a second server telemetry channel.
5. Every measured sample is cold and isolated: fresh `TestServer`, fresh browser context, blocked service workers, disabled HTTP cache, empty storage unless the scenario explicitly seeds browser local state.
6. The user accepted a heavy breadth but only two measured samples per scenario: one `desktop_local` and one `mobile_restricted`. The artifact must preserve raw per-sample values; it must not invent medians or percentiles for scenario/profile summaries.
7. Offscreen work must be computed mechanically, not by later interpretation. Each scenario must declare which normalized API routes and WebSocket message types are allowed before focused readiness; everything else observed before readiness counts as offscreen work.
8. The audit must measure application transport, not static asset loading noise. Only `/api/**` requests except known harness-only routes and only the app WebSocket count toward the transport summaries.
9. Browser-local persisted layout state and server-side fixture data are different concerns. Server HOME seeding must not be used for tabs/panes, which live in browser storage.

This plan lands the requested end state directly:

1. `npm run perf:audit:visible-first` writes exactly one JSON artifact to `artifacts/perf/visible-first-audit.json` unless an explicit alternate output path is supplied.
2. The default run always includes the full six-scenario, two-profile matrix.
3. The compare command reads two artifacts and emits one machine-readable diff without changing the audit contract.

## Codebase Findings

1. [test/e2e-browser/helpers/test-server.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/test/e2e-browser/helpers/test-server.ts) is the correct isolation seam, but it currently deletes the temp HOME on stop and does not expose the log directory. The audit runner cannot parse logs without extending it.
2. [src/lib/test-harness.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/src/lib/test-harness.ts) already exposes Redux state, WebSocket readiness, and terminal buffers in production builds behind `?e2e=1`. That is the correct seam for audit-only readiness snapshots.
3. [src/lib/perf-logger.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/src/lib/perf-logger.ts) already emits browser perf events and terminal input-to-output latency, but it only logs to the console today. The audit needs a narrow sink API, not a new logging path.
4. [src/lib/client-logger.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/src/lib/client-logger.ts) intentionally filters `perf: true` console payloads before posting to `/api/logs/client`. That behavior is correct and must remain unchanged.
5. [server/request-logger.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/server/request-logger.ts), [server/perf-logger.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/server/perf-logger.ts), and [server/logger.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/server/logger.ts) already emit structured JSONL that the audit can parse.
6. [src/main.tsx](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/src/main.tsx) registers the service worker unconditionally in production mode. The audit runner must explicitly block service workers at the browser-context level so cold samples stay cold without adding app-only behavior.
7. Tabs and panes persist in browser `localStorage`, not in the temp HOME. The exact keys are in [src/store/storage-keys.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/src/store/storage-keys.ts) and the schema versions are in [src/store/persistedState.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/src/store/persistedState.ts). The previous plan was wrong to treat offscreen-tab state as server fixture data.
8. [test/e2e-browser/vitest.config.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/test/e2e-browser/vitest.config.ts) only includes `helpers/**/*.test.ts` today. Perf smoke coverage will not run until that config includes `perf/**/*.test.ts`.

## Fixed Audit Matrix

The IDs and scenario definitions below are part of the artifact contract. Keep them stable.

### Profiles

1. `desktop_local`
   - Browser: Chromium
   - Viewport: `1440x900`
   - Device emulation: none
   - Network throttling: none
   - CPU throttling: none

2. `mobile_restricted`
   - Browser: Chromium
   - Device emulation: Playwright `devices['iPhone 14']`
   - Network throttling: `download=1_600_000 bps`, `upload=750_000 bps`, `latency=150 ms`
   - CPU throttling: none

### Deterministic Server Fixture Data

Seed exactly one reusable server fixture set for all measured scenarios:

1. Session corpus:
   - 12 projects
   - 180 session summaries total
   - 36 sessions whose titles contain the stable search token `alpha`
   - stable timestamps and deterministic sort order
2. Long agent-chat history:
   - 1 dedicated session
   - 240 turns total
   - 30 most recent turns dense enough to render immediately
   - at least 80 older turns with longer bodies so “visible recent turns first” is measurable
3. Terminal replay script data:
   - write one deterministic Node script into the temp HOME, for example `audit-terminal-backlog.js`
   - the script must emit 1,200 lines with stable prefixes and a short delayed tail so reconnect timing is measurable
4. Auth-required scenario:
   - no special server seed beyond normal settings

### Deterministic Browser Storage Seed

Seed browser storage separately from server HOME for scenarios that need persisted client layout:

1. Use `page.addInitScript()` before navigation.
2. Write `freshell_version=3`.
3. Write [src/store/storage-keys.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/src/store/storage-keys.ts) keys with current schema-compatible payloads:
   - `freshell.tabs.v2`
   - `freshell.panes.v2`
4. Do not seed unrelated keys.
5. The offscreen-tab scenario must start with:
   - one active lightweight terminal tab
   - one background agent-chat tab backed by the long-history session
   - one background terminal tab if needed for tab-selection coverage
   - sidebar closed by default

### Scenario Definitions

Each scenario owns:

1. its stable `id`
2. how the server fixture or browser storage is prepared
3. how the page is navigated
4. which milestone is the focused-ready boundary
5. which normalized API route IDs and WebSocket message types are allowed before that boundary

#### `auth-required-cold-boot`

1. Navigation:
   - `/?e2e=1&perfAudit=1`
   - no auth token
2. Focused-ready milestone:
   - `app.auth_required_visible`
3. Allowed API route IDs before ready:
   - `/api/settings`
4. Allowed WebSocket message types before ready:
   - none

#### `terminal-cold-boot`

1. Setup:
   - normal auth token
   - default active tab resolves to a terminal pane
2. Navigation:
   - `/?token=<token>&e2e=1&perfAudit=1`
3. Focused-ready milestone:
   - `terminal.first_output`
4. Allowed API route IDs before ready:
   - `/api/settings`
   - `/api/terminals`
5. Allowed WebSocket message types before ready:
   - `hello`
   - `ready`
   - `terminal.create`
   - `terminal.created`
   - `terminal.output`
   - `terminal.list`
   - `terminal.meta.list`

#### `agent-chat-cold-boot`

1. Setup:
   - browser storage seeds the active tab to the dedicated long-history agent session
2. Navigation:
   - `/?token=<token>&e2e=1&perfAudit=1`
3. Focused-ready milestone:
   - `agent_chat.surface_visible`
4. Allowed API route IDs before ready:
   - `/api/settings`
   - `/api/sessions`
   - `/api/sessions/:sessionId`
5. Allowed WebSocket message types before ready:
   - `hello`
   - `ready`
   - `sdk.history`
   - `sessions.updated`
   - `sessions.patch`

#### `sidebar-search-large-corpus`

1. Setup:
   - start from a lightweight terminal tab with the sidebar hidden
2. Navigation:
   - `/?token=<token>&e2e=1&perfAudit=1`
3. Interaction:
   - open the sidebar
   - type the stable query `alpha`
4. Focused-ready milestone:
   - `sidebar.search_results_visible`
5. Allowed API route IDs before ready:
   - `/api/settings`
   - `/api/sessions`
   - `/api/sessions/search`
6. Allowed WebSocket message types before ready:
   - `hello`
   - `ready`
   - `sessions.updated`
   - `sessions.patch`

#### `terminal-reconnect-backlog`

1. Setup:
   - create a real terminal
   - run the deterministic Node backlog script through that terminal
   - force disconnect after the backlog is established
2. Navigation:
   - `/?token=<token>&e2e=1&perfAudit=1`
3. Focused-ready milestone:
   - `terminal.first_output`
4. Allowed API route IDs before ready:
   - `/api/settings`
   - `/api/terminals`
5. Allowed WebSocket message types before ready:
   - `hello`
   - `ready`
   - `terminal.attach`
   - `terminal.snapshot`
   - `terminal.output`
   - `terminal.list`
   - `terminal.meta.list`

#### `offscreen-tab-selection`

1. Setup:
   - seed browser storage with one lightweight active tab and one heavy offscreen agent-chat tab
2. Navigation:
   - `/?token=<token>&e2e=1&perfAudit=1`
3. Interaction:
   - after initial paint, select the heavy background tab
4. Focused-ready milestone:
   - `tab.selected_surface_visible`
5. Allowed API route IDs before ready:
   - `/api/settings`
6. Allowed WebSocket message types before ready:
   - `hello`
   - `ready`

### Transport Normalization Rules

The current plan must not leave route matching ambiguous. Implement these rules once and reuse them everywhere:

1. Only count requests whose pathname starts with `/api/`.
2. Ignore these pathnames entirely for derived transport metrics:
   - `/api/health`
   - `/api/logs/client`
3. Strip origin and query string before classification.
4. Normalize dynamic segments into stable route IDs:
   - `/api/sessions/<id>` -> `/api/sessions/:sessionId`
   - `/api/terminals/<id>` -> `/api/terminals/:terminalId`
5. Leave static route IDs untouched:
   - `/api/settings`
   - `/api/sessions`
   - `/api/sessions/search`
   - `/api/terminals`
6. Bucket WebSocket frames by top-level JSON `type`; non-JSON or missing-`type` frames become `unknown`.
7. “Offscreen before ready” means:
   - request/frame timestamp is `<= focusedReadyTimestamp`
   - normalized route ID or WS type is not in that scenario’s allowlist

## Artifact Contract

Implement the contract once in `test/e2e-browser/perf/audit-contract.ts` and make the runner, smoke test, and compare tool all use it.

### Top-level required fields

1. `schemaVersion: 1`
2. `generatedAt`
3. `git: { commit, branch, dirty }`
4. `build: { nodeVersion, browserVersion, command }`
5. `profiles`
6. `scenarios`

### Per-scenario required fields

1. `id`
2. `description`
3. `focusedReadyMilestone`
4. `samples`
5. `summaryByProfile`

Each scenario must contain exactly two samples in stable order:

1. `desktop_local`
2. `mobile_restricted`

### Per-sample required fields

1. `profileId`
2. `status`
3. `startedAt`
4. `finishedAt`
5. `durationMs`
6. `browser`
7. `transport`
8. `server`
9. `derived`
10. `errors`

### Authoritative sample subtrees

These come directly from collectors and must not be recomputed differently elsewhere:

1. `browser`
   - milestone timestamps
   - captured perf events
   - terminal latency samples
2. `transport`
   - raw HTTP observations from CDP
   - raw WebSocket frames from CDP
   - normalized summaries by route/type
3. `server`
   - parsed `http_request` entries
   - parsed perf events
   - parsed `perf_system` samples
   - parser diagnostics

### Derived sample metrics

Derived metrics must be computed from the authoritative data and the scenario definition:

1. `focusedReadyMs`
2. `wsReadyMs` when present
3. `terminalInputToFirstOutputMs` when present
4. `httpRequestsBeforeReady`
5. `httpBytesBeforeReady`
6. `wsFramesBeforeReady`
7. `wsBytesBeforeReady`
8. `offscreenHttpRequestsBeforeReady`
9. `offscreenHttpBytesBeforeReady`
10. `offscreenWsFramesBeforeReady`
11. `offscreenWsBytesBeforeReady`

### Failure policy

The audit fails only when the artifact becomes untrustworthy:

1. the scenario crashes or times out
2. the focused-ready milestone is missing
3. CDP transport capture is missing
4. server log capture is missing
5. the final JSON fails schema validation

The audit does not fail on latency budgets yet.

## Task 1: Lock the Stable IDs and Artifact Schema

**Files:**
- Create: `test/e2e-browser/perf/audit-contract.ts`
- Create: `test/unit/lib/visible-first-audit-contract.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import {
  AUDIT_PROFILE_IDS,
  AUDIT_SCENARIO_IDS,
  VisibleFirstAuditSchema,
} from '@test/e2e-browser/perf/audit-contract'

describe('VisibleFirstAuditSchema', () => {
  it('accepts a full artifact with six scenarios and exactly two samples per scenario', () => {
    const artifact = buildAuditFixture()
    expect(AUDIT_PROFILE_IDS).toEqual(['desktop_local', 'mobile_restricted'])
    expect(AUDIT_SCENARIO_IDS).toHaveLength(6)
    expect(VisibleFirstAuditSchema.parse(artifact).scenarios).toHaveLength(6)
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-contract.test.ts
```

Expected: FAIL with a module-not-found error for `audit-contract.ts`.

**Step 3: Write the minimal implementation**

Create `test/e2e-browser/perf/audit-contract.ts` with:

1. `AUDIT_PROFILE_IDS`
2. `AUDIT_SCENARIO_IDS`
3. strict Zod schemas for the top-level artifact, scenario objects, and sample objects
4. exported TypeScript types inferred from the schema

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-contract.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/audit-contract.ts test/unit/lib/visible-first-audit-contract.test.ts
git commit -m "test: define visible-first audit contract"
```

## Task 2: Make Route Normalization and Offscreen Classification Explicit

**Files:**
- Create: `test/e2e-browser/perf/derive-visible-first-metrics.ts`
- Create: `test/unit/lib/visible-first-audit-derived-metrics.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import {
  deriveVisibleFirstMetrics,
  normalizeAuditRouteId,
} from '@test/e2e-browser/perf/derive-visible-first-metrics'

describe('deriveVisibleFirstMetrics', () => {
  it('normalizes dynamic routes and counts pre-ready offscreen work by scenario allowlist', () => {
    expect(normalizeAuditRouteId('http://localhost:3000/api/sessions/abc123?token=secret')).toBe(
      '/api/sessions/:sessionId',
    )

    const result = deriveVisibleFirstMetrics(buildSampleFixture())
    expect(result.offscreenHttpRequestsBeforeReady).toBe(1)
    expect(result.offscreenWsFramesBeforeReady).toBe(2)
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-derived-metrics.test.ts
```

Expected: FAIL with a module-not-found error for `derive-visible-first-metrics.ts`.

**Step 3: Write the minimal implementation**

Create `derive-visible-first-metrics.ts` as pure functions that:

1. normalize API route IDs
2. ignore `/api/health` and `/api/logs/client`
3. bucket WebSocket frames by `type`
4. use the scenario focused-ready milestone as the readiness cutoff
5. return only derived numeric data

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-derived-metrics.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/derive-visible-first-metrics.ts test/unit/lib/visible-first-audit-derived-metrics.test.ts
git commit -m "test: define visible-first derived metrics"
```

## Task 3: Keep Aggregation and Comparison Pure

**Files:**
- Create: `test/e2e-browser/perf/audit-aggregator.ts`
- Create: `test/e2e-browser/perf/compare-visible-first-audits.ts`
- Create: `test/unit/lib/visible-first-audit-aggregator.test.ts`
- Create: `test/unit/lib/visible-first-audit-compare.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { summarizeScenarioSamples } from '@test/e2e-browser/perf/audit-aggregator'
import { compareVisibleFirstAudits } from '@test/e2e-browser/perf/compare-visible-first-audits'

describe('audit aggregation', () => {
  it('produces stable summaryByProfile entries without inventing medians', () => {
    const summary = summarizeScenarioSamples(buildScenarioFixture())
    expect(summary.desktop_local.focusedReadyMs).toBeTypeOf('number')
  })

  it('diffs two schema-valid artifacts by scenario and profile', () => {
    const diff = compareVisibleFirstAudits(baseAuditFixture(), candidateAuditFixture())
    expect(diff.scenarios[0]?.profiles[0]?.profileId).toBe('desktop_local')
  })
})
```

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-aggregator.test.ts test/unit/lib/visible-first-audit-compare.test.ts
```

Expected: FAIL with module-not-found errors.

**Step 3: Write the minimal implementation**

Create pure modules that:

1. summarize one sample into compare-friendly fields
2. summarize one scenario into `desktop_local` and `mobile_restricted`
3. compare two already-validated artifacts by scenario and profile
4. never import Playwright, DOM, or filesystem code

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-aggregator.test.ts test/unit/lib/visible-first-audit-compare.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/audit-aggregator.ts test/e2e-browser/perf/compare-visible-first-audits.ts test/unit/lib/visible-first-audit-aggregator.test.ts test/unit/lib/visible-first-audit-compare.test.ts
git commit -m "test: add visible-first audit aggregation and diff helpers"
```

## Task 4: Extend TestServer for Audit Retention

**Files:**
- Modify: `test/e2e-browser/helpers/test-server.ts`
- Modify: `test/e2e-browser/helpers/test-server.test.ts`

**Step 1: Write the failing test**

```ts
it('exposes home and logs directories and can preserve them for audit collection', async () => {
  const server = new TestServer({
    preserveHomeOnStop: true,
    setupHome: async (homeDir) => {
      await fs.promises.mkdir(path.join(homeDir, '.claude', 'projects', 'perf'), { recursive: true })
    },
  })

  const info = await server.start()
  expect(info.homeDir).toContain('freshell-e2e-')
  expect(info.logsDir).toContain(path.join('.freshell', 'logs'))
  await server.stop()
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:e2e:helpers -- test/e2e-browser/helpers/test-server.test.ts
```

Expected: FAIL because `setupHome`, `preserveHomeOnStop`, `homeDir`, and `logsDir` do not exist.

**Step 3: Write the minimal implementation**

Extend `TestServer` with:

1. `setupHome?: (homeDir: string) => Promise<void>`
2. `preserveHomeOnStop?: boolean`
3. `homeDir` and `logsDir` in `TestServerInfo`

Keep default cleanup behavior unchanged for non-audit callers.

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:e2e:helpers -- test/e2e-browser/helpers/test-server.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/helpers/test-server.ts test/e2e-browser/helpers/test-server.test.ts
git commit -m "test: extend test server for audit retention"
```

## Task 5: Seed Deterministic Server Fixture Data

**Files:**
- Create: `test/e2e-browser/perf/seed-server-home.ts`
- Create: `test/unit/lib/visible-first-audit-seed-server-home.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { seedVisibleFirstAuditServerHome } from '@test/e2e-browser/perf/seed-server-home'

describe('seedVisibleFirstAuditServerHome', () => {
  it('writes the approved session corpus, long-history session, and backlog script', async () => {
    const result = await seedVisibleFirstAuditServerHome(tmpHome)
    expect(result.sessionCount).toBe(180)
    expect(result.alphaSessionCount).toBe(36)
    expect(result.longHistoryTurnCount).toBe(240)
    expect(result.backlogScriptPath).toContain('audit-terminal-backlog')
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-seed-server-home.test.ts
```

Expected: FAIL with a module-not-found error for `seed-server-home.ts`.

**Step 3: Write the minimal implementation**

Create `seed-server-home.ts` that deterministically writes:

1. the 180-session corpus
2. the 240-turn long-history session
3. one Node backlog script with stable line output
4. any required config files using real app formats

Do not attempt to store tab or pane state here.

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-seed-server-home.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/seed-server-home.ts test/unit/lib/visible-first-audit-seed-server-home.test.ts
git commit -m "test: add deterministic audit server fixtures"
```

## Task 6: Seed Deterministic Browser Storage for Layout-Based Scenarios

**Files:**
- Create: `test/e2e-browser/perf/seed-browser-storage.ts`
- Create: `test/unit/lib/visible-first-audit-seed-browser-storage.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { buildOffscreenTabBrowserStorageSeed } from '@test/e2e-browser/perf/seed-browser-storage'

describe('buildOffscreenTabBrowserStorageSeed', () => {
  it('returns schema-compatible localStorage payloads for tabs and panes', () => {
    const seed = buildOffscreenTabBrowserStorageSeed()
    expect(seed['freshell_version']).toBe('3')
    expect(seed['freshell.tabs.v2']).toContain('tabs')
    expect(seed['freshell.panes.v2']).toContain('layouts')
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-seed-browser-storage.test.ts
```

Expected: FAIL with a module-not-found error for `seed-browser-storage.ts`.

**Step 3: Write the minimal implementation**

Create `seed-browser-storage.ts` with helpers that:

1. build current-schema tab and pane payloads
2. return a plain key-value map for `page.addInitScript()`
3. cover the agent-chat active-tab and offscreen-tab-selection scenarios

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-seed-browser-storage.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/seed-browser-storage.ts test/unit/lib/visible-first-audit-seed-browser-storage.test.ts
git commit -m "test: add deterministic audit browser storage seeds"
```

## Task 7: Freeze the Approved Profiles and Scenario Matrix

**Files:**
- Create: `test/e2e-browser/perf/profiles.ts`
- Create: `test/e2e-browser/perf/scenarios.ts`
- Create: `test/unit/lib/visible-first-audit-profiles.test.ts`
- Create: `test/unit/lib/visible-first-audit-scenarios.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { AUDIT_PROFILES } from '@test/e2e-browser/perf/profiles'
import { AUDIT_SCENARIOS } from '@test/e2e-browser/perf/scenarios'

describe('audit matrix', () => {
  it('defines exactly the approved profiles', () => {
    expect(AUDIT_PROFILES.map((profile) => profile.id)).toEqual([
      'desktop_local',
      'mobile_restricted',
    ])
  })

  it('defines the six scenarios in stable order with readiness and allowlists', () => {
    expect(AUDIT_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      'auth-required-cold-boot',
      'terminal-cold-boot',
      'agent-chat-cold-boot',
      'sidebar-search-large-corpus',
      'terminal-reconnect-backlog',
      'offscreen-tab-selection',
    ])
  })
})
```

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-profiles.test.ts test/unit/lib/visible-first-audit-scenarios.test.ts
```

Expected: FAIL with module-not-found errors.

**Step 3: Write the minimal implementation**

Create immutable definitions for:

1. both profiles, including the exact mobile bandwidth settings
2. all six scenarios, including:
   - navigation URL builder
   - optional server-home seeding
   - optional browser-storage seeding
   - focused-ready milestone name
   - normalized API and WS allowlists

Do not let scenario files own browser launch, artifact writing, or log parsing.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-profiles.test.ts test/unit/lib/visible-first-audit-scenarios.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/profiles.ts test/e2e-browser/perf/scenarios.ts test/unit/lib/visible-first-audit-profiles.test.ts test/unit/lib/visible-first-audit-scenarios.test.ts
git commit -m "test: define visible-first audit matrix"
```

## Task 8: Create the Browser Audit Bridge

**Files:**
- Create: `src/lib/perf-audit-bridge.ts`
- Create: `test/unit/client/lib/perf-audit-bridge.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { createPerfAuditBridge } from '@/lib/perf-audit-bridge'

describe('createPerfAuditBridge', () => {
  it('records milestones and returns serializable snapshots', () => {
    const audit = createPerfAuditBridge()
    audit.mark('app.bootstrap_ready', { view: 'terminal' })
    expect(audit.snapshot().milestones['app.bootstrap_ready']).toBeTypeOf('number')
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/client/lib/perf-audit-bridge.test.ts
```

Expected: FAIL because the bridge does not exist.

**Step 3: Write the minimal implementation**

Create `src/lib/perf-audit-bridge.ts` as an in-memory collector with:

1. milestone recording
2. metadata recording
3. client perf event collection
4. terminal latency sample collection
5. `snapshot()` returning serializable data only

Do not couple it to `window` directly.

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/client/lib/perf-audit-bridge.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/perf-audit-bridge.ts test/unit/client/lib/perf-audit-bridge.test.ts
git commit -m "test: add browser perf audit bridge"
```

## Task 9: Feed Existing Client Perf Signals into the Bridge

**Files:**
- Modify: `src/lib/perf-logger.ts`
- Modify: `test/unit/client/lib/perf-logger.test.ts`

**Step 1: Write the failing test**

```ts
it('forwards perf entries to an installed audit sink without changing console behavior', async () => {
  const { installClientPerfAuditSink, logClientPerf } = await loadPerfLoggerModule()
  const seen: unknown[] = []
  installClientPerfAuditSink((entry) => seen.push(entry))
  logClientPerf('perf.paint', { name: 'first-contentful-paint' })
  expect(seen).toHaveLength(1)
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/client/lib/perf-logger.test.ts
```

Expected: FAIL because the audit sink API does not exist.

**Step 3: Write the minimal implementation**

Add a narrow sink API to `src/lib/perf-logger.ts`:

1. `installClientPerfAuditSink`
2. forwarding from `logClientPerf`
3. forwarding from `markTerminalOutputSeen`

Keep console logging unchanged and do not route perf entries through `/api/logs/client`.

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/client/lib/perf-logger.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/perf-logger.ts test/unit/client/lib/perf-logger.test.ts
git commit -m "test: route client perf signals into audit sink"
```

## Task 10: Expose Audit Snapshots Through the Existing Test Harness

**Files:**
- Modify: `src/lib/test-harness.ts`
- Modify: `test/e2e-browser/helpers/test-harness.ts`
- Create: `test/unit/client/lib/test-harness.perf-audit.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'

describe('test harness perf audit helpers', () => {
  it('exposes a perf audit snapshot when installed', async () => {
    const harness = installHarnessForTest()
    expect(harness.getPerfAuditSnapshot().milestones).toBeDefined()
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/client/lib/test-harness.perf-audit.test.ts
```

Expected: FAIL because the harness does not expose audit snapshots.

**Step 3: Write the minimal implementation**

Extend the harness layers with:

1. `getPerfAuditSnapshot()`
2. `waitForAuditMilestone(name, timeoutMs?)`

Do not create a second browser-only bridge API when the existing harness can carry this.

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/client/lib/test-harness.perf-audit.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/test-harness.ts test/e2e-browser/helpers/test-harness.ts test/unit/client/lib/test-harness.perf-audit.test.ts
git commit -m "test: expose perf audit snapshots in the test harness"
```

## Task 11: Mark App and Terminal Readiness Milestones

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/TerminalView.tsx`
- Modify: `test/unit/client/components/App.lazy-views.test.tsx`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`

**Step 1: Write the failing tests**

```ts
it('marks auth-required readiness when booting without a token in perf audit mode', async () => {
  renderAppAt('/?e2e=1&perfAudit=1')
  expect(await getAuditMilestone('app.auth_required_visible')).toBeGreaterThanOrEqual(0)
})
```

```ts
it('marks terminal visibility and first output in perf audit mode', async () => {
  renderTerminalViewForAudit()
  expect(await getAuditMilestone('terminal.surface_visible')).toBeGreaterThanOrEqual(0)
  expect(await getAuditMilestone('terminal.first_output')).toBeGreaterThanOrEqual(0)
})
```

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/App.lazy-views.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
```

Expected: FAIL because the audit milestones are not emitted.

**Step 3: Write the minimal implementation**

In audit mode (`?e2e=1&perfAudit=1`):

1. install the bridge from `App.tsx`
2. mark `app.bootstrap_started`
3. mark `app.bootstrap_ready`
4. mark `app.ws_ready`
5. mark `app.auth_required_visible`
6. mark `terminal.surface_visible`
7. mark `terminal.first_output` only for the active terminal

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/App.lazy-views.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/App.tsx src/components/TerminalView.tsx test/unit/client/components/App.lazy-views.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "test: add app and terminal audit milestones"
```

## Task 12: Mark Agent-Chat, Sidebar Search, and Tab-Selection Milestones

**Files:**
- Modify: `src/components/agent-chat/AgentChatView.tsx`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/TabContent.tsx`
- Create: `test/unit/client/components/agent-chat/AgentChatView.perf-audit.test.tsx`
- Create: `test/unit/client/components/Sidebar.perf-audit.test.tsx`
- Create: `test/unit/client/components/TabContent.perf-audit.test.tsx`

**Step 1: Write the failing tests**

```ts
it('marks agent-chat readiness when recent visible messages render', async () => {
  renderAgentChatViewForAudit(longHistoryFixture)
  expect(await getAuditMilestone('agent_chat.surface_visible')).toBeGreaterThanOrEqual(0)
})
```

```ts
it('marks sidebar search results visibility for the active query', async () => {
  renderSidebarForAudit()
  expect(await getAuditMilestone('sidebar.search_results_visible')).toBeGreaterThanOrEqual(0)
})
```

```ts
it('marks offscreen tab selection when the selected tab becomes visible', async () => {
  renderTabContentForAudit()
  expect(await getAuditMilestone('tab.selected_surface_visible')).toBeGreaterThanOrEqual(0)
})
```

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/agent-chat/AgentChatView.perf-audit.test.tsx test/unit/client/components/Sidebar.perf-audit.test.tsx test/unit/client/components/TabContent.perf-audit.test.tsx
```

Expected: FAIL because those milestones do not exist.

**Step 3: Write the minimal implementation**

Add audit-only milestones:

1. `agent_chat.surface_visible`
2. `agent_chat.restore_timed_out`
3. `sidebar.search_started`
4. `sidebar.search_results_visible`
5. `tab.selected_surface_visible`

Do not count hidden or background work as readiness.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/agent-chat/AgentChatView.perf-audit.test.tsx test/unit/client/components/Sidebar.perf-audit.test.tsx test/unit/client/components/TabContent.perf-audit.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/agent-chat/AgentChatView.tsx src/components/Sidebar.tsx src/components/TabContent.tsx test/unit/client/components/agent-chat/AgentChatView.perf-audit.test.tsx test/unit/client/components/Sidebar.perf-audit.test.tsx test/unit/client/components/TabContent.perf-audit.test.tsx
git commit -m "test: add visible-readiness milestones for audit scenarios"
```

## Task 13: Record HTTP and WebSocket Transport Through Chromium CDP

**Files:**
- Create: `test/e2e-browser/perf/cdp-network-recorder.ts`
- Create: `test/unit/lib/visible-first-audit-network-recorder.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { NetworkRecorder } from '@test/e2e-browser/perf/cdp-network-recorder'

describe('NetworkRecorder', () => {
  it('groups websocket frames by direction and message type and ignores non-api HTTP noise', () => {
    const recorder = new NetworkRecorder()
    recorder.onFrame('received', JSON.stringify({ type: 'sessions.updated' }))
    recorder.onFrame('sent', JSON.stringify({ type: 'hello' }))
    recorder.onHttpCompleted({
      url: 'http://localhost:3000/assets/app.js',
      method: 'GET',
      status: 200,
      encodedDataLength: 1200,
      startTimeMs: 0,
      endTimeMs: 10,
    })

    const summary = recorder.summarize()
    expect(summary.ws.byType).toContainEqual(
      expect.objectContaining({ direction: 'received', type: 'sessions.updated', count: 1 }),
    )
    expect(summary.http.byPath).toHaveLength(0)
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-network-recorder.test.ts
```

Expected: FAIL because the recorder does not exist.

**Step 3: Write the minimal implementation**

Implement `cdp-network-recorder.ts` around Chromium CDP:

1. enable `Network`
2. join `requestWillBeSent`, `responseReceived`, and `loadingFinished`
3. use `encodedDataLength` for HTTP bytes
4. record `webSocketFrameSent` and `webSocketFrameReceived`
5. normalize route IDs and WS types
6. ignore non-API requests and ignored API routes

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-network-recorder.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/cdp-network-recorder.ts test/unit/lib/visible-first-audit-network-recorder.test.ts
git commit -m "test: add cdp transport recorder for audit runs"
```

## Task 14: Parse Server JSONL Logs Into Audit Data

**Files:**
- Create: `test/e2e-browser/perf/server-log-parser.ts`
- Create: `test/unit/lib/visible-first-audit-server-log-parser.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { parseServerDebugLogs } from '@test/e2e-browser/perf/server-log-parser'

describe('parseServerDebugLogs', () => {
  it('extracts http_request, perf events, and perf_system samples from server logs', async () => {
    const parsed = await parseServerDebugLogs([fixtureLogPath])
    expect(parsed.httpRequests).toHaveLength(1)
    expect(parsed.perfSystem[0]?.event).toBe('perf_system')
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-server-log-parser.test.ts
```

Expected: FAIL because the parser does not exist.

**Step 3: Write the minimal implementation**

Create `server-log-parser.ts` that:

1. reads `server-debug*.jsonl`
2. extracts `http_request`
3. extracts perf events from the perf logger
4. extracts `perf_system`
5. counts malformed lines in diagnostics instead of crashing the whole sample

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-server-log-parser.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/server-log-parser.ts test/unit/lib/visible-first-audit-server-log-parser.test.ts
git commit -m "test: parse server perf logs for audit artifacts"
```

## Task 15: Build the Per-Sample Runner With Hard Cold Isolation

**Files:**
- Create: `test/e2e-browser/perf/run-sample.ts`
- Create: `test/unit/lib/visible-first-audit-run-sample.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { runAuditSample } from '@test/e2e-browser/perf/run-sample'

describe('runAuditSample', () => {
  it('returns one schema-shaped sample with merged browser, network, server, and derived data', async () => {
    const sample = await runAuditSample(buildRunSampleFixture())
    expect(sample.profileId).toBe('desktop_local')
    expect(sample.transport.http.byPath).toBeDefined()
    expect(sample.derived.focusedReadyMs).toBeTypeOf('number')
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-run-sample.test.ts
```

Expected: FAIL because `run-sample.ts` does not exist.

**Step 3: Write the minimal implementation**

Create `run-sample.ts` that owns one complete cold sample:

1. start `TestServer` with `PERF_LOGGING=true`, `setupHome`, and preserved HOME
2. launch Chromium
3. create a fresh browser context for the selected profile with:
   - `serviceWorkers: 'block'`
   - empty storage
4. attach a CDP session
5. call `Network.enable`
6. call `Network.setCacheDisabled({ cacheDisabled: true })`
7. apply `Network.emulateNetworkConditions` only for `mobile_restricted`
8. apply browser-storage seeds through `page.addInitScript()` only when the scenario asks for them
9. execute the scenario driver
10. collect the browser audit snapshot
11. parse server logs
12. derive visible-first metrics
13. return one sample object
14. clean up browser and server in `finally`

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-run-sample.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/run-sample.ts test/unit/lib/visible-first-audit-run-sample.test.ts
git commit -m "test: add visible-first audit sample runner"
```

## Task 16: Build the Full Audit Runner and Both CLIs

**Files:**
- Create: `test/e2e-browser/perf/run-visible-first-audit.ts`
- Create: `test/e2e-browser/perf/audit-cli.ts`
- Create: `scripts/visible-first-audit.ts`
- Create: `scripts/compare-visible-first-audit.ts`
- Modify: `package.json`
- Create: `test/unit/lib/visible-first-audit-cli.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { parseAuditArgs } from '@test/e2e-browser/perf/audit-cli'

describe('parseAuditArgs', () => {
  it('defaults output to artifacts/perf/visible-first-audit.json', () => {
    expect(parseAuditArgs([]).outputPath).toContain('artifacts/perf/visible-first-audit.json')
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-cli.test.ts
```

Expected: FAIL because the CLI helpers do not exist.

**Step 3: Write the minimal implementation**

Create:

1. `run-visible-first-audit.ts` to loop serially across the fixed scenario/profile matrix
2. `audit-cli.ts` to parse output path plus optional smoke filters
3. `scripts/visible-first-audit.ts` to invoke the runner and write exactly one artifact
4. `scripts/compare-visible-first-audit.ts` to load two schema-valid artifacts and emit one JSON diff

Update `package.json` with:

```json
"perf:audit:visible-first": "tsx scripts/visible-first-audit.ts",
"perf:audit:compare": "tsx scripts/compare-visible-first-audit.ts"
```

The audit runner must:

1. ensure a production build exists
2. validate the final artifact with `VisibleFirstAuditSchema`
3. create `artifacts/perf/` when needed
4. write exactly one JSON file per invocation

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-cli.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/run-visible-first-audit.ts test/e2e-browser/perf/audit-cli.ts scripts/visible-first-audit.ts scripts/compare-visible-first-audit.ts package.json test/unit/lib/visible-first-audit-cli.test.ts
git commit -m "feat: add visible-first audit runner and compare cli"
```

## Task 17: Add Smoke Coverage and Operator Docs

**Files:**
- Modify: `.gitignore`
- Modify: `test/e2e-browser/vitest.config.ts`
- Create: `test/e2e-browser/perf/visible-first-audit.smoke.test.ts`
- Modify: `README.md`

**Step 1: Write the failing smoke test**

```ts
import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { runVisibleFirstAudit } from './run-visible-first-audit'
import { VisibleFirstAuditSchema } from './audit-contract'

describe('visible-first audit smoke', () => {
  it('writes a schema-valid artifact for a reduced run', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'visible-first-audit-'))
    const outputPath = path.join(outputDir, 'audit.json')

    await runVisibleFirstAudit({
      outputPath,
      scenarioIds: ['auth-required-cold-boot'],
      profileIds: ['desktop_local'],
    })

    const parsed = VisibleFirstAuditSchema.parse(JSON.parse(await readFile(outputPath, 'utf8')))
    expect(parsed.scenarios).toHaveLength(1)
  })
})
```

**Step 2: Run the smoke test to verify it fails**

Run:

```bash
npm run test:e2e:helpers -- test/e2e-browser/perf/visible-first-audit.smoke.test.ts
```

Expected: FAIL because the helper config does not include `perf/**/*.test.ts` yet or the runner is not smoke-test friendly.

**Step 3: Write the minimal implementation**

1. Widen `test/e2e-browser/vitest.config.ts` to include `perf/**/*.test.ts`.
2. Ignore `artifacts/perf/` in `.gitignore`.
3. Add the smoke test.
4. Document in `README.md`:
   - how to run the audit
   - default artifact path
   - how to diff two artifacts
   - why the mobile sample is bandwidth-restricted

**Step 4: Run the smoke test to verify it passes**

Run:

```bash
npm run test:e2e:helpers -- test/e2e-browser/perf/visible-first-audit.smoke.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add .gitignore test/e2e-browser/vitest.config.ts test/e2e-browser/perf/visible-first-audit.smoke.test.ts README.md
git commit -m "test: smoke test visible-first audit pipeline"
```

## Final Verification and Baseline Capture

Run these in order after all tasks are complete.

**Step 1: Run the focused tests**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-contract.test.ts test/unit/lib/visible-first-audit-derived-metrics.test.ts test/unit/lib/visible-first-audit-aggregator.test.ts test/unit/lib/visible-first-audit-compare.test.ts test/unit/lib/visible-first-audit-seed-server-home.test.ts test/unit/lib/visible-first-audit-seed-browser-storage.test.ts test/unit/lib/visible-first-audit-profiles.test.ts test/unit/lib/visible-first-audit-scenarios.test.ts test/unit/lib/visible-first-audit-network-recorder.test.ts test/unit/lib/visible-first-audit-server-log-parser.test.ts test/unit/lib/visible-first-audit-run-sample.test.ts test/unit/lib/visible-first-audit-cli.test.ts test/unit/client/lib/perf-audit-bridge.test.ts test/unit/client/lib/perf-logger.test.ts test/unit/client/lib/test-harness.perf-audit.test.ts test/unit/client/components/App.lazy-views.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/agent-chat/AgentChatView.perf-audit.test.tsx test/unit/client/components/Sidebar.perf-audit.test.tsx test/unit/client/components/TabContent.perf-audit.test.tsx
npm run test:e2e:helpers -- test/e2e-browser/helpers/test-server.test.ts test/e2e-browser/perf/visible-first-audit.smoke.test.ts
```

Expected: PASS.

**Step 2: Run the repo-standard full suite**

Run:

```bash
npm test
```

Expected: PASS.

**Step 3: Run the full audit**

Run:

```bash
npm run perf:audit:visible-first
```

Expected: `artifacts/perf/visible-first-audit.json` is written successfully.

**Step 4: Verify the artifact shape**

Run:

```bash
node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync('artifacts/perf/visible-first-audit.json','utf8')); console.log(data.schemaVersion, data.scenarios.length, data.scenarios.every((s)=>s.samples.length===2))"
```

Expected output:

```text
1 6 true
```

**Step 5: Verify compare mode**

Run:

```bash
npm run perf:audit:compare -- --base artifacts/perf/visible-first-audit.json --candidate artifacts/perf/visible-first-audit.json
```

Expected: PASS with zero deltas or an equivalent empty diff.

## Notes for the Execution Agent

1. Keep scenario IDs, profile IDs, milestone names, route IDs, and artifact field names stable.
2. Do not route perf collection through `/api/logs/client`.
3. Do not reuse server instances or browser contexts across measured samples.
4. Block service workers in the browser context instead of adding app-specific “disable SW” behavior.
5. Use browser-storage seeding only for client-persisted state; use HOME seeding only for server-side fixture data.
6. Prefer browser-observed truth over app instrumentation whenever the browser can already answer the question.
7. Only add app instrumentation for readiness states that transport cannot infer safely.
8. Do not invent summary statistics that the accepted sampling plan does not support.
9. Leave generated artifacts uncommitted unless the user explicitly asks to version a baseline.
