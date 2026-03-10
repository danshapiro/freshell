# Visible-First Performance Audit Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Build a repeatable visible-first performance audit that runs six production-mode Freshell scenarios in Chromium, captures exactly one `desktop_local` sample and one `mobile_restricted` sample per scenario, and writes one schema-validated JSON artifact at `artifacts/perf/visible-first-audit.json`.

**Architecture:** Land a dedicated audit runner instead of stretching the normal Playwright runner into a performance harness. Reuse the existing isolated `TestServer`, add a narrow browser-side audit bridge for milestones the browser cannot infer on its own, capture transport truth through Chromium CDP plus existing server JSONL logs, and merge everything into one strict artifact contract that can be re-run and diffed later.

**Tech Stack:** TypeScript, Node.js, Playwright Chromium API, existing `test/e2e-browser/helpers/TestServer`, Zod, Vitest, pino JSONL logs, browser `PerformanceObserver`, Node `perf_hooks`.

---

## Strategy Gate

The accepted direction is correct, but the current plan was not yet excellent because it still hid major design decisions inside oversized implementation steps. The execution agent should not have to decide mid-flight how to decompose the runner, the browser bridge, or the transport collectors.

The right problem is not “add some perf tests.” The right problem is “create one trustworthy, repeatable characterization artifact for the current transport so later visible-first work can be evaluated mechanically.” That leads to these hard decisions:

1. The canonical deliverable is the JSON artifact, not a test report.
2. HTTP and WebSocket bytes/timings must come from the browser network stack, not app-side guesses.
3. Browser-visible readiness milestones must come from explicit app instrumentation because neither screenshots nor raw network data can safely infer “focused surface ready.”
4. Server telemetry should be parsed from existing JSONL logs instead of introducing a second server reporting path.
5. Every measured sample must be cold and isolated: fresh server, fresh origin, fresh browser context, cleared storage.

This plan lands the requested end state directly:

1. `npm run perf:audit:visible-first` writes `artifacts/perf/visible-first-audit.json`.
2. The artifact includes all six approved scenarios and both approved profiles.
3. `npm run perf:audit:compare -- --base <old> --candidate <new>` compares two artifacts for later visible-first work.

## Codebase Findings

1. [test-server.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/test/e2e-browser/helpers/test-server.ts) is the correct isolation seam, but it currently deletes the temp HOME immediately and does not expose the logs directory, which blocks post-run collection.
2. [test-harness.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/src/lib/test-harness.ts) already exposes Redux state, WebSocket readiness, and terminal buffers, so it is the right place to surface a perf-audit snapshot instead of inventing a second browser test channel.
3. [perf-logger.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/src/lib/perf-logger.ts) already captures navigation, paint, long-task, memory, and terminal input-to-output data, but today it only writes to console.
4. [client-logger.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/src/lib/client-logger.ts) intentionally filters perf-tagged console payloads before posting to `/api/logs/client`; that is correct and should not be bypassed by this audit.
5. [request-logger.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/server/request-logger.ts), [perf-logger.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/server/perf-logger.ts), and the structured server logs already contain most server-side data the audit needs.
6. [test/e2e-browser/vitest.config.ts](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/test/e2e-browser/vitest.config.ts) currently only includes `helpers/**/*.test.ts`, so a smoke test under `perf/` will not run until that config is widened deliberately.
7. [package.json](/home/user/code/freshell/.worktrees/codex-visible-first-perf-audit/package.json) already has the exact test commands this work should use: `test:client:standard`, `test:e2e:helpers`, and `test`.

## Scenario Matrix

Keep the scenario IDs and profile IDs stable. They are part of the artifact contract.

### Scenarios

1. `auth-required-cold-boot`
   Focused-ready milestone: auth-required UI is visible and no protected hydration ran.
2. `terminal-cold-boot`
   Focused-ready milestone: the active terminal surface is visible and first meaningful output is available.
3. `agent-chat-cold-boot`
   Focused-ready milestone: recent chat content is visible for a long-history agent chat session.
4. `sidebar-search-large-corpus`
   Focused-ready milestone: search results for the active query are visible against a large seeded corpus.
5. `terminal-reconnect-backlog`
   Focused-ready milestone: reconnect shows current terminal output and replay-tail metrics are captured.
6. `offscreen-tab-selection`
   Focused-ready milestone: selecting an offscreen tab hydrates it on demand and records pre-selection offscreen work.

### Profiles

1. `desktop_local`
   Chromium desktop viewport `1440x900`, no throttling.
2. `mobile_restricted`
   Playwright `devices['iPhone 14']`, CDP network emulation at `1.6 Mbps down / 750 kbps up / 150 ms RTT`, no CPU throttling.

## Artifact Contract

The final artifact must be strict, versioned, and shared by the runner, the smoke test, and the compare tool. The top-level shape should be implemented with Zod and include:

1. `schemaVersion`
2. `generatedAt`
3. `git`
4. `build`
5. `profiles`
6. `scenarios`

Each scenario must contain:

1. stable `id` and `description`
2. exactly two samples, one per approved profile
3. `status`, timestamps, and duration
4. browser milestone data
5. raw and summarized HTTP data
6. raw and summarized WebSocket frame data
7. browser perf observations
8. parsed server log observations
9. derived visible-first metrics
10. structured errors
11. per-profile summary values for quick comparison

The audit fails only when the artifact becomes untrustworthy:

1. scenario/profile timeout or crash
2. missing required milestone
3. missing browser or server telemetry
4. final JSON fails schema validation

It does not fail on latency budgets yet.

## Task 1: Define the Audit Contract

**Files:**
- Create: `test/e2e-browser/perf/audit-contract.ts`
- Create: `test/unit/lib/visible-first-audit-contract.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { VisibleFirstAuditSchema } from '@test/e2e-browser/perf/audit-contract'

describe('VisibleFirstAuditSchema', () => {
  it('accepts one desktop sample and one mobile sample for every scenario', () => {
    const result = VisibleFirstAuditSchema.safeParse(buildAuditFixture())
    expect(result.success).toBe(true)
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

1. `AUDIT_SCENARIO_IDS`
2. `AUDIT_PROFILE_IDS`
3. `VisibleFirstAuditSchema`
4. exported TypeScript types inferred from the schema

Keep the schema strict enough that future compare tooling can trust it.

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

## Task 2: Define Scenario Summary Aggregation

**Files:**
- Create: `test/e2e-browser/perf/audit-aggregator.ts`
- Create: `test/unit/lib/visible-first-audit-aggregator.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { summarizeScenarioSamples } from '@test/e2e-browser/perf/audit-aggregator'

describe('summarizeScenarioSamples', () => {
  it('keeps profile order stable and totals bytes by profile', () => {
    const summary = summarizeScenarioSamples(buildScenarioFixture())
    expect(summary.desktop_local.totalHttpBytes).toBe(2048)
    expect(summary.mobile_restricted.totalWsBytes).toBe(8192)
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-aggregator.test.ts
```

Expected: FAIL with a module-not-found error for `audit-aggregator.ts`.

**Step 3: Write the minimal implementation**

Create `test/e2e-browser/perf/audit-aggregator.ts` as pure functions only. It should:

1. summarize one sample into totals the compare tool will use
2. summarize one scenario into `desktop_local` and `mobile_restricted` entries
3. never import Playwright, DOM, or filesystem code

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-aggregator.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/audit-aggregator.ts test/unit/lib/visible-first-audit-aggregator.test.ts
git commit -m "test: add visible-first audit aggregation"
```

## Task 3: Make TestServer Preserve Audit Inputs and Outputs

**Files:**
- Modify: `test/e2e-browser/helpers/test-server.ts`
- Modify: `test/e2e-browser/helpers/test-server.test.ts`

**Step 1: Write the failing test**

```ts
it('runs setupHome before server start and exposes home and logs directories', async () => {
  const server = new TestServer({
    setupHome: async (homeDir) => {
      await fs.promises.mkdir(path.join(homeDir, '.claude', 'projects', 'perf'), { recursive: true })
    },
    preserveHomeOnStop: true,
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

Call `setupHome` after creating the temp HOME and before starting the server. Keep default cleanup behavior unchanged for non-audit callers.

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:e2e:helpers -- test/e2e-browser/helpers/test-server.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/helpers/test-server.ts test/e2e-browser/helpers/test-server.test.ts
git commit -m "test: extend test server for perf audit runs"
```

## Task 4: Add Deterministic Audit Fixture Seeding

**Files:**
- Create: `test/e2e-browser/perf/seed-home.ts`
- Create: `test/unit/lib/visible-first-audit-seed-home.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { seedVisibleFirstAuditHome } from '@test/e2e-browser/perf/seed-home'

describe('seedVisibleFirstAuditHome', () => {
  it('creates the large deterministic fixture set used by the audit scenarios', async () => {
    const result = await seedVisibleFirstAuditHome(tmpHome)
    expect(result.sessionCount).toBeGreaterThan(100)
    expect(result.scenarioIds).toContain('sidebar-search-large-corpus')
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-seed-home.test.ts
```

Expected: FAIL with a module-not-found error for `seed-home.ts`.

**Step 3: Write the minimal implementation**

Create `seed-home.ts` that deterministically writes:

1. large session corpus for sidebar/search
2. long agent-chat history
3. layout state for offscreen tab selection
4. data needed for reconnect/backlog scenarios

Reuse existing fixture shapes already understood by the app instead of inventing new file formats.

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-seed-home.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/seed-home.ts test/unit/lib/visible-first-audit-seed-home.test.ts
git commit -m "test: add deterministic visible-first audit fixtures"
```

## Task 5: Add the Browser Audit Bridge Core

**Files:**
- Create: `src/lib/perf-audit-bridge.ts`
- Modify: `src/lib/test-harness.ts`
- Create: `test/unit/client/lib/perf-audit-bridge.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { createPerfAuditBridge } from '@/lib/perf-audit-bridge'

describe('createPerfAuditBridge', () => {
  it('records milestones and exposes immutable snapshots', () => {
    const audit = createPerfAuditBridge()
    audit.mark('app.bootstrap_ready', { view: 'terminal' })
    const snapshot = audit.snapshot()
    expect(snapshot.milestones['app.bootstrap_ready']).toBeTypeOf('number')
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/client/lib/perf-audit-bridge.test.ts
```

Expected: FAIL because the audit bridge does not exist.

**Step 3: Write the minimal implementation**

Create `src/lib/perf-audit-bridge.ts` as an in-memory collector with:

1. milestone recording
2. contextual metadata for milestones
3. client perf event collection
4. terminal latency sample collection
5. `snapshot()` returning serializable data

Expose `getPerfAuditSnapshot()` through `window.__FRESHELL_TEST_HARNESS__`.

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/client/lib/perf-audit-bridge.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/perf-audit-bridge.ts src/lib/test-harness.ts test/unit/client/lib/perf-audit-bridge.test.ts
git commit -m "test: add browser perf audit bridge"
```

## Task 6: Feed Existing Client Perf Signals into the Audit Bridge

**Files:**
- Modify: `src/lib/perf-logger.ts`
- Modify: `test/unit/client/lib/perf-logger.test.ts`

**Step 1: Write the failing test**

```ts
it('forwards perf entries into the audit sink when one is installed', async () => {
  const received: unknown[] = []
  installClientPerfAuditSink((entry) => received.push(entry))
  logClientPerf('perf.paint', { name: 'first-contentful-paint' })
  expect(received).toHaveLength(1)
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
2. forward `logClientPerf` payloads to the sink
3. forward terminal input-to-output latency samples to the sink

Do not change normal logging behavior and do not route perf data through `/api/logs/client`.

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/client/lib/perf-logger.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/perf-logger.ts test/unit/client/lib/perf-logger.test.ts
git commit -m "test: pipe client perf logs into audit sink"
```

## Task 7: Mark App-Level Readiness Milestones

**Files:**
- Modify: `src/App.tsx`
- Modify: `test/unit/client/components/App.lazy-views.test.tsx`

**Step 1: Write the failing test**

```ts
it('marks auth-required readiness when booting without a token in perf audit mode', async () => {
  renderAppAt('/?e2e=1&perfAudit=1')
  expect(await getAuditMilestone('app.auth_required_visible')).toBeGreaterThanOrEqual(0)
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/App.lazy-views.test.tsx
```

Expected: FAIL because the audit milestones are not emitted.

**Step 3: Write the minimal implementation**

In `src/App.tsx`, when `?e2e=1&perfAudit=1` is present:

1. install the audit bridge
2. mark `app.bootstrap_started`
3. mark `app.bootstrap_ready`
4. mark `app.ws_ready`
5. mark `app.auth_required_visible` when that path wins

Keep audit-specific logic behind the runtime flag so normal production behavior stays unchanged.

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/App.lazy-views.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/App.tsx test/unit/client/components/App.lazy-views.test.tsx
git commit -m "test: add app bootstrap audit milestones"
```

## Task 8: Mark Terminal and Agent-Chat Readiness Milestones

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/components/agent-chat/AgentChatView.tsx`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Create: `test/unit/client/components/AgentChatView.perf-audit.test.tsx`

**Step 1: Write the failing tests**

```ts
it('marks terminal surface visibility and first output in perf audit mode', async () => {
  renderTerminalViewForAudit()
  expect(await getAuditMilestone('terminal.surface_visible')).toBeGreaterThanOrEqual(0)
  expect(await getAuditMilestone('terminal.first_output')).toBeGreaterThanOrEqual(0)
})
```

```ts
it('marks agent chat surface visibility when recent messages render', async () => {
  renderAgentChatViewForAudit(longHistoryFixture)
  expect(await getAuditMilestone('agent_chat.surface_visible')).toBeGreaterThanOrEqual(0)
})
```

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/AgentChatView.perf-audit.test.tsx
```

Expected: FAIL because those milestones do not exist.

**Step 3: Write the minimal implementation**

In `TerminalView.tsx`:

1. mark `terminal.surface_visible` when the terminal is attached and visible
2. mark `terminal.first_output` on the first output for the active terminal

In `AgentChatView.tsx`:

1. mark `agent_chat.surface_visible` when the recent visible window renders
2. mark `agent_chat.restore_timed_out` if the existing timeout fallback path fires

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/AgentChatView.perf-audit.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/TerminalView.tsx src/components/agent-chat/AgentChatView.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/AgentChatView.perf-audit.test.tsx
git commit -m "test: add terminal and agent-chat audit milestones"
```

## Task 9: Record HTTP and WebSocket Transport Data Through CDP

**Files:**
- Create: `test/e2e-browser/perf/cdp-network-recorder.ts`
- Create: `test/unit/lib/visible-first-audit-network-recorder.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { NetworkRecorder } from '@test/e2e-browser/perf/cdp-network-recorder'

describe('NetworkRecorder', () => {
  it('groups websocket frames by direction and message type', () => {
    const recorder = new NetworkRecorder()
    recorder.onFrame('received', JSON.stringify({ type: 'sessions.updated' }))
    recorder.onFrame('sent', JSON.stringify({ type: 'hello' }))
    const summary = recorder.summarize()
    expect(summary.byType).toContainEqual(
      expect.objectContaining({ direction: 'received', type: 'sessions.updated', count: 1 }),
    )
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
2. join `responseReceived` and `loadingFinished` into HTTP samples
3. record WebSocket frames from `webSocketFrameSent` and `webSocketFrameReceived`
4. bucket frame types from JSON payload `type`, falling back to `unknown`
5. expose raw samples plus `byPath` and `byType` summaries

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

## Task 10: Parse Server Debug Logs Into Structured Audit Data

**Files:**
- Create: `test/e2e-browser/perf/server-log-parser.ts`
- Create: `test/unit/lib/visible-first-audit-server-log-parser.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { parseServerDebugLogs } from '@test/e2e-browser/perf/server-log-parser'

describe('parseServerDebugLogs', () => {
  it('extracts http_request and perf_system entries from server logs', async () => {
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

1. reads `server-debug.*.jsonl` files from the sample log directory
2. extracts `http_request`
3. extracts `perf_system`
4. extracts server perf events and terminal stream perf events
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

## Task 11: Define the Fixed Profile Matrix

**Files:**
- Create: `test/e2e-browser/perf/profiles.ts`
- Create: `test/unit/lib/visible-first-audit-profiles.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { AUDIT_PROFILES } from '@test/e2e-browser/perf/profiles'

describe('AUDIT_PROFILES', () => {
  it('defines exactly the approved desktop and restricted mobile profiles', () => {
    expect(AUDIT_PROFILES.map((profile) => profile.id)).toEqual([
      'desktop_local',
      'mobile_restricted',
    ])
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-profiles.test.ts
```

Expected: FAIL because `profiles.ts` does not exist.

**Step 3: Write the minimal implementation**

Create `profiles.ts` with immutable definitions for:

1. desktop viewport
2. mobile device emulation
3. restricted-bandwidth CDP settings

Keep all approved profile constants in one file so the runner and compare tool cannot drift.

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-profiles.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/profiles.ts test/unit/lib/visible-first-audit-profiles.test.ts
git commit -m "test: define visible-first audit profiles"
```

## Task 12: Define the Fixed Scenario Matrix

**Files:**
- Create: `test/e2e-browser/perf/scenarios.ts`
- Create: `test/unit/lib/visible-first-audit-scenarios.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { AUDIT_SCENARIOS } from '@test/e2e-browser/perf/scenarios'

describe('AUDIT_SCENARIOS', () => {
  it('defines the approved six scenarios in stable order', () => {
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

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-scenarios.test.ts
```

Expected: FAIL because `scenarios.ts` does not exist.

**Step 3: Write the minimal implementation**

Create `scenarios.ts` as data plus small driver functions. Each scenario must:

1. navigate with `?e2e=1&perfAudit=1`
2. include or omit the token intentionally
3. wait for one focused-ready milestone
4. perform only the extra user action specific to that scenario
5. return a final browser audit snapshot

Do not let scenario files own browser lifecycle, artifact writing, or log parsing.

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-scenarios.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/scenarios.ts test/unit/lib/visible-first-audit-scenarios.test.ts
git commit -m "test: define visible-first audit scenarios"
```

## Task 13: Build the Per-Sample Runner

**Files:**
- Create: `test/e2e-browser/perf/run-sample.ts`
- Create: `test/unit/lib/visible-first-audit-run-sample.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { runAuditSample } from '@test/e2e-browser/perf/run-sample'

describe('runAuditSample', () => {
  it('returns a schema-shaped sample with merged browser, network, and server data', async () => {
    const sample = await runAuditSample(buildRunSampleFixture())
    expect(sample.profile).toBe('desktop_local')
    expect(sample.browser.longTasks).toBeDefined()
    expect(sample.server.httpRequests).toBeDefined()
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
3. apply the selected profile
4. attach CDP recorder
5. execute one scenario driver
6. collect browser audit snapshot
7. parse server logs
8. derive visible-first metrics
9. return one sample object
10. clean up browser and server in `finally`

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

## Task 14: Build the Full Audit Runner

**Files:**
- Create: `test/e2e-browser/perf/run-visible-first-audit.ts`
- Create: `test/e2e-browser/perf/audit-cli.ts`
- Create: `scripts/visible-first-audit.ts`
- Create: `test/unit/lib/visible-first-audit-cli.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { parseAuditArgs } from '@test/e2e-browser/perf/audit-cli'

describe('parseAuditArgs', () => {
  it('defaults output to artifacts/perf/visible-first-audit.json', () => {
    expect(parseAuditArgs([]).outputPath).toContain('artifacts/perf/visible-first-audit.json')
  })
})
```

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-cli.test.ts
```

Expected: FAIL because the CLI helpers do not exist.

**Step 3: Write the minimal implementation**

Create:

1. `run-visible-first-audit.ts` to loop serially across the fixed scenario/profile matrix
2. `audit-cli.ts` to parse output path and optional reduced smoke-test filters
3. `scripts/visible-first-audit.ts` to invoke the runner and write the artifact

The full runner must:

1. ensure a perf-enabled build exists
2. validate the final artifact with `VisibleFirstAuditSchema`
3. create `artifacts/perf/` when needed
4. write exactly one JSON file per invocation

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-cli.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/run-visible-first-audit.ts test/e2e-browser/perf/audit-cli.ts scripts/visible-first-audit.ts test/unit/lib/visible-first-audit-cli.test.ts
git commit -m "feat: add visible-first audit runner"
```

## Task 15: Build the Artifact Compare Tool

**Files:**
- Create: `scripts/compare-visible-first-audit.ts`
- Modify: `package.json`
- Create: `test/unit/lib/visible-first-audit-compare.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { compareVisibleFirstAudits } from '../../scripts/compare-visible-first-audit'

describe('compareVisibleFirstAudits', () => {
  it('diffs two schema-valid artifacts by scenario and profile', () => {
    const diff = compareVisibleFirstAudits(baseAuditFixture(), candidateAuditFixture())
    expect(diff.scenarios[0]?.id).toBe('terminal-cold-boot')
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-compare.test.ts
```

Expected: FAIL because the compare tool does not exist.

**Step 3: Write the minimal implementation**

Create `compare-visible-first-audit.ts` that:

1. loads two schema-valid artifacts
2. compares them by scenario and profile
3. emits concise JSON deltas for key metrics

Add both scripts to `package.json`:

```json
"perf:audit:visible-first": "tsx scripts/visible-first-audit.ts",
"perf:audit:compare": "tsx scripts/compare-visible-first-audit.ts"
```

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-compare.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/compare-visible-first-audit.ts package.json test/unit/lib/visible-first-audit-compare.test.ts
git commit -m "feat: add visible-first audit comparison tool"
```

## Task 16: Add Artifact Output Hygiene and Smoke Coverage

**Files:**
- Modify: `.gitignore`
- Modify: `test/e2e-browser/vitest.config.ts`
- Create: `test/e2e-browser/perf/visible-first-audit.smoke.test.ts`
- Modify: `README.md`

**Step 1: Write the failing smoke test**

```ts
import { describe, expect, it } from 'vitest'
import { readFile } from 'fs/promises'
import path from 'path'
import os from 'os'
import { mkdtemp } from 'fs/promises'
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

Expected: FAIL because the E2E helper config does not include `perf/**/*.test.ts` yet or the runner is not yet test-friendly.

**Step 3: Write the minimal implementation**

1. Widen `test/e2e-browser/vitest.config.ts` to include the new `perf/**/*.test.ts`.
2. Add `.gitignore` entry:

```gitignore
artifacts/perf/
```

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
npm run test:client:standard -- test/unit/lib/visible-first-audit-contract.test.ts test/unit/lib/visible-first-audit-aggregator.test.ts test/unit/lib/visible-first-audit-seed-home.test.ts test/unit/lib/visible-first-audit-network-recorder.test.ts test/unit/lib/visible-first-audit-server-log-parser.test.ts test/unit/lib/visible-first-audit-profiles.test.ts test/unit/lib/visible-first-audit-scenarios.test.ts test/unit/lib/visible-first-audit-run-sample.test.ts test/unit/lib/visible-first-audit-cli.test.ts test/unit/lib/visible-first-audit-compare.test.ts test/unit/client/lib/perf-audit-bridge.test.ts test/unit/client/lib/perf-logger.test.ts test/unit/client/components/App.lazy-views.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/AgentChatView.perf-audit.test.tsx
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
node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync('artifacts/perf/visible-first-audit.json','utf8')); console.log(data.schemaVersion, data.scenarios.length)"
```

Expected output:

```text
1 6
```

**Step 5: Verify compare mode**

Run:

```bash
npm run perf:audit:compare -- --base artifacts/perf/visible-first-audit.json --candidate artifacts/perf/visible-first-audit.json
```

Expected: PASS with zero deltas or an equivalent empty diff.

## Notes for the Execution Agent

1. Keep scenario IDs, profile IDs, and artifact field names stable. Longitudinal value depends on it.
2. Do not reuse browser contexts or server instances across measured samples.
3. Do not route perf collection through `/api/logs/client`.
4. Prefer browser-observed truth over app instrumentation whenever the browser can already answer the question.
5. Only add app instrumentation for readiness states that cannot be inferred safely from transport events alone.
6. Leave generated artifacts uncommitted unless explicitly asked to version a baseline.
