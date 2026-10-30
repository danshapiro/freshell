// Freshell OpenCode TUI plugin — unmanaged rebind signals and managed adoption
// observations.
//
// Injected per-pane by the freshell Rust server via OPENCODE_TUI_CONFIG,
// which points at the freshell-owned plugin-only tui.json installed next to
// this file in ~/.freshell/opencode/ (crates/freshell-platform/src/opencode_plugin.rs).
// Unmanaged launches keep the legacy route/session switch signal:
//   <home>/.freshell/session-signals/opencode/<FRESHELL_TERMINAL_ID>__<nonce>.json
//   body: {"session_id":"ses_...","source":"opencode-tui-plugin"}
// The freshell server sweeps that directory (crates/freshell-ws/src/opencode_signal.rs)
// and rebinds the pane identity through the guarded rebind lane.
// Managed launches never write a route-only session signal. They read the
// host-published <terminal>.expected.json and emit a body-free adoption
// observation under opencode-adoption only when hydrated TUI state matches the
// exact root and current tail (or a qualified error-aware empty read).
//
// HARD RULES (version tolerance): this file must NEVER break the TUI. Every
// interaction with the opencode plugin API is wrapped; if any surface is
// absent or changed, the plugin silently no-ops and Freshell keeps managed
// input blocked. The 1s route poll and slot re-renders are wake-up edges only
// for managed launches; their route and callback arguments are never
// observation evidence. Slots have visibility gaps, so the route poll covers
// periods when session_prompt or sidebar_title is not mounted.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SESSION_ID_RE = /^ses_[A-Za-z0-9]+$/
const MESSAGE_ID_RE = /^msg_[A-Za-z0-9]+$/
const SAFE_BINDING_RE = /^[A-Za-z0-9_.:-]{1,160}$/
const EVIDENCE_GENERATION_RE = /^[a-f0-9]{64}$/
const POLL_INTERVAL_MS = 1000
const ADOPTION_ENV_KEYS = [
  'FRESHELL_OPENCODE_ADOPTION_ROOT_SESSION_ID',
  'FRESHELL_OPENCODE_ADOPTION_TAIL_MESSAGE_ID',
  'FRESHELL_OPENCODE_ADOPTION_EXPECTED_EMPTY',
  'FRESHELL_OPENCODE_ADOPTION_EVIDENCE_GENERATION',
  'FRESHELL_OPENCODE_ADOPTION_INCARNATION_ID',
  'FRESHELL_OPENCODE_ADOPTION_LAUNCH_NONCE',
] as const

interface AdoptionExpectation {
  terminalId: string
  rootSessionId: string
  tailMessageId: string | null
  expectedEmpty: boolean
  evidenceGeneration: string
  incarnationId: string
  launchNonce: string
  dir: string
}

type TuiSlotContribution = {
  slots: Record<string, (context: unknown, props: unknown) => unknown>
}

interface AdoptionTuiApi {
  route?: { current?: unknown; navigate?: (name: 'session', params: { sessionID: string }) => void }
  state?: {
    ready?: unknown
    part?: (messageId: string) => unknown
    session?: {
      get?: (sessionId: string) => unknown
      messages?: (sessionId: string) => unknown
    }
  }
  client?: {
      session?: {
        create?: (parameters: Record<string, never>, options: { throwOnError: true }) => Promise<unknown>
        get?: (parameters: { sessionID: string }, options: { throwOnError: true }) => Promise<unknown>
        messages?: (
          parameters: { sessionID: string; limit?: number },
          options: { throwOnError: true },
        ) => Promise<unknown>
      }
  }
}

interface NativeLaunch {
  incarnationId: string
  launchNonce: string
  evidenceRevision: number
  executionGeneration: number
  requestedNativeSessionId: string | null
}

export interface EmitterDeps {
  env: Record<string, string | undefined>
  signal?: AbortSignal
  writeFile?: (dir: string, name: string, body: string) => void
  readExpectation?: (path: string) => string | null
  now?: () => number
  onRefusal?: (record: NativeObservationRefusal) => void
  wakeContext?: () => NativeObservationWake
}

type NativeObservationWake = {
  trigger: 'initial' | 'poll' | 'session_prompt' | 'sidebar_title'
  registeredSlotCount: number
  slotRegistrationFailureCount: number
  sessionPromptRenderCount: number
  sidebarTitleRenderCount: number
  elapsedMs: number
}

type NativeRefusalReason = 'tui_not_ready' | 'route_not_selected' | 'tui_root_not_loaded'
  | 'tui_session_api_unavailable'
  | 'native_api_unavailable' | 'native_root_load_failed' | 'native_history_load_failed'
  | 'tui_context_changed' | 'revert_not_hydrated' | 'history_not_hydrated'
  | 'empty_history_not_hydrated' | 'tail_not_hydrated' | 'parts_not_hydrated'
  | 'native_tail_mismatch'
  | 'producer_or_publication_failed'

export type NativeObservationRefusal = Partial<NativeObservationWake> & {
  severity: 'warning'
  event: 'runtime.opencode.native_observation_refused'
  terminalId: string
  nativeSessionId: string
  incarnationId: string
  launchNonce: string
  evidenceGeneration: string
  reason: NativeRefusalReason
  nativeActiveMessageCount?: number
  tuiActiveMessageCount?: number
  nativeTuiPageMessageCount?: number | null
}

export function extractSessionId(value: unknown): string | null {
  if (typeof value === 'string') return SESSION_ID_RE.test(value) ? value : null
  if (value === null || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  for (const key of ['sessionID', 'session_id', 'sessionId']) {
    const v = obj[key]
    if (typeof v === 'string' && SESSION_ID_RE.test(v)) return v
  }
  const params = obj['params']
  if (params && typeof params === 'object') return extractSessionId(params)
  return null
}

function defaultWriteFile(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `${name}.tmp`)
  writeFileSync(tmp, body, { encoding: 'utf-8' })
  renameSync(tmp, join(dir, `${name}.json`))
}

function defaultReadExpectation(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8')
  } catch (error) {
    if (
      error !== null &&
      typeof error === 'object' &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return null
    }
    throw error
  }
}

function resolveSignalTarget(
  env: EmitterDeps['env'],
): { dir: string; terminalId: string } | null {
  // Mirror the Rust consumer's home resolution (OpencodeSignalWatcher::
  // default_root is cfg-gated: USERPROFILE only on Windows, HOME otherwise)
  // — otherwise a Windows git-bash/MSYS shell with HOME set would emit
  // signals into a directory the server never sweeps.
  const home =
    process.platform === 'win32'
      ? (env.USERPROFILE ?? env.HOME)
      : (env.HOME ?? env.USERPROFILE)
  const terminalId = env.FRESHELL_TERMINAL_ID
  if (!home || !terminalId) return null
  return { dir: join(home, '.freshell', 'session-signals', 'opencode'), terminalId }
}

/** Plugin-alive heartbeat: written ONCE at TUI startup, before any opencode
 *  API surface is touched, so it proves the plugin LOADED (not that the
 *  route API still exists). The server's sweeper consumes it silently as
 *  liveness proof and warns when an opencode pane never says hello. */
export function emitHello(deps: EmitterDeps): void {
  try {
    const target = resolveSignalTarget(deps.env)
    if (!target) return
    const write = deps.writeFile ?? defaultWriteFile
    const now = deps.now ?? Date.now
    const nonce = `${String(now()).padStart(14, '0')}-000000-${process.pid}`
    write(
      target.dir,
      `${target.terminalId}__${nonce}`,
      JSON.stringify({ hello: true, source: 'opencode-tui-plugin' }),
    )
  } catch {
    // Losing the hello degrades to no-heartbeat. Never surface into the TUI.
  }
}

export function createEmitter(deps: EmitterDeps): (candidate: unknown) => void {
  const target = resolveSignalTarget(deps.env)
  if (!target) return () => {}
  const { dir, terminalId } = target
  const write = deps.writeFile ?? defaultWriteFile
  const now = deps.now ?? Date.now
  let lastEmitted: string | null = null
  let seq = 0
  return (candidate: unknown) => {
    try {
      const sessionId = extractSessionId(candidate)
      if (!sessionId || sessionId === lastEmitted) return
      lastEmitted = sessionId
      seq += 1
      // Nonce: timestamp-first so one pane's signals sort lexicographically in
      // emission order (the consumer's sorted drain makes A->B->A deterministic).
      // Digits and '-' only — can never contain '__' (the filename delimiter).
      const nonce = `${String(now()).padStart(14, '0')}-${String(seq).padStart(6, '0')}-${process.pid}`
      write(
        dir,
        `${terminalId}__${nonce}`,
        JSON.stringify({ session_id: sessionId, source: 'opencode-tui-plugin' }),
      )
    } catch {
      // Losing a signal degrades to no-rebind. Never surface into the TUI.
    }
  }
}

/** Detect a managed launch even if some expectation fields are missing. An
 * incomplete managed expectation must remain blocked instead of falling back
 * to the legacy route-only session signal. */
export function hasAdoptionExpectation(env: EmitterDeps['env']): boolean {
  return ADOPTION_ENV_KEYS.some((key) => env[key] !== undefined)
}

function resolveAdoptionExpectation(
  env: EmitterDeps['env'],
): AdoptionExpectation | null {
  const target = resolveSignalTarget(env)
  if (!target || !SAFE_BINDING_RE.test(target.terminalId)) return null

  const rootSessionId = env.FRESHELL_OPENCODE_ADOPTION_ROOT_SESSION_ID
  const rawTailMessageId = env.FRESHELL_OPENCODE_ADOPTION_TAIL_MESSAGE_ID
  const expectedEmpty = env.FRESHELL_OPENCODE_ADOPTION_EXPECTED_EMPTY
  const evidenceGeneration = env.FRESHELL_OPENCODE_ADOPTION_EVIDENCE_GENERATION
  const incarnationId = env.FRESHELL_OPENCODE_ADOPTION_INCARNATION_ID
  const launchNonce = env.FRESHELL_OPENCODE_ADOPTION_LAUNCH_NONCE
  if (
    !rootSessionId ||
    !SESSION_ID_RE.test(rootSessionId) ||
    !evidenceGeneration ||
    !EVIDENCE_GENERATION_RE.test(evidenceGeneration) ||
    !incarnationId ||
    !SAFE_BINDING_RE.test(incarnationId) ||
    !launchNonce ||
    !SAFE_BINDING_RE.test(launchNonce)
  ) {
    return null
  }

  const dir = join(target.dir, '..', 'opencode-adoption')
  if (expectedEmpty === 'true') {
    if (rawTailMessageId !== undefined) return null
    return {
      terminalId: target.terminalId,
      rootSessionId,
      tailMessageId: null,
      expectedEmpty: true,
      evidenceGeneration,
      incarnationId,
      launchNonce,
      dir,
    }
  }

  if (
    expectedEmpty !== 'false' ||
    !rawTailMessageId ||
    !MESSAGE_ID_RE.test(rawTailMessageId)
  ) {
    return null
  }
  return {
    terminalId: target.terminalId,
    rootSessionId,
    tailMessageId: rawTailMessageId,
    expectedEmpty: false,
    evidenceGeneration,
    incarnationId,
    launchNonce,
    dir,
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null
}

function currentRouteSessionId(value: unknown): string | null {
  const route = asRecord(value)
  const params = asRecord(route?.params)
  if (route?.name !== 'session') return null
  const sessionId = params?.sessionID
  return typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId)
    ? sessionId
    : null
}

function sessionIsExactRoot(value: unknown, expectedId: string): boolean {
  const session = asRecord(value)
  return session?.id === expectedId && (session.parentID === undefined || session.parentID === null)
}

function lastActiveMessageId(value: unknown, expectedSessionId: string): string | null {
  if (!Array.isArray(value) || value.length === 0) return null
  let lastId: string | null = null
  for (const candidate of value) {
    const message = asRecord(candidate)
    if (
      typeof message?.id !== 'string' ||
      !MESSAGE_ID_RE.test(message.id) ||
      message.sessionID !== expectedSessionId
    ) {
      return null
    }
    lastId = message.id
  }
  return lastId
}

function nativeMessagesFromResult(value: unknown): unknown[] | null {
  const response = asRecord(value)
  if (!response) return null
  if ('error' in response && response.error !== undefined && response.error !== null) return null
  return Array.isArray(response.data) ? response.data : null
}

function activeMessages(value: unknown, sessionId: string, revertValue: unknown): unknown[] | null {
  if (!Array.isArray(value) || (value.length > 0 && lastActiveMessageId(value, sessionId) === null)) return null
  const revert = asRecord(revertValue)
  if (!revert?.messageID) return value
  if (typeof revert.messageID !== 'string' || !MESSAGE_ID_RE.test(revert.messageID)) return null
  const index = value.findIndex((message) => asRecord(message)?.id === revert.messageID)
  if (index < 0) return null
  if (revert.partID !== undefined && revert.partID !== null && typeof revert.partID !== 'string') return null
  return value.slice(0, index + (typeof revert.partID === 'string' ? 1 : 0))
}

function revertReference(value: unknown): string {
  const record = asRecord(value)
  return JSON.stringify({ messageID: record?.messageID ?? null, partID: record?.partID ?? null })
}

function nativeTailPartsHydrated(api: AdoptionTuiApi, rows: unknown[], revertValue: unknown, tail: string): boolean {
  const parts = asRecord(rows.find(row => asRecord(asRecord(row)?.info)?.id === tail))?.parts
  if (!Array.isArray(parts)) return false
  if (parts.length === 0) return true
  const readParts = api.state?.part
  const hydrated = typeof readParts === 'function' ? readParts.call(api.state, tail) : null
  if (!Array.isArray(hydrated)) return false
  const ids = new Set(hydrated.map(part => asRecord(part)?.id))
  const boundary = asRecord(revertValue)?.partID
  const end = typeof boundary === 'string' ? parts.findIndex(part => asRecord(part)?.id === boundary) : parts.length
  return end >= 0 && parts.slice(0, end).every(part => typeof asRecord(part)?.id === 'string'
    && ids.has(asRecord(part)?.id))
}

function exactObjectKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

/**
 * The provider process cannot update its environment after launch. The session
 * host therefore publishes the currently verified root tail and evidence
 * generation atomically in a body-free sidecar. Terminal, root, and
 * incarnation remain bound to the original launch; nonce, generation, and
 * tail may rotate only when the host revalidates the complete native store.
 */
function readCurrentAdoptionExpectation(
  initial: AdoptionExpectation,
  readExpectation: (path: string) => string | null,
): AdoptionExpectation | null {
  const expectedPath = join(initial.dir, `${initial.terminalId}.expected.json`)
  let raw: string | null
  try {
    raw = readExpectation(expectedPath)
  } catch {
    return null
  }
  if (raw === null) return initial

  try {
    const file = asRecord(JSON.parse(raw))
    if (
      !file ||
      !exactObjectKeys(file, [
        'terminal_id',
        'root_session_id',
        'root_tail',
        'evidence_generation',
        'incarnation_id',
        'launch_nonce',
      ]) ||
      file.terminal_id !== initial.terminalId ||
      file.root_session_id !== initial.rootSessionId ||
      file.incarnation_id !== initial.incarnationId ||
      typeof file.launch_nonce !== 'string' ||
      !SAFE_BINDING_RE.test(file.launch_nonce) ||
      typeof file.evidence_generation !== 'string' ||
      !EVIDENCE_GENERATION_RE.test(file.evidence_generation)
    ) {
      return null
    }

    const rootTail = asRecord(file.root_tail)
    if (!rootTail || typeof rootTail.state !== 'string') return null
    let tailMessageId: string | null
    let expectedEmpty: boolean
    if (rootTail.state === 'message') {
      const data = asRecord(rootTail.data)
      if (!data) return null
      const hasSnake = Object.hasOwn(data, 'message_id')
      const hasCamel = Object.hasOwn(data, 'messageId')
      if (
        hasSnake === hasCamel ||
        !exactObjectKeys(rootTail, ['state', 'data']) ||
        !exactObjectKeys(data, [hasSnake ? 'message_id' : 'messageId'])
      ) {
        return null
      }
      const value = data[hasSnake ? 'message_id' : 'messageId']
      if (typeof value !== 'string' || !MESSAGE_ID_RE.test(value)) return null
      tailMessageId = value
      expectedEmpty = false
    } else if (rootTail.state === 'qualified_empty') {
      if (!exactObjectKeys(rootTail, ['state'])) return null
      tailMessageId = null
      expectedEmpty = true
    } else {
      return null
    }

    return {
      ...initial,
      tailMessageId,
      expectedEmpty,
      evidenceGeneration: file.evidence_generation,
      launchNonce: file.launch_nonce,
    }
  } catch {
    return null
  }
}

class NativeHistoryReadError extends Error {
  constructor(readonly reason: NativeRefusalReason) { super(reason) }
}

async function readNativeHistory(api: AdoptionTuiApi, sessionId: string): Promise<
  { session: Record<string, unknown>; messages: unknown[] }
  | { failure: NativeRefusalReason }
> {
  try {
    const sessionClient = api.client?.session
    const read = sessionClient?.messages
    const get = sessionClient?.get
    if (typeof read !== 'function' || typeof get !== 'function') return { failure: 'native_api_unavailable' }
    // The exact-session SDK request explicitly throws for non-2xx results.
    // Changed shapes, errors, missing data, and malformed responses are all
    // treated as an unqualified read, never as empty history.
    const [metadata, result] = await Promise.all([
      Promise.resolve().then(() => get.call(sessionClient, { sessionID: sessionId }, { throwOnError: true }))
        .catch(() => { throw new NativeHistoryReadError('native_root_load_failed') }),
      Promise.resolve().then(() => read.call(sessionClient, { sessionID: sessionId }, { throwOnError: true }))
        .catch(() => { throw new NativeHistoryReadError('native_history_load_failed') }),
    ])
    const response = asRecord(metadata)
    const session = asRecord(response?.data)
    if (!session || response?.error || !sessionIsExactRoot(session, sessionId)) return { failure: 'native_root_load_failed' }
    const messages = nativeMessagesFromResult(result)
    if (!messages || messages.some((row) => !asRecord(asRecord(row)?.info) || !Array.isArray(asRecord(row)?.parts))) return { failure: 'native_history_load_failed' }
    return { session, messages }
  } catch (error) {
    return { failure: error instanceof NativeHistoryReadError ? error.reason : 'native_history_load_failed' }
  }
}

/**
 * Emits a managed-only adoption receipt. Route state is just a display gate:
 * a receipt also requires OpenCode's ready TUI state, the exact root session,
 * and that session's current last message. Empty histories additionally need
 * an error-aware exact-session native messages read because the synchronous
 * TUI messages getter cannot distinguish unloaded/error from empty.
 */
export function createObservationEmitter(
  deps: EmitterDeps,
): (apiValue: unknown) => Promise<void> {
  const expected = resolveAdoptionExpectation(deps.env)
  if (!expected) return async () => {}

  const write = deps.writeFile ?? defaultWriteFile
  const readExpectation = deps.readExpectation ?? defaultReadExpectation
  const now = deps.now ?? Date.now
  let seq = 0
  let lastEmitted: string | null = null
  let lastRefusal: string | null = null
  let inFlight = false
  let observingTrigger: NativeObservationWake['trigger'] | undefined
  let lastCurrent = expected
  let observed: AdoptionExpectation | null = null
  type ProgressStage = 'in_flight' | 'expectation_unavailable' | 'expectation_read'
    | 'native_read_pending' | 'native_read_settled' | 'duplicate' | 'publication_succeeded' | 'withdrawn'
  // Fixed stage filenames retain the last actual transition even if a later
  // poll is blocked by an in-flight native read. No history or error bodies
  // enter these bounded diagnostics, and a reporting failure is inert.
  const progress = (stage: ProgressStage): void => {
    try {
      defaultWriteFile(join(lastCurrent.dir, '..', 'opencode-adoption-diagnostics'),
        `${lastCurrent.terminalId}.${stage}`, JSON.stringify({
          event: 'runtime.opencode.native_observation_progress', severity: 'info', stage,
          terminalId: lastCurrent.terminalId, nativeSessionId: lastCurrent.rootSessionId,
          incarnationId: lastCurrent.incarnationId, launchNonce: lastCurrent.launchNonce,
          evidenceGeneration: lastCurrent.evidenceGeneration, inFlight,
          ...deps.wakeContext?.(),
        }))
    } catch { /* Diagnostic storage never changes native admission or renderer behavior. */ }
  }
  const refuse = (current: AdoptionExpectation, reason: NativeRefusalReason,
    history?: { nativeActiveMessageCount: number; tuiActiveMessageCount: number; nativeTuiPageMessageCount?: number | null }): void => {
    if (deps.signal?.aborted) return
    const record: NativeObservationRefusal = {
      severity: 'warning', event: 'runtime.opencode.native_observation_refused',
      terminalId: current.terminalId, nativeSessionId: current.rootSessionId,
      incarnationId: current.incarnationId, launchNonce: current.launchNonce,
      evidenceGeneration: current.evidenceGeneration, reason, ...history,
      ...(observingTrigger ? { ...deps.wakeContext?.(), trigger: observingTrigger } : {}),
    }
    const signature = JSON.stringify(record)
    if (signature === lastRefusal) return
    try {
      if (deps.onRefusal) deps.onRefusal(record)
      else defaultWriteFile(join(current.dir, '..', 'opencode-adoption-diagnostics'), current.terminalId, signature)
      lastRefusal = signature
    } catch { /* A diagnostic failure cannot change the native gate or break the renderer. */ }
  }
  const publish = (current: AdoptionExpectation, hydrated: boolean,
    messagesRead: 'success' | 'empty_confirmed' | 'failed'): boolean => {
    const observation = {
      terminal_id: current.terminalId, root_session_id: current.rootSessionId,
      tail_message_id: current.tailMessageId, evidence_generation: current.evidenceGeneration,
      incarnation_id: current.incarnationId, launch_nonce: current.launchNonce,
      hydrated, messages_read: messagesRead,
    }
    const signature = JSON.stringify(observation)
    if (signature === lastEmitted) {
      progress('duplicate')
      return false
    }
    seq += 1
    const nonce = `${String(now()).padStart(14, '0')}-${String(seq).padStart(6, '0')}-${process.pid}`
    write(current.dir, `${current.terminalId}__${nonce}`, JSON.stringify({
      session_id: expected.rootSessionId, source: 'opencode-tui-plugin', adoption_observation: observation,
    }))
    lastEmitted = signature
    if (!hydrated) observed = null
    else if (messagesRead !== 'failed') observed = current
    progress(hydrated ? 'publication_succeeded' : 'withdrawn')
    return true
  }
  const withdraw = (): void => {
    if (!observed) return
    try { publish(observed, false, 'failed') }
    catch { /* Retain the positive state locally so the next wake retries withdrawal. */ }
  }
  const contextStillSelected = (apiValue: unknown, current: AdoptionExpectation): boolean => {
    try {
      const api = asRecord(apiValue) as unknown as AdoptionTuiApi | null
      const session = api?.state?.session
      return api?.state?.ready === true && currentRouteSessionId(api.route?.current) === current.rootSessionId
        && typeof session?.get === 'function' && sessionIsExactRoot(session.get(current.rootSessionId), current.rootSessionId)
    } catch { return false }
  }
  deps.signal?.addEventListener('abort', withdraw, { once: true })
  return async (apiValue: unknown): Promise<void> => {
    if (deps.signal?.aborted) return withdraw()
    // Recheck the displayed root even during a pending native read. The
    // initial adoption receipt must never outlive a later TUI route switch.
    if (observed && !contextStillSelected(apiValue, observed)) withdraw()
    if (inFlight) {
      progress('in_flight')
      return
    }
    inFlight = true
    observingTrigger = deps.wakeContext?.().trigger
    let active = expected
    try {
      const current = readCurrentAdoptionExpectation(expected, readExpectation)
      if (!current) {
        progress('expectation_unavailable')
        return
      }
      active = current
      lastCurrent = current
      progress('expectation_read')
      const api = asRecord(apiValue) as unknown as AdoptionTuiApi | null
      const state = asRecord(api?.state)
      const sessionState = asRecord(state?.session)
      if (!api || state?.ready !== true) return refuse(current, 'tui_not_ready')
      if (currentRouteSessionId(api.route?.current) !== current.rootSessionId) return refuse(current, 'route_not_selected')
      if (
        typeof sessionState?.get !== 'function' ||
        typeof sessionState.messages !== 'function'
      ) {
        return refuse(current, 'tui_session_api_unavailable')
      }
      if (!sessionIsExactRoot(sessionState.get(current.rootSessionId), current.rootSessionId)) {
        return refuse(current, 'tui_root_not_loaded')
      }

      if (deps.signal?.aborted) return
      progress('native_read_pending')
      const read = await readNativeHistory(api, current.rootSessionId)
      if (deps.signal?.aborted) return
      progress('native_read_settled')
      const native = 'failure' in read ? null : read
      if (!contextStillSelected(api, current)) {
        withdraw()
        return refuse(current, 'tui_context_changed')
      }
      const selected = asRecord(sessionState.get(current.rootSessionId))
      if (!sessionIsExactRoot(selected, current.rootSessionId)) return refuse(current, 'tui_root_not_loaded')
      const hydratedMessages = activeMessages(sessionState.messages(current.rootSessionId), current.rootSessionId, selected?.revert)
      let messagesRead: 'success' | 'empty_confirmed' | 'failed'
      if (!native) {
        if ('failure' in read) refuse(current, read.failure)
        messagesRead = 'failed'
      } else {
        if (revertReference(native.session.revert) !== revertReference(selected?.revert)) return refuse(current, 'revert_not_hydrated')
        const nativeActive = activeMessages(native.messages.map((row) => asRecord(row)?.info), current.rootSessionId, native.session.revert)
        if (!nativeActive || !hydratedMessages) return refuse(current, 'history_not_hydrated')
        if (current.expectedEmpty) {
          if (nativeActive.length !== 0 || hydratedMessages.length !== 0) return refuse(current, 'empty_history_not_hydrated')
          messagesRead = 'empty_confirmed'
        } else {
          const history = { nativeActiveMessageCount: nativeActive.length, tuiActiveMessageCount: hydratedMessages.length }
          if (lastActiveMessageId(nativeActive, current.rootSessionId) !== current.tailMessageId) return refuse(current, 'native_tail_mismatch', history)
          if (lastActiveMessageId(hydratedMessages, current.rootSessionId) !== current.tailMessageId) {
            // The pinned TUI hydrates through this bounded V1 page. Its read
            // result distinguishes native pagination from missing UI sync;
            // it never substitutes for the actual hydrated state above.
            let nativeTuiPageMessageCount: number | null = null
            try {
              const page = await api.client!.session!.messages!(
                { sessionID: current.rootSessionId, limit: 100 }, { throwOnError: true },
              )
              nativeTuiPageMessageCount = nativeMessagesFromResult(page)?.length ?? null
            } catch { /* A page read failure stays unobserved without exposing provider strings. */ }
            if (deps.signal?.aborted) return
            return refuse(current, 'tail_not_hydrated', { ...history, nativeTuiPageMessageCount })
          }
          if (!nativeTailPartsHydrated(api, native.messages, native.session.revert, current.tailMessageId!)) {
            return refuse(current, 'parts_not_hydrated')
          }
          messagesRead = 'success'
        }
      }

      if (deps.signal?.aborted) return
      // A failed publication must remain eligible for the next observation.
      publish(current, true, messagesRead)
      if (messagesRead !== 'failed') lastRefusal = null
    } catch {
      refuse(active, 'producer_or_publication_failed')
    } finally {
      inFlight = false
    }
  }
}

/** Ordinary managed roots use the native loader, without an import baseline.
 * Creation is one supported native API call before input; an uncertain call
 * is never retried. The returned root still needs the same V1/TUI hydration
 * conjunction before it can be observed. Imported roots retain their separate
 * baseline gate above.
 */
function createNativeObservationEmitter(deps: EmitterDeps): (apiValue: unknown) => Promise<void> {
  let launch: NativeLaunch
  let directory: string
  try {
    const value = asRecord(JSON.parse(deps.env.FRESHELL_NATIVE_IDENTITY_LAUNCH ?? ''))
    const home = deps.env.HOME
    if (!value || !home || !exactObjectKeys(value, ['incarnationId', 'launchNonce', 'evidenceRevision',
      'executionGeneration', 'requestedNativeSessionId']) || typeof value.incarnationId !== 'string'
      || !SAFE_BINDING_RE.test(value.incarnationId) || typeof value.launchNonce !== 'string'
      || !/^[A-Za-z0-9_-]+$/.test(value.launchNonce) || !Number.isSafeInteger(value.evidenceRevision)
      || (value.evidenceRevision as number) < 0 || !Number.isSafeInteger(value.executionGeneration)
      || (value.executionGeneration as number) < 1 || (value.requestedNativeSessionId !== null
        && (typeof value.requestedNativeSessionId !== 'string' || !SESSION_ID_RE.test(value.requestedNativeSessionId)))) {
      return async () => {}
    }
    launch = value as unknown as NativeLaunch
    directory = join(home, '.freshell/native-identity', launch.launchNonce)
    if (deps.env.FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR !== directory) return async () => {}
  } catch { return async () => {} }
  const write = deps.writeFile ?? defaultWriteFile
  let root = launch.requestedNativeSessionId
  const now = deps.now ?? Date.now
  let createAttempted = false
  let inFlight = false
  let lastEvidence: string | null = null
  let lastRefusal: string | undefined
  type ProgressStage = 'in_flight' | 'native_create_pending' | 'native_create_settled'
    | 'native_read_pending' | 'native_read_settled' | 'refused' | 'publication_succeeded' | 'duplicate'
  // Retain each last actual phase under this launch, including busy renderer
  // wake-ups. These body-free diagnostics never serve as identity evidence.
  const progress = (stage: ProgressStage, reason?: string): void => {
    if (deps.signal?.aborted) return
    try {
      defaultWriteFile(join(directory, 'opencode-native-diagnostics'), stage, JSON.stringify({
        event: 'runtime.opencode.native_loader_progress', severity: reason ? 'warning' : 'info', stage,
        observedAtMs: now(), terminalId: deps.env.FRESHELL_TERMINAL_ID ?? null,
        nativeSessionId: root, incarnationId: launch.incarnationId, launchNonce: launch.launchNonce,
        evidenceRevision: launch.evidenceRevision, executionGeneration: launch.executionGeneration,
        inFlight, ...(reason ? { reason } : {}), ...(deps.wakeContext?.() ?? {}),
      }))
    } catch { /* Reporting failure cannot release input or change native state. */ }
  }
  const withdraw = (reason: string): void => {
    if (lastEvidence === null) return
    try {
      write(directory, 'opencode-loaded', JSON.stringify({ launch, native: {
        source: 'opencode-tui-native-loader', session_id: root, hydrated: false, reason,
      } }))
      lastEvidence = null
    } catch { /* A failed withdrawal cannot create new observation evidence. */ }
  }
  deps.signal?.addEventListener('abort', () => withdraw('disposed'), { once: true })
  const refuse = (reason: string): void => {
    withdraw(reason)
    progress('refused', reason)
    if (deps.signal?.aborted || reason === lastRefusal) return
    try {
      write(directory, 'opencode-refused', JSON.stringify({
        event: 'runtime.opencode.native_loader_refused', severity: 'warning',
        terminalId: deps.env.FRESHELL_TERMINAL_ID ?? null, nativeSessionId: root,
        incarnationId: launch.incarnationId, launchNonce: launch.launchNonce,
        evidenceRevision: launch.evidenceRevision, executionGeneration: launch.executionGeneration, reason,
      }))
      lastRefusal = reason
    } catch { /* Reporting cannot admit input or break the native renderer. */ }
  }
  return async (apiValue: unknown): Promise<void> => {
    if (deps.signal?.aborted) return
    const api = asRecord(apiValue) as unknown as AdoptionTuiApi | null
    if (inFlight) {
      try {
        // A pending refresh must not retain a receipt for a TUI context
        // that a newer poll or slot wake can already see has changed.
        if (lastEvidence !== null && (api?.state?.ready !== true
          || currentRouteSessionId(api?.route?.current) !== root)) refuse('tui_context_changed')
      } catch { refuse('native_loader_or_publication_failed') }
      progress('in_flight')
      return
    }
    inFlight = true
    try {
      if (!api || api.state?.ready !== true) return refuse('tui_not_ready')
      if (root === null) {
        const create = api.client?.session?.create
        const navigate = api.route?.navigate
        if (createAttempted) return refuse('native_create_unconfirmed')
        if (typeof create !== 'function' || typeof navigate !== 'function') return refuse('native_create_api_unavailable')
        createAttempted = true
        progress('native_create_pending')
        const response = asRecord(await create.call(api.client!.session, {}, { throwOnError: true }))
        if (deps.signal?.aborted) return
        const created = asRecord(response?.data)
        if (response?.error || typeof created?.id !== 'string' || !SESSION_ID_RE.test(created.id)
          || !sessionIsExactRoot(created, created.id)) return refuse('native_create_unconfirmed')
        root = created.id
        progress('native_create_settled')
        navigate.call(api.route, 'session', { sessionID: root })
      }
      // A fresh native launch may select another existing root in the TUI.
      // Selection chooses what to read; only the complete native/hydrated
      // conjunction below can replace the observed identity. Resume pins
      // continue to require the exact requested root.
      const selectedRoot = currentRouteSessionId(api.route?.current)
      const candidate = launch.requestedNativeSessionId === null ? selectedRoot : root
      if (candidate === null || selectedRoot !== candidate) return refuse('route_not_selected')
      // The old root is no longer selected while the candidate's reads wait.
      if (candidate !== root) withdraw('route_not_selected')
      const get = api.state?.session?.get
      const messages = api.state?.session?.messages
      if (typeof get !== 'function' || typeof messages !== 'function') return refuse('tui_session_api_unavailable')
      // Read the exact native root while the TUI hydrates it. Publication
      // still requires the current selected root and complete history below.
      progress('native_read_pending')
      const native = await readNativeHistory(api, candidate)
      if (deps.signal?.aborted) return
      progress('native_read_settled')
      if ('failure' in native) return refuse(native.failure)
      const selected = asRecord(get(candidate))
      if (!sessionIsExactRoot(selected, candidate)) return refuse('tui_root_not_loaded')
      if (api.state?.ready !== true || currentRouteSessionId(api.route?.current) !== candidate) return refuse('tui_context_changed')
      if (revertReference(native.session.revert) !== revertReference(selected?.revert)) return refuse('revert_not_hydrated')
      const active = activeMessages(native.messages.map(row => asRecord(row)?.info), candidate, native.session.revert)
      const hydrated = activeMessages(messages(candidate), candidate, selected?.revert)
      if (!active || !hydrated) return refuse('history_not_hydrated')
      const tail = lastActiveMessageId(active, candidate)
      if (active.length === 0 ? hydrated.length !== 0 : lastActiveMessageId(hydrated, candidate) !== tail) {
        return refuse('tail_not_hydrated')
      }
      if (tail !== null && !nativeTailPartsHydrated(api, native.messages, native.session.revert, tail)) {
        return refuse('parts_not_hydrated')
      }
      if (deps.signal?.aborted) return
      root = candidate
      const evidence = JSON.stringify({ launch, native: {
        source: 'opencode-tui-native-loader', session_id: root, parent_id: null, hydrated: true,
        messages_read: active.length === 0 ? 'empty_confirmed' : 'success',
        active_message_count: active.length, tail_message_id: tail,
      } })
      if (evidence === lastEvidence) {
        progress('duplicate')
        return
      }
      write(directory, 'opencode-loaded', evidence)
      lastEvidence = evidence
      progress('publication_succeeded')
    } catch { refuse('native_loader_or_publication_failed') }
    finally { inFlight = false }
  }
}

// TuiPluginModule shape per @opencode-ai/plugin: { id?, tui: (api) => void }
export default {
  id: 'freshell-rebind',
  tui(api: unknown): void {
    try {
      emitHello({ env: process.env })
      const env = process.env
      const a = api as {
        slots?: { register?: (plugin: TuiSlotContribution) => unknown }
        route?: { current?: unknown }
        lifecycle?: {
          signal?: AbortSignal
          onDispose?: (fn: () => void) => unknown
        }
      } | undefined
      const cancellation = new AbortController()
      let timer: ReturnType<typeof setInterval> | undefined
      const stop = (): void => {
        cancellation.abort()
        if (timer !== undefined) clearInterval(timer)
        try {
          a?.lifecycle?.signal?.removeEventListener?.('abort', stop)
        } catch {
          /* lifecycle cleanup must not break the renderer */
        }
      }
      try {
        if (a?.lifecycle?.signal?.aborted) stop()
        else a?.lifecycle?.signal?.addEventListener?.('abort', stop, { once: true })
      } catch {
        /* no lifecycle signal */
      }
      try {
        a?.lifecycle?.onDispose?.(stop)
      } catch {
        /* no onDispose */
      }
      const managedAdoption = hasAdoptionExpectation(env)
      const managedNative = env.FRESHELL_NATIVE_IDENTITY_LAUNCH !== undefined
      const startedAt = performance.now()
      let trigger: NativeObservationWake['trigger'] = 'initial'
      let registeredSlotCount = 0
      let slotRegistrationFailureCount = 0
      const renderCounts = { session_prompt: 0, sidebar_title: 0 }
      const wakeContext = (): NativeObservationWake => ({
        trigger, registeredSlotCount, slotRegistrationFailureCount,
        sessionPromptRenderCount: renderCounts.session_prompt,
        sidebarTitleRenderCount: renderCounts.sidebar_title,
        elapsedMs: Math.max(0, Math.floor(performance.now() - startedAt)),
      })
      const emitLegacy = managedAdoption || managedNative ? undefined : createEmitter({ env })
      const emitObservation = managedAdoption
        ? createObservationEmitter({ env, signal: cancellation.signal, wakeContext })
        : managedNative ? createNativeObservationEmitter({ env, signal: cancellation.signal, wakeContext }) : undefined
      // Unmanaged panes keep their route/slot rebind signal. For managed
      // launches, these edges only trigger a fresh TUI-state check; their
      // route and slot arguments never qualify as adoption evidence. The
      // renderer returns null so this plugin contributes no host content.
      for (const slot of ['session_prompt', 'sidebar_title'] as const) {
        try {
          if (typeof a?.slots?.register !== 'function') continue
          a.slots.register({
            slots: {
              [slot]: (_context: unknown, props: unknown) => {
                if (cancellation.signal.aborted) return null
                trigger = slot
                renderCounts[slot] += 1
                if (emitLegacy) emitLegacy(props)
                if (emitObservation) void emitObservation(a)
                return null
              },
            },
          })
          registeredSlotCount += 1
        } catch {
          slotRegistrationFailureCount += 1
          /* slot API absent/changed -> polling still covers us */
        }
      }
      // PRIMARY edge: 1s poll covers the slots' visibility gaps. In managed
      // mode, route state only triggers a check and cannot emit adoption.
      const tick = (edge: NativeObservationWake['trigger']): void => {
        if (cancellation.signal.aborted) return
        trigger = edge
        try {
          if (emitLegacy) emitLegacy(a?.route?.current)
          if (emitObservation) void emitObservation(a)
        } catch {
          /* route API absent/changed */
        }
      }
      tick('initial')
      if (!cancellation.signal.aborted) timer = setInterval(() => tick('poll'), POLL_INTERVAL_MS)
    } catch {
      // Version tolerance: silently no-op.
    }
  },
}
