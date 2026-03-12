import { execFile } from 'child_process'
import { promisify } from 'util'
import { chromium } from '@playwright/test'
import {
  AUDIT_PROFILE_IDS,
  AUDIT_SCENARIO_IDS,
  VisibleFirstAuditSchema,
  type VisibleFirstAuditArtifact,
  type VisibleFirstProfileId,
  type VisibleFirstScenarioId,
} from './audit-contract.js'
import { summarizeScenarioSamples } from './audit-aggregator.js'
import { AUDIT_PROFILES } from './profiles.js'
import { AUDIT_SCENARIOS } from './scenarios.js'
import { runVisibleFirstAuditSample } from './run-sample.js'

const execFileAsync = promisify(execFile)

type GitInfo = {
  commit: string
  branch: string
  dirty: boolean
}

type RunVisibleFirstAuditInput = {
  scenarioIds?: VisibleFirstScenarioId[]
  profileIds?: VisibleFirstProfileId[]
  deps?: {
    runSample?: typeof runVisibleFirstAuditSample
    getGitInfo?: () => Promise<GitInfo>
    getBrowserVersion?: () => Promise<string>
    getNowIso?: () => string
  }
}

async function readGitInfo(): Promise<GitInfo> {
  const [{ stdout: commit }, { stdout: branch }, { stdout: dirtyStatus }] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD']),
    execFileAsync('git', ['branch', '--show-current']),
    execFileAsync('git', ['status', '--porcelain']),
  ])

  return {
    commit: commit.trim(),
    branch: branch.trim(),
    dirty: dirtyStatus.trim().length > 0,
  }
}

async function readBrowserVersion(): Promise<string> {
  const browser = await chromium.launch({ headless: true })
  try {
    return browser.version()
  } finally {
    await browser.close()
  }
}

function resolveScenarioIds(input?: VisibleFirstScenarioId[]): VisibleFirstScenarioId[] {
  if (!input || input.length === 0) {
    return [...AUDIT_SCENARIO_IDS]
  }

  const allowed = new Set(AUDIT_SCENARIO_IDS)
  return input.filter((scenarioId) => allowed.has(scenarioId))
}

function resolveProfileIds(input?: VisibleFirstProfileId[]): VisibleFirstProfileId[] {
  if (!input || input.length === 0) {
    return [...AUDIT_PROFILE_IDS]
  }

  const allowed = new Set(AUDIT_PROFILE_IDS)
  return input.filter((profileId) => allowed.has(profileId))
}

export async function runVisibleFirstAudit(
  input: RunVisibleFirstAuditInput = {},
): Promise<VisibleFirstAuditArtifact> {
  const runSample = input.deps?.runSample ?? runVisibleFirstAuditSample
  const scenarioIds = resolveScenarioIds(input.scenarioIds)
  const profileIds = resolveProfileIds(input.profileIds)
  const nowIso = input.deps?.getNowIso ?? (() => new Date().toISOString())
  const [git, browserVersion] = await Promise.all([
    (input.deps?.getGitInfo ?? readGitInfo)(),
    (input.deps?.getBrowserVersion ?? readBrowserVersion)(),
  ])

  const scenarios = []
  for (const scenarioId of scenarioIds) {
    const scenario = AUDIT_SCENARIOS.find((candidate) => candidate.id === scenarioId)
    if (!scenario) {
      throw new Error(`Unknown visible-first audit scenario: ${scenarioId}`)
    }

    const samples = []
    for (const profileId of profileIds) {
      samples.push(await runSample({ scenarioId, profileId }))
    }

    scenarios.push({
      id: scenario.id,
      description: scenario.description,
      focusedReadyMilestone: scenario.focusedReadyMilestone,
      samples,
      summaryByProfile: summarizeScenarioSamples({ samples }),
    })
  }

  return VisibleFirstAuditSchema.parse({
    schemaVersion: 1,
    generatedAt: nowIso(),
    git,
    build: {
      nodeVersion: process.version,
      browserVersion,
      command: 'npm run perf:audit:visible-first',
    },
    profiles: AUDIT_PROFILES.filter((profile) => profileIds.includes(profile.id)),
    scenarios,
  })
}
