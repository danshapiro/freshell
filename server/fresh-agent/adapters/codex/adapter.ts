import { randomBytes } from 'node:crypto'

import type { FreshAgentCreateRequest, FreshAgentInputImage, FreshAgentRuntimeAdapter } from '../../runtime-adapter.js'
import type { FreshAgentTurn } from '../../../../shared/fresh-agent-contract.js'
import { FreshAgentTurnPageSchema } from '../../../../shared/fresh-agent-contract.js'
import {
  FreshAgentAmbiguousTurnBodyError,
  FreshAgentInvalidDisplayIdError,
  FreshAgentInvalidTurnCursorError,
  FreshAgentStaleThreadRevisionError,
  FreshAgentUnprovableThreadRevisionError,
  FreshAgentTurnNotFoundError,
} from '../../runtime-manager.js'
import type {
  CodexThreadForkParams,
  CodexTurnInterruptParams,
  CodexTurnStartParams,
} from '../../../coding-cli/codex-app-server/protocol.js'
import {
  CodexDisplayTurnNotFoundError,
  createCodexDisplayId,
  normalizeCodexDisplayTurns,
  normalizeCodexThreadSnapshot,
  normalizeCodexTurnBody,
  parseCodexDisplayIdHandle,
} from './normalize.js'
import { normalizeFreshAgentEffort, normalizeFreshAgentModel } from '../../../../shared/fresh-agent-models.js'
import { nextMonotonicTurnCompleteAt } from '../../turn-complete-clock.js'

type CodexThreadLifecycleEvent =
  | {
    kind: 'thread_started'
    thread: {
      id: string
      updatedAt?: number
      status?: unknown
    }
  }
  | {
    kind: 'thread_closed'
    threadId: string
  }
  | {
    kind: 'thread_status_changed'
    threadId: string
    status: unknown
  }

type CodexRuntimePort = {
  startThread: (input: {
    cwd?: string
    model?: string
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
    approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never'
  }) => Promise<{ threadId: string; wsUrl: string }>
  resumeThread: (input: {
    threadId: string
    cwd?: string
    model?: string
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
    approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never'
  }) => Promise<{ threadId: string; wsUrl: string }>
  forkThread?: (input: CodexThreadForkParams) => Promise<{ threadId: string; wsUrl: string }>
  startTurn?: (input: CodexTurnStartParams) => Promise<{ turnId: string }>
  compactThread?: (input: { threadId: string; instructions?: string }) => Promise<void>
  interruptTurn?: (input: CodexTurnInterruptParams) => Promise<void>
  shutdown?: () => Promise<void>
  onThreadLifecycle?: (handler: (event: CodexThreadLifecycleEvent) => void) => () => void
  onTurnCompleted?: (
    handler: (event: { threadId: string; turnId?: string; params: Record<string, unknown> }) => void,
  ) => () => void
  readThread: (input: { threadId: string; includeTurns?: boolean }) => Promise<Record<string, any>>
  listThreadTurns: (input: {
    threadId: string
    cursor?: string
    limit?: number
    itemsView?: 'notLoaded' | 'summary' | 'full'
  }) => Promise<Record<string, any>>
  readThreadTurn: (input: { threadId: string; turnId: string; revision?: number }) => Promise<Record<string, any>>
}

type DisplayIndexEntry = {
  threadId: string
  revision: number
  displayTurnId: string
  providerTurnId: string
  role: NonNullable<FreshAgentTurn['role']>
  rawTurn: Record<string, unknown>
}

type CodexDisplayCursorEntry = {
  threadId: string
  revision: number
  providerCursor: string | null
  drainingProviderTurnId?: string
  nextDisplayOffset: number
  rawTurn?: Record<string, unknown>
  order: 'provider-default'
  expiresAt: number
}

type SubmittedInputRecord = {
  requestId: string
  providerTurnId: string
  submittedTurnId: string
  input: CodexTurnStartParams['input']
  createdAt: number
}

const DISPLAY_INDEX_MAX_REVISIONS = 32
const DISPLAY_CURSOR_PREFIX = 'codex-cursor:v1:'
const DISPLAY_CURSOR_TTL_MS = 5 * 60 * 1000
const DISPLAY_CURSOR_MAX_ENTRIES = 512
const SUBMITTED_INPUT_TTL_MS = 30 * 60 * 1000

function toCodexApprovalPolicy(value: string | undefined) {
  if (value === undefined) return undefined
  if (value === 'untrusted' || value === 'on-failure' || value === 'on-request' || value === 'never') {
    return value
  }
  throw new Error(`Freshcodex does not support approval policy "${value}". Choose untrusted, on-failure, on-request, or never.`)
}

function toCodexReasoningEffort(value: FreshAgentCreateRequest['effort'] | undefined) {
  if (value === undefined) return undefined
  if (value === 'max' || value === 'xhigh') return 'xhigh'
  if (value === 'none' || value === 'minimal' || value === 'low' || value === 'medium' || value === 'high') {
    return value
  }
  throw new Error(`Freshcodex does not support reasoning effort "${value}". Choose none, minimal, low, medium, high, or max.`)
}

function toCodexSandboxPolicy(value: FreshAgentCreateRequest['sandbox'] | undefined): CodexTurnStartParams['sandboxPolicy'] {
  switch (value) {
    case undefined:
      return undefined
    case 'danger-full-access':
      return { type: 'dangerFullAccess' }
    case 'read-only':
      return { type: 'readOnly' }
    case 'workspace-write':
      return { type: 'workspaceWrite' }
    default:
      throw new Error(`Freshcodex does not support sandbox "${String(value)}".`)
  }
}

function toCodexResumeInput(
  threadId: string,
  settings?: Partial<FreshAgentCreateRequest>,
): Parameters<CodexRuntimePort['resumeThread']>[0] {
  return {
    threadId,
    ...(settings?.cwd !== undefined ? { cwd: settings.cwd } : {}),
    ...(settings?.model !== undefined ? { model: settings.model } : {}),
    ...(settings?.sandbox !== undefined ? { sandbox: settings.sandbox } : {}),
    ...(settings?.permissionMode !== undefined ? { approvalPolicy: toCodexApprovalPolicy(settings.permissionMode) } : {}),
  }
}

function toCodexUserInput(text: string, images: FreshAgentInputImage[] | undefined): CodexTurnStartParams['input'] {
  const input: CodexTurnStartParams['input'] = [{
    type: 'text',
    text,
    text_elements: [],
  }]
  for (const image of images ?? []) {
    if (image.kind === 'url') {
      input.push({ type: 'image', url: image.url })
    } else if (image.kind === 'local') {
      input.push({ type: 'localImage', path: image.path })
    } else {
      input.push({ type: 'image', url: `data:${image.mediaType};base64,${image.data}` })
    }
  }
  return input
}

function submittedInputKey(providerTurnId: string, requestId: string): string {
  return `${providerTurnId}\u0000${requestId}`
}

function displayIndexKey(threadId: string, revision: number): string {
  return `${threadId}\u0000${revision}`
}

function readDisplayCursorHandle(cursor: string): string | null {
  const pattern = new RegExp(`^${DISPLAY_CURSOR_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([A-Za-z0-9_-]{22})$`)
  return cursor.match(pattern)?.[1] ?? null
}

function stripCodexDisplayMetadata(turn: FreshAgentTurn): FreshAgentTurn {
  const {
    syntheticKind: _syntheticKind,
    requestId: _requestId,
    ...publicTurn
  } = turn as FreshAgentTurn & {
    syntheticKind?: string
    requestId?: string | number
  }
  return publicTurn
}

function readRawTurns(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((turn): turn is Record<string, unknown> => !!turn && typeof turn === 'object' && !Array.isArray(turn))
    : []
}

function hasCodexUserMessage(rawTurn: Record<string, unknown>): boolean {
  return readRawTurns(rawTurn.items).some((item) => item.type === 'userMessage')
}

function submittedInputContent(input: CodexTurnStartParams['input']): unknown[] {
  return input.map((part) => {
    if (part.type === 'text') {
      return { type: 'text', text: part.text }
    }
    if (part.type === 'localImage') {
      return { type: 'localImage', path: part.path }
    }
    return { type: 'image', url: part.url }
  })
}

function makeSubmittedUserMessage(record: SubmittedInputRecord): Record<string, unknown> {
  return {
    id: `codex-submitted-input:${record.requestId}`,
    type: 'userMessage',
    content: submittedInputContent(record.input),
  }
}

function normalizeCodexInput(input: FreshAgentCreateRequest): FreshAgentCreateRequest {
  const model = normalizeFreshAgentModel(input.sessionType, 'codex', input.model)
  return {
    ...input,
    model,
    effort: normalizeFreshAgentEffort(input.sessionType, 'codex', model, input.effort),
  }
}

function normalizeCodexThreadStatus(status: unknown): string {
  if (!status || typeof status !== 'object') return 'idle'
  const type = (status as { type?: unknown }).type
  if (type === 'active') return 'running'
  if (type === 'notLoaded') return 'starting'
  if (type === 'systemError') return 'exited'
  if (type === 'idle') return 'idle'
  return 'idle'
}

function makeCodexStatusEvent(sessionId: string, status: unknown, revision?: number) {
  return {
    type: 'sdk.session.snapshot',
    sessionId,
    latestTurnId: null,
    status: normalizeCodexThreadStatus(status),
    timelineSessionId: sessionId,
    revision,
  }
}

function isCodexIncludeTurnsUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message.includes('includeTurns is unavailable before first user message')
    || error.message.includes('not materialized yet')
}

function findActiveTurnId(rawSnapshot: Record<string, any>): string | undefined {
  const turns = Array.isArray(rawSnapshot.thread?.turns) ? rawSnapshot.thread.turns : []
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    if (!turn || typeof turn !== 'object' || Array.isArray(turn)) continue
    const record = turn as Record<string, unknown>
    if (record.status === 'inProgress' && typeof record.id === 'string' && record.id.length > 0) {
      return record.id
    }
  }
  return undefined
}

export function createCodexFreshAgentAdapter(deps: {
  displayIdSecret: string
  runtime?: CodexRuntimePort
  runtimeFactory?: () => CodexRuntimePort
}): FreshAgentRuntimeAdapter {
  if (typeof deps.displayIdSecret !== 'string' || deps.displayIdSecret.trim().length === 0) {
    throw new Error('Codex fresh-agent adapter requires a persisted display-id secret.')
  }
  const displayIdSecret = deps.displayIdSecret
  const activeTurnByThread = new Map<string, string>()
  // Per-thread (not per-subscription) so the monotonic turn-complete clamp survives a WS
  // reconnect, matching how Claude/OpenCode keep it on session state.
  const lastTurnCompleteAtByThread = new Map<string, number>()
  const settingsByThread = new Map<string, Partial<FreshAgentCreateRequest>>()
  const runtimeByThread = new Map<string, CodexRuntimePort>()
  const threadIdsByRuntime = new Map<CodexRuntimePort, Set<string>>()
  const ownedRuntimes = new Set<CodexRuntimePort>()
  const runtimeResumeByThread = new Map<string, Promise<CodexRuntimePort>>()
  const runtimeResumeGenerationByThread = new Map<string, number>()
  const modelByTurnByThread = new Map<string, Map<string, string>>()
  const displayIndexByRevision = new Map<string, Map<string, DisplayIndexEntry>>()
  const displayCursorByHandle = new Map<string, CodexDisplayCursorEntry>()
  const submittedInputsByThread = new Map<string, Map<string, SubmittedInputRecord>>()
  const submittedAliasByThread = new Map<string, Map<string, string>>()

  const pruneDisplayIndex = () => {
    while (displayIndexByRevision.size > DISPLAY_INDEX_MAX_REVISIONS) {
      const oldestKey = displayIndexByRevision.keys().next().value
      if (!oldestKey) return
      displayIndexByRevision.delete(oldestKey)
    }
  }

  const pruneDisplayCursors = () => {
    const now = Date.now()
    for (const [handle, entry] of displayCursorByHandle) {
      if (entry.expiresAt <= now) {
        displayCursorByHandle.delete(handle)
      }
    }
    while (displayCursorByHandle.size > DISPLAY_CURSOR_MAX_ENTRIES) {
      const oldestHandle = displayCursorByHandle.keys().next().value
      if (!oldestHandle) return
      displayCursorByHandle.delete(oldestHandle)
    }
  }

  const createDisplayCursor = (entry: Omit<CodexDisplayCursorEntry, 'expiresAt'>): string => {
    pruneDisplayCursors()
    let handle = randomBytes(16).toString('base64url')
    while (displayCursorByHandle.has(handle)) {
      handle = randomBytes(16).toString('base64url')
    }
    displayCursorByHandle.set(handle, {
      ...entry,
      expiresAt: Date.now() + DISPLAY_CURSOR_TTL_MS,
    })
    pruneDisplayCursors()
    return `${DISPLAY_CURSOR_PREFIX}${handle}`
  }

  const resolveDisplayCursor = (input: {
    cursor: string
    threadId: string
    revision: number
  }): CodexDisplayCursorEntry => {
    pruneDisplayCursors()
    const handle = readDisplayCursorHandle(input.cursor)
    if (!handle) {
      throw new FreshAgentInvalidTurnCursorError('Invalid Codex display cursor.')
    }
    const entry = displayCursorByHandle.get(handle)
    if (!entry) {
      throw new FreshAgentInvalidTurnCursorError('Invalid or expired Codex display cursor.')
    }
    if (entry.threadId !== input.threadId) {
      throw new FreshAgentInvalidTurnCursorError('Codex display cursor does not belong to this thread.')
    }
    if (entry.revision !== input.revision) {
      throw new FreshAgentStaleThreadRevisionError(entry.revision)
    }
    return entry
  }

  const pruneSubmittedInputs = (threadId: string) => {
    const records = submittedInputsByThread.get(threadId)
    if (!records) return
    const cutoff = Date.now() - SUBMITTED_INPUT_TTL_MS
    for (const [key, record] of records) {
      if (record.createdAt < cutoff) {
        records.delete(key)
      }
    }
    if (records.size === 0) {
      submittedInputsByThread.delete(threadId)
    }
  }

  const submittedRequestIdMap = (threadId: string): Map<string, string | number> => {
    pruneSubmittedInputs(threadId)
    const requestIds = new Map<string, string | number>()
    const aliases = submittedAliasByThread.get(threadId)
    for (const [providerTurnId, requestId] of aliases ?? []) {
      requestIds.set(providerTurnId, requestId)
    }
    for (const record of submittedInputsByThread.get(threadId)?.values() ?? []) {
      requestIds.set(record.providerTurnId, record.requestId)
    }
    return requestIds
  }

  const firstSubmittedRecordForProviderTurn = (threadId: string, providerTurnId: string): SubmittedInputRecord | undefined => {
    pruneSubmittedInputs(threadId)
    for (const record of submittedInputsByThread.get(threadId)?.values() ?? []) {
      if (record.providerTurnId === providerTurnId) return record
    }
    return undefined
  }

  const rememberSubmittedInput = (threadId: string, record: SubmittedInputRecord) => {
    const records = submittedInputsByThread.get(threadId) ?? new Map<string, SubmittedInputRecord>()
    records.set(submittedInputKey(record.providerTurnId, record.requestId), record)
    submittedInputsByThread.set(threadId, records)
  }

  const rememberSubmittedAlias = (threadId: string, providerTurnId: string, requestId: string) => {
    const aliases = submittedAliasByThread.get(threadId) ?? new Map<string, string>()
    aliases.set(providerTurnId, requestId)
    submittedAliasByThread.set(threadId, aliases)
  }

  const prepareRawTurnForNormalization = (threadId: string, rawTurn: Record<string, unknown>): Record<string, unknown> => {
    const providerTurnId = String(rawTurn.id ?? '')
    if (!providerTurnId) return rawTurn
    const record = firstSubmittedRecordForProviderTurn(threadId, providerTurnId)
    if (!record) return rawTurn

    if (hasCodexUserMessage(rawTurn)) {
      submittedInputsByThread.get(threadId)?.delete(submittedInputKey(providerTurnId, record.requestId))
      rememberSubmittedAlias(threadId, providerTurnId, record.requestId)
      return rawTurn
    }

    return {
      ...rawTurn,
      items: [
        makeSubmittedUserMessage(record),
        ...readRawTurns(rawTurn.items),
      ],
    }
  }

  const registerDisplayRows = (input: {
    threadId: string
    revision: number
    rawTurn: Record<string, unknown>
    displayRows: Array<{
      turnId: string
      role: NonNullable<FreshAgentTurn['role']>
      providerTurnId: string
    }>
  }) => {
    const key = displayIndexKey(input.threadId, input.revision)
    const entries = displayIndexByRevision.get(key) ?? new Map<string, DisplayIndexEntry>()
    for (const row of input.displayRows) {
      entries.set(row.turnId, {
        threadId: input.threadId,
        revision: input.revision,
        displayTurnId: row.turnId,
        providerTurnId: row.providerTurnId,
        role: row.role,
        rawTurn: input.rawTurn,
      })
    }
    displayIndexByRevision.set(key, entries)
    pruneDisplayIndex()
  }

  const normalizeSingleRawTurn = (input: {
    threadId: string
    revision: number
    rawTurn: Record<string, unknown>
  }) => {
    const preparedTurn = prepareRawTurnForNormalization(input.threadId, input.rawTurn)
    const normalized = normalizeCodexDisplayTurns(preparedTurn, 0, {
      threadId: input.threadId,
      secret: displayIdSecret,
      submittedRequestIdByProviderTurnId: submittedRequestIdMap(input.threadId),
      model: typeof preparedTurn.id === 'string'
        ? modelByTurnByThread.get(input.threadId)?.get(preparedTurn.id)
        : undefined,
    })
    registerDisplayRows({
      threadId: input.threadId,
      revision: input.revision,
      rawTurn: preparedTurn,
      displayRows: normalized.displayRows,
    })
    return {
      rawTurn: preparedTurn,
      providerTurnId: String(preparedTurn.id ?? ''),
      turns: normalized.turns.map(stripCodexDisplayMetadata),
    }
  }

  const normalizeRawTurns = (input: {
    threadId: string
    revision: number
    rawTurns: Record<string, unknown>[]
  }): FreshAgentTurn[] => input.rawTurns.flatMap((rawTurn) => normalizeSingleRawTurn({
    threadId: input.threadId,
    revision: input.revision,
    rawTurn,
  }).turns).map((turn, index) => ({
    ...turn,
    ordinal: index,
  }))

  const normalizeRawPage = (input: {
    threadId: string
    revision: number
    rawPage: { turns?: unknown[]; nextCursor?: string | null; backwardsCursor?: string | null }
  }) => {
    const turns = normalizeRawTurns({
      threadId: input.threadId,
      revision: input.revision,
      rawTurns: readRawTurns(input.rawPage.turns),
    })
    return FreshAgentTurnPageSchema.parse({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: input.threadId,
      revision: input.revision,
      nextCursor: input.rawPage.nextCursor ?? null,
      backwardsCursor: input.rawPage.backwardsCursor ?? null,
      turns,
      bodies: Object.fromEntries(turns.map((turn) => [turn.turnId, turn])),
    })
  }

  const normalizeDisplayTurnPage = async (input: {
    runtime: CodexRuntimePort
    threadId: string
    revision: number
    cursor?: string
    limit?: number
  }) => {
    const limit = input.limit ?? 30
    const turns: FreshAgentTurn[] = []
    let providerCursor: string | null | undefined
    let backwardsCursor: string | null | undefined

    const appendTurnRows = (rawTurn: Record<string, unknown>, offset: number, providerCursorAfterTurn: string | null) => {
      const normalized = normalizeSingleRawTurn({
        threadId: input.threadId,
        revision: input.revision,
        rawTurn,
      })
      const availableRows = normalized.turns.slice(offset)
      const remainingSlots = limit - turns.length
      const selectedRows = availableRows.slice(0, remainingSlots)
      turns.push(...selectedRows)
      const nextDisplayOffset = offset + selectedRows.length
      if (nextDisplayOffset < normalized.turns.length) {
        return createDisplayCursor({
          threadId: input.threadId,
          revision: input.revision,
          providerCursor: providerCursorAfterTurn,
          drainingProviderTurnId: normalized.providerTurnId,
          nextDisplayOffset,
          rawTurn: normalized.rawTurn,
          order: 'provider-default',
        })
      }
      if (providerCursorAfterTurn && turns.length >= limit) {
        return createDisplayCursor({
          threadId: input.threadId,
          revision: input.revision,
          providerCursor: providerCursorAfterTurn,
          nextDisplayOffset: 0,
          order: 'provider-default',
        })
      }
      return null
    }

    if (input.cursor) {
      const cursor = resolveDisplayCursor({
        cursor: input.cursor,
        threadId: input.threadId,
        revision: input.revision,
      })
      providerCursor = cursor.providerCursor
      if (cursor.rawTurn) {
        const nextCursor = appendTurnRows(cursor.rawTurn, cursor.nextDisplayOffset, cursor.providerCursor)
        if (turns.length >= limit || nextCursor || !cursor.providerCursor) {
          return FreshAgentTurnPageSchema.parse({
            sessionType: 'freshcodex',
            provider: 'codex',
            threadId: input.threadId,
            revision: input.revision,
            nextCursor,
            backwardsCursor: null,
            turns: turns.map((turn, index) => ({ ...turn, ordinal: index })),
            bodies: Object.fromEntries(turns.map((turn) => [turn.turnId, turn])),
          })
        }
      }
    }

    while (turns.length < limit) {
      const rawPage = await input.runtime.listThreadTurns({
        threadId: input.threadId,
        ...(providerCursor ? { cursor: providerCursor } : {}),
        limit: 1,
        itemsView: 'full',
      })
      const pageRevision = Number(rawPage.revision ?? input.revision)
      if (pageRevision !== input.revision) {
        throw new FreshAgentStaleThreadRevisionError(pageRevision)
      }
      backwardsCursor = typeof rawPage.backwardsCursor === 'string' ? rawPage.backwardsCursor : backwardsCursor
      const rawTurns = readRawTurns(rawPage.turns)
      providerCursor = typeof rawPage.nextCursor === 'string' && rawPage.nextCursor.length > 0
        ? rawPage.nextCursor
        : null
      if (rawTurns.length === 0) {
        if (providerCursor) continue
        break
      }
      const nextCursor = appendTurnRows(rawTurns[0], 0, providerCursor)
      if (turns.length >= limit || nextCursor) {
        return FreshAgentTurnPageSchema.parse({
          sessionType: 'freshcodex',
          provider: 'codex',
          threadId: input.threadId,
          revision: input.revision,
          nextCursor,
          backwardsCursor: backwardsCursor ?? null,
          turns: turns.map((turn, index) => ({ ...turn, ordinal: index })),
          bodies: Object.fromEntries(turns.map((turn) => [turn.turnId, turn])),
        })
      }
      if (!providerCursor) break
    }

    return FreshAgentTurnPageSchema.parse({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: input.threadId,
      revision: input.revision,
      nextCursor: null,
      backwardsCursor: backwardsCursor ?? null,
      turns: turns.map((turn, index) => ({ ...turn, ordinal: index })),
      bodies: Object.fromEntries(turns.map((turn) => [turn.turnId, turn])),
    })
  }

  const findDisplayIndexEntry = (threadId: string, revision: number, displayTurnId: string): DisplayIndexEntry | undefined => {
    return displayIndexByRevision.get(displayIndexKey(threadId, revision))?.get(displayTurnId)
  }

  const rescanDisplayIndex = async (
    runtime: CodexRuntimePort,
    threadId: string,
    revision: number,
    displayTurnId: string,
  ): Promise<DisplayIndexEntry | null> => {
    let cursor: string | undefined
    do {
      const rawPage = await runtime.listThreadTurns({
        threadId,
        ...(cursor ? { cursor } : {}),
        limit: 100,
        itemsView: 'full',
      })
      const currentRevision = Number(rawPage.revision ?? revision)
      normalizeRawPage({ threadId, revision: currentRevision, rawPage })
      if (currentRevision !== revision) {
        throw new FreshAgentStaleThreadRevisionError(currentRevision)
      }
      const entry = findDisplayIndexEntry(threadId, revision, displayTurnId)
      if (entry) return entry
      cursor = typeof rawPage.nextCursor === 'string' && rawPage.nextCursor.length > 0
        ? rawPage.nextCursor
        : undefined
    } while (cursor)
    return null
  }

  const clearThreadState = (threadId: string) => {
    activeTurnByThread.delete(threadId)
    lastTurnCompleteAtByThread.delete(threadId)
    settingsByThread.delete(threadId)
    modelByTurnByThread.delete(threadId)
    submittedInputsByThread.delete(threadId)
    submittedAliasByThread.delete(threadId)
    for (const key of [...displayIndexByRevision.keys()]) {
      if (key.startsWith(`${threadId}\u0000`)) {
        displayIndexByRevision.delete(key)
      }
    }
    for (const [handle, entry] of displayCursorByHandle) {
      if (entry.threadId === threadId) {
        displayCursorByHandle.delete(handle)
      }
    }
  }

  const rememberThreadSettings = (
    threadId: string,
    settings?: Partial<FreshAgentCreateRequest>,
  ): Partial<FreshAgentCreateRequest> | undefined => {
    if (!settings) return settingsByThread.get(threadId)
    const definedSettings = Object.fromEntries(
      Object.entries(settings).filter(([, value]) => value !== undefined),
    ) as Partial<FreshAgentCreateRequest>
    if (Object.keys(definedSettings).length === 0) return settingsByThread.get(threadId)
    const merged = {
      ...settingsByThread.get(threadId),
      ...definedSettings,
    }
    settingsByThread.set(threadId, merged)
    return merged
  }

  const settingsFromLocator = (
    locator: { sessionType?: FreshAgentCreateRequest['sessionType']; cwd?: string },
  ): Partial<FreshAgentCreateRequest> | undefined => {
    const cwd = typeof locator.cwd === 'string' && locator.cwd.trim().length > 0
      ? locator.cwd
      : undefined
    return cwd ? { sessionType: locator.sessionType, cwd } : undefined
  }

  const rememberRuntimeThread = (threadId: string, runtime: CodexRuntimePort) => {
    runtimeByThread.set(threadId, runtime)
    const threadIds = threadIdsByRuntime.get(runtime) ?? new Set<string>()
    threadIds.add(threadId)
    threadIdsByRuntime.set(runtime, threadIds)
  }

  const forgetRuntimeThread = (threadId: string): CodexRuntimePort | undefined => {
    const runtime = runtimeByThread.get(threadId)
    runtimeByThread.delete(threadId)
    if (!runtime) return undefined
    const threadIds = threadIdsByRuntime.get(runtime)
    threadIds?.delete(threadId)
    if (threadIds && threadIds.size === 0) {
      threadIdsByRuntime.delete(runtime)
    }
    return runtime
  }

  const allocateRuntime = () => {
    if (deps.runtimeFactory) {
      const runtime = deps.runtimeFactory()
      ownedRuntimes.add(runtime)
      return { runtime, owned: true }
    }
    if (deps.runtime) return { runtime: deps.runtime, owned: false }
    throw new Error('Codex fresh-agent adapter requires a runtime or runtimeFactory.')
  }

  const getExistingRuntime = (sessionId: string): CodexRuntimePort | undefined => {
    return runtimeByThread.get(sessionId) ?? deps.runtime
  }

  const requireRuntime = (sessionId: string): CodexRuntimePort => {
    const runtime = runtimeByThread.get(sessionId) ?? deps.runtime
    if (!runtime) {
      throw new Error(`Codex app-server runtime is not available for freshcodex session ${sessionId}.`)
    }
    return runtime
  }

  const ensureRuntime = async (sessionId: string, settings?: Partial<FreshAgentCreateRequest>): Promise<CodexRuntimePort> => {
    const effectiveSettings = rememberThreadSettings(sessionId, settings)
    const existing = getExistingRuntime(sessionId)
    if (existing) return existing
    const inflight = runtimeResumeByThread.get(sessionId)
    if (inflight) return inflight

    const { runtime, owned } = allocateRuntime()
    const resumeGeneration = runtimeResumeGenerationByThread.get(sessionId) ?? 0
    let resumePromise: Promise<CodexRuntimePort> | undefined
    let runtimeDiscarded = false
    const discardOwnedRuntime = async () => {
      if (!owned || runtimeDiscarded) return
      runtimeDiscarded = true
      ownedRuntimes.delete(runtime)
      await runtime.shutdown?.().catch(() => undefined)
    }
    resumePromise = (async () => {
      try {
        const resumed = await runtime.resumeThread(toCodexResumeInput(sessionId, effectiveSettings))
        if ((runtimeResumeGenerationByThread.get(sessionId) ?? 0) !== resumeGeneration) {
          await discardOwnedRuntime()
          throw new Error(`Codex app-server runtime resume was cancelled for freshcodex session ${sessionId}.`)
        }
        rememberRuntimeThread(resumed.threadId, runtime)
        if (effectiveSettings) {
          settingsByThread.set(resumed.threadId, effectiveSettings)
        }
        return runtime
      } catch (error) {
        await discardOwnedRuntime()
        throw error
      } finally {
        if (resumePromise && runtimeResumeByThread.get(sessionId) === resumePromise) {
          runtimeResumeByThread.delete(sessionId)
        }
      }
    })()
    runtimeResumeByThread.set(sessionId, resumePromise)
    return resumePromise
  }

  const releaseRuntime = async (sessionId: string) => {
    const runtime = runtimeByThread.get(sessionId)
    runtimeByThread.delete(sessionId)
    const threadIds = runtime ? threadIdsByRuntime.get(runtime) : undefined
    threadIds?.delete(sessionId)
    if (!runtime || !ownedRuntimes.has(runtime)) return
    if ((threadIds?.size ?? 0) > 0) return
    await runtime.shutdown?.()
    ownedRuntimes.delete(runtime)
    threadIdsByRuntime.delete(runtime)
  }

  return {
    runtimeProvider: 'codex',

    async create(input: FreshAgentCreateRequest) {
      const normalizedInput = normalizeCodexInput(input)
      toCodexReasoningEffort(normalizedInput.effort)
      const { runtime, owned } = allocateRuntime()
      let started: { threadId: string; wsUrl: string }
      try {
        started = await runtime.startThread({
          cwd: normalizedInput.cwd,
          model: normalizedInput.model,
          sandbox: normalizedInput.sandbox,
          approvalPolicy: toCodexApprovalPolicy(normalizedInput.permissionMode),
        })
      } catch (error) {
        if (owned) {
          ownedRuntimes.delete(runtime)
          await runtime.shutdown?.().catch(() => undefined)
        }
        throw error
      }
      rememberRuntimeThread(started.threadId, runtime)
      settingsByThread.set(started.threadId, normalizedInput)
      return { sessionId: started.threadId, sessionRef: { provider: 'codex', sessionId: started.threadId } }
    },

    async resume(input: FreshAgentCreateRequest) {
      if (!input.resumeSessionId) {
        throw new Error('Codex rich resume requires resumeSessionId')
      }
      const normalizedInput = normalizeCodexInput(input)
      toCodexReasoningEffort(normalizedInput.effort)
      const { runtime, owned } = allocateRuntime()
      let resumed: { threadId: string; wsUrl: string }
      try {
        resumed = await runtime.resumeThread({
          threadId: input.resumeSessionId,
          cwd: normalizedInput.cwd,
          model: normalizedInput.model,
          sandbox: normalizedInput.sandbox,
          approvalPolicy: toCodexApprovalPolicy(normalizedInput.permissionMode),
        })
      } catch (error) {
        if (owned) {
          ownedRuntimes.delete(runtime)
          await runtime.shutdown?.().catch(() => undefined)
        }
        throw error
      }
      rememberRuntimeThread(resumed.threadId, runtime)
      settingsByThread.set(resumed.threadId, normalizedInput)
      return { sessionId: resumed.threadId, sessionRef: { provider: 'codex', sessionId: resumed.threadId } }
    },

    attach(locator) {
      rememberThreadSettings(locator.sessionId, settingsFromLocator(locator))
      return { sessionId: locator.sessionId, sessionRef: { provider: 'codex', sessionId: locator.sessionId } }
    },

    async subscribe(sessionId, listener) {
      const runtime = await ensureRuntime(sessionId, settingsByThread.get(sessionId))
      if (!runtime.onThreadLifecycle) {
        throw new Error('Codex app-server runtime does not support thread lifecycle subscriptions.')
      }
      const offLifecycle = runtime.onThreadLifecycle((event) => {
        if (event.kind === 'thread_started') {
          if (event.thread.id !== sessionId) return
          listener(makeCodexStatusEvent(sessionId, event.thread.status, event.thread.updatedAt))
          return
        }
        if (event.kind === 'thread_closed') {
          if (event.threadId !== sessionId) return
          clearThreadState(sessionId)
          void releaseRuntime(sessionId).catch(() => undefined)
          listener({
            type: 'sdk.status',
            sessionId,
            status: 'exited',
          })
          return
        }
        if (event.threadId !== sessionId) return
        const status = normalizeCodexThreadStatus(event.status)
        if (status !== 'running' && status !== 'starting') {
          activeTurnByThread.delete(sessionId)
        }
        listener(makeCodexStatusEvent(sessionId, event.status))
      })

      // onTurnCompleted fires after the turn is committed to the app-server's
      // thread history. thread_status_changed(idle) can fire BEFORE that commit,
      // leaving the client with an empty transcript. Emit an idle snapshot here
      // to make the client re-fetch the committed transcript (parity with
      // freshopencode's post-idle emit).
      const offTurnCompleted = runtime.onTurnCompleted?.((event) => {
        if (event.threadId !== sessionId) return
        activeTurnByThread.delete(sessionId)
        listener(makeCodexStatusEvent(sessionId, 'idle'))

        // Server-authoritative turn-complete edge for the GREEN/SOUND pipeline.
        // turn/completed fires for interrupts/failures too, so chime only on a
        // positive completion. The authoritative status appears either inline at
        // params.turn.status (codex-cli 0.142.0, probed live) or flat at
        // params.status (the shape the app-server client tests model); accept
        // either so neither version silently fails.
        const params = event.params as { status?: unknown; turn?: { status?: unknown } } | undefined
        const status = params?.turn?.status ?? params?.status
        if (status !== 'completed') return
        const at = nextMonotonicTurnCompleteAt(lastTurnCompleteAtByThread.get(sessionId), Date.now())
        lastTurnCompleteAtByThread.set(sessionId, at)
        listener({ type: 'sdk.turn.complete', sessionId, at })
      })
      return () => {
        offLifecycle()
        offTurnCompleted?.()
      }
    },

    async send(sessionId, input) {
      const requestId = input.requestId ?? `codex-send-${Date.now()}`
      const settings: Partial<FreshAgentCreateRequest> = {
        ...settingsByThread.get(sessionId),
        ...input.settings,
      }
      const model = normalizeFreshAgentModel(settings.sessionType ?? 'freshcodex', 'codex', settings.model)
      settings.model = model
      settings.effort = normalizeFreshAgentEffort(settings.sessionType ?? 'freshcodex', 'codex', model, settings.effort)
      const runtime = await ensureRuntime(sessionId, Object.keys(settings).length > 0 ? settings : undefined)
      if (Object.keys(settings).length > 0) {
        settingsByThread.set(sessionId, settings)
      }
      if (!runtime.startTurn) {
        throw new Error('Codex app-server runtime does not support turn/start.')
      }
      const turn = await runtime.startTurn({
        threadId: sessionId,
        input: toCodexUserInput(input.text, input.images),
        cwd: settings.cwd,
        approvalPolicy: toCodexApprovalPolicy(settings.permissionMode),
        sandboxPolicy: toCodexSandboxPolicy(settings.sandbox),
        model: settings.model,
        effort: toCodexReasoningEffort(settings.effort),
      })
      activeTurnByThread.set(sessionId, turn.turnId)
      const submittedTurnId = createCodexDisplayId({
        secret: displayIdSecret,
        threadId: sessionId,
        providerTurnId: turn.turnId,
        role: 'user',
        syntheticKind: 'submitted-input',
        requestId,
      })
      rememberSubmittedInput(sessionId, {
        requestId,
        providerTurnId: turn.turnId,
        submittedTurnId,
        input: toCodexUserInput(input.text, input.images),
        createdAt: Date.now(),
      })
      if (settings.model) {
        const modelByTurn = modelByTurnByThread.get(sessionId) ?? new Map<string, string>()
        modelByTurn.set(turn.turnId, settings.model)
        modelByTurnByThread.set(sessionId, modelByTurn)
      }
      return { requestId, submittedTurnId }
    },

    async interrupt(sessionId) {
      const runtime = await ensureRuntime(sessionId, settingsByThread.get(sessionId))
      if (!runtime.interruptTurn) {
        throw new Error('Codex app-server runtime does not support turn/interrupt.')
      }
      let turnId = activeTurnByThread.get(sessionId)
      if (!turnId) {
        try {
          const rawSnapshot = await runtime.readThread({ threadId: sessionId, includeTurns: true })
          turnId = findActiveTurnId(rawSnapshot)
          if (turnId) {
            activeTurnByThread.set(sessionId, turnId)
          }
        } catch (error) {
          if (!isCodexIncludeTurnsUnavailable(error)) {
            throw error
          }
        }
      }
      if (!turnId) {
        throw new Error(`No active Codex turn is tracked for ${sessionId}.`)
      }
      await runtime.interruptTurn({ threadId: sessionId, turnId })
      activeTurnByThread.delete(sessionId)
    },

    async compact(sessionId, input) {
      const settings = settingsByThread.get(sessionId)
      const runtime = await ensureRuntime(sessionId, settings)
      if (runtime.compactThread) {
        await runtime.compactThread({ threadId: sessionId, instructions: input?.instructions })
        return
      }
      if (!runtime.startTurn) {
        throw new Error('Codex app-server runtime does not support thread compaction.')
      }
      const text = input?.instructions ? `/compact ${input.instructions}` : '/compact'
      const turn = await runtime.startTurn({
        threadId: sessionId,
        input: toCodexUserInput(text, undefined),
        cwd: settings?.cwd,
        approvalPolicy: toCodexApprovalPolicy(settings?.permissionMode),
        sandboxPolicy: toCodexSandboxPolicy(settings?.sandbox),
        model: settings?.model,
        effort: toCodexReasoningEffort(settings?.effort),
      })
      activeTurnByThread.set(sessionId, turn.turnId)
    },

    async fork(sessionId, input) {
      const settings = settingsByThread.get(sessionId)
      const runtime = await ensureRuntime(sessionId, settings)
      if (!runtime.forkThread) {
        throw new Error('Codex app-server runtime does not support thread/fork.')
      }
      const forked = await runtime.forkThread({
        threadId: sessionId,
        cwd: typeof input?.cwd === 'string' ? input.cwd : settings?.cwd,
        model: typeof input?.model === 'string' ? input.model : settings?.model,
        sandbox: typeof input?.sandbox === 'string' ? input.sandbox as FreshAgentCreateRequest['sandbox'] : settings?.sandbox,
        approvalPolicy: toCodexApprovalPolicy(
          typeof input?.permissionMode === 'string' ? input.permissionMode : settings?.permissionMode,
        ),
        excludeTurns: true,
      })
      if (forked && typeof forked.threadId === 'string') {
        rememberRuntimeThread(forked.threadId, runtime)
        settingsByThread.set(forked.threadId, {
          ...(settings ?? { requestId: '', sessionType: 'freshcodex' }),
          ...(typeof input?.cwd === 'string' ? { cwd: input.cwd } : {}),
          ...(typeof input?.model === 'string' ? { model: input.model } : {}),
          ...(typeof input?.sandbox === 'string' ? { sandbox: input.sandbox as FreshAgentCreateRequest['sandbox'] } : {}),
          ...(typeof input?.permissionMode === 'string' ? { permissionMode: input.permissionMode } : {}),
        })
      }
      return forked
    },

    async getSnapshot(thread, revision) {
      const runtime = await ensureRuntime(
        thread.threadId,
        settingsFromLocator(thread) ?? settingsByThread.get(thread.threadId),
      )
      let rawSnapshot: Record<string, any>
      try {
        rawSnapshot = await runtime.readThread({ threadId: thread.threadId, includeTurns: true })
      } catch (error) {
        if (!isCodexIncludeTurnsUnavailable(error)) {
          throw error
        }
        rawSnapshot = await runtime.readThread({ threadId: thread.threadId, includeTurns: false })
      }
      const rawThreadTurns: unknown[] = Array.isArray(rawSnapshot.thread?.turns)
        ? rawSnapshot.thread.turns
        : []
      const activeTurnId = findActiveTurnId(rawSnapshot)
      if (activeTurnId) {
        activeTurnByThread.set(thread.threadId, activeTurnId)
      } else if (normalizeCodexThreadStatus(rawSnapshot.thread?.status) !== 'running') {
        activeTurnByThread.delete(thread.threadId)
      }
      const rawTurns = rawThreadTurns
        .filter((turn): turn is Record<string, unknown> => !!turn && typeof turn === 'object' && !Array.isArray(turn))
      const revisionNumber = Number(rawSnapshot.thread?.updatedAt ?? revision ?? 0)
      const turns = normalizeRawTurns({
        threadId: thread.threadId,
        revision: revisionNumber,
        rawTurns,
      })
      return normalizeCodexThreadSnapshot({
        threadId: thread.threadId,
        revision: revisionNumber,
        status: normalizeCodexThreadStatus(rawSnapshot.thread?.status),
        transcript: {
          turns,
        },
        rawSnapshot,
      })
    },

    async getTurnPage(thread, query) {
      const runtime = await ensureRuntime(
        thread.threadId,
        settingsFromLocator(thread) ?? settingsByThread.get(thread.threadId),
      )
      return normalizeDisplayTurnPage({
        runtime,
        threadId: thread.threadId,
        revision: Number(query.revision ?? 0),
        cursor: typeof query.cursor === 'string' ? query.cursor : undefined,
        limit: typeof query.limit === 'number' ? query.limit : undefined,
      })
    },

    async getTurnBody(thread, revision) {
      const runtime = await ensureRuntime(
        thread.threadId,
        settingsFromLocator(thread) ?? settingsByThread.get(thread.threadId),
      )
      if (thread.turnId.startsWith('codex-display:') && !parseCodexDisplayIdHandle(thread.turnId)) {
        throw new FreshAgentInvalidDisplayIdError('Invalid Codex display turn id.')
      }
      const displayHandle = parseCodexDisplayIdHandle(thread.turnId)
      if (displayHandle) {
        const entry = findDisplayIndexEntry(thread.threadId, revision, thread.turnId)
          ?? await rescanDisplayIndex(runtime, thread.threadId, revision, thread.turnId)
        if (!entry) {
          throw new FreshAgentTurnNotFoundError('Codex display turn was not found in the requested thread revision.')
        }
        const rawTurn = await runtime.readThreadTurn({
          threadId: thread.threadId,
          turnId: entry.providerTurnId,
          revision,
        })
        try {
          return normalizeCodexTurnBody({
            threadId: thread.threadId,
            revision,
            requestedTurnId: thread.turnId,
            rawTurn: prepareRawTurnForNormalization(thread.threadId, rawTurn),
            model: modelByTurnByThread.get(thread.threadId)?.get(entry.providerTurnId),
            secret: displayIdSecret,
            submittedRequestIdByProviderTurnId: submittedRequestIdMap(thread.threadId),
          })
        } catch (error) {
          if (error instanceof CodexDisplayTurnNotFoundError) {
            throw new FreshAgentUnprovableThreadRevisionError(revision)
          }
          throw error
        }
      }

      const rawTurn = await runtime.readThreadTurn({
        threadId: thread.threadId,
        turnId: thread.turnId,
        revision,
      })
      const preparedTurn = prepareRawTurnForNormalization(thread.threadId, rawTurn)
      const normalized = normalizeCodexDisplayTurns(preparedTurn, 0, {
        threadId: thread.threadId,
        secret: displayIdSecret,
        submittedRequestIdByProviderTurnId: submittedRequestIdMap(thread.threadId),
        model: typeof preparedTurn.id === 'string'
          ? modelByTurnByThread.get(thread.threadId)?.get(preparedTurn.id)
          : undefined,
      })
      registerDisplayRows({
        threadId: thread.threadId,
        revision,
        rawTurn: preparedTurn,
        displayRows: normalized.displayRows,
      })
      if (normalized.turns.length !== 1) {
        throw new FreshAgentAmbiguousTurnBodyError(
          `Codex native turn ${thread.turnId} normalizes to ${normalized.turns.length} display turns; request a display turn id instead.`,
        )
      }
      return normalizeCodexTurnBody({
        threadId: thread.threadId,
        revision,
        requestedTurnId: normalized.turns[0].turnId,
        rawTurn: preparedTurn,
        model: typeof rawTurn.id === 'string'
          ? modelByTurnByThread.get(thread.threadId)?.get(rawTurn.id)
          : undefined,
        secret: displayIdSecret,
        submittedRequestIdByProviderTurnId: submittedRequestIdMap(thread.threadId),
      })
    },

    async kill(sessionId) {
      clearThreadState(sessionId)
      runtimeResumeGenerationByThread.set(sessionId, (runtimeResumeGenerationByThread.get(sessionId) ?? 0) + 1)
      runtimeResumeByThread.delete(sessionId)
      await releaseRuntime(sessionId)
      return true
    },

    async shutdown() {
      const runtimes = [...ownedRuntimes]
      ownedRuntimes.clear()
      runtimeByThread.clear()
      threadIdsByRuntime.clear()
      runtimeResumeByThread.clear()
      runtimeResumeGenerationByThread.clear()
      activeTurnByThread.clear()
      settingsByThread.clear()
      modelByTurnByThread.clear()
      displayIndexByRevision.clear()
      displayCursorByHandle.clear()
      submittedInputsByThread.clear()
      submittedAliasByThread.clear()
      lastTurnCompleteAtByThread.clear()
      await Promise.all(runtimes.map((runtime) => runtime.shutdown?.()))
    },
  }
}
