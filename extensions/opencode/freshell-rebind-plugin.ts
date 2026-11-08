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
  route?: { current?: unknown }
  state?: {
    ready?: unknown
    session?: {
      get?: (sessionId: string) => unknown
      messages?: (sessionId: string) => unknown
    }
  }
  client?: {
    v2?: {
      session?: {
        messages?: (
          parameters: { sessionID: string },
          options: { throwOnError: true },
        ) => Promise<unknown>
      }
    }
  }
}

export interface EmitterDeps {
  env: Record<string, string | undefined>
  writeFile?: (dir: string, name: string, body: string) => void
  readExpectation?: (path: string) => string | null
  now?: () => number
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

function lastTuiMessageId(value: unknown, expectedSessionId: string): string | null {
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
  const result = asRecord(response.data)
  return result && Array.isArray(result.data) ? result.data : null
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

async function readEmptyHistory(api: AdoptionTuiApi, sessionId: string): Promise<boolean> {
  try {
    const sessionClient = api.client?.v2?.session
    const read = sessionClient?.messages
    if (typeof read !== 'function') return false
    // The exact-session SDK request explicitly throws for non-2xx results.
    // Changed shapes, errors, missing data, and malformed responses are all
    // treated as an unqualified read, never as empty history.
    const result = await read.call(
      sessionClient,
      { sessionID: sessionId },
      { throwOnError: true },
    )
    const messages = nativeMessagesFromResult(result)
    return messages !== null && messages.length === 0
  } catch {
    return false
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
  let inFlight = false
  return async (apiValue: unknown): Promise<void> => {
    if (inFlight) return
    inFlight = true
    try {
      const current = readCurrentAdoptionExpectation(expected, readExpectation)
      if (!current) return
      const api = asRecord(apiValue) as unknown as AdoptionTuiApi | null
      const state = asRecord(api?.state)
      const sessionState = asRecord(state?.session)
      if (
        !api ||
        state?.ready !== true ||
        currentRouteSessionId(api.route?.current) !== current.rootSessionId ||
        typeof sessionState?.get !== 'function' ||
        typeof sessionState.messages !== 'function' ||
        !sessionIsExactRoot(sessionState.get(current.rootSessionId), current.rootSessionId)
      ) {
        return
      }

      const hydratedMessages = sessionState.messages(current.rootSessionId)
      let messagesRead: 'success' | 'empty_confirmed' | 'failed'
      if (current.expectedEmpty) {
        if (!Array.isArray(hydratedMessages) || hydratedMessages.length !== 0) return
        messagesRead = await readEmptyHistory(api, current.rootSessionId)
          ? 'empty_confirmed'
          : 'failed'
      } else {
        if (lastTuiMessageId(hydratedMessages, current.rootSessionId) !== current.tailMessageId) return
        messagesRead = 'success'
      }

      const observation = {
        terminal_id: current.terminalId,
        root_session_id: current.rootSessionId,
        tail_message_id: current.tailMessageId,
        evidence_generation: current.evidenceGeneration,
        incarnation_id: current.incarnationId,
        launch_nonce: current.launchNonce,
        hydrated: true,
        messages_read: messagesRead,
      }
      const signature = JSON.stringify(observation)
      if (signature === lastEmitted) return
      lastEmitted = signature
      seq += 1
      const nonce = `${String(now()).padStart(14, '0')}-${String(seq).padStart(6, '0')}-${process.pid}`
      write(
        current.dir,
        `${current.terminalId}__${nonce}`,
        JSON.stringify({
          session_id: expected.rootSessionId,
          source: 'opencode-tui-plugin',
          adoption_observation: observation,
        }),
      )
    } catch {
      // Version drift and local I/O errors leave adoption blocked and quiet.
    } finally {
      inFlight = false
    }
  }
}

// TuiPluginModule shape per @opencode-ai/plugin: { id?, tui: (api) => void }
export default {
  id: 'freshell-rebind',
  tui(api: unknown): void {
    try {
      emitHello({ env: process.env })
      const env = process.env
      const managedAdoption = hasAdoptionExpectation(env)
      const emitLegacy = managedAdoption ? undefined : createEmitter({ env })
      const emitObservation = managedAdoption
        ? createObservationEmitter({ env })
        : undefined
      const a = api as {
        slots?: { register?: (plugin: TuiSlotContribution) => unknown }
        route?: { current?: unknown }
        lifecycle?: {
          signal?: AbortSignal
          onDispose?: (fn: () => void) => unknown
        }
      } | undefined
      // Unmanaged panes keep their route/slot rebind signal. For managed
      // launches, these edges only trigger a fresh TUI-state check; their
      // route and slot arguments never qualify as adoption evidence. The
      // renderer returns null so this plugin contributes no host content.
      for (const slot of ['session_prompt', 'sidebar_title']) {
        try {
          a?.slots?.register?.({
            slots: {
              [slot]: (_context: unknown, props: unknown) => {
                if (emitLegacy) emitLegacy(props)
                if (emitObservation) void emitObservation(a)
                return null
              },
            },
          })
        } catch {
          /* slot API absent/changed -> polling still covers us */
        }
      }
      // PRIMARY edge: 1s poll covers the slots' visibility gaps. In managed
      // mode, route state only triggers a check and cannot emit adoption.
      const tick = (): void => {
        try {
          if (emitLegacy) emitLegacy(a?.route?.current)
          if (emitObservation) void emitObservation(a)
        } catch {
          /* route API absent/changed */
        }
      }
      tick()
      const timer = setInterval(tick, POLL_INTERVAL_MS)
      const stop = (): void => clearInterval(timer)
      try {
        a?.lifecycle?.signal?.addEventListener?.('abort', stop)
      } catch {
        /* no lifecycle signal */
      }
      try {
        a?.lifecycle?.onDispose?.(stop)
      } catch {
        /* no onDispose */
      }
    } catch {
      // Version tolerance: silently no-op.
    }
  },
}
