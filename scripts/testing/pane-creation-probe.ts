import { ErrorCode, type ErrorCode as WireErrorCode } from '../../shared/ws-protocol.js'

const LAUNCH_STATES = ['prepared', 'created', 'starting', 'running', 'stopping', 'stopped', 'failed'] as const
const MAX_MATCHING_ROWS = 10_000
const MAX_MATCHING_ROW_DETAILS = 8

export type PaneCreationProbe = {
  terminalCreateResult: 'request_id_missing' | 'request_not_observed' | 'no_reply' | 'created' | 'error'
  wireErrorCode?: WireErrorCode
  inventoryRead: 'ok' | 'failed'
  matchingRowCount: number
  matchingRows: Array<{
    launchState: typeof LAUNCH_STATES[number] | 'unknown'
    providerMatch: boolean
    containerIdPresent: boolean
  }>
}

export type PaneCreationProbeInput = {
  terminalId?: string | null
  createRequestId?: string | null
  provider: string
  sentMessages: unknown
  receivedMessages: unknown
  inventoryRead: 'ok' | 'failed'
  inventory: unknown
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function projectTerminalCreate(input: PaneCreationProbeInput): Pick<PaneCreationProbe,
  'terminalCreateResult' | 'wireErrorCode'> {
  const createRequestId = typeof input.createRequestId === 'string' ? input.createRequestId : ''
  if (!createRequestId) return { terminalCreateResult: 'request_id_missing' }

  const createSent = list(input.sentMessages).some(message => {
    const candidate = record(message)
    return candidate?.type === 'terminal.create' && candidate.requestId === createRequestId
  })
  let terminalCreateResult: PaneCreationProbe['terminalCreateResult'] = createSent
    ? 'no_reply'
    : 'request_not_observed'
  let wireErrorCode: WireErrorCode | undefined
  for (const message of list(input.receivedMessages)) {
    const candidate = record(message)
    if (candidate?.requestId !== createRequestId) continue
    if (candidate.type === 'terminal.created') {
      terminalCreateResult = 'created'
      wireErrorCode = undefined
    } else if (candidate.type === 'error') {
      terminalCreateResult = 'error'
      const parsed = ErrorCode.safeParse(candidate.code)
      wireErrorCode = parsed.success ? parsed.data : undefined
    }
  }

  return { terminalCreateResult, ...(wireErrorCode ? { wireErrorCode } : {}) }
}

function projectInventory(input: PaneCreationProbeInput): Pick<PaneCreationProbe,
  'inventoryRead' | 'matchingRowCount' | 'matchingRows'> {
  if (input.inventoryRead !== 'ok' || !Array.isArray(input.inventory)) {
    return { inventoryRead: 'failed', matchingRowCount: 0, matchingRows: [] }
  }

  const terminalId = typeof input.terminalId === 'string' ? input.terminalId : ''
  const createRequestId = typeof input.createRequestId === 'string' ? input.createRequestId : ''
  let matchingRowCount = 0
  const matchingRows: PaneCreationProbe['matchingRows'] = []
  for (const value of input.inventory) {
    const row = record(value)
    const matches = terminalId
      ? row?.terminalId === terminalId
      : !!createRequestId && row?.terminalCreateRequestId === createRequestId
    if (!matches) continue
    if (matchingRowCount === MAX_MATCHING_ROWS) break
    matchingRowCount += 1
    if (matchingRows.length >= MAX_MATCHING_ROW_DETAILS) continue

    const launchState = typeof row?.launchState === 'string'
      && (LAUNCH_STATES as readonly string[]).includes(row.launchState)
      ? row.launchState as typeof LAUNCH_STATES[number]
      : 'unknown'
    matchingRows.push({
      launchState,
      providerMatch: row?.provider === input.provider,
      containerIdPresent: typeof row?.containerId === 'string' && row.containerId.length > 0,
    })
  }
  return { inventoryRead: 'ok', matchingRowCount, matchingRows }
}

/** Keep pane-creation timeout evidence bounded and free of runtime identities or message bodies. */
export function projectPaneCreationProbe(input: PaneCreationProbeInput): PaneCreationProbe {
  return { ...projectTerminalCreate(input), ...projectInventory(input) }
}
