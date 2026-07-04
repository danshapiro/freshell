import path from 'node:path'
import { TextDecoder } from 'node:util'

import {
  MAX_SCANNED_TOKEN_BYTES,
  type JsonRpcFrameInput,
} from './json-rpc-envelope.js'

type JsonRpcId = string | number
type ProxyFrame = Buffer

export type ThreadForkRewriteResult =
  | { ok: true; raw: ProxyFrame }
  | { ok: false; reason: SideEffectFailureReason }

export type ThreadForkResponseRewriteResult =
  | { ok: true; raw: ProxyFrame }
  | { ok: false; reason: SideEffectFailureReason }

type ExtractFailure = { ok: false; reason: SideEffectFailureReason }

type CandidateThread = {
  id: string
  path: string | null
  ephemeral: boolean
}

export type ThreadStartResponseCandidateExtractionResult =
  | {
      ok: true
      candidate: {
        source: 'thread_start_response'
        thread: CandidateThread
      }
    }
  | ExtractFailure

export type ForkResponseCandidateExtractionResult =
  | {
      ok: true
      candidate: {
        source: 'thread_fork_response'
        thread: {
          id: string
          path: string
          ephemeral: boolean
        }
      }
    }
  | ExtractFailure

export type ThreadStartedNotificationSideEffectsExtractionResult =
  | {
      ok: true
      candidate: {
        source: 'thread_started_notification'
        thread: CandidateThread
      }
      lifecycle: {
        kind: 'thread_started'
        thread: CandidateThread
      }
    }
  | ExtractFailure

export type TurnNotificationEventExtractionResult =
  | {
      ok: true
      event:
        | {
            kind: 'turn_started'
            threadId: string
            turnId?: string
          }
        | {
            kind: 'turn_completed'
            threadId: string
            turnId?: string
            status?: string
          }
    }
  | ExtractFailure

export type ThreadLifecycleEventExtractionResult =
  | {
      ok: true
      event:
        | {
            kind: 'thread_closed'
            threadId: string
          }
        | {
            kind: 'thread_status_changed'
            threadId: string
            status: { type: string } & Record<string, unknown>
          }
    }
  | ExtractFailure

export type FsChangedRepairTriggerExtractionResult =
  | {
      ok: true
      trigger: {
        kind: 'fs_changed'
        watchId: string
        changedPaths: string[]
      }
    }
  | ExtractFailure

type SideEffectFailureReason =
  | 'batch_unsupported'
  | 'ephemeral_thread'
  | 'id_not_pending_fork'
  | 'id_not_pending_thread_start'
  | 'malformed_json'
  | 'missing_parent_thread_id'
  | 'missing_rollout_path'
  | 'missing_thread'
  | 'path_alias_conflict'
  | 'relative_rollout_path'
  | 'same_as_parent'
  | 'token_too_large'
  | 'unsafe_duplicate_key'
  | 'unsupported_shape'

type JsonValueKind = 'array' | 'literal' | 'number' | 'object' | 'string'

type ObjectEntry = {
  key: string
  keyStart: number
  keyEnd: number
  valueStart: number
  valueEnd: number
  valueKind: JsonValueKind
}

type ScannedObject = {
  entries: ObjectEntry[]
  start: number
  closeIndex: number
  end: number
}

type ScanResult<T> = { ok: true; value: T } | ExtractFailure
type IndexScanResult = { ok: true; next: number } | ExtractFailure
type ObjectScanResult = { ok: true; object: ScannedObject } | ExtractFailure
type StringScanResult = { ok: true; value: string; next: number } | ExtractFailure
type StringBoundsScanResult =
  | { ok: true; contentStart: number; contentEnd: number; hasEscape: boolean; next: number }
  | ExtractFailure
type ThreadScanResult =
  | {
      ok: true
      thread: CandidateThread
      aliases: {
        rolloutPath?: string
        rollout_path?: string
      }
    }
  | ExtractFailure

type ContainerFrame =
  | {
      type: 'array'
      state: 'expectValueOrEnd' | 'expectValue' | 'expectCommaOrEnd'
    }
  | {
      type: 'object'
      state: 'expectKeyOrEnd' | 'expectKey' | 'expectColon' | 'expectValue' | 'expectCommaOrEnd'
    }

const utf8Decoder = new TextDecoder('utf-8')
const MAX_SMALL_PARSE_BYTES = 16 * 1024
const MAX_FS_CHANGED_PATHS_BYTES = 16 * 1024

const BYTE_TAB = 0x09
const BYTE_LF = 0x0a
const BYTE_CR = 0x0d
const BYTE_SPACE = 0x20
const BYTE_QUOTE = 0x22
const BYTE_MINUS = 0x2d
const BYTE_COMMA = 0x2c
const BYTE_DOT = 0x2e
const BYTE_COLON = 0x3a
const BYTE_BACKSLASH = 0x5c
const BYTE_OPEN_BRACKET = 0x5b
const BYTE_CLOSE_BRACKET = 0x5d
const BYTE_OPEN_BRACE = 0x7b
const BYTE_CLOSE_BRACE = 0x7d

export function rewriteThreadForkRequestExcludeTurns(input: JsonRpcFrameInput): ThreadForkRewriteResult {
  const raw = frameToBuffer(input)
  const root = scanRootObject(raw)
  if (!root.ok) return root
  if (hasDuplicateKey(root.object.entries, 'params')) {
    return failure('unsafe_duplicate_key')
  }

  const params = findEntry(root.object.entries, 'params')
  if (!params) {
    const prefix = root.object.entries.length === 0 ? '' : ','
    return {
      ok: true,
      raw: spliceBuffer(raw, root.object.closeIndex, root.object.closeIndex, `${prefix}"params":{"excludeTurns":true}`),
    }
  }

  if (params.valueKind !== 'object') return failure('unsupported_shape')
  const paramsObject = scanObject(raw, params.valueStart)
  if (!paramsObject.ok) return paramsObject
  if (hasDuplicateKey(paramsObject.object.entries, 'excludeTurns')) {
    return failure('unsafe_duplicate_key')
  }

  const excludeTurns = findEntry(paramsObject.object.entries, 'excludeTurns')
  if (!excludeTurns) {
    const prefix = paramsObject.object.entries.length === 0 ? '' : ','
    return {
      ok: true,
      raw: spliceBuffer(
        raw,
        paramsObject.object.closeIndex,
        paramsObject.object.closeIndex,
        `${prefix}"excludeTurns":true`,
      ),
    }
  }

  if (literalEquals(raw, excludeTurns, 'true')) {
    return { ok: true, raw }
  }
  if (!literalEquals(raw, excludeTurns, 'false') && !literalEquals(raw, excludeTurns, 'null')) {
    return failure('unsupported_shape')
  }

  return {
    ok: true,
    raw: spliceBuffer(raw, excludeTurns.valueStart, excludeTurns.valueEnd, 'true'),
  }
}

export function normalizeThreadForkResponseForTui(input: JsonRpcFrameInput): ThreadForkResponseRewriteResult {
  const raw = frameToBuffer(input)
  const root = scanRootObject(raw)
  if (!root.ok) return root
  if (hasAnyDuplicateKey(root.object.entries, ['result'])) return failure('unsafe_duplicate_key')

  const result = findEntry(root.object.entries, 'result')
  if (!result || result.valueKind !== 'object') return failure('unsupported_shape')
  const resultObject = scanObject(raw, result.valueStart)
  if (!resultObject.ok) return resultObject
  if (hasAnyDuplicateKey(resultObject.object.entries, ['thread'])) return failure('unsafe_duplicate_key')

  const thread = findEntry(resultObject.object.entries, 'thread')
  if (!thread || thread.valueKind !== 'object') return failure('missing_thread')
  const threadObject = scanObject(raw, thread.valueStart)
  if (!threadObject.ok) return threadObject
  if (hasAnyDuplicateKey(threadObject.object.entries, ['id', 'path', 'ephemeral', 'turns'])) {
    return failure('unsafe_duplicate_key')
  }

  const turns = findEntry(threadObject.object.entries, 'turns')
  if (turns) {
    if (turns.valueKind !== 'array') return failure('unsupported_shape')
    return { ok: true, raw }
  }

  const prefix = threadObject.object.entries.length === 0 ? '' : ','
  return {
    ok: true,
    raw: spliceBuffer(raw, threadObject.object.closeIndex, threadObject.object.closeIndex, `${prefix}"turns":[]`),
  }
}

export function extractThreadStartResponseCandidate(
  input: JsonRpcFrameInput,
  options: {
    pendingThreadStartRequestIds: ReadonlySet<string | number>
  },
): ThreadStartResponseCandidateExtractionResult {
  const raw = frameToBuffer(input)
  const root = scanRootObject(raw)
  if (!root.ok) return root
  if (hasAnyDuplicateKey(root.object.entries, ['id', 'result'])) {
    return failure('unsafe_duplicate_key')
  }

  const id = extractTopLevelId(raw, root.object.entries)
  if (!id.ok) return id
  if (!options.pendingThreadStartRequestIds.has(id.value)) {
    return failure('id_not_pending_thread_start')
  }

  const thread = extractResultThread(raw, root.object.entries)
  if (!thread.ok) return thread

  return {
    ok: true,
    candidate: {
      source: 'thread_start_response',
      thread: thread.thread,
    },
  }
}

export function extractForkResponseCandidate(
  input: JsonRpcFrameInput,
  options: {
    parentThreadId?: string | null
    pendingForkRequestIds: ReadonlySet<string | number>
    provenForkPathField: 'path'
  },
): ForkResponseCandidateExtractionResult {
  const raw = frameToBuffer(input)
  const root = scanRootObject(raw)
  if (!root.ok) return root
  if (hasAnyDuplicateKey(root.object.entries, ['id', 'result'])) {
    return failure('unsafe_duplicate_key')
  }

  const id = extractTopLevelId(raw, root.object.entries)
  if (!id.ok) return id
  if (!options.pendingForkRequestIds.has(id.value)) {
    return failure('id_not_pending_fork')
  }
  if (typeof options.parentThreadId !== 'string' || options.parentThreadId.length === 0) {
    return failure('missing_parent_thread_id')
  }

  const thread = extractResultThread(raw, root.object.entries)
  if (!thread.ok) return thread
  if (thread.thread.id === options.parentThreadId) return failure('same_as_parent')
  if (thread.thread.ephemeral) return failure('ephemeral_thread')
  if (typeof thread.thread.path !== 'string' || thread.thread.path.length === 0) {
    return failure('missing_rollout_path')
  }
  if (!path.isAbsolute(thread.thread.path)) return failure('relative_rollout_path')

  for (const alias of [thread.aliases.rolloutPath, thread.aliases.rollout_path]) {
    if (typeof alias === 'string' && alias !== thread.thread.path) {
      return failure('path_alias_conflict')
    }
  }

  return {
    ok: true,
    candidate: {
      source: 'thread_fork_response',
      thread: {
        id: thread.thread.id,
        path: thread.thread.path,
        ephemeral: thread.thread.ephemeral,
      },
    },
  }
}

export function extractThreadStartedNotificationSideEffects(
  input: JsonRpcFrameInput,
): ThreadStartedNotificationSideEffectsExtractionResult {
  const raw = frameToBuffer(input)
  const root = scanRootObject(raw)
  if (!root.ok) return root
  if (hasAnyDuplicateKey(root.object.entries, ['method', 'params'])) {
    return failure('unsafe_duplicate_key')
  }
  const method = extractMethod(raw, root.object.entries)
  if (!method.ok) return method
  if (method.value !== 'thread/started') return failure('unsupported_shape')

  const params = findEntry(root.object.entries, 'params')
  if (!params || params.valueKind !== 'object') return failure('unsupported_shape')
  const paramsObject = scanObject(raw, params.valueStart)
  if (!paramsObject.ok) return paramsObject
  if (hasAnyDuplicateKey(paramsObject.object.entries, ['thread'])) {
    return failure('unsafe_duplicate_key')
  }
  const threadEntry = findEntry(paramsObject.object.entries, 'thread')
  if (!threadEntry || threadEntry.valueKind !== 'object') return failure('missing_thread')
  const thread = extractThread(raw, threadEntry)
  if (!thread.ok) return thread

  return {
    ok: true,
    candidate: {
      source: 'thread_started_notification',
      thread: thread.thread,
    },
    lifecycle: {
      kind: 'thread_started',
      thread: thread.thread,
    },
  }
}

export function extractTurnNotificationEvent(input: JsonRpcFrameInput): TurnNotificationEventExtractionResult {
  const raw = frameToBuffer(input)
  const root = scanRootObject(raw)
  if (!root.ok) return root
  if (hasAnyDuplicateKey(root.object.entries, ['method', 'params'])) {
    return failure('unsafe_duplicate_key')
  }

  const method = extractMethod(raw, root.object.entries)
  if (!method.ok) return method
  if (method.value !== 'turn/started' && method.value !== 'turn/completed') {
    return failure('unsupported_shape')
  }

  const paramsObject = extractParamsObject(raw, root.object.entries)
  if (!paramsObject.ok) return paramsObject
  if (hasAnyDuplicateKey(paramsObject.object.entries, ['threadId', 'turnId', 'turn', 'status'])) {
    return failure('unsafe_duplicate_key')
  }

  const threadId = extractRequiredString(raw, paramsObject.object.entries, 'threadId')
  if (!threadId.ok) return threadId
  const turnId = extractOptionalString(raw, paramsObject.object.entries, 'turnId')
  if (!turnId.ok) return turnId

  if (method.value === 'turn/started') {
    return {
      ok: true,
      event: {
        kind: 'turn_started',
        threadId: threadId.value,
        ...(turnId.value !== undefined ? { turnId: turnId.value } : {}),
      },
    }
  }

  const status = extractTurnCompletedStatus(raw, paramsObject.object.entries)
  if (!status.ok) return status
  return {
    ok: true,
    event: {
      kind: 'turn_completed',
      threadId: threadId.value,
      ...(turnId.value !== undefined ? { turnId: turnId.value } : {}),
      ...(status.value !== undefined ? { status: status.value } : {}),
    },
  }
}

export function extractThreadLifecycleEvent(input: JsonRpcFrameInput): ThreadLifecycleEventExtractionResult {
  const raw = frameToBuffer(input)
  const root = scanRootObject(raw)
  if (!root.ok) return root
  if (hasAnyDuplicateKey(root.object.entries, ['method', 'params'])) {
    return failure('unsafe_duplicate_key')
  }

  const method = extractMethod(raw, root.object.entries)
  if (!method.ok) return method
  if (method.value !== 'thread/closed' && method.value !== 'thread/status/changed') {
    return failure('unsupported_shape')
  }

  const paramsObject = extractParamsObject(raw, root.object.entries)
  if (!paramsObject.ok) return paramsObject
  if (hasAnyDuplicateKey(paramsObject.object.entries, ['threadId', 'status'])) {
    return failure('unsafe_duplicate_key')
  }

  const threadId = extractRequiredString(raw, paramsObject.object.entries, 'threadId')
  if (!threadId.ok) return threadId
  if (method.value === 'thread/closed') {
    return {
      ok: true,
      event: {
        kind: 'thread_closed',
        threadId: threadId.value,
      },
    }
  }

  const status = extractThreadStatus(raw, paramsObject.object.entries)
  if (!status.ok) return status
  return {
    ok: true,
    event: {
      kind: 'thread_status_changed',
      threadId: threadId.value,
      status: status.value,
    },
  }
}

export function extractFsChangedRepairTrigger(input: JsonRpcFrameInput): FsChangedRepairTriggerExtractionResult {
  const raw = frameToBuffer(input)
  const root = scanRootObject(raw)
  if (!root.ok) return root
  if (hasAnyDuplicateKey(root.object.entries, ['method', 'params'])) {
    return failure('unsafe_duplicate_key')
  }

  const method = extractMethod(raw, root.object.entries)
  if (!method.ok) return method
  if (method.value !== 'fs/changed') return failure('unsupported_shape')

  const paramsObject = extractParamsObject(raw, root.object.entries)
  if (!paramsObject.ok) return paramsObject
  if (hasAnyDuplicateKey(paramsObject.object.entries, ['watchId', 'changedPaths'])) {
    return failure('unsafe_duplicate_key')
  }

  const watchId = extractRequiredString(raw, paramsObject.object.entries, 'watchId')
  if (!watchId.ok) return watchId

  const changedPaths = findEntry(paramsObject.object.entries, 'changedPaths')
  if (!changedPaths || changedPaths.valueKind !== 'array') return failure('unsupported_shape')
  if (changedPaths.valueEnd - changedPaths.valueStart > MAX_FS_CHANGED_PATHS_BYTES) {
    return {
      ok: true,
      trigger: {
        kind: 'fs_changed',
        watchId: watchId.value,
        changedPaths: [],
      },
    }
  }

  const parsed = parseSmallJsonValue(raw, changedPaths)
  if (!parsed.ok || !Array.isArray(parsed.value) || !parsed.value.every((value) => typeof value === 'string')) {
    return failure('unsupported_shape')
  }

  return {
    ok: true,
    trigger: {
      kind: 'fs_changed',
      watchId: watchId.value,
      changedPaths: parsed.value,
    },
  }
}

function extractResultThread(raw: Buffer, rootEntries: ObjectEntry[]): ThreadScanResult {
  const result = findEntry(rootEntries, 'result')
  if (!result || result.valueKind !== 'object') return failure('missing_thread')
  const resultObject = scanObject(raw, result.valueStart)
  if (!resultObject.ok) return resultObject
  if (hasAnyDuplicateKey(resultObject.object.entries, ['thread'])) {
    return failure('unsafe_duplicate_key')
  }

  const thread = findEntry(resultObject.object.entries, 'thread')
  if (!thread || thread.valueKind !== 'object') return failure('missing_thread')
  return extractThread(raw, thread)
}

function extractThread(raw: Buffer, threadEntry: ObjectEntry): ThreadScanResult {
  const threadObject = scanObject(raw, threadEntry.valueStart)
  if (!threadObject.ok) return threadObject
  if (hasAnyDuplicateKey(threadObject.object.entries, [
    'id',
    'path',
    'ephemeral',
    'rolloutPath',
    'rollout_path',
  ])) {
    return failure('unsafe_duplicate_key')
  }

  const id = extractRequiredString(raw, threadObject.object.entries, 'id')
  if (!id.ok) return failure('missing_thread')
  const pathValue = extractNullableString(raw, threadObject.object.entries, 'path')
  if (!pathValue.ok) return pathValue
  const ephemeral = extractOptionalBoolean(raw, threadObject.object.entries, 'ephemeral')
  if (!ephemeral.ok) return ephemeral
  const rolloutPath = extractOptionalString(raw, threadObject.object.entries, 'rolloutPath')
  if (!rolloutPath.ok) return rolloutPath
  const rollout_path = extractOptionalString(raw, threadObject.object.entries, 'rollout_path')
  if (!rollout_path.ok) return rollout_path

  return {
    ok: true,
    thread: {
      id: id.value,
      path: pathValue.value,
      ephemeral: ephemeral.value ?? false,
    },
    aliases: {
      ...(rolloutPath.value !== undefined ? { rolloutPath: rolloutPath.value } : {}),
      ...(rollout_path.value !== undefined ? { rollout_path: rollout_path.value } : {}),
    },
  }
}

function extractParamsObject(raw: Buffer, rootEntries: ObjectEntry[]): ObjectScanResult {
  const params = findEntry(rootEntries, 'params')
  if (!params || params.valueKind !== 'object') return failure('unsupported_shape')
  return scanObject(raw, params.valueStart)
}

function extractMethod(raw: Buffer, rootEntries: ObjectEntry[]): ScanResult<string> {
  const method = findEntry(rootEntries, 'method')
  if (!method || method.valueKind !== 'string') return failure('unsupported_shape')
  const value = decodeStringEntry(raw, method)
  if (!value.ok || value.value.length === 0) return failure('unsupported_shape')
  return value
}

function extractTopLevelId(raw: Buffer, rootEntries: ObjectEntry[]): ScanResult<JsonRpcId> {
  const id = findEntry(rootEntries, 'id')
  if (!id) return failure('unsupported_shape')
  if (id.valueKind === 'string') {
    const value = decodeStringEntry(raw, id)
    if (!value.ok || value.value.length === 0) return failure('unsupported_shape')
    return value
  }
  if (id.valueKind === 'number') {
    const token = decodeAscii(raw, id.valueStart, id.valueEnd)
    if (token.includes('.') || token.includes('e') || token.includes('E')) return failure('unsupported_shape')
    const value = Number(token)
    return Number.isInteger(value) ? { ok: true, value } : failure('unsupported_shape')
  }
  return failure('unsupported_shape')
}

function extractRequiredString(raw: Buffer, entries: ObjectEntry[], key: string): ScanResult<string> {
  const value = extractOptionalString(raw, entries, key)
  if (!value.ok) return value
  if (value.value === undefined || value.value.length === 0) return failure('unsupported_shape')
  return { ok: true, value: value.value }
}

function extractOptionalString(raw: Buffer, entries: ObjectEntry[], key: string): ScanResult<string | undefined> {
  const entry = findEntry(entries, key)
  if (!entry) return { ok: true, value: undefined }
  if (entry.valueKind !== 'string') return failure('unsupported_shape')
  return decodeStringEntry(raw, entry)
}

function extractNullableString(raw: Buffer, entries: ObjectEntry[], key: string): ScanResult<string | null> {
  const entry = findEntry(entries, key)
  if (!entry) return { ok: true, value: null }
  if (entry.valueKind === 'string') return decodeStringEntry(raw, entry)
  if (literalEquals(raw, entry, 'null')) return { ok: true, value: null }
  return { ok: true, value: null }
}

function extractOptionalBoolean(raw: Buffer, entries: ObjectEntry[], key: string): ScanResult<boolean | undefined> {
  const entry = findEntry(entries, key)
  if (!entry) return { ok: true, value: undefined }
  if (literalEquals(raw, entry, 'true')) return { ok: true, value: true }
  if (literalEquals(raw, entry, 'false')) return { ok: true, value: false }
  return { ok: true, value: undefined }
}

function extractTurnCompletedStatus(raw: Buffer, paramsEntries: ObjectEntry[]): ScanResult<string | undefined> {
  const turn = findEntry(paramsEntries, 'turn')
  if (turn) {
    if (turn.valueKind !== 'object') return failure('unsupported_shape')
    const turnObject = scanObject(raw, turn.valueStart)
    if (!turnObject.ok) return turnObject
    if (hasAnyDuplicateKey(turnObject.object.entries, ['status'])) return failure('unsafe_duplicate_key')
    const turnStatus = extractOptionalString(raw, turnObject.object.entries, 'status')
    if (!turnStatus.ok) return turnStatus
    if (turnStatus.value !== undefined) return turnStatus
  }
  return extractOptionalString(raw, paramsEntries, 'status')
}

function extractThreadStatus(raw: Buffer, paramsEntries: ObjectEntry[]): ScanResult<{ type: string } & Record<string, unknown>> {
  const status = findEntry(paramsEntries, 'status')
  if (!status || status.valueKind !== 'object') return failure('unsupported_shape')
  const statusObject = scanObject(raw, status.valueStart)
  if (!statusObject.ok) return statusObject
  if (hasAnyDuplicateKey(statusObject.object.entries, ['type'])) return failure('unsafe_duplicate_key')

  const type = extractRequiredString(raw, statusObject.object.entries, 'type')
  if (!type.ok) return type
  if (status.valueEnd - status.valueStart <= MAX_SMALL_PARSE_BYTES) {
    const parsed = parseSmallJsonValue(raw, status)
    if (
      parsed.ok &&
      parsed.value &&
      typeof parsed.value === 'object' &&
      !Array.isArray(parsed.value) &&
      typeof (parsed.value as { type?: unknown }).type === 'string'
    ) {
      return { ok: true, value: parsed.value as { type: string } & Record<string, unknown> }
    }
  }
  return { ok: true, value: { type: type.value } }
}

function parseSmallJsonValue(raw: Buffer, entry: ObjectEntry): ScanResult<unknown> {
  if (entry.valueEnd - entry.valueStart > MAX_SMALL_PARSE_BYTES) return failure('token_too_large')
  try {
    return {
      ok: true,
      value: JSON.parse(utf8Decoder.decode(raw.subarray(entry.valueStart, entry.valueEnd))) as unknown,
    }
  } catch {
    return failure('malformed_json')
  }
}

function scanRootObject(raw: Buffer): ObjectScanResult {
  const start = skipWhitespace(raw, 0)
  if (start >= raw.length) return failure('malformed_json')
  if (raw[start] === BYTE_OPEN_BRACKET) return failure('batch_unsupported')
  if (raw[start] !== BYTE_OPEN_BRACE) return failure('unsupported_shape')
  const object = scanObject(raw, start)
  if (!object.ok) return object
  const trailing = skipWhitespace(raw, object.object.end)
  if (trailing !== raw.length) return failure('malformed_json')
  return object
}

function scanObject(raw: Buffer, start: number): ObjectScanResult {
  if (raw[start] !== BYTE_OPEN_BRACE) return failure('malformed_json')
  const entries: ObjectEntry[] = []
  let index = skipWhitespace(raw, start + 1)
  if (index >= raw.length) return failure('malformed_json')
  if (raw[index] === BYTE_CLOSE_BRACE) {
    return { ok: true, object: { entries, start, closeIndex: index, end: index + 1 } }
  }

  while (index < raw.length) {
    const key = parseBoundedString(raw, index)
    if (!key.ok) return key
    index = skipWhitespace(raw, key.next)
    if (index >= raw.length || raw[index] !== BYTE_COLON) return failure('malformed_json')
    const valueStart = skipWhitespace(raw, index + 1)
    if (valueStart >= raw.length) return failure('malformed_json')
    const value = skipValue(raw, valueStart)
    if (!value.ok) return value
    entries.push({
      key: key.value,
      keyStart: index,
      keyEnd: key.next,
      valueStart,
      valueEnd: value.next,
      valueKind: classifyValue(raw[valueStart]!),
    })
    index = skipWhitespace(raw, value.next)
    if (index >= raw.length) return failure('malformed_json')
    if (raw[index] === BYTE_COMMA) {
      index = skipWhitespace(raw, index + 1)
      continue
    }
    if (raw[index] === BYTE_CLOSE_BRACE) {
      return { ok: true, object: { entries, start, closeIndex: index, end: index + 1 } }
    }
    return failure('malformed_json')
  }

  return failure('malformed_json')
}

function skipValue(raw: Buffer, index: number): IndexScanResult {
  let cursor = skipWhitespace(raw, index)
  if (cursor >= raw.length) return failure('malformed_json')

  const first = raw[cursor]!
  if (first === BYTE_QUOTE) return scanStringBounds(raw, cursor)
  if (first === BYTE_MINUS || isDigit(first)) return scanNumber(raw, cursor)
  if (startsWithLiteral(raw, cursor, 'true')) return { ok: true, next: cursor + 4 }
  if (startsWithLiteral(raw, cursor, 'false')) return { ok: true, next: cursor + 5 }
  if (startsWithLiteral(raw, cursor, 'null')) return { ok: true, next: cursor + 4 }
  if (first !== BYTE_OPEN_BRACE && first !== BYTE_OPEN_BRACKET) return failure('malformed_json')

  const stack: ContainerFrame[] = []
  if (first === BYTE_OPEN_BRACE) {
    stack.push({ type: 'object', state: 'expectKeyOrEnd' })
  } else {
    stack.push({ type: 'array', state: 'expectValueOrEnd' })
  }
  cursor += 1

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!
    cursor = skipWhitespace(raw, cursor)
    if (cursor >= raw.length) return failure('malformed_json')

    if (frame.type === 'object') {
      if (frame.state === 'expectKeyOrEnd') {
        if (raw[cursor] === BYTE_CLOSE_BRACE) {
          cursor += 1
          stack.pop()
          markContainerValueComplete(stack)
          continue
        }
        frame.state = 'expectKey'
        continue
      }
      if (frame.state === 'expectKey') {
        const key = scanStringBounds(raw, cursor)
        if (!key.ok) return key
        cursor = key.next
        frame.state = 'expectColon'
        continue
      }
      if (frame.state === 'expectColon') {
        if (raw[cursor] !== BYTE_COLON) return failure('malformed_json')
        cursor += 1
        frame.state = 'expectValue'
        continue
      }
      if (frame.state === 'expectValue') {
        const consumed = consumeStackValue(raw, cursor, stack)
        if (!consumed.ok) return consumed
        cursor = consumed.next
        continue
      }
      if (raw[cursor] === BYTE_COMMA) {
        cursor += 1
        frame.state = 'expectKey'
        continue
      }
      if (raw[cursor] === BYTE_CLOSE_BRACE) {
        cursor += 1
        stack.pop()
        markContainerValueComplete(stack)
        continue
      }
      return failure('malformed_json')
    }

    if (frame.state === 'expectValueOrEnd') {
      if (raw[cursor] === BYTE_CLOSE_BRACKET) {
        cursor += 1
        stack.pop()
        markContainerValueComplete(stack)
        continue
      }
      frame.state = 'expectValue'
      continue
    }
    if (frame.state === 'expectValue') {
      const consumed = consumeStackValue(raw, cursor, stack)
      if (!consumed.ok) return consumed
      cursor = consumed.next
      continue
    }
    if (raw[cursor] === BYTE_COMMA) {
      cursor += 1
      frame.state = 'expectValue'
      continue
    }
    if (raw[cursor] === BYTE_CLOSE_BRACKET) {
      cursor += 1
      stack.pop()
      markContainerValueComplete(stack)
      continue
    }
    return failure('malformed_json')
  }

  return { ok: true, next: cursor }
}

function consumeStackValue(raw: Buffer, index: number, stack: ContainerFrame[]): IndexScanResult {
  const cursor = skipWhitespace(raw, index)
  if (cursor >= raw.length) return failure('malformed_json')
  const first = raw[cursor]!

  if (first === BYTE_OPEN_BRACE) {
    stack.push({ type: 'object', state: 'expectKeyOrEnd' })
    return { ok: true, next: cursor + 1 }
  }
  if (first === BYTE_OPEN_BRACKET) {
    stack.push({ type: 'array', state: 'expectValueOrEnd' })
    return { ok: true, next: cursor + 1 }
  }

  let next: IndexScanResult
  if (first === BYTE_QUOTE) {
    next = scanStringBounds(raw, cursor)
  } else if (first === BYTE_MINUS || isDigit(first)) {
    next = scanNumber(raw, cursor)
  } else if (startsWithLiteral(raw, cursor, 'true')) {
    next = { ok: true, next: cursor + 4 }
  } else if (startsWithLiteral(raw, cursor, 'false')) {
    next = { ok: true, next: cursor + 5 }
  } else if (startsWithLiteral(raw, cursor, 'null')) {
    next = { ok: true, next: cursor + 4 }
  } else {
    return failure('malformed_json')
  }
  if (!next.ok) return next
  markContainerValueComplete(stack)
  return next
}

function markContainerValueComplete(stack: ContainerFrame[]): void {
  const parent = stack[stack.length - 1]
  if (!parent) return
  parent.state = 'expectCommaOrEnd'
}

function scanStringBounds(raw: Buffer, index: number): StringBoundsScanResult {
  if (raw[index] !== BYTE_QUOTE) return failure('malformed_json')
  let cursor = index + 1
  let hasEscape = false
  while (cursor < raw.length) {
    const byte = raw[cursor]!
    if (byte === BYTE_QUOTE) {
      return {
        ok: true,
        contentStart: index + 1,
        contentEnd: cursor,
        hasEscape,
        next: cursor + 1,
      }
    }
    if (byte < 0x20) return failure('malformed_json')
    if (byte === BYTE_BACKSLASH) {
      hasEscape = true
      if (cursor + 1 >= raw.length) return failure('malformed_json')
      const escaped = raw[cursor + 1]!
      if (
        escaped === BYTE_QUOTE ||
        escaped === BYTE_BACKSLASH ||
        escaped === 0x2f ||
        escaped === 0x62 ||
        escaped === 0x66 ||
        escaped === 0x6e ||
        escaped === 0x72 ||
        escaped === 0x74
      ) {
        cursor += 2
        continue
      }
      if (escaped === 0x75) {
        if (cursor + 5 >= raw.length) return failure('malformed_json')
        for (let offset = cursor + 2; offset <= cursor + 5; offset += 1) {
          if (!isHex(raw[offset]!)) return failure('malformed_json')
        }
        cursor += 6
        continue
      }
      return failure('malformed_json')
    }
    cursor += 1
  }
  return failure('malformed_json')
}

function parseBoundedString(raw: Buffer, index: number): StringScanResult {
  const bounds = scanStringBounds(raw, index)
  if (!bounds.ok) return bounds
  if (bounds.contentEnd - bounds.contentStart > MAX_SCANNED_TOKEN_BYTES) {
    return failure('token_too_large')
  }
  if (!bounds.hasEscape) {
    return {
      ok: true,
      value: utf8Decoder.decode(raw.subarray(bounds.contentStart, bounds.contentEnd)),
      next: bounds.next,
    }
  }
  if (bounds.next - index > MAX_SCANNED_TOKEN_BYTES + 2) {
    return failure('token_too_large')
  }
  try {
    return {
      ok: true,
      value: JSON.parse(utf8Decoder.decode(raw.subarray(index, bounds.next))) as string,
      next: bounds.next,
    }
  } catch {
    return failure('malformed_json')
  }
}

function decodeStringEntry(raw: Buffer, entry: ObjectEntry): ScanResult<string> {
  if (entry.valueKind !== 'string') return failure('unsupported_shape')
  const parsed = parseBoundedString(raw, entry.valueStart)
  if (!parsed.ok) return parsed
  if (parsed.next !== entry.valueEnd) return failure('malformed_json')
  return { ok: true, value: parsed.value }
}

function scanNumber(raw: Buffer, index: number): IndexScanResult {
  let cursor = index
  if (raw[cursor] === BYTE_MINUS) cursor += 1
  if (cursor >= raw.length) return failure('malformed_json')
  if (raw[cursor] === 0x30) {
    cursor += 1
  } else if (isDigitOneToNine(raw[cursor]!)) {
    cursor += 1
    while (cursor < raw.length && isDigit(raw[cursor]!)) cursor += 1
  } else {
    return failure('malformed_json')
  }
  if (raw[cursor] === BYTE_DOT) {
    cursor += 1
    if (cursor >= raw.length || !isDigit(raw[cursor]!)) return failure('malformed_json')
    while (cursor < raw.length && isDigit(raw[cursor]!)) cursor += 1
  }
  if (raw[cursor] === 0x65 || raw[cursor] === 0x45) {
    cursor += 1
    if (raw[cursor] === 0x2b || raw[cursor] === BYTE_MINUS) cursor += 1
    if (cursor >= raw.length || !isDigit(raw[cursor]!)) return failure('malformed_json')
    while (cursor < raw.length && isDigit(raw[cursor]!)) cursor += 1
  }
  if (cursor - index > MAX_SCANNED_TOKEN_BYTES) return failure('token_too_large')
  return { ok: true, next: cursor }
}

function classifyValue(byte: number): JsonValueKind {
  if (byte === BYTE_OPEN_BRACE) return 'object'
  if (byte === BYTE_OPEN_BRACKET) return 'array'
  if (byte === BYTE_QUOTE) return 'string'
  if (byte === BYTE_MINUS || isDigit(byte)) return 'number'
  return 'literal'
}

function findEntry(entries: ObjectEntry[], key: string): ObjectEntry | undefined {
  return entries.find((entry) => entry.key === key)
}

function hasDuplicateKey(entries: ObjectEntry[], key: string): boolean {
  let seen = false
  for (const entry of entries) {
    if (entry.key !== key) continue
    if (seen) return true
    seen = true
  }
  return false
}

function hasAnyDuplicateKey(entries: ObjectEntry[], keys: readonly string[]): boolean {
  return keys.some((key) => hasDuplicateKey(entries, key))
}

function literalEquals(raw: Buffer, entry: ObjectEntry, literal: 'false' | 'null' | 'true'): boolean {
  return entry.valueEnd - entry.valueStart === literal.length &&
    decodeAscii(raw, entry.valueStart, entry.valueEnd) === literal
}

function startsWithLiteral(raw: Buffer, index: number, literal: 'false' | 'null' | 'true'): boolean {
  if (index + literal.length > raw.length) return false
  for (let offset = 0; offset < literal.length; offset += 1) {
    if (raw[index + offset] !== literal.charCodeAt(offset)) return false
  }
  return true
}

function frameToBuffer(input: JsonRpcFrameInput): Buffer {
  if (typeof input === 'string') return Buffer.from(input)
  if (Buffer.isBuffer(input)) return input
  if (Array.isArray(input)) return Buffer.concat(input.map((part) => Buffer.from(part)))
  return Buffer.from(input)
}

function spliceBuffer(raw: Buffer, start: number, end: number, replacement: string): Buffer {
  return Buffer.concat([
    raw.subarray(0, start),
    Buffer.from(replacement),
    raw.subarray(end),
  ])
}

function decodeAscii(raw: Buffer, start: number, end: number): string {
  let value = ''
  for (let index = start; index < end; index += 1) {
    value += String.fromCharCode(raw[index]!)
  }
  return value
}

function skipWhitespace(raw: Buffer, index: number): number {
  let cursor = index
  while (cursor < raw.length) {
    const byte = raw[cursor]!
    if (byte !== BYTE_SPACE && byte !== BYTE_TAB && byte !== BYTE_LF && byte !== BYTE_CR) {
      break
    }
    cursor += 1
  }
  return cursor
}

function isDigit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39
}

function isDigitOneToNine(byte: number): boolean {
  return byte >= 0x31 && byte <= 0x39
}

function isHex(byte: number): boolean {
  return (
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x46) ||
    (byte >= 0x61 && byte <= 0x66)
  )
}

function failure(reason: SideEffectFailureReason): ExtractFailure {
  return { ok: false, reason }
}
