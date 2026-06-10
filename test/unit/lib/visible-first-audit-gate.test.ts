// @vitest-environment node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AUDIT_PROFILE_IDS,
  AUDIT_SCENARIO_IDS,
  VisibleFirstAuditSchema,
  type VisibleFirstAuditArtifact,
  type VisibleFirstProfileId,
  type VisibleFirstScenarioId,
} from '@test/e2e-browser/perf/audit-contract'
import {
  evaluateVisibleFirstAuditGate,
  type VisibleFirstAuditGateResult,
} from '@test/e2e-browser/perf/visible-first-audit-gate'
import { deriveVisibleFirstMetrics } from '@test/e2e-browser/perf/derive-visible-first-metrics'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)

type GateMetric = VisibleFirstAuditGateResult['violations'][number]['metric']

const TERMINAL_RECONNECT_REQUIRED_METRICS = {
  focusedReadyMs: 100,
  maxRafGapMs: 16,
  terminalReplayMessageCount: 2,
  terminalReplaySerializedBytes: 12_000,
  terminalParserAppliedLagMs: 24,
  terminalReplayGapCount: 0,
  terminalFullHydrateFallbackCount: 0,
  terminalSurfaceQuarantineCount: 0,
  terminalStaleGenerationRejectionCount: 0,
  terminalStoppedRetentionCoveredMs: 0,
  terminalStopResumeGapCount: 0,
}

function reconnectRequiredMetrics(profileId: VisibleFirstProfileId) {
  return {
    terminalInputToFirstOutputMs: profileId === 'mobile_restricted' ? 35 : 25,
    ...TERMINAL_RECONNECT_REQUIRED_METRICS,
  }
}

function deriveReconnectMetricsWithStopResumeEvent(stopResumeEvent: Record<string, unknown>) {
  return deriveVisibleFirstMetrics({
    focusedReadyMilestone: 'terminal.first_output',
    allowedApiRouteIdsBeforeReady: ['/api/bootstrap', '/api/terminals/:terminalId/viewport'],
    allowedWsTypesBeforeReady: ['hello', 'ready', 'terminal.attach', 'terminal.output', 'terminal.output.batch'],
    browser: {
      milestones: {
        'terminal.first_output': 100,
      },
      perfEvents: [
        { event: 'visible_first.audit.max_raf_gap', maxGapMs: 16 },
        { event: 'terminal.parser_applied', timestamp: 40, parserAppliedSeq: 1 },
        stopResumeEvent,
      ],
    },
    transport: {
      http: { requests: [] },
      ws: {
        frames: [
          {
            timestamp: 10,
            direction: 'sent',
            type: 'terminal.attach',
            payload: JSON.stringify({ type: 'terminal.attach', terminalId: 'term-reconnect' }),
            payloadLength: 80,
          },
          {
            timestamp: 30,
            direction: 'received',
            type: 'terminal.output.batch',
            payload: JSON.stringify({
              type: 'terminal.output.batch',
              source: 'replay',
              terminalId: 'term-reconnect',
              seqStart: 1,
              seqEnd: 1,
              serializedBytes: 120,
            }),
            payloadLength: 120,
          },
        ],
      },
    },
    server: {
      terminalReplayEvents: [
        {
          event: 'terminal.replay.batch',
          source: 'replay',
          seqStart: 1,
          seqEnd: 1,
          serializedBytes: 120,
        },
      ],
    },
  })
}

function createArtifact(): VisibleFirstAuditArtifact {
  return VisibleFirstAuditSchema.parse({
    schemaVersion: 1,
    generatedAt: '2026-03-10T00:00:00.000Z',
    git: {
      commit: 'abc123',
      branch: 'feature/visible-first',
      dirty: false,
    },
    build: {
      nodeVersion: process.version,
      browserVersion: 'chromium-test',
      command: 'npm run perf:audit:visible-first',
    },
    profiles: AUDIT_PROFILE_IDS.map((id) => ({ id })),
    scenarios: AUDIT_SCENARIO_IDS.map((scenarioId) => ({
      id: scenarioId,
      description: scenarioId,
      focusedReadyMilestone: 'app.focused_ready',
      samples: AUDIT_PROFILE_IDS.map((profileId) => ({
        profileId,
        status: 'ok',
        startedAt: '2026-03-10T00:00:00.000Z',
        finishedAt: '2026-03-10T00:00:01.000Z',
        durationMs: 1_000,
        browser: {},
        transport: {},
        server: {},
        derived: scenarioId === 'terminal-reconnect-backlog'
          ? reconnectRequiredMetrics(profileId)
          : {},
        errors: [],
      })),
      summaryByProfile: {
        desktop_local: {
          focusedReadyMs: 100,
          terminalInputToFirstOutputMs: 25,
          offscreenHttpRequestsBeforeReady: 0,
          offscreenHttpBytesBeforeReady: 0,
          offscreenWsFramesBeforeReady: 0,
          offscreenWsBytesBeforeReady: 0,
          ...(scenarioId === 'terminal-reconnect-backlog' ? reconnectRequiredMetrics('desktop_local') : {}),
        },
        mobile_restricted: {
          focusedReadyMs: 150,
          terminalInputToFirstOutputMs: 35,
          offscreenHttpRequestsBeforeReady: 0,
          offscreenHttpBytesBeforeReady: 0,
          offscreenWsFramesBeforeReady: 0,
          offscreenWsBytesBeforeReady: 0,
          ...(scenarioId === 'terminal-reconnect-backlog' ? reconnectRequiredMetrics('mobile_restricted') : {}),
        },
      },
    })),
  })
}

function getScenario(artifact: VisibleFirstAuditArtifact, scenarioId: VisibleFirstScenarioId) {
  const scenario = artifact.scenarios.find((entry) => entry.id === scenarioId)
  if (!scenario) {
    throw new Error(`Scenario not found in test fixture: ${scenarioId}`)
  }
  return scenario
}

function setMetric(
  artifact: VisibleFirstAuditArtifact,
  scenarioId: VisibleFirstScenarioId,
  profileId: VisibleFirstProfileId,
  metric: GateMetric,
  value: number,
): void {
  const scenario = getScenario(artifact, scenarioId)
  const summary = scenario.summaryByProfile[profileId] ?? {}
  scenario.summaryByProfile[profileId] = {
    ...summary,
    [metric]: value,
  }
}

function replaceReconnectDerivedMetrics(
  artifact: VisibleFirstAuditArtifact,
  profileId: VisibleFirstProfileId,
  derived: Record<string, unknown>,
): void {
  const scenario = getScenario(artifact, 'terminal-reconnect-backlog')
  const sample = scenario.samples.find((entry) => entry.profileId === profileId)
  if (!sample) {
    throw new Error(`Sample not found in test fixture: terminal-reconnect-backlog/${profileId}`)
  }
  sample.derived = derived
  scenario.summaryByProfile[profileId] = derived
}

function removeSample(
  artifact: VisibleFirstAuditArtifact,
  scenarioId: VisibleFirstScenarioId,
  profileId: VisibleFirstProfileId,
): void {
  const scenario = getScenario(artifact, scenarioId)
  scenario.samples = scenario.samples.filter((sample) => sample.profileId !== profileId)
}

async function writeArtifacts(base: VisibleFirstAuditArtifact, candidate: VisibleFirstAuditArtifact) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'visible-first-gate-'))
  const basePath = path.join(tempDir, 'base.json')
  const candidatePath = path.join(tempDir, 'candidate.json')
  await Promise.all([
    fs.writeFile(basePath, JSON.stringify(base, null, 2)),
    fs.writeFile(candidatePath, JSON.stringify(candidate, null, 2)),
  ])
  return { tempDir, basePath, candidatePath }
}

describe('evaluateVisibleFirstAuditGate', () => {
  const tempDirs = new Set<string>()

  afterEach(async () => {
    await Promise.all(
      Array.from(tempDirs).map(async (tempDir) => {
        await fs.rm(tempDir, { recursive: true, force: true })
      }),
    )
    tempDirs.clear()
  })

  it('validates both artifacts with assertVisibleFirstAuditTrusted()', () => {
    const base = createArtifact()
    const candidate = createArtifact()
    getScenario(candidate, 'auth-required-cold-boot').samples[0].status = 'error'

    expect(() => evaluateVisibleFirstAuditGate(base, candidate)).toThrow(/untrustworthy/i)
  })

  it('fails when a required scenario/profile pair is missing', () => {
    const base = createArtifact()
    const candidate = createArtifact()
    removeSample(candidate, 'terminal-cold-boot', 'mobile_restricted')

    expect(() => evaluateVisibleFirstAuditGate(base, candidate)).toThrow(/terminal-cold-boot\/mobile_restricted/i)
  })

  it('fails when a candidate sample is missing a scenario-required terminal catch-up metric', () => {
    const base = createArtifact()
    const candidate = createArtifact()
    const scenario = getScenario(candidate, 'terminal-reconnect-backlog')
    delete (scenario.samples[0].derived as Record<string, unknown>).terminalReplayGapCount
    delete (scenario.summaryByProfile.desktop_local as Record<string, unknown>).terminalReplayGapCount

    expect(() => evaluateVisibleFirstAuditGate(base, candidate)).toThrow(
      /terminal-reconnect-backlog\/desktop_local.*terminalReplayGapCount/i,
    )
  })

  it('fails when synthetic stop/resume proof does not derive source-backed required metrics', () => {
    const base = createArtifact()
    const candidate = createArtifact()
    const derived = deriveReconnectMetricsWithStopResumeEvent({
      event: 'terminal.catchup.stop_resume',
      source: 'unit_reconnect_fixture',
      browserExecutionStopped: false,
      retentionCoveredMs: 900,
      stoppedDurationMs: 1_200,
      outputStartedAfterStopMs: 300,
      outputStartedBeforeResumeMs: 900,
      cdpCatchupOutputMessageCount: 5,
      gapCount: 0,
    })

    expect(derived).not.toHaveProperty('terminalStoppedRetentionCoveredMs')
    expect(derived).not.toHaveProperty('terminalStopResumeGapCount')

    replaceReconnectDerivedMetrics(candidate, 'desktop_local', derived)

    expect(() => evaluateVisibleFirstAuditGate(base, candidate)).toThrow(
      /terminal-reconnect-backlog\/desktop_local:terminalStoppedRetentionCoveredMs/i,
    )
  })

  it('accepts required stop/resume metrics derived from validated process-suspend proof', () => {
    const base = createArtifact()
    const candidate = createArtifact()
    const derived = deriveReconnectMetricsWithStopResumeEvent({
      event: 'terminal.catchup.stop_resume',
      source: 'visible_first_audit_process_suspend',
      browserExecutionStopped: true,
      retentionCoveredMs: 900,
      stoppedDurationMs: 1_200,
      outputStartedAfterStopMs: 300,
      outputStartedBeforeResumeMs: 900,
      cdpCatchupOutputMessageCount: 5,
      gapCount: 0,
    })

    expect(derived.terminalStoppedRetentionCoveredMs).toBe(900)
    expect(derived.terminalStopResumeGapCount).toBe(0)

    replaceReconnectDerivedMetrics(candidate, 'desktop_local', derived)

    expect(evaluateVisibleFirstAuditGate(base, candidate)).toEqual({
      ok: true,
      violations: [],
    })
  })

  it('fails on a positive mobile_restricted focusedReadyMs delta', () => {
    const base = createArtifact()
    const candidate = createArtifact()
    setMetric(candidate, 'fresh-agent-cold-boot', 'mobile_restricted', 'focusedReadyMs', 151)

    expect(evaluateVisibleFirstAuditGate(base, candidate)).toEqual({
      ok: false,
      violations: [
        {
          scenarioId: 'fresh-agent-cold-boot',
          profileId: 'mobile_restricted',
          metric: 'focusedReadyMs',
          base: 150,
          candidate: 151,
          delta: 1,
        },
      ],
    })
  })

  it('fails on a positive mobile terminalInputToFirstOutputMs delta for the two terminal scenarios', () => {
    const base = createArtifact()
    const candidate = createArtifact()
    setMetric(candidate, 'terminal-cold-boot', 'mobile_restricted', 'terminalInputToFirstOutputMs', 40)
    setMetric(candidate, 'terminal-reconnect-backlog', 'mobile_restricted', 'terminalInputToFirstOutputMs', 36)

    expect(evaluateVisibleFirstAuditGate(base, candidate)).toEqual({
      ok: false,
      violations: [
        {
          scenarioId: 'terminal-cold-boot',
          profileId: 'mobile_restricted',
          metric: 'terminalInputToFirstOutputMs',
          base: 35,
          candidate: 40,
          delta: 5,
        },
        {
          scenarioId: 'terminal-reconnect-backlog',
          profileId: 'mobile_restricted',
          metric: 'terminalInputToFirstOutputMs',
          base: 35,
          candidate: 36,
          delta: 1,
        },
      ],
    })
  })

  it('fails on positive offscreen-before-ready deltas for either profile', () => {
    const base = createArtifact()
    const candidate = createArtifact()
    setMetric(candidate, 'offscreen-tab-selection', 'desktop_local', 'offscreenWsBytesBeforeReady', 3)
    setMetric(candidate, 'sidebar-search-large-corpus', 'mobile_restricted', 'offscreenHttpRequestsBeforeReady', 1)

    expect(evaluateVisibleFirstAuditGate(base, candidate)).toEqual({
      ok: false,
      violations: [
        {
          scenarioId: 'sidebar-search-large-corpus',
          profileId: 'mobile_restricted',
          metric: 'offscreenHttpRequestsBeforeReady',
          base: 0,
          candidate: 1,
          delta: 1,
        },
        {
          scenarioId: 'offscreen-tab-selection',
          profileId: 'desktop_local',
          metric: 'offscreenWsBytesBeforeReady',
          base: 0,
          candidate: 3,
          delta: 3,
        },
      ],
    })
  })

  it('prints JSON only and exits non-zero on violations', async () => {
    const base = createArtifact()
    const candidate = createArtifact()
    setMetric(candidate, 'fresh-agent-cold-boot', 'mobile_restricted', 'focusedReadyMs', 151)

    const { tempDir, basePath, candidatePath } = await writeArtifacts(base, candidate)
    tempDirs.add(tempDir)

    const result = await execFileAsync(
      process.execPath,
      [
        require.resolve('tsx/cli'),
        path.resolve(process.cwd(), 'scripts/assert-visible-first-audit-gate.ts'),
        '--base',
        basePath,
        '--candidate',
        candidatePath,
      ],
      {
        cwd: process.cwd(),
      },
    ).catch((error: any) => error)

    expect(result.code).toBe(1)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      violations: [
        {
          scenarioId: 'fresh-agent-cold-boot',
          profileId: 'mobile_restricted',
          metric: 'focusedReadyMs',
          base: 150,
          candidate: 151,
          delta: 1,
        },
      ],
    })
  })

  it('prints validation errors when the gate CLI rejects missing required metrics', async () => {
    const base = createArtifact()
    const candidate = createArtifact()
    const scenario = getScenario(candidate, 'terminal-reconnect-backlog')
    delete (scenario.samples[0].derived as Record<string, unknown>).terminalParserAppliedLagMs
    delete (scenario.summaryByProfile.desktop_local as Record<string, unknown>).terminalParserAppliedLagMs

    const { tempDir, basePath, candidatePath } = await writeArtifacts(base, candidate)
    tempDirs.add(tempDir)

    const result = await execFileAsync(
      process.execPath,
      [
        require.resolve('tsx/cli'),
        path.resolve(process.cwd(), 'scripts/assert-visible-first-audit-gate.ts'),
        '--base',
        basePath,
        '--candidate',
        candidatePath,
      ],
      {
        cwd: process.cwd(),
      },
    ).catch((error: any) => error)

    expect(result.code).toBe(1)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      validationErrors: [
        expect.stringMatching(/terminal-reconnect-backlog\/desktop_local:terminalParserAppliedLagMs/),
      ],
      violations: [],
    })
  })
})
