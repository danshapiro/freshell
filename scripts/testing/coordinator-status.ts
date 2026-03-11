import {
  buildReusableSuccessKey,
  type HolderRecord,
  type LatestRunRecord,
  type ReusableSuccessRecord,
} from './coordinator-schema.js'
import {
  buildCoordinatorEndpoint,
  readActiveHolder,
  type CoordinatorEndpoint,
} from './coordinator-endpoint.js'
import {
  readCommandRuns,
  readReusableSuccesses,
  readSuiteRuns,
} from './coordinator-store.js'

export type StatusRequest = {
  commonDir: string
  endpoint?: CoordinatorEndpoint
  endpointPlatform?: NodeJS.Platform
  endpointBaseDirs?: string[]
  commandKey?: string
  suiteKey?: string
  commit?: string
  isDirty?: boolean
  nodeVersion?: string
  platform?: string
  arch?: string
}

export type StatusView = {
  state: 'idle' | 'running' | 'running-undescribed'
  holder?: HolderRecord
  latestCommand?: LatestRunRecord
  latestSuite?: LatestRunRecord
  reusableSuccess?: ReusableSuccessRecord
  fullSuiteReusableSuccess?: ReusableSuccessRecord
  latestCommandsByKey: Record<string, LatestRunRecord>
  latestSuitesByKey: Record<string, LatestRunRecord>
}

export async function buildStatusView(request: StatusRequest): Promise<StatusView> {
  const endpoint = request.endpoint ?? buildCoordinatorEndpoint(
    request.commonDir,
    request.endpointPlatform ?? process.platform,
    request.endpointBaseDirs,
  )
  const [activeHolder, commandRuns, suiteRuns, reusableSuccesses] = await Promise.all([
    readActiveHolder(endpoint),
    readCommandRuns(endpoint.storeDir),
    readSuiteRuns(endpoint.storeDir),
    readReusableSuccesses(endpoint.storeDir),
  ])

  const state = activeHolder === 'running-undescribed'
    ? 'running-undescribed'
    : activeHolder
      ? 'running'
      : 'idle'
  const latestCommand = request.commandKey ? commandRuns.byKey[request.commandKey] : undefined
  const latestSuite = request.suiteKey
    ? suiteRuns.byKey[request.suiteKey]
    : pickLatestRunRecord(suiteRuns.byKey)
  const reusableSuccess = request.suiteKey
    ? resolveReusableSuccess(reusableSuccesses.byReusableKey, {
      suiteKey: request.suiteKey,
      commit: request.commit,
      isDirty: request.isDirty,
      nodeVersion: request.nodeVersion,
      platform: request.platform,
      arch: request.arch,
    })
    : latestSuite?.entrypoint.suiteKey
      ? resolveReusableSuccess(reusableSuccesses.byReusableKey, {
        suiteKey: latestSuite.entrypoint.suiteKey,
        commit: request.commit,
        isDirty: request.isDirty,
        nodeVersion: request.nodeVersion,
        platform: request.platform,
        arch: request.arch,
      })
      : undefined
  const fullSuiteReusableSuccess = request.suiteKey
    ? undefined
    : resolveReusableSuccess(reusableSuccesses.byReusableKey, {
      suiteKey: 'full-suite',
      commit: request.commit,
      isDirty: request.isDirty,
      nodeVersion: request.nodeVersion,
      platform: request.platform,
      arch: request.arch,
    })

  return {
    state,
    holder: activeHolder && activeHolder !== 'running-undescribed' ? activeHolder : undefined,
    latestCommand,
    latestSuite,
    reusableSuccess,
    fullSuiteReusableSuccess: fullSuiteReusableSuccess?.reusableKey === reusableSuccess?.reusableKey
      ? undefined
      : fullSuiteReusableSuccess,
    latestCommandsByKey: commandRuns.byKey,
    latestSuitesByKey: suiteRuns.byKey,
  }
}

export function renderStatusView(view: StatusView): string {
  const lines = [`state: ${view.state}`]

  if (view.holder) {
    lines.push(`holder: ${view.holder.summary}`)
    lines.push(`commandKey: ${view.holder.entrypoint.commandKey}`)
    if (view.holder.entrypoint.suiteKey) {
      lines.push(`suiteKey: ${view.holder.entrypoint.suiteKey}`)
    }
    lines.push(`elapsed: ${formatElapsed(view.holder.startedAt)}`)
    lines.push(`branch: ${view.holder.repo.branch ?? 'unknown'}`)
    lines.push(`worktree: ${view.holder.repo.worktreePath}`)
    lines.push(`command: ${view.holder.command.display}`)
    lines.push(`pid: ${view.holder.pid}`)

    if (view.holder.agent.kind) lines.push(`agent: ${view.holder.agent.kind}`)
    if (view.holder.agent.sessionId) lines.push(`session: ${view.holder.agent.sessionId}`)
    if (view.holder.agent.threadId) lines.push(`thread: ${view.holder.agent.threadId}`)
  }

  if (view.latestCommand) {
    lines.push(`latest-command: ${view.latestCommand.entrypoint.commandKey} ${view.latestCommand.outcome} exit=${view.latestCommand.exitCode}`)
  }

  if (view.latestSuite?.entrypoint.suiteKey) {
    lines.push(`latest-suite: ${view.latestSuite.entrypoint.suiteKey} ${view.latestSuite.outcome} exit=${view.latestSuite.exitCode}`)
  }

  if (view.reusableSuccess) {
    lines.push(`reusable-summary: ${view.reusableSuccess.summary}`)
    lines.push(`reusable-success: ${view.reusableSuccess.reusableKey}`)
  }

  if (view.fullSuiteReusableSuccess) {
    lines.push(`full-suite-reusable-summary: ${view.fullSuiteReusableSuccess.summary}`)
    lines.push(`full-suite-reusable-success: ${view.fullSuiteReusableSuccess.reusableKey}`)
  }

  if (Object.keys(view.latestCommandsByKey).length > 0) {
    const summary = Object.entries(view.latestCommandsByKey)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, record]) => `${key}=${record.outcome}`)
      .join(', ')
    lines.push(`latest-commands: ${summary}`)
  }

  if (Object.keys(view.latestSuitesByKey).length > 0) {
    const summary = Object.entries(view.latestSuitesByKey)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, record]) => `${key}=${record.outcome}`)
      .join(', ')
    lines.push(`latest-suites: ${summary}`)
  }

  return lines.join('\n')
}

function resolveReusableSuccess(
  byReusableKey: Record<string, ReusableSuccessRecord>,
  input: {
    suiteKey: string
    commit?: string
    isDirty?: boolean
    nodeVersion?: string
    platform?: string
    arch?: string
  },
): ReusableSuccessRecord | undefined {
  if (!input.commit || !input.nodeVersion || !input.platform || !input.arch) {
    return undefined
  }

  const reusableKey = buildReusableSuccessKey({
    suiteKey: input.suiteKey,
    commit: input.commit,
    isDirty: input.isDirty,
    nodeVersion: input.nodeVersion,
    platform: input.platform,
    arch: input.arch,
  })
  return byReusableKey[reusableKey]
}

function formatElapsed(startedAt: string): string {
  const started = Date.parse(startedAt)
  if (Number.isNaN(started)) {
    return 'unknown'
  }

  const elapsedMs = Math.max(0, Date.now() - started)
  const elapsedSeconds = Math.floor(elapsedMs / 1000)
  const hours = Math.floor(elapsedSeconds / 3600)
  const minutes = Math.floor((elapsedSeconds % 3600) / 60)
  const seconds = elapsedSeconds % 60

  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function pickLatestRunRecord(byKey: Record<string, LatestRunRecord>): LatestRunRecord | undefined {
  const records = Object.values(byKey)
  if (records.length === 0) {
    return undefined
  }

  return records.sort((left, right) => compareRecordRecency(right) - compareRecordRecency(left))[0]
}

function compareRecordRecency(record: LatestRunRecord): number {
  return parseTimestamp(record.finishedAt) ?? parseTimestamp(record.startedAt) ?? 0
}

function parseTimestamp(value: string): number | undefined {
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}
