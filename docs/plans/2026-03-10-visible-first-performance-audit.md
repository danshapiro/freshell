# Visible-First Performance Audit Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Build a repeatable visible-first baseline audit that runs six production-mode Freshell scenarios in Chromium, records exactly one desktop sample and one mobile restricted-bandwidth sample per scenario, and writes one machine-readable JSON artifact at `artifacts/perf/visible-first-audit.json`.

**Architecture:** Do not bolt this onto the existing Playwright test runner. Land a dedicated audit command that reuses the existing isolated `TestServer` harness, launches Chromium directly, captures HTTP and WebSocket transport data through Chromium DevTools Protocol, captures browser milestones and client perf samples through an in-page audit bridge exposed via `window.__FRESHELL_TEST_HARNESS__`, and merges that with parsed server JSONL debug logs into one schema-validated artifact. Keep the runtime path clean: deterministic fixture seeding, fresh server origin per sample, serial execution, and no threshold-heavy pass/fail behavior beyond audit integrity.

**Tech Stack:** TypeScript, Node.js, `@playwright/test` Chromium API, existing `test/e2e-browser/helpers/TestServer`, Zod, Vitest, pino JSONL logs, browser `PerformanceObserver`, Node `perf_hooks`.

---

## Strategy Gate

The accepted audit strategy is correct, but the clean implementation path is narrower than a generic "perf test suite":

1. The canonical output is a JSON artifact, not a Playwright report. A dedicated audit runner is the right abstraction because it owns serial sample order, artifact writing, and scenario/profile loops directly.
2. The transport numbers should come from the browser network stack, not from app-level guesses. Use Chromium CDP for HTTP timing/bytes and WebSocket frame sizes/types.
3. Browser readiness should not be inferred from screenshots or console scraping. Add an explicit in-page audit bridge for milestones and structured client perf snapshots, then read that bridge through the existing test harness.
4. Server telemetry already exists in structured JSONL logs. Parse those logs instead of inventing a second server-side reporting channel.
5. Cold-start repeatability matters more than synthetic medians. Start a fresh production server on a fresh ephemeral port for every sample, clear browser state every time, and run exactly the two samples the user approved.

This lands the requested end state directly:

1. `npm run perf:audit:visible-first` builds with perf enabled, runs all twelve samples, and writes one JSON file.
2. `npm run perf:audit:compare -- --base <old> --candidate <new>` diffs two audit artifacts for the later transport work.
3. The audit itself has unit coverage for schema/aggregation/parsing and smoke E2E coverage for the full pipeline.

## Codebase Findings

1. `test/e2e-browser/helpers/test-server.ts` is the correct server isolation seam, but today it hides the logs directory and deletes the temp home on stop, which is incompatible with post-run artifact collection.
2. `test/e2e-browser/playwright.config.ts` is deliberately parallel and multi-project in CI. That is good for correctness tests and bad for stable characterization, so the audit must not reuse that runner shape.
3. `src/lib/test-harness.ts` already exposes Redux state, WebSocket state, and terminal buffer access, but it does not expose explicit performance milestones or a structured perf snapshot.
4. `src/lib/perf-logger.ts` already emits navigation, paint, long-task, resource, memory, and terminal input-to-output data, but it only logs to the console. That is useful as an event source, but the audit needs a structured in-memory sink.
5. `src/lib/client-logger.ts` intentionally drops perf-tagged console entries before posting to `/api/logs/client`. That is correct behavior for normal logging and a strong reason not to use the client-logs API as the audit collector.
6. `server/request-logger.ts`, `server/perf-logger.ts`, and `server/logger.ts` already produce the server-side data the audit needs: request timing, payload size headers, event-loop delay, and memory samples in structured JSONL.
7. `src/main.tsx` registers the service worker unconditionally, so cold-start correctness depends on fresh origin and storage isolation per sample. Reusing a single server/browser context would contaminate the audit.

## Scenario Matrix

The audit runner must hardcode this matrix and keep the scenario IDs stable:

| Scenario ID | Scenario | Focused-ready milestone |
| --- | --- | --- |
| `auth-required-cold-boot` | Cold boot without a valid token | Auth-required modal is visible and no protected data hydration ran |
| `terminal-cold-boot` | Cold boot into a terminal pane | Terminal surface is visible with first meaningful output before/without waiting for later background work |
| `agent-chat-cold-boot` | Cold boot into an agent chat pane with long history | Recent turns are visible and older history remains deferred |
| `sidebar-search-large-corpus` | Open session browsing and search a large corpus | Search results window is visible for the active query |
| `terminal-reconnect-backlog` | Reconnect to a busy terminal with backlog | Current terminal buffer is visible and replay tail metrics are captured |
| `offscreen-tab-selection` | Boot with offscreen tabs, then select one after first paint | Newly selected tab hydrates on demand and offscreen work before selection is measured |

Profiles are also fixed:

1. `desktop_local`
   - Chromium desktop viewport (`1440x900`)
   - no network throttling
   - fresh context, storage cleared
2. `mobile_restricted`
   - Chromium device emulation based on `devices['iPhone 14']`
   - CDP `Network.emulateNetworkConditions` at `1.6 Mbps down / 750 kbps up / 150 ms RTT`
   - no CPU throttling
   - fresh context, storage cleared

## Artifact Contract

Keep the artifact human-readable JSON, but treat the schema as strict and versioned. The top-level shape should be implemented with Zod and exported for both the runner and tests:

```ts
export const VisibleFirstAuditSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  git: z.object({
    commit: z.string(),
    branch: z.string(),
    dirty: z.boolean(),
  }),
  build: z.object({
    clientPerfEnabled: z.boolean(),
    serverPerfEnabled: z.boolean(),
    command: z.string(),
  }),
  profiles: z.array(z.enum(['desktop_local', 'mobile_restricted'])).length(2),
  scenarios: z.array(z.object({
    id: z.string(),
    description: z.string(),
    samples: z.array(z.object({
      profile: z.enum(['desktop_local', 'mobile_restricted']),
      status: z.enum(['passed', 'failed', 'incomplete']),
      startedAt: z.string(),
      durationMs: z.number(),
      milestones: z.record(z.string(), z.number()),
      http: z.object({
        requests: z.array(z.object({
          path: z.string(),
          method: z.string(),
          status: z.number().optional(),
          durationMs: z.number(),
          transferBytes: z.number().nullable(),
          encodedBodyBytes: z.number().nullable(),
          decodedBodyBytes: z.number().nullable(),
        })),
        byPath: z.array(z.object({
          path: z.string(),
          count: z.number(),
          totalDurationMs: z.number(),
          totalTransferBytes: z.number(),
        })),
      }),
      ws: z.object({
        frames: z.array(z.object({
          direction: z.enum(['sent', 'received']),
          type: z.string(),
          bytes: z.number(),
          timestampMs: z.number(),
        })),
        byType: z.array(z.object({
          direction: z.enum(['sent', 'received']),
          type: z.string(),
          count: z.number(),
          totalBytes: z.number(),
        })),
      }),
      browser: z.object({
        navigation: z.array(z.record(z.string(), z.unknown())),
        paints: z.array(z.record(z.string(), z.unknown())),
        longTasks: z.array(z.record(z.string(), z.unknown())),
        resources: z.array(z.record(z.string(), z.unknown())),
        memorySamples: z.array(z.record(z.string(), z.unknown())),
        terminalInputToOutput: z.array(z.number()),
      }),
      server: z.object({
        httpRequests: z.array(z.record(z.string(), z.unknown())),
        perfSystem: z.array(z.record(z.string(), z.unknown())),
        perfEvents: z.array(z.record(z.string(), z.unknown())),
      }),
      derived: z.object({
        focusedReadyMs: z.number().nullable(),
        wsReadyMs: z.number().nullable(),
        offscreenRequestsBeforeFocusedReady: z.number(),
        offscreenWsBytesBeforeFocusedReady: z.number(),
      }),
      errors: z.array(z.object({
        code: z.string(),
        message: z.string(),
      })),
    })).length(2),
    summary: z.object({
      desktop_local: z.object({
        focusedReadyMs: z.number().nullable(),
        totalHttpBytes: z.number(),
        totalWsBytes: z.number(),
      }),
      mobile_restricted: z.object({
        focusedReadyMs: z.number().nullable(),
        totalHttpBytes: z.number(),
        totalWsBytes: z.number(),
      }),
    }),
  })),
})
```

The runner must fail the audit only when the artifact is untrustworthy:

1. a scenario/profile crashes or times out
2. required milestones are missing
3. server or browser telemetry could not be collected
4. the final JSON does not satisfy `VisibleFirstAuditSchema`

It must not fail on subjective latency budgets yet.

## Task 1: Define the Audit Contract and Aggregation Rules

**Files:**
- Create: `test/e2e-browser/perf/audit-contract.ts`
- Create: `test/e2e-browser/perf/audit-aggregator.ts`
- Create: `test/unit/lib/visible-first-audit-contract.test.ts`
- Create: `test/unit/lib/visible-first-audit-aggregator.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import {
  VisibleFirstAuditSchema,
} from '@test/e2e-browser/perf/audit-contract'
import { summarizeScenarioSamples } from '@test/e2e-browser/perf/audit-aggregator'

describe('VisibleFirstAuditSchema', () => {
  it('accepts one desktop and one mobile sample per scenario', () => {
    const parsed = VisibleFirstAuditSchema.safeParse(buildAuditFixture())
    expect(parsed.success).toBe(true)
  })
})

describe('summarizeScenarioSamples', () => {
  it('keeps profile order stable and totals bytes by profile', () => {
    const summary = summarizeScenarioSamples(buildScenarioFixture())
    expect(summary.desktop_local.totalHttpBytes).toBe(2048)
    expect(summary.mobile_restricted.totalWsBytes).toBe(8192)
  })
})
```

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-contract.test.ts test/unit/lib/visible-first-audit-aggregator.test.ts
```

Expected: FAIL with module-not-found errors for the new audit contract files.

**Step 3: Write the minimal implementation**

Create `test/e2e-browser/perf/audit-contract.ts` with the Zod schema, exported types, stable profile/scenario enums, and helper builders. Create `test/e2e-browser/perf/audit-aggregator.ts` with pure functions only:

```ts
export const AUDIT_PROFILES = ['desktop_local', 'mobile_restricted'] as const

export function summarizeScenarioSamples(
  samples: VisibleFirstAuditScenario['samples'],
): VisibleFirstAuditScenario['summary'] {
  const byProfile = new Map(samples.map((sample) => [sample.profile, sample]))
  return {
    desktop_local: summarizeProfile(byProfile.get('desktop_local')),
    mobile_restricted: summarizeProfile(byProfile.get('mobile_restricted')),
  }
}
```

Keep this layer intentionally free of Playwright, filesystem, and DOM concerns so it stays easy to test and safe to reuse from both the runner and compare tool.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-contract.test.ts test/unit/lib/visible-first-audit-aggregator.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/audit-contract.ts test/e2e-browser/perf/audit-aggregator.ts test/unit/lib/visible-first-audit-contract.test.ts test/unit/lib/visible-first-audit-aggregator.test.ts
git commit -m "test: define visible-first audit contract"
```

## Task 2: Extend TestServer for Deterministic Fixture Seeding and Log Collection

**Files:**
- Modify: `test/e2e-browser/helpers/test-server.ts`
- Modify: `test/e2e-browser/helpers/test-server.test.ts`
- Create: `test/e2e-browser/perf/seed-home.ts`
- Create: `test/unit/lib/visible-first-audit-seed-home.test.ts`

**Step 1: Write the failing tests**

```ts
it('runs setupHome before the server starts and exposes the logs directory', async () => {
  const server = new TestServer({
    setupHome: async (homeDir) => {
      await fs.promises.writeFile(path.join(homeDir, '.claude', 'projects', 'perf', 'seed.jsonl'), '...')
    },
  })

  const info = await server.start()
  expect(info.homeDir).toContain('freshell-e2e-')
  expect(info.logsDir).toContain(path.join('.freshell', 'logs'))
  await server.stop()
})
```

```ts
it('seeds a large visible-first fixture set deterministically', async () => {
  const seed = await seedVisibleFirstAuditHome(tmpHome)
  expect(seed.scenarioIds).toContain('sidebar-search-large-corpus')
  expect(seed.sessionCount).toBeGreaterThan(100)
})
```

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:e2e:helpers -- test/e2e-browser/helpers/test-server.test.ts
npm run test:client:standard -- test/unit/lib/visible-first-audit-seed-home.test.ts
```

Expected: FAIL because `setupHome`, `homeDir`, `logsDir`, and the new seed helper do not exist yet.

**Step 3: Write the minimal implementation**

1. Extend `TestServerOptions` with:
   - `setupHome?: (homeDir: string) => Promise<void>`
   - `preserveHomeOnStop?: boolean`
2. Extend `TestServerInfo` with:
   - `homeDir`
   - `logsDir`
3. Invoke `setupHome` after creating the temp HOME and before spawning the server.
4. Keep default cleanup behavior, but allow the audit runner to preserve the temp HOME until after logs are parsed.
5. Create `test/e2e-browser/perf/seed-home.ts` with deterministic seed builders:
   - large Claude/Codex session corpus for sidebar/history search
   - long agent-chat session history
   - layout/tab seed for offscreen tab selection
   - any metadata files needed by the existing indexers

Use the existing `test/fixtures/sessions/healthy.jsonl` format as the base shape instead of inventing an unproven JSONL dialect.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:e2e:helpers -- test/e2e-browser/helpers/test-server.test.ts
npm run test:client:standard -- test/unit/lib/visible-first-audit-seed-home.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/helpers/test-server.ts test/e2e-browser/helpers/test-server.test.ts test/e2e-browser/perf/seed-home.ts test/unit/lib/visible-first-audit-seed-home.test.ts
git commit -m "test: add deterministic audit server seeding"
```

## Task 3: Add the In-Page Audit Bridge and Explicit Milestones

**Files:**
- Create: `src/lib/perf-audit-bridge.ts`
- Modify: `src/lib/test-harness.ts`
- Modify: `src/lib/perf-logger.ts`
- Modify: `src/App.tsx`
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/components/agent-chat/AgentChatView.tsx`
- Create: `test/unit/client/lib/perf-audit-bridge.test.ts`
- Modify: `test/unit/client/lib/perf-logger.test.ts`

**Step 1: Write the failing tests**

```ts
it('records milestones and exposes a snapshot through the test harness', () => {
  const audit = createPerfAuditBridge()
  audit.mark('app.bootstrap_ready', { view: 'terminal' })
  audit.recordClientPerf({ event: 'perf.paint', startTime: 123.45 })
  const snapshot = audit.snapshot()
  expect(snapshot.milestones['app.bootstrap_ready']).toBeTypeOf('number')
  expect(snapshot.clientPerf[0].event).toBe('perf.paint')
})
```

```ts
it('forwards logClientPerf events into the audit bridge when installed', async () => {
  const { logClientPerf, installClientPerfAuditSink } = await import('@/lib/perf-logger')
  const received: unknown[] = []
  installClientPerfAuditSink((entry) => received.push(entry))
  logClientPerf('perf.paint', { name: 'first-contentful-paint' })
  expect(received).toHaveLength(1)
})
```

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:client:standard -- test/unit/client/lib/perf-audit-bridge.test.ts test/unit/client/lib/perf-logger.test.ts
```

Expected: FAIL because the audit bridge and perf sink hooks do not exist.

**Step 3: Write the minimal implementation**

Create `src/lib/perf-audit-bridge.ts` as a tiny in-memory collector:

```ts
export type PerfAuditSnapshot = {
  startedAtMs: number
  milestones: Record<string, number>
  milestoneContext: Record<string, Record<string, unknown>>
  clientPerf: Array<Record<string, unknown>>
  terminalSamples: number[]
}

export function createPerfAuditBridge() {
  const startedAtMs = performance.now()
  const milestones: Record<string, number> = {}
  const clientPerf: Array<Record<string, unknown>> = []

  return {
    mark(name: string, context: Record<string, unknown> = {}) {
      if (milestones[name] !== undefined) return
      milestones[name] = Number((performance.now() - startedAtMs).toFixed(2))
    },
    recordClientPerf(entry: Record<string, unknown>) {
      clientPerf.push(entry)
    },
    snapshot(): PerfAuditSnapshot {
      return { startedAtMs, milestones: { ...milestones }, milestoneContext: {}, clientPerf: [...clientPerf], terminalSamples: [] }
    },
  }
}
```

Wire it like this:

1. `src/lib/perf-logger.ts`
   - add `installClientPerfAuditSink`
   - call the sink inside `logClientPerf`
   - push terminal input-to-output samples into the sink as raw numbers
2. `src/lib/test-harness.ts`
   - expose `getPerfAuditSnapshot()`
3. `src/App.tsx`
   - install the bridge when `?e2e=1&perfAudit=1`
   - mark `app.bootstrap_started`, `app.bootstrap_ready`, `app.ws_ready`, `app.auth_required_visible`
4. `src/components/TerminalView.tsx`
   - mark `terminal.surface_visible` once the xterm instance is attached and visible
   - mark `terminal.first_output` on first output frame for the active terminal
5. `src/components/agent-chat/AgentChatView.tsx`
   - mark `agent_chat.surface_visible` when recent messages render
   - mark `agent_chat.restore_timed_out` if that fallback path fires

Do not add generic audit code to unrelated components. Keep the seam intentionally narrow and scenario-oriented.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:client:standard -- test/unit/client/lib/perf-audit-bridge.test.ts test/unit/client/lib/perf-logger.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/perf-audit-bridge.ts src/lib/test-harness.ts src/lib/perf-logger.ts src/App.tsx src/components/TerminalView.tsx src/components/agent-chat/AgentChatView.tsx test/unit/client/lib/perf-audit-bridge.test.ts test/unit/client/lib/perf-logger.test.ts
git commit -m "test: add browser audit bridge for perf runs"
```

## Task 4: Build the CDP Network Recorder and Server Log Parser

**Files:**
- Create: `test/e2e-browser/perf/cdp-network-recorder.ts`
- Create: `test/e2e-browser/perf/server-log-parser.ts`
- Create: `test/unit/lib/visible-first-audit-server-log-parser.test.ts`
- Create: `test/unit/lib/visible-first-audit-network-recorder.test.ts`

**Step 1: Write the failing tests**

```ts
it('groups websocket frames by parsed message type and direction', () => {
  const recorder = new NetworkRecorder()
  recorder.onFrame('received', JSON.stringify({ type: 'sessions.updated' }))
  recorder.onFrame('received', JSON.stringify({ type: 'sessions.updated' }))
  recorder.onFrame('sent', JSON.stringify({ type: 'hello' }))
  expect(recorder.summarize().byType).toContainEqual(
    expect.objectContaining({ direction: 'received', type: 'sessions.updated', count: 2 }),
  )
})
```

```ts
it('extracts http_request and perf_system entries from server debug logs', async () => {
  const parsed = await parseServerDebugLogs([fixtureLogPath])
  expect(parsed.httpRequests).toHaveLength(1)
  expect(parsed.perfSystem[0]?.event).toBe('perf_system')
})
```

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-server-log-parser.test.ts test/unit/lib/visible-first-audit-network-recorder.test.ts
```

Expected: FAIL because the parser and recorder files do not exist yet.

**Step 3: Write the minimal implementation**

Implement `cdp-network-recorder.ts` around a Chromium CDP session:

```ts
await client.send('Network.enable')
client.on('Network.responseReceived', handleResponseReceived)
client.on('Network.loadingFinished', handleLoadingFinished)
client.on('Network.webSocketFrameSent', handleWsSent)
client.on('Network.webSocketFrameReceived', handleWsReceived)
```

Rules:

1. For HTTP, join `responseReceived` with `loadingFinished` to calculate duration and transfer size.
2. For WebSocket frames, parse JSON payloads and bucket by `type`; if parsing fails, bucket as `unknown`.
3. Preserve raw samples and summarized `byPath`/`byType` views.

Implement `server-log-parser.ts` to read every `server-debug.*.jsonl` file in the sample log directory and extract:

1. `event === 'http_request'`
2. `event === 'perf_system'`
3. any `event` starting with `perf.` or the existing terminal stream perf event names

Keep parsing forgiving: malformed log lines should be counted in parser diagnostics, not crash the whole run.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-server-log-parser.test.ts test/unit/lib/visible-first-audit-network-recorder.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/cdp-network-recorder.ts test/e2e-browser/perf/server-log-parser.ts test/unit/lib/visible-first-audit-server-log-parser.test.ts test/unit/lib/visible-first-audit-network-recorder.test.ts
git commit -m "test: capture transport and server perf telemetry"
```

## Task 5: Implement Scenario Drivers and the Profile Matrix

**Files:**
- Create: `test/e2e-browser/perf/profiles.ts`
- Create: `test/e2e-browser/perf/scenarios.ts`
- Create: `test/e2e-browser/perf/run-sample.ts`
- Create: `test/unit/lib/visible-first-audit-scenarios.test.ts`

**Step 1: Write the failing tests**

```ts
it('defines the accepted scenario IDs in stable order', async () => {
  const { AUDIT_SCENARIOS } = await import('@test/e2e-browser/perf/scenarios')
  expect(AUDIT_SCENARIOS.map((s) => s.id)).toEqual([
    'auth-required-cold-boot',
    'terminal-cold-boot',
    'agent-chat-cold-boot',
    'sidebar-search-large-corpus',
    'terminal-reconnect-backlog',
    'offscreen-tab-selection',
  ])
})

it('defines exactly the two approved profiles', async () => {
  const { AUDIT_PROFILES } = await import('@test/e2e-browser/perf/profiles')
  expect(AUDIT_PROFILES.map((p) => p.id)).toEqual(['desktop_local', 'mobile_restricted'])
})
```

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-scenarios.test.ts
```

Expected: FAIL because the scenario and profile modules do not exist yet.

**Step 3: Write the minimal implementation**

Create `profiles.ts` with stable immutable profile definitions:

```ts
export const AUDIT_PROFILES = [
  { id: 'desktop_local', viewport: { width: 1440, height: 900 } },
  {
    id: 'mobile_restricted',
    device: devices['iPhone 14'],
    network: { downloadBps: 200_000, uploadBps: 93_750, latencyMs: 150 },
  },
] as const
```

Create `scenarios.ts` with six explicit scenario drivers. Each scenario function receives a `runContext` containing:

1. `testServer`
2. `browser` / `context` / `page`
3. `networkRecorder`
4. `seedResult`
5. `harness`
6. `markError`

Each scenario must:

1. navigate with `?token=...&e2e=1&perfAudit=1` or intentionally omit the token for the auth case
2. wait for the one scenario-specific focused-ready milestone
3. optionally perform the extra action that defines the scenario
4. collect a final harness snapshot

Keep scenario code data-driven and small. The runner owns looping, server lifecycle, artifact collection, and profile selection; the scenario drivers only describe user flows.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-scenarios.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/profiles.ts test/e2e-browser/perf/scenarios.ts test/e2e-browser/perf/run-sample.ts test/unit/lib/visible-first-audit-scenarios.test.ts
git commit -m "test: define visible-first audit scenarios"
```

## Task 6: Wire the Standalone Audit Runner and Artifact Compare Tool

**Files:**
- Create: `scripts/visible-first-audit.ts`
- Create: `scripts/compare-visible-first-audit.ts`
- Create: `test/e2e-browser/perf/audit-cli.ts`
- Modify: `package.json`
- Modify: `.gitignore`
- Create: `test/unit/lib/visible-first-audit-cli.test.ts`

**Step 1: Write the failing tests**

```ts
it('defaults the audit output path to artifacts/perf/visible-first-audit.json', async () => {
  const { parseAuditArgs } = await import('@test/e2e-browser/perf/audit-cli')
  expect(parseAuditArgs([]).outputPath).toContain('artifacts/perf/visible-first-audit.json')
})

it('requires base and candidate paths for compare mode', async () => {
  const { parseCompareArgs } = await import('@test/e2e-browser/perf/audit-cli')
  expect(() => parseCompareArgs([])).toThrow(/--base/)
})
```

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-cli.test.ts
```

Expected: FAIL because the CLI helpers and scripts do not exist yet.

**Step 3: Write the minimal implementation**

1. Create `scripts/visible-first-audit.ts` that:
   - ensures a perf-enabled production build exists by running `npm run build:client` and `npm run build:server` with `PERF_LOGGING=true` when needed
   - loops serially over the fixed scenario/profile matrix
   - starts a fresh `TestServer` per sample with `PERF_LOGGING=true`
   - launches Chromium, applies the profile, and records the sample
   - validates the final artifact with `VisibleFirstAuditSchema`
   - writes JSON to the requested output path
2. Create `scripts/compare-visible-first-audit.ts` that:
   - loads two schema-validated artifacts
   - emits a concise JSON diff by scenario/profile/metric
3. Create `test/e2e-browser/perf/audit-cli.ts` with `parseAuditArgs` and `parseCompareArgs` so the scripts and tests share one argument parser.
4. Add scripts to `package.json`:

```json
"perf:audit:visible-first": "tsx scripts/visible-first-audit.ts",
"perf:audit:compare": "tsx scripts/compare-visible-first-audit.ts"
```

5. Ignore generated artifacts in `.gitignore`:

```gitignore
artifacts/perf/
```

Do not write the audit under `test-results/` or `playwright-report/`. This output is product telemetry, not test-runner exhaust.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-cli.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/visible-first-audit.ts scripts/compare-visible-first-audit.ts test/e2e-browser/perf/audit-cli.ts package.json .gitignore test/unit/lib/visible-first-audit-cli.test.ts
git commit -m "feat: add visible-first audit runner"
```

## Task 7: Add Smoke E2E Coverage for the Full Audit Pipeline

**Files:**
- Create: `test/e2e-browser/perf/visible-first-audit.smoke.test.ts`
- Create: `test/e2e-browser/perf/run-visible-first-audit.ts`
- Modify: `test/e2e-browser/vitest.config.ts`
- Modify: `README.md`

**Step 1: Write the failing smoke test**

```ts
import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'fs/promises'
import os from 'os'
import path from 'path'

describe('visible-first audit smoke', () => {
  it('writes a schema-valid JSON artifact for a reduced scenario set', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'visible-first-audit-'))
    const output = path.join(tmpDir, 'audit.json')

    await runVisibleFirstAudit({
      outputPath: output,
      scenarioIds: ['auth-required-cold-boot'],
      profileIds: ['desktop_local'],
    })

    const artifact = JSON.parse(await readFile(output, 'utf8'))
    expect(VisibleFirstAuditSchema.parse(artifact).scenarios).toHaveLength(1)
  })
})
```

**Step 2: Run the test to verify it fails**

Run:

```bash
npm run test:e2e:helpers -- test/e2e-browser/perf/visible-first-audit.smoke.test.ts
```

Expected: FAIL because the runner is not yet exported in a test-friendly form or the smoke plumbing is incomplete.

**Step 3: Write the minimal implementation**

1. Refactor `scripts/visible-first-audit.ts` so the core runner lives in `test/e2e-browser/perf/run-visible-first-audit.ts`, and both the script and smoke test import that module.
2. Add the smoke test to `test/e2e-browser/vitest.config.ts` if needed so the helper test environment can run it.
3. Document the audit commands in `README.md`:
   - how to run the full audit
   - default output path
   - how to diff two artifacts
   - why the mobile profile is intentionally bandwidth-throttled

**Step 4: Run the test to verify it passes**

Run:

```bash
npm run test:e2e:helpers -- test/e2e-browser/perf/visible-first-audit.smoke.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/visible-first-audit.smoke.test.ts test/e2e-browser/perf/run-visible-first-audit.ts test/e2e-browser/vitest.config.ts README.md
git commit -m "test: smoke test visible-first audit pipeline"
```

## Final Verification and Baseline Capture

After the implementation tasks are complete, do the full verification in this order:

1. Run the focused unit and helper suites touched by this work:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-contract.test.ts test/unit/lib/visible-first-audit-aggregator.test.ts test/unit/lib/visible-first-audit-seed-home.test.ts test/unit/lib/visible-first-audit-server-log-parser.test.ts test/unit/lib/visible-first-audit-network-recorder.test.ts test/unit/lib/visible-first-audit-scenarios.test.ts test/unit/lib/visible-first-audit-cli.test.ts test/unit/client/lib/perf-audit-bridge.test.ts test/unit/client/lib/perf-logger.test.ts
npm run test:e2e:helpers -- test/e2e-browser/helpers/test-server.test.ts test/e2e-browser/perf/visible-first-audit.smoke.test.ts
```

2. Run the full standard suite required by repo policy:

```bash
npm test
```

3. Run the full audit and verify the artifact exists:

```bash
npm run perf:audit:visible-first
test -f artifacts/perf/visible-first-audit.json
```

4. Spot-check the artifact shape:

```bash
node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync('artifacts/perf/visible-first-audit.json','utf8')); console.log(data.schemaVersion, data.scenarios.length)"
```

Expected output:

```text
1 6
```

5. Optional but recommended for future transport work:

```bash
npm run perf:audit:compare -- --base artifacts/perf/visible-first-audit.json --candidate /path/to/another-audit.json
```

## Notes for the Execution Agent

1. Keep the scenario IDs, profile IDs, and artifact path stable. The value of this audit is longitudinal comparison.
2. Do not relax the "fresh origin per sample" rule. Reusing a server or browser context invalidates the cold-boot numbers.
3. Do not reintroduce `/api/logs/client` into the design. The current client logger is correct to drop perf entries; the audit should collect perf locally through the bridge and CDP.
4. Prefer browser/network observation over app-side instrumentation whenever the browser already knows the truth. Only add app instrumentation for readiness milestones the browser cannot infer safely.
5. When the full audit run is green, leave the generated JSON artifact uncommitted unless the user explicitly asks to version a baseline file.
