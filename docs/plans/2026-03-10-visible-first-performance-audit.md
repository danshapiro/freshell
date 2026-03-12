# Visible-First Performance Audit Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Build one repeatable, production-mode performance audit command for the current Freshell app that runs six fixed scenarios in Chromium, captures exactly one `desktop_local` sample and one `mobile_restricted` sample per scenario, and writes one schema-validated JSON artifact to `artifacts/perf/visible-first-audit.json`.

**Architecture:** Implement the audit as a dedicated Node/Playwright pipeline under `test/e2e-browser/perf/`, not as an overgrown Playwright spec. Use Chromium CDP as the authority for HTTP and WebSocket transport, add only the smallest app-side audit bridge needed to define focused-surface readiness, parse the existing server JSONL logs instead of inventing a second server telemetry path, and merge everything into one strict artifact contract plus a pure compare utility.

**Tech Stack:** TypeScript, Node.js, Playwright Chromium library API, existing `test/e2e-browser/helpers/TestServer`, Zod, Vitest, existing client/server perf loggers, existing pino JSONL logs, Chromium CDP `Network` domain.

---

## Strategy Gate

The accepted direction is correct, but the previous plan was not execution-ready enough for trycycle.

The real problem is not “add perf tests.” The real problem is “produce one trustworthy characterization artifact for today’s transport so the visible-first transport work can be judged mechanically against the same workload later.” That leads to these design decisions:

1. The JSON artifact is the product. Traces, screenshots, videos, and raw logs are debugging side artifacts only.
2. Transport truth must come from Chromium CDP, not app counters. HTTP timings/bytes and WebSocket frame counts/bytes need browser-observed capture.
3. Focused readiness must come from explicit app milestones because transport alone cannot safely decide when the user can actually use the focused surface.
4. Server work must come from the existing structured logs and perf logging. Do not add a parallel server telemetry transport just for the audit.
5. Every measured sample must be cold and isolated: fresh `TestServer`, fresh browser context, service workers blocked, HTTP cache disabled, empty browser storage unless the scenario explicitly seeds it.
6. The accepted sampling plan is exactly two measured samples per scenario: one `desktop_local`, one `mobile_restricted`. Do not add warmups, medians, or fake percentiles.
7. Offscreen work must be computed mechanically. Each scenario declares which normalized API routes and WebSocket message types are allowed before focused readiness; everything else before that boundary is offscreen work.
8. The audit is about application transport, not Vite/dev-mode behavior and not static asset noise. Measure production build only, and count only app `/api/**` requests plus the app WebSocket.
9. Browser-persisted layout state and server fixture data are different concerns. Seed them separately.
10. The command the team re-runs later must be the same command that writes the baseline now. No “manual prep first” requirement is acceptable for the main audit path.

This plan lands the requested end state directly:

1. `npm run perf:audit:visible-first` builds the app, runs the full six-scenario/two-profile matrix, validates the artifact, and writes exactly one JSON file unless the caller explicitly passes `--output`.
2. The default artifact path is always `artifacts/perf/visible-first-audit.json`.
3. `npm run perf:audit:compare` reads two artifacts and prints one JSON diff without changing the audit contract.

## Codebase Findings

1. [test-server.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/test/e2e-browser/helpers/test-server.ts) is the right isolation seam, but it currently only exposes `configDir` and deletes everything on stop. The audit needs retained HOME/log locations and the exact debug-log file path.
2. [test-harness.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/src/lib/test-harness.ts) already exposes Redux state, WebSocket readiness, and terminal buffers in production builds behind `?e2e=1`. That is the right place to expose audit snapshots.
3. [perf-logger.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/src/lib/perf-logger.ts) already produces useful browser perf events plus terminal input-to-output latency, but it only emits to the console today. The audit needs a sink hook, not a second logging transport.
4. [client-logger.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/src/lib/client-logger.ts) intentionally filters `perf: true` console payloads before sending anything to `/api/logs/client`. That behavior is correct and must remain unchanged.
5. [request-logger.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/server/request-logger.ts), [server/perf-logger.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/server/perf-logger.ts), and [logger.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/server/logger.ts) already emit structured server-side data the audit can parse.
6. [main.tsx](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/src/main.tsx) registers the service worker in production mode. The audit should block service workers from the browser context instead of adding app-only disable logic.
7. Tabs and panes persist in browser `localStorage`, not in HOME. The relevant keys are in [storage-keys.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/src/store/storage-keys.ts), and the payload parsers/version constants are in [persistedState.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/src/store/persistedState.ts).
8. Existing session fixture files in [test/fixtures/sessions](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/test/fixtures/sessions) are the best reference for writing deterministic JSONL session data in the real app format.
9. The root [vitest.config.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/vitest.config.ts) excludes `test/e2e-browser/**`, so pure Node-side audit tests should live under `test/unit/**` with `// @vitest-environment node`. The dedicated E2E helper config should be expanded later only for smoke coverage that really belongs beside the audit runner.

## Fixed Audit Matrix

The IDs in this section are part of the artifact contract. Keep them stable.

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

Seed one reusable server fixture set for all measured scenarios:

1. Session corpus
   - 12 projects
   - 180 session summaries total
   - 36 sessions whose titles contain the stable token `alpha`
   - stable timestamps and deterministic sort order
2. Long agent-chat history
   - 1 dedicated session
   - 240 turns total
   - at least 30 recent turns dense enough to render immediately
   - at least 80 older turns with longer bodies so “visible recent turns first” remains measurable later
3. Terminal replay script
   - write one deterministic Node script, for example `audit-terminal-backlog.js`
   - emit 1,200 stable lines plus a short delayed tail
4. Auth-required scenario
   - no special server seed beyond normal settings

### Deterministic Browser Storage Seed

Seed browser storage separately from HOME whenever a scenario needs persisted layout state:

1. Use `page.addInitScript()` before navigation.
2. Write `freshell_version=3`.
3. Write the current schema-compatible keys:
   - `freshell.tabs.v2`
   - `freshell.panes.v2`
4. Do not seed unrelated keys.
5. The offscreen-tab scenario must start with:
   - one active lightweight terminal tab
   - one heavy background agent-chat tab backed by the long-history session
   - sidebar closed by default

### Scenario Definitions

Each scenario owns:

1. its stable `id`
2. its deterministic setup
3. its navigation path
4. its focused-ready milestone
5. the exact normalized API route IDs and WebSocket message types allowed before focused readiness

#### `auth-required-cold-boot`

1. Navigation: `/?e2e=1&perfAudit=1`
2. Token: none
3. Focused-ready milestone: `app.auth_required_visible`
4. Allowed API routes before ready:
   - `/api/settings`
5. Allowed WS message types before ready:
   - none

#### `terminal-cold-boot`

1. Navigation: `/?token=<token>&e2e=1&perfAudit=1`
2. Setup: normal auth token, active tab resolves to a terminal pane
3. Focused-ready milestone: `terminal.first_output`
4. Allowed API routes before ready:
   - `/api/settings`
   - `/api/terminals`
5. Allowed WS message types before ready:
   - `hello`
   - `ready`
   - `terminal.create`
   - `terminal.created`
   - `terminal.output`
   - `terminal.list`
   - `terminal.meta.list`
   - `terminal.meta.list.response`

#### `agent-chat-cold-boot`

1. Navigation: `/?token=<token>&e2e=1&perfAudit=1`
2. Setup: browser storage seeds the active tab to the long-history agent session
3. Focused-ready milestone: `agent_chat.surface_visible`
4. Allowed API routes before ready:
   - `/api/settings`
   - `/api/sessions`
   - `/api/sessions/:sessionId`
5. Allowed WS message types before ready:
   - `hello`
   - `ready`
   - `sdk.history`
   - `sessions.updated`
   - `sessions.patch`

#### `sidebar-search-large-corpus`

1. Navigation: `/?token=<token>&e2e=1&perfAudit=1`
2. Setup: start from a lightweight terminal tab with sidebar hidden
3. Interaction:
   - open the sidebar
   - type `alpha`
4. Focused-ready milestone: `sidebar.search_results_visible`
5. Allowed API routes before ready:
   - `/api/settings`
   - `/api/sessions`
   - `/api/sessions/search`
6. Allowed WS message types before ready:
   - `hello`
   - `ready`
   - `sessions.updated`
   - `sessions.patch`

#### `terminal-reconnect-backlog`

1. Navigation: `/?token=<token>&e2e=1&perfAudit=1`
2. Setup:
   - create a real terminal
   - run the deterministic backlog script
   - force disconnect after backlog is established
3. Focused-ready milestone: `terminal.first_output`
4. Allowed API routes before ready:
   - `/api/settings`
   - `/api/terminals`
5. Allowed WS message types before ready:
   - `hello`
   - `ready`
   - `terminal.attach`
   - `terminal.snapshot`
   - `terminal.output`
   - `terminal.list`
   - `terminal.meta.list`
   - `terminal.meta.list.response`

#### `offscreen-tab-selection`

1. Navigation: `/?token=<token>&e2e=1&perfAudit=1`
2. Setup: browser storage seeds one lightweight active tab and one heavy background agent-chat tab
3. Interaction: after initial paint, select the heavy background tab
4. Focused-ready milestone: `tab.selected_surface_visible`
5. Allowed API routes before ready:
   - `/api/settings`
6. Allowed WS message types before ready:
   - `hello`
   - `ready`

### Transport Normalization Rules

Implement these rules once and reuse them everywhere:

1. Only count requests whose pathname starts with `/api/`.
2. Ignore these paths entirely:
   - `/api/health`
   - `/api/logs/client`
3. Strip origin and query string before classification.
4. Normalize dynamic routes into stable IDs:
   - `/api/sessions/<id>` -> `/api/sessions/:sessionId`
   - `/api/terminals/<id>` -> `/api/terminals/:terminalId`
5. Leave static routes untouched:
   - `/api/settings`
   - `/api/sessions`
   - `/api/sessions/search`
   - `/api/terminals`
6. Bucket WebSocket frames by top-level JSON `type`; non-JSON or missing-`type` frames become `unknown`.
7. “Offscreen before ready” means:
   - the observation timestamp is `<= focusedReadyTimestamp`
   - the normalized route ID or WS type is not in that scenario’s allowlist

## Artifact Contract

Implement the Zod contract once and make the runner, smoke test, and compare tool all use it.

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

These are collector outputs. Do not recompute them elsewhere:

1. `browser`
   - milestone timestamps
   - captured client perf events
   - terminal latency samples
2. `transport`
   - raw HTTP observations from CDP
   - raw WebSocket frames from CDP
   - normalized summaries by route/type
3. `server`
   - parsed `http_request` log entries
   - parsed perf events
   - parsed `perf_system` samples
   - parser diagnostics

### Derived sample metrics

Derived metrics are computed from authoritative data plus the scenario definition:

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

1. a scenario crashes or times out
2. the focused-ready milestone is missing
3. CDP transport capture is missing
4. server log capture is missing
5. the final JSON fails schema validation

The audit does not fail on latency budgets yet.

## Task 1: Freeze Stable Profile and Scenario IDs

**Files:**
- Create: `test/e2e-browser/perf/profiles.ts`
- Create: `test/e2e-browser/perf/scenarios.ts`
- Create: `test/unit/lib/visible-first-audit-profiles.test.ts`
- Create: `test/unit/lib/visible-first-audit-scenarios.test.ts`

**Step 1: Write the failing tests**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { AUDIT_PROFILES } from '@test/e2e-browser/perf/profiles'
import { AUDIT_SCENARIOS } from '@test/e2e-browser/perf/scenarios'

describe('visible-first audit matrix', () => {
  it('defines exactly the accepted profiles', () => {
    expect(AUDIT_PROFILES.map((profile) => profile.id)).toEqual([
      'desktop_local',
      'mobile_restricted',
    ])
  })

  it('defines the six accepted scenarios in stable order', () => {
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

Create immutable definitions in `profiles.ts` and `scenarios.ts`:

```ts
export const AUDIT_PROFILES = [
  { id: 'desktop_local', viewport: { width: 1440, height: 900 } },
  {
    id: 'mobile_restricted',
    deviceName: 'iPhone 14',
    network: { downloadBps: 1_600_000, uploadBps: 750_000, latencyMs: 150 },
  },
] as const

export const AUDIT_SCENARIOS = [
  {
    id: 'auth-required-cold-boot',
    focusedReadyMilestone: 'app.auth_required_visible',
    allowedApiRouteIdsBeforeReady: ['/api/settings'],
    allowedWsTypesBeforeReady: [],
  },
  // ...the remaining five accepted scenarios...
] as const
```

Each scenario definition must also carry:

1. description text for the artifact
2. URL builder
3. optional HOME seed hook
4. optional browser-storage seed hook
5. optional interaction driver

Do not let these files own browser launch, CDP wiring, or artifact writing.

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

## Task 2: Define the Artifact Schema

**Files:**
- Create: `test/e2e-browser/perf/audit-contract.ts`
- Create: `test/unit/lib/visible-first-audit-contract.test.ts`

**Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  AUDIT_PROFILE_IDS,
  AUDIT_SCENARIO_IDS,
  VisibleFirstAuditSchema,
} from '@test/e2e-browser/perf/audit-contract'

describe('VisibleFirstAuditSchema', () => {
  it('accepts a six-scenario artifact with exactly two samples per scenario', () => {
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

Expected: FAIL with a module-not-found error.

**Step 3: Write the minimal implementation**

Create strict Zod schemas in `audit-contract.ts`:

```ts
export const AUDIT_PROFILE_IDS = ['desktop_local', 'mobile_restricted'] as const
export const AUDIT_SCENARIO_IDS = AUDIT_SCENARIOS.map((scenario) => scenario.id)

const AuditSampleSchema = z.object({
  profileId: z.enum(AUDIT_PROFILE_IDS),
  status: z.enum(['ok', 'timeout', 'error']),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number().nonnegative(),
  browser: z.object({}).passthrough(),
  transport: z.object({}).passthrough(),
  server: z.object({}).passthrough(),
  derived: z.object({}).passthrough(),
  errors: z.array(z.string()),
}).strict()
```

Also export:

1. `VisibleFirstAuditSchema`
2. `VisibleFirstAuditArtifact`
3. helper types for scenario/sample objects inferred from Zod

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

## Task 3: Make Route Normalization and Offscreen Classification Explicit

**Files:**
- Create: `test/e2e-browser/perf/derive-visible-first-metrics.ts`
- Create: `test/unit/lib/visible-first-audit-derived-metrics.test.ts`

**Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  deriveVisibleFirstMetrics,
  normalizeAuditRouteId,
} from '@test/e2e-browser/perf/derive-visible-first-metrics'

describe('deriveVisibleFirstMetrics', () => {
  it('normalizes routes and counts offscreen work before focused readiness', () => {
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

Expected: FAIL with a module-not-found error.

**Step 3: Write the minimal implementation**

Implement pure functions only:

```ts
export function normalizeAuditRouteId(input: string): string | null
export function classifyWsFrameType(rawPayload: string): string
export function deriveVisibleFirstMetrics(sample: DerivedMetricsInput): VisibleFirstDerivedMetrics
```

The implementation must:

1. ignore `/api/health` and `/api/logs/client`
2. normalize `/api/sessions/:sessionId` and `/api/terminals/:terminalId`
3. cut off derived counts at the focused-ready milestone timestamp
4. never mutate the authoritative collector output

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

## Task 4: Keep Aggregation and Comparison Pure

**Files:**
- Create: `test/e2e-browser/perf/audit-aggregator.ts`
- Create: `test/e2e-browser/perf/compare-visible-first-audits.ts`
- Create: `test/unit/lib/visible-first-audit-aggregator.test.ts`
- Create: `test/unit/lib/visible-first-audit-compare.test.ts`

**Step 1: Write the failing tests**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { summarizeScenarioSamples } from '@test/e2e-browser/perf/audit-aggregator'
import { compareVisibleFirstAudits } from '@test/e2e-browser/perf/compare-visible-first-audits'

describe('visible-first audit aggregation', () => {
  it('summarizes the single sample per profile without inventing medians', () => {
    const summary = summarizeScenarioSamples(buildScenarioFixture())
    expect(summary.desktop_local.focusedReadyMs).toBeTypeOf('number')
  })

  it('compares two artifacts by scenario and profile', () => {
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

Create pure helpers that:

1. summarize each scenario into `desktop_local` and `mobile_restricted`
2. copy derived metrics from the one authoritative sample for that profile
3. compare two already-validated artifacts by scenario/profile
4. never import Playwright, DOM, or filesystem APIs

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-aggregator.test.ts test/unit/lib/visible-first-audit-compare.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/audit-aggregator.ts test/e2e-browser/perf/compare-visible-first-audits.ts test/unit/lib/visible-first-audit-aggregator.test.ts test/unit/lib/visible-first-audit-compare.test.ts
git commit -m "test: add visible-first audit aggregation helpers"
```

## Task 5: Extend TestServer for Audit Retention

**Files:**
- Modify: `test/e2e-browser/helpers/test-server.ts`
- Modify: `test/e2e-browser/helpers/test-server.test.ts`

**Step 1: Write the failing test**

```ts
it('exposes HOME, logs, and debug-log paths and can preserve them for audit collection', async () => {
  const server = new TestServer({
    preserveHomeOnStop: true,
    setupHome: async (homeDir) => {
      await fs.promises.mkdir(path.join(homeDir, '.claude', 'projects', 'perf'), { recursive: true })
    },
  })

  const info = await server.start()
  expect(info.homeDir).toContain('freshell-e2e-')
  expect(info.logsDir).toContain(path.join('.freshell', 'logs'))
  expect(info.debugLogPath).toContain('.jsonl')
  await server.stop()
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:e2e:helpers -- test/e2e-browser/helpers/test-server.test.ts
```

Expected: FAIL because `setupHome`, `preserveHomeOnStop`, `homeDir`, `logsDir`, and `debugLogPath` do not exist.

**Step 3: Write the minimal implementation**

Extend `TestServer` with:

```ts
export interface TestServerInfo {
  port: number
  baseUrl: string
  wsUrl: string
  token: string
  configDir: string
  homeDir: string
  logsDir: string
  debugLogPath: string
  pid: number
}

export interface TestServerOptions {
  setupHome?: (homeDir: string) => Promise<void>
  preserveHomeOnStop?: boolean
}
```

Implementation rules:

1. Call `setupHome(homeDir)` before spawning the server.
2. Preserve the old cleanup behavior unless `preserveHomeOnStop` is `true`.
3. Expose the exact debug-log path so the parser does not guess.

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

## Task 6: Seed Deterministic Server Fixture Data

**Files:**
- Create: `test/e2e-browser/perf/seed-server-home.ts`
- Create: `test/unit/lib/visible-first-audit-seed-server-home.test.ts`

**Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { seedVisibleFirstAuditServerHome } from '@test/e2e-browser/perf/seed-server-home'

describe('seedVisibleFirstAuditServerHome', () => {
  it('writes the accepted session corpus, long-history session, and backlog script', async () => {
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

Expected: FAIL with a module-not-found error.

**Step 3: Write the minimal implementation**

Implement `seedVisibleFirstAuditServerHome(homeDir)` so it:

1. creates the expected `~/.claude/projects/.../sessions/*.jsonl` structure
2. writes session JSONL using real app format, using [test/fixtures/sessions](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/test/fixtures/sessions) as the format reference
3. writes a deterministic long-history session with 240 turns
4. writes `audit-terminal-backlog.js`
5. returns a summary object with counts and important paths

Do not persist tabs or panes here.

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

## Task 7: Seed Deterministic Browser Storage

**Files:**
- Create: `test/e2e-browser/perf/seed-browser-storage.ts`
- Create: `test/unit/lib/visible-first-audit-seed-browser-storage.test.ts`

**Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  buildAgentChatBrowserStorageSeed,
  buildOffscreenTabBrowserStorageSeed,
} from '@test/e2e-browser/perf/seed-browser-storage'
import { parsePersistedTabsRaw, parsePersistedPanesRaw } from '@/store/persistedState'

describe('visible-first browser storage seeds', () => {
  it('returns schema-compatible tabs and panes payloads', () => {
    const seed = buildOffscreenTabBrowserStorageSeed()
    expect(seed.freshell_version).toBe('3')
    expect(parsePersistedTabsRaw(seed['freshell.tabs.v2'])).not.toBeNull()
    expect(parsePersistedPanesRaw(seed['freshell.panes.v2'])).not.toBeNull()
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-seed-browser-storage.test.ts
```

Expected: FAIL with a module-not-found error.

**Step 3: Write the minimal implementation**

Create helpers that return plain key-value maps for `page.addInitScript()`:

```ts
export function buildAgentChatBrowserStorageSeed(): Record<string, string>
export function buildOffscreenTabBrowserStorageSeed(): Record<string, string>
```

Rules:

1. write only `freshell_version`, `freshell.tabs.v2`, and `freshell.panes.v2`
2. keep payloads current-schema-compatible by round-tripping through the existing parsers in tests
3. keep the offscreen-tab seed small except for the intentionally heavy agent-chat tab

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

Create a window-free collector:

```ts
export type PerfAuditSnapshot = {
  milestones: Record<string, number>
  metadata: Record<string, unknown>
  perfEvents: Array<Record<string, unknown>>
  terminalLatencySamplesMs: number[]
}

export function createPerfAuditBridge() {
  return {
    mark(name: string, data?: Record<string, unknown>) {},
    addPerfEvent(event: Record<string, unknown>) {},
    addTerminalLatencySample(latencyMs: number) {},
    snapshot(): PerfAuditSnapshot {},
  }
}
```

Keep it serializable and in-memory only.

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

## Task 9: Feed Existing Client Perf Signals Into the Bridge

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

Add a narrow sink hook:

```ts
type ClientPerfAuditSink = (entry: Record<string, unknown>) => void

export function installClientPerfAuditSink(sink: ClientPerfAuditSink | null): void
```

Forward entries from:

1. `logClientPerf(...)`
2. `markTerminalOutputSeen(...)`

Keep console logging unchanged, and do not route anything through `/api/logs/client`.

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

Extend the harness contract with:

```ts
getPerfAuditSnapshot: () => PerfAuditSnapshot | null
```

And add the matching Playwright helper:

```ts
async getPerfAuditSnapshot(): Promise<PerfAuditSnapshot | null>
```

Keep all existing harness APIs unchanged.

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/client/lib/test-harness.perf-audit.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/test-harness.ts test/e2e-browser/helpers/test-harness.ts test/unit/client/lib/test-harness.perf-audit.test.ts
git commit -m "test: expose perf audit snapshots through test harness"
```

## Task 11: Mark Bootstrap and Auth Milestones

**Files:**
- Modify: `src/App.tsx`
- Create: `test/unit/client/components/App.perf-audit-bootstrap.test.tsx`

**Step 1: Write the failing test**

```ts
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

describe('App perf audit milestones', () => {
  it('marks auth-required visibility when the auth modal is shown in perf-audit mode', async () => {
    render(<AppWithPerfAuditAndNoToken />)
    expect(await screen.findByText(/auth required/i)).toBeVisible()
    expect(readPerfAuditSnapshot().milestones['app.auth_required_visible']).toBeTypeOf('number')
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/App.perf-audit-bootstrap.test.tsx
```

Expected: FAIL because no perf-audit milestone is recorded.

**Step 3: Write the minimal implementation**

In `App.tsx`, when `perfAudit=1` is present:

1. create one `PerfAuditBridge`
2. install it into the test harness
3. mark:
   - `app.bootstrap_started`
   - `app.settings_loaded`
   - `app.auth_required_visible` when auth gating is rendered

Use `useRef` so the bridge is created once per page load.

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/App.perf-audit-bootstrap.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/App.tsx test/unit/client/components/App.perf-audit-bootstrap.test.tsx
git commit -m "test: mark app bootstrap audit milestones"
```

## Task 12: Mark Terminal Readiness Milestones

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/lib/ws-client.ts`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`

**Step 1: Write the failing test**

```ts
it('marks terminal.first_output when the focused terminal renders output', async () => {
  render(<TerminalViewWithPerfAudit />)
  emitTerminalOutput('hello from terminal')
  expect(readPerfAuditSnapshot().milestones['terminal.first_output']).toBeTypeOf('number')
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/TerminalView.lifecycle.test.tsx
```

Expected: FAIL because the terminal milestone is not recorded.

**Step 3: Write the minimal implementation**

Use the smallest hooks already available:

1. in `ws-client.ts`, keep calling `markTerminalOutputSeen`
2. when perf audit is active, forward terminal latency samples into the bridge
3. in `TerminalView.tsx`, mark `terminal.first_output` only once for the focused terminal pane when buffer content becomes non-empty

Do not mark this for hidden panes.

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/TerminalView.lifecycle.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/TerminalView.tsx src/lib/ws-client.ts test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "test: mark terminal readiness audit milestone"
```

## Task-Sizing Corrections

The earlier revision had the right architecture, but three places were still too coarse for disciplined trycycle execution:

1. it bundled three unrelated UI milestone seams into one task
2. it bundled the serial runner, write CLI, compare CLI, and package wiring into one task
3. it bundled smoke coverage, `.gitignore`, and README work into one task without explicitly running lint afterward

The tasks below split those seams so each commit leaves a smaller, reviewable, green state.

## Task 13: Mark Agent-Chat Readiness

**Files:**
- Modify: `src/components/agent-chat/AgentChatView.tsx`
- Create: `test/unit/client/components/agent-chat/AgentChatView.perf-audit.test.tsx`

**Step 1: Write the failing test**

```ts
it('marks agent_chat.surface_visible when the focused history is rendered and loaded', async () => {
  render(<AgentChatViewWithPerfAudit />)
  expect(await screen.findByText(/assistant/i)).toBeVisible()
  expect(readPerfAuditSnapshot().milestones['agent_chat.surface_visible']).toBeTypeOf('number')
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/agent-chat/AgentChatView.perf-audit.test.tsx
```

Expected: FAIL because the milestone is not recorded.

**Step 3: Write the minimal implementation**

In `AgentChatView.tsx`, mark `agent_chat.surface_visible` only when:

1. the pane is focused
2. `historyLoaded` is true
3. at least one visible history row has rendered

Ignore repeat marks.

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/agent-chat/AgentChatView.perf-audit.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/agent-chat/AgentChatView.tsx test/unit/client/components/agent-chat/AgentChatView.perf-audit.test.tsx
git commit -m "test: mark agent chat audit readiness"
```

## Task 14: Mark Sidebar Search Readiness

**Files:**
- Modify: `src/components/Sidebar.tsx`
- Create: `test/unit/client/components/Sidebar.perf-audit.test.tsx`

**Step 1: Write the failing test**

```ts
it('marks sidebar.search_results_visible when visible results render for the active query', async () => {
  render(<SidebarWithPerfAudit />)
  await typeSearch('alpha')
  expect(await screen.findByText(/alpha/i)).toBeVisible()
  expect(readPerfAuditSnapshot().milestones['sidebar.search_results_visible']).toBeTypeOf('number')
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/Sidebar.perf-audit.test.tsx
```

Expected: FAIL because the milestone is not recorded.

**Step 3: Write the minimal implementation**

In `Sidebar.tsx`, mark `sidebar.search_results_visible` after:

1. the sidebar is visible
2. the current query is non-empty
3. the filtered result list for that query has rendered

Do not mark for stale queries or empty-state renders.

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/Sidebar.perf-audit.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/Sidebar.tsx test/unit/client/components/Sidebar.perf-audit.test.tsx
git commit -m "test: mark sidebar audit readiness"
```

## Task 15: Mark Selected-Tab Readiness

**Files:**
- Modify: `src/components/TabContent.tsx`
- Create: `test/unit/client/components/TabContent.perf-audit.test.tsx`

**Step 1: Write the failing test**

```ts
it('marks tab.selected_surface_visible when a background tab becomes the selected visible tab', async () => {
  render(<TabContentWithPerfAudit />)
  await selectBackgroundTab()
  expect(readPerfAuditSnapshot().milestones['tab.selected_surface_visible']).toBeTypeOf('number')
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/TabContent.perf-audit.test.tsx
```

Expected: FAIL because the milestone is not recorded.

**Step 3: Write the minimal implementation**

In `TabContent.tsx`, mark `tab.selected_surface_visible` once:

1. the newly selected tab is active
2. its focused pane is mounted
3. the pane container is visible

Do not fire the mark for the initial tab on first load; this milestone exists only for the offscreen-tab scenario.

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/TabContent.perf-audit.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/TabContent.tsx test/unit/client/components/TabContent.perf-audit.test.tsx
git commit -m "test: mark selected tab audit readiness"
```

## Task 16: Record HTTP and WebSocket Transport Through Chromium CDP

**Files:**
- Create: `test/e2e-browser/perf/network-recorder.ts`
- Create: `test/unit/lib/visible-first-audit-network-recorder.test.ts`

**Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  createNetworkRecorder,
  summarizeNetworkCapture,
} from '@test/e2e-browser/perf/network-recorder'

describe('createNetworkRecorder', () => {
  it('normalizes app API requests and WS frames from CDP events', () => {
    const recorder = createNetworkRecorder()
    recorder.onRequestWillBeSent(fakeApiRequest('/api/sessions/abc123'))
    recorder.onLoadingFinished(fakeLoadingFinished())
    recorder.onWebSocketFrameReceived(fakeWsFrame('sdk.history'))

    const summary = summarizeNetworkCapture(recorder.snapshot())
    expect(summary.http.byRoute['/api/sessions/:sessionId']?.count).toBe(1)
    expect(summary.ws.byType['sdk.history']?.receivedFrames).toBe(1)
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-network-recorder.test.ts
```

Expected: FAIL with a module-not-found error.

**Step 3: Write the minimal implementation**

Build a recorder around CDP `Network` events:

```ts
export function createNetworkRecorder() {
  return {
    onRequestWillBeSent(event: RequestWillBeSentEvent) {},
    onResponseReceived(event: ResponseReceivedEvent) {},
    onLoadingFinished(event: LoadingFinishedEvent) {},
    onWebSocketFrameSent(event: WebSocketFrameEvent) {},
    onWebSocketFrameReceived(event: WebSocketFrameEvent) {},
    snapshot(): NetworkCapture {},
  }
}
```

Implementation rules:

1. count only `/api/**`
2. ignore `/api/health` and `/api/logs/client`
3. use `encodedDataLength` where available for bytes
4. preserve raw observations plus summarized `byRoute` and `byType` maps
5. classify non-JSON or missing-`type` payloads as `unknown`

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-network-recorder.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/network-recorder.ts test/unit/lib/visible-first-audit-network-recorder.test.ts
git commit -m "test: add visible-first audit network recorder"
```

## Task 17: Parse Server JSONL Logs Into Audit Data

**Files:**
- Create: `test/e2e-browser/perf/parse-server-logs.ts`
- Create: `test/unit/lib/visible-first-audit-server-log-parser.test.ts`

**Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseVisibleFirstServerLogs } from '@test/e2e-browser/perf/parse-server-logs'

describe('parseVisibleFirstServerLogs', () => {
  it('extracts request logs, perf events, perf_system samples, and diagnostics', async () => {
    const result = await parseVisibleFirstServerLogs(debugLogPath)
    expect(result.httpRequests.length).toBeGreaterThan(0)
    expect(result.perfEvents.length).toBeGreaterThan(0)
    expect(result.parserDiagnostics).toEqual([])
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-server-log-parser.test.ts
```

Expected: FAIL with a module-not-found error.

**Step 3: Write the minimal implementation**

Implement a tolerant JSONL parser:

```ts
export async function parseVisibleFirstServerLogs(debugLogPath: string): Promise<{
  httpRequests: unknown[]
  perfEvents: unknown[]
  perfSystemSamples: unknown[]
  parserDiagnostics: string[]
}>
```

Rules:

1. read the exact `debugLogPath` from `TestServerInfo`
2. parse line-by-line
3. collect malformed lines into `parserDiagnostics` instead of throwing
4. preserve raw matching log objects for later derived calculations

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-server-log-parser.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/parse-server-logs.ts test/unit/lib/visible-first-audit-server-log-parser.test.ts
git commit -m "test: add visible-first server log parser"
```

## Task 18: Build the Cold Browser Context Helper

**Files:**
- Create: `test/e2e-browser/perf/create-audit-context.ts`
- Create: `test/unit/lib/visible-first-audit-context.test.ts`

**Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildAuditContextOptions } from '@test/e2e-browser/perf/create-audit-context'

describe('buildAuditContextOptions', () => {
  it('blocks service workers and disables cache for both profiles', () => {
    const desktop = buildAuditContextOptions({ profileId: 'desktop_local' })
    const mobile = buildAuditContextOptions({ profileId: 'mobile_restricted' })
    expect(desktop.serviceWorkers).toBe('block')
    expect(mobile.serviceWorkers).toBe('block')
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-context.test.ts
```

Expected: FAIL with a module-not-found error.

**Step 3: Write the minimal implementation**

Create one helper that owns browser-context cold-start rules:

```ts
export function buildAuditContextOptions(input: { profileId: 'desktop_local' | 'mobile_restricted' }) {
  return {
    serviceWorkers: 'block' as const,
    viewport: ...,
    userAgent: ...,
  }
}

export async function applyProfileNetworkConditions(cdpSession: CDPSession, profileId: string): Promise<void>
```

Rules:

1. block service workers for both profiles
2. disable cache through CDP
3. apply Playwright `devices['iPhone 14']` only for `mobile_restricted`
4. apply the fixed bandwidth and latency profile only for `mobile_restricted`

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-context.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/create-audit-context.ts test/unit/lib/visible-first-audit-context.test.ts
git commit -m "test: define visible-first audit browser context rules"
```

## Task 19: Build the Per-Sample Runner

**Files:**
- Create: `test/e2e-browser/perf/run-sample.ts`
- Create: `test/unit/lib/visible-first-audit-run-sample.test.ts`

**Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { runVisibleFirstAuditSample } from '@test/e2e-browser/perf/run-sample'

describe('runVisibleFirstAuditSample', () => {
  it('returns one schema-shaped sample with browser, transport, server, and derived data', async () => {
    const sample = await runVisibleFirstAuditSample(fakeRunContext())
    expect(sample.profileId).toBe('desktop_local')
    expect(sample.browser).toBeDefined()
    expect(sample.transport).toBeDefined()
    expect(sample.server).toBeDefined()
    expect(sample.derived.focusedReadyMs).toBeTypeOf('number')
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-run-sample.test.ts
```

Expected: FAIL with a module-not-found error.

**Step 3: Write the minimal implementation**

Implement the end-to-end sample runner in one place:

```ts
export async function runVisibleFirstAuditSample(input: {
  scenarioId: string
  profileId: string
  outputDir?: string
}): Promise<VisibleFirstAuditSample>
```

Execution order:

1. create a fresh `TestServer` with the shared fixture seed
2. launch Chromium
3. create a fresh browser context with the profile helper
4. create a CDP session and start `Network.enable`
5. install browser-storage seed if the scenario needs it
6. navigate to the scenario URL
7. run any scenario interaction
8. wait for the scenario focused-ready milestone
9. read the audit snapshot from the test harness
10. stop capture and parse server logs
11. derive visible-first metrics
12. return one sample object
13. clean up browser and server in `finally`

This is the first true end-to-end slice of the audit. If this slice is awkward, fix the interfaces instead of adding glue elsewhere.

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

## Task 20: Build the Serial Audit Runner

**Files:**
- Create: `test/e2e-browser/perf/run-visible-first-audit.ts`
- Create: `test/unit/lib/visible-first-audit-runner.test.ts`

**Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { runVisibleFirstAudit } from '@test/e2e-browser/perf/run-visible-first-audit'

describe('runVisibleFirstAudit', () => {
  it('runs the accepted scenario/profile matrix in stable order and returns a schema-valid object', async () => {
    const artifact = await runVisibleFirstAudit(fakeAuditRunContext())
    expect(artifact.scenarios.map((scenario) => scenario.id)).toEqual([
      'auth-required-cold-boot',
      'terminal-cold-boot',
      'agent-chat-cold-boot',
      'sidebar-search-large-corpus',
      'terminal-reconnect-backlog',
      'offscreen-tab-selection',
    ])
    expect(artifact.scenarios.every((scenario) => scenario.samples).toBeDefined()).toBe(true)
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-runner.test.ts
```

Expected: FAIL with a module-not-found error.

**Step 3: Write the minimal implementation**

Create `runVisibleFirstAudit(...)` so it:

1. loops serially across all requested scenarios and profiles
2. calls `runVisibleFirstAuditSample(...)` for each pair
3. builds `summaryByProfile` from the authoritative samples
4. validates the final artifact with `VisibleFirstAuditSchema`
5. returns the parsed artifact object rather than writing files directly

Keep filesystem writes out of this task.

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-runner.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/run-visible-first-audit.ts test/unit/lib/visible-first-audit-runner.test.ts
git commit -m "test: add visible-first audit runner"
```

## Task 21: Add the Main Audit CLI and Package Wiring

**Files:**
- Create: `test/e2e-browser/perf/audit-cli.ts`
- Create: `scripts/visible-first-audit.ts`
- Modify: `package.json`
- Create: `test/unit/lib/visible-first-audit-cli.test.ts`

**Step 1: Write the failing test**

```ts
// @vitest-environment node
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

1. `audit-cli.ts`
   - parses `--output`, `--scenario`, and `--profile`
2. `scripts/visible-first-audit.ts`
   - runs `runVisibleFirstAudit(...)`
   - creates `artifacts/perf/` when needed
   - writes pretty JSON with a trailing newline
   - exits non-zero if schema validation fails

Update `package.json` with:

```json
"perf:audit:visible-first": "npm run build && tsx scripts/visible-first-audit.ts"
```

Do not add compare-mode wiring in this task.

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-cli.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/audit-cli.ts scripts/visible-first-audit.ts package.json test/unit/lib/visible-first-audit-cli.test.ts
git commit -m "feat: add visible-first audit cli"
```

## Task 22: Add the Compare CLI

**Files:**
- Modify: `test/e2e-browser/perf/audit-cli.ts`
- Create: `scripts/compare-visible-first-audit.ts`
- Modify: `package.json`
- Create: `test/unit/lib/visible-first-audit-compare-cli.test.ts`

**Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseCompareArgs } from '@test/e2e-browser/perf/audit-cli'

describe('parseCompareArgs', () => {
  it('requires both base and candidate artifact paths', () => {
    expect(() => parseCompareArgs(['--base', 'base.json'])).toThrow(/candidate/i)
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-compare-cli.test.ts
```

Expected: FAIL because compare-mode parsing and the compare script do not exist yet.

**Step 3: Write the minimal implementation**

Add:

1. `parseCompareArgs(...)` in `audit-cli.ts`
2. `scripts/compare-visible-first-audit.ts`
   - loads two schema-valid artifacts
   - prints one JSON diff from `compareVisibleFirstAudits(...)`

Update `package.json` with:

```json
"perf:audit:compare": "tsx scripts/compare-visible-first-audit.ts"
```

Keep compare output machine-readable JSON only.

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-compare-cli.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/audit-cli.ts scripts/compare-visible-first-audit.ts package.json test/unit/lib/visible-first-audit-compare-cli.test.ts
git commit -m "feat: add visible-first audit compare cli"
```

## Task 23: Add Smoke Coverage, Artifact Ignore Rules, and Operator Documentation

**Files:**
- Modify: `.gitignore`
- Modify: `test/e2e-browser/vitest.config.ts`
- Create: `test/e2e-browser/perf/visible-first-audit.smoke.test.ts`
- Modify: `README.md`

**Step 1: Write the failing smoke test**

```ts
import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { runVisibleFirstAudit } from './run-visible-first-audit'
import { VisibleFirstAuditSchema } from './audit-contract'

describe('visible-first audit smoke', () => {
  it('writes a schema-valid artifact for a reduced auth-only run', async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'visible-first-audit-'))
    const outputPath = path.join(outputDir, 'audit.json')

    const artifact = await runVisibleFirstAudit({
      scenarioIds: ['auth-required-cold-boot'],
      profileIds: ['desktop_local'],
    })
    await writeFile(outputPath, JSON.stringify(artifact, null, 2) + '\n')

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

Expected: FAIL because `perf/**/*.test.ts` is not included yet or the runner is not smoke-test friendly yet.

**Step 3: Write the minimal implementation**

1. widen `test/e2e-browser/vitest.config.ts` to include `perf/**/*.test.ts`
2. ignore `artifacts/perf/` in `.gitignore`
3. add the smoke test
4. document in `README.md`:
   - how to run the audit
   - the default artifact path
   - how to diff two artifacts
   - why the mobile sample is bandwidth-restricted

Keep the README section short and operational.

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
npm run test:client:standard -- test/unit/lib/visible-first-audit-profiles.test.ts test/unit/lib/visible-first-audit-scenarios.test.ts test/unit/lib/visible-first-audit-contract.test.ts test/unit/lib/visible-first-audit-derived-metrics.test.ts test/unit/lib/visible-first-audit-aggregator.test.ts test/unit/lib/visible-first-audit-compare.test.ts test/unit/lib/visible-first-audit-seed-server-home.test.ts test/unit/lib/visible-first-audit-seed-browser-storage.test.ts test/unit/lib/visible-first-audit-network-recorder.test.ts test/unit/lib/visible-first-audit-server-log-parser.test.ts test/unit/lib/visible-first-audit-context.test.ts test/unit/lib/visible-first-audit-run-sample.test.ts test/unit/lib/visible-first-audit-runner.test.ts test/unit/lib/visible-first-audit-cli.test.ts test/unit/lib/visible-first-audit-compare-cli.test.ts test/unit/client/lib/perf-audit-bridge.test.ts test/unit/client/lib/perf-logger.test.ts test/unit/client/lib/test-harness.perf-audit.test.ts test/unit/client/components/App.perf-audit-bootstrap.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/agent-chat/AgentChatView.perf-audit.test.tsx test/unit/client/components/Sidebar.perf-audit.test.tsx test/unit/client/components/TabContent.perf-audit.test.tsx
npm run test:e2e:helpers -- test/e2e-browser/helpers/test-server.test.ts test/e2e-browser/perf/visible-first-audit.smoke.test.ts
```

Expected: PASS.

**Step 2: Run lint for the touched UI and harness code**

Run:

```bash
npm run lint
```

Expected: PASS.

**Step 3: Run the repo-standard full suite**

Run:

```bash
npm test
```

Expected: PASS.

**Step 4: Run the full audit**

Run:

```bash
npm run perf:audit:visible-first
```

Expected: `artifacts/perf/visible-first-audit.json` is written successfully.

**Step 5: Verify the artifact shape**

Run:

```bash
node --input-type=module -e "import fs from 'node:fs'; const data = JSON.parse(fs.readFileSync('artifacts/perf/visible-first-audit.json', 'utf8')); console.log(data.schemaVersion, data.scenarios.length, data.scenarios.every((scenario) => scenario.samples.length === 2))"
```

Expected output:

```text
1 6 true
```

**Step 6: Verify compare mode**

Run:

```bash
npm run perf:audit:compare -- --base artifacts/perf/visible-first-audit.json --candidate artifacts/perf/visible-first-audit.json
```

Expected: JSON output showing zero deltas.

## Notes for the Execution Agent

1. Keep scenario IDs, profile IDs, milestone names, route IDs, and artifact field names stable.
2. Keep Node-side audit tests under `test/unit/**` with `// @vitest-environment node` unless the test genuinely belongs beside the E2E runner.
3. Do not route perf collection through `/api/logs/client`.
4. Do not reuse server instances or browser contexts across measured samples.
5. Block service workers in the browser context instead of adding app-specific “disable SW” behavior.
6. Use browser-storage seeding only for client-persisted state; use HOME seeding only for server-side fixture data.
7. Prefer browser-observed truth over app instrumentation whenever the browser can already answer the question.
8. Only add app instrumentation for readiness states that transport cannot infer safely.
9. Do not invent summary statistics that the accepted sampling plan does not support.
10. For new runtime ESM imports outside Vite, include `.js` extensions.
11. Leave generated artifacts uncommitted unless the user explicitly asks to version a baseline.
