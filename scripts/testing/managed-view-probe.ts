import { ErrorCode, type ErrorCode as WireErrorCode } from '../../shared/ws-protocol.js'

const LAUNCH_STATES = ['prepared', 'created', 'starting', 'running', 'stopping', 'stopped', 'failed'] as const
const MAX_MATCHING_ROWS = 10_000
const MAX_MATCHING_ROW_DETAILS = 8

export type ManagedViewProbe = {
  terminalCreateResult: 'created' | 'error' | 'no_reply'
  createSent: boolean
  wireErrorCode?: WireErrorCode
  inventoryRead: 'ok' | 'failed'
  matchingRowCount: number
  matchingRows: Array<{
    launchState: typeof LAUNCH_STATES[number] | 'unknown'
    providerMatch: boolean
    containerIdPresent: boolean
  }>
}

export type ManagedViewProbeInput = {
  terminalId: string
  createRequestId: string
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

function projectTerminalCreate(input: ManagedViewProbeInput): Pick<ManagedViewProbe,
  'terminalCreateResult' | 'createSent' | 'wireErrorCode'> {
  const hasRequestId = input.createRequestId.length > 0
  const createSent = hasRequestId && list(input.sentMessages).some(message => {
    const candidate = record(message)
    return candidate?.type === 'terminal.create' && candidate.requestId === input.createRequestId
  })

  let terminalCreateResult: ManagedViewProbe['terminalCreateResult'] = 'no_reply'
  let wireErrorCode: ManagedViewProbe['wireErrorCode']
  for (const message of list(input.receivedMessages)) {
    const candidate = record(message)
    if (!hasRequestId || candidate?.requestId !== input.createRequestId) continue
    if (candidate.type === 'terminal.created') {
      terminalCreateResult = 'created'
      wireErrorCode = undefined
    } else if (candidate.type === 'error') {
      terminalCreateResult = 'error'
      const parsed = ErrorCode.safeParse(candidate.code)
      wireErrorCode = parsed.success ? parsed.data : undefined
    }
  }

  return {
    terminalCreateResult,
    createSent,
    ...(wireErrorCode ? { wireErrorCode } : {}),
  }
}

function projectInventory(input: ManagedViewProbeInput): Pick<ManagedViewProbe,
  'inventoryRead' | 'matchingRowCount' | 'matchingRows'> {
  if (input.inventoryRead !== 'ok' || !Array.isArray(input.inventory)) {
    return { inventoryRead: 'failed', matchingRowCount: 0, matchingRows: [] }
  }

  let matchingRowCount = 0
  const matchingRows: ManagedViewProbe['matchingRows'] = []
  for (const value of input.inventory) {
    const row = record(value)
    if (row?.terminalId !== input.terminalId) continue
    if (matchingRowCount === MAX_MATCHING_ROWS) break
    matchingRowCount += 1
    if (matchingRows.length >= MAX_MATCHING_ROW_DETAILS) continue

    const launchState = typeof row.launchState === 'string'
      && (LAUNCH_STATES as readonly string[]).includes(row.launchState)
      ? row.launchState as typeof LAUNCH_STATES[number]
      : 'unknown'
    matchingRows.push({
      launchState,
      providerMatch: row.provider === input.provider,
      containerIdPresent: typeof row.containerId === 'string' && row.containerId.length > 0,
    })
  }
  return { inventoryRead: 'ok', matchingRowCount, matchingRows }
}

/** Project private create and inventory observations into bounded, body-free facts. */
export function projectManagedViewProbe(input: ManagedViewProbeInput): ManagedViewProbe {
  return { ...projectTerminalCreate(input), ...projectInventory(input) }
}
