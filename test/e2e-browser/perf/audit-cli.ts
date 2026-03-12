import path from 'path'
import {
  AUDIT_PROFILE_IDS,
  AUDIT_SCENARIO_IDS,
  type VisibleFirstProfileId,
  type VisibleFirstScenarioId,
} from './audit-contract.js'

export type ParsedAuditArgs = {
  outputPath: string
  scenarioIds: VisibleFirstScenarioId[]
  profileIds: VisibleFirstProfileId[]
}

export type ParsedCompareArgs = {
  basePath: string
  candidatePath: string
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

export function parseAuditArgs(args: string[], cwd = process.cwd()): ParsedAuditArgs {
  const scenarioIds: VisibleFirstScenarioId[] = []
  const profileIds: VisibleFirstProfileId[] = []
  let outputPath = path.resolve(cwd, 'artifacts/perf/visible-first-audit.json')

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--output') {
      outputPath = path.resolve(cwd, requireValue(arg, args[index + 1]))
      index += 1
      continue
    }
    if (arg === '--scenario') {
      const scenarioId = requireValue(arg, args[index + 1]) as VisibleFirstScenarioId
      if (!AUDIT_SCENARIO_IDS.includes(scenarioId)) {
        throw new Error(`Unknown visible-first audit scenario: ${scenarioId}`)
      }
      scenarioIds.push(scenarioId)
      index += 1
      continue
    }
    if (arg === '--profile') {
      const profileId = requireValue(arg, args[index + 1]) as VisibleFirstProfileId
      if (!AUDIT_PROFILE_IDS.includes(profileId)) {
        throw new Error(`Unknown visible-first audit profile: ${profileId}`)
      }
      profileIds.push(profileId)
      index += 1
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  return {
    outputPath,
    scenarioIds: scenarioIds.length > 0 ? scenarioIds : [...AUDIT_SCENARIO_IDS],
    profileIds: profileIds.length > 0 ? profileIds : [...AUDIT_PROFILE_IDS],
  }
}

export function parseCompareArgs(args: string[], cwd = process.cwd()): ParsedCompareArgs {
  let basePath: string | null = null
  let candidatePath: string | null = null

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--base') {
      basePath = path.resolve(cwd, requireValue(arg, args[index + 1]))
      index += 1
      continue
    }
    if (arg === '--candidate') {
      candidatePath = path.resolve(cwd, requireValue(arg, args[index + 1]))
      index += 1
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  if (!basePath) {
    throw new Error('compare mode requires --base')
  }
  if (!candidatePath) {
    throw new Error('compare mode requires --candidate')
  }

  return {
    basePath,
    candidatePath,
  }
}
