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

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)

type GateMetric = VisibleFirstAuditGateResult['violations'][number]['metric']

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
        derived: {},
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
        },
        mobile_restricted: {
          focusedReadyMs: 150,
          terminalInputToFirstOutputMs: 35,
          offscreenHttpRequestsBeforeReady: 0,
          offscreenHttpBytesBeforeReady: 0,
          offscreenWsFramesBeforeReady: 0,
          offscreenWsBytesBeforeReady: 0,
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

  it('fails on a positive mobile_restricted focusedReadyMs delta', () => {
    const base = createArtifact()
    const candidate = createArtifact()
    setMetric(candidate, 'agent-chat-cold-boot', 'mobile_restricted', 'focusedReadyMs', 151)

    expect(evaluateVisibleFirstAuditGate(base, candidate)).toEqual({
      ok: false,
      violations: [
        {
          scenarioId: 'agent-chat-cold-boot',
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
    setMetric(candidate, 'agent-chat-cold-boot', 'mobile_restricted', 'focusedReadyMs', 151)

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
          scenarioId: 'agent-chat-cold-boot',
          profileId: 'mobile_restricted',
          metric: 'focusedReadyMs',
          base: 150,
          candidate: 151,
          delta: 1,
        },
      ],
    })
  })
})
