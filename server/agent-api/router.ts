import { Router } from 'express'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { nanoid } from 'nanoid'
import { allocateLocalhostPort } from '../local-port.js'
import type { CodexLaunchPlan, CodexLaunchPlanner } from '../coding-cli/codex-app-server/launch-planner.js'
import {
  planCodexLaunchWithRetry,
} from '../coding-cli/codex-app-server/launch-retry.js'
import {
  CodexLaunchConfigError,
  getCodexSessionBindingReason,
  normalizeCodexSandboxSetting,
} from '../coding-cli/codex-launch-config.js'
import { INVALID_RAW_CODEX_RESUME_MESSAGE } from '../coding-cli/codex-app-server/restore-decision.js'
import { makeSessionKey } from '../coding-cli/types.js'
import { terminalIdFromCreateError, UnknownTerminalModeError, type ProviderSettings, type TerminalInputResult } from '../terminal-registry.js'
import { buildSessionIdentityMismatchDetails, terminalMatchesExpectedSession } from '../terminal-session-identity.js'
import { MAX_TERMINAL_TITLE_OVERRIDE_LENGTH } from '../terminals-router.js'
import { logger } from '../logger.js'
import { ok, approx, fail } from './response.js'
import { renderCapture } from './capture.js'
import { waitForMatch } from './wait-for.js'
import { resolveScreenshotOutputPath } from './screenshot-path.js'
import { sanitizeSessionRef } from '../../shared/session-contract.js'
import type { LayoutStore } from './layout-store.js'
import type { FreshAgentRuntimeProvider, FreshAgentSessionType } from '../../shared/fresh-agent.js'
import type {
  FreshAgentSessionLocator,
  FreshAgentThreadLocator,
} from '../fresh-agent/runtime-adapter.js'
import {
  FreshAgentContractValidationError,
  FreshAgentLostSessionError,
  FreshAgentRuntimeUnavailableError,
  FreshAgentSessionLocatorMismatchError,
  FreshAgentStaleThreadRevisionError,
  FreshAgentUnsupportedCapabilityError,
} from '../fresh-agent/runtime-manager.js'

const truthy = (value: unknown) => value === true || value === 'true' || value === '1' || value === 'yes'
const SYNCABLE_TERMINAL_MODES = new Set(['claude', 'codex', 'opencode', 'gemini', 'kimi'])
const log = logger.child({ component: 'agent-api' })
const CODEX_INPUT_READY_WAIT_TIMEOUT_MS = 60_000

class AgentRouteInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentRouteInputError'
  }
}

function agentRouteErrorStatus(error: unknown): number {
  if (error instanceof CodexLaunchConfigError
    || error instanceof AgentRouteInputError
    || error instanceof UnknownTerminalModeError) {
    return 400
  }
  if (error instanceof FreshAgentLostSessionError) return 404
  if (error instanceof FreshAgentUnsupportedCapabilityError
    || error instanceof FreshAgentSessionLocatorMismatchError
    || error instanceof FreshAgentStaleThreadRevisionError) {
    return 409
  }
  if (error instanceof FreshAgentRuntimeUnavailableError) return 503
  if (error instanceof FreshAgentContractValidationError) return 502
  return 500
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function freshAgentErrorStatus(error: unknown): number {
  if (error instanceof FreshAgentLostSessionError) return 404
  if (error instanceof FreshAgentUnsupportedCapabilityError
    || error instanceof FreshAgentSessionLocatorMismatchError
    || error instanceof FreshAgentStaleThreadRevisionError) {
    return 409
  }
  if (error instanceof FreshAgentRuntimeUnavailableError) return 503
  if (error instanceof FreshAgentContractValidationError) return 502
  return 500
}

const FRESH_AGENT_SEND_IDLE_TIMEOUT_MS = 600_000

async function waitForFreshAgentIdle(
  runtimeManager: NonNullable<FreshAgentRuntimeManagerLike>,
  locator: { sessionType: string; provider: string; threadId: string },
  deadline: number,
): Promise<{ status: string; deadlineMissed: boolean }> {
  while (Date.now() < deadline) {
    const snap = await runtimeManager.getSnapshot(locator as FreshAgentThreadLocator)
    const status = snap?.status
    if (status === 'idle') return { status, deadlineMissed: false }
    await new Promise((r) => setTimeout(r, 200))
  }
  return { status: 'unknown', deadlineMissed: true }
}

function combineWithCleanupError(primary: unknown, cleanupError: unknown): Error {
  const primaryMessage = errorMessage(primary)
  const cleanupMessage = errorMessage(cleanupError)
  return new Error(`${primaryMessage}; cleanup failed: ${cleanupMessage}`)
}

/**
 * Resolve provider settings for a terminal spawn. Explicit API params override
 * the user's configured defaults from settings.
 */
async function resolveProviderSettings(
  mode: string,
  configStore: any,
  overrides: { permissionMode?: string; model?: string; sandbox?: string },
): Promise<{ permissionMode?: string; model?: string; sandbox?: string } | undefined> {
  if (mode === 'shell') return undefined
  const defaults = configStore
    ? (await configStore.getSettings())?.codingCli?.providers?.[mode] ?? {}
    : {}
  return {
    permissionMode: overrides.permissionMode ?? defaults.permissionMode,
    model: overrides.model ?? defaults.model,
    sandbox: overrides.sandbox ?? defaults.sandbox,
  }
}

async function resolveSpawnProviderSettings(
  mode: string,
  configStore: any,
  overrides: { permissionMode?: string; model?: string; sandbox?: string },
  opts: {
    cwd?: string
    resumeSessionId?: string
    codexLaunchPlanner?: CodexLaunchPlanner
    assertTerminalCreateAccepted?: () => void
  } = {},
): Promise<{ resumeSessionId?: string; providerSettings?: ProviderSettings; codexPlan?: CodexLaunchPlan }> {
  const providerSettings = await resolveProviderSettings(mode, configStore, overrides)
  if (mode === 'codex') {
    if (!opts.codexLaunchPlanner) {
      throw new Error('Codex terminal launch requires the app-server launch planner.')
    }
    opts.assertTerminalCreateAccepted?.()
    const plan = await planCodexLaunchWithRetry({
      planner: opts.codexLaunchPlanner,
      logger: log,
      input: {
        cwd: opts.cwd,
        resumeSessionId: opts.resumeSessionId,
        model: providerSettings?.model,
        sandbox: normalizeCodexSandboxSetting(providerSettings?.sandbox),
        approvalPolicy: providerSettings?.permissionMode,
      },
    })
    return {
      resumeSessionId: opts.resumeSessionId ? (plan.sessionId ?? opts.resumeSessionId) : undefined,
      providerSettings: {
        codexAppServer: {
          ...plan.remote,
          sidecar: plan.sidecar,
          deferLifecycleUntilPublished: true,
          recovery: {
            planCreate: (input) => opts.codexLaunchPlanner!.planCreate({
              cwd: input.cwd ?? opts.cwd,
              resumeSessionId: input.resumeSessionId,
              model: providerSettings?.model,
              sandbox: normalizeCodexSandboxSetting(providerSettings?.sandbox),
              approvalPolicy: providerSettings?.permissionMode,
            }),
          },
        },
      },
      codexPlan: plan,
    }
  }
  if (mode !== 'opencode') {
    return {
      resumeSessionId: opts.resumeSessionId,
      providerSettings,
    }
  }
  return {
    resumeSessionId: opts.resumeSessionId,
    providerSettings: {
      ...(providerSettings ?? {}),
      opencodeServer: await allocateLocalhostPort(),
    },
  }
}

type ResolvedSpawnProviderSettings = Awaited<ReturnType<typeof resolveSpawnProviderSettings>>

function requestedResumeSessionIdForMode(
  sessionRef: ReturnType<typeof sanitizeSessionRef>,
  mode: string,
  legacyResumeSessionId: unknown,
): string | undefined {
  const acceptedSessionRef = acceptedSessionRefForMode(sessionRef, mode)
  if (acceptedSessionRef) return acceptedSessionRef.sessionId
  if (mode === 'codex') {
    if (isNonEmptyString(legacyResumeSessionId)) {
      throw new AgentRouteInputError(INVALID_RAW_CODEX_RESUME_MESSAGE)
    }
    return undefined
  }
  return typeof legacyResumeSessionId === 'string' ? legacyResumeSessionId : undefined
}

function acceptedSessionRefForMode(
  sessionRef: ReturnType<typeof sanitizeSessionRef>,
  mode: string,
): ReturnType<typeof sanitizeSessionRef> {
  if (!sessionRef || sessionRef.provider !== mode) return undefined
  return sessionRef
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

async function adoptCodexLaunch(
  launch: ResolvedSpawnProviderSettings | undefined,
  terminalId: string,
): Promise<void> {
  await launch?.codexPlan?.sidecar.adopt({ terminalId, generation: 0 })
}

async function cleanupUnadoptedCodexLaunch(launch: ResolvedSpawnProviderSettings | undefined): Promise<void> {
  await launch?.codexPlan?.sidecar.shutdown()
}

function publishCodexLaunch(registry: any, launch: ResolvedSpawnProviderSettings | undefined, terminalId: string): void {
  if (!launch?.codexPlan) return
  registry.publishCodexSidecar?.(terminalId)
}

function assertCodexCreateTerminalRunning(terminal: { status?: unknown }): void {
  if (terminal.status === 'exited') {
    throw new Error('Codex terminal PTY exited before create completed.')
  }
}

function formatSessionRef(sessionRef: ReturnType<typeof sanitizeSessionRef> | undefined): string {
  if (!sessionRef) return 'unknown session'
  return `${sessionRef.provider}:${sessionRef.sessionId}`
}

function sessionIdentityMismatchMessage(
  expectedSessionRef: ReturnType<typeof sanitizeSessionRef> | undefined,
  actualSessionRef: ReturnType<typeof sanitizeSessionRef> | undefined,
): string {
  const expected = formatSessionRef(expectedSessionRef)
  if (!actualSessionRef) {
    return `Terminal session identity mismatch. Expected ${expected}, but the target terminal could not prove that identity.`
  }
  return `Terminal session identity mismatch. Expected ${expected}, got ${formatSessionRef(actualSessionRef)}.`
}

function paneCanonicalSessionRef(
  layoutStore: any,
  paneId: string,
): ReturnType<typeof sanitizeSessionRef> {
  return sanitizeSessionRef(layoutStore.getPaneSnapshot?.(paneId)?.paneContent?.sessionRef)
}

function expectedPaneSessionRefForTerminal(
  layoutStore: any,
  paneId: string,
  terminalMode: unknown,
  requestedSessionRef: ReturnType<typeof sanitizeSessionRef>,
): ReturnType<typeof sanitizeSessionRef> {
  const paneSessionRef = paneCanonicalSessionRef(layoutStore, paneId)
  if (paneSessionRef) return paneSessionRef
  return acceptedSessionRefForMode(requestedSessionRef, typeof terminalMode === 'string' ? terminalMode : '')
}

function terminalInputFailureMessage(result: Exclude<TerminalInputResult, { status: 'written' }>): string {
  if (result.status === 'session_identity_mismatch') {
    return sessionIdentityMismatchMessage(result.expectedSessionRef, result.actualSessionRef)
  }
  if (result.status === 'blocked_codex_identity_pending') {
    return 'Codex restore identity is not ready yet.'
  }
  if (result.status === 'blocked_codex_identity_capture_timeout') {
    return 'Codex restore identity timed out before input could be accepted.'
  }
  if (result.status === 'blocked_codex_identity_unavailable') {
    return 'Codex restore identity could not be captured before input could be accepted.'
  }
  if (result.status === 'blocked_codex_recovery_pending') {
    return 'Codex durable recovery is still in progress.'
  }
  if (result.status === 'blocked_codex_clean_exit_decision_pending') {
    return 'Codex clean exit state is still being resolved.'
  }
  if (result.status === 'blocked_codex_lifecycle_loss_pending') {
    return 'Codex worker lifecycle loss is still being resolved.'
  }
  return 'Terminal is not running.'
}

function renderFreshAgentTranscript(snapshot: any): string {
  const turns = Array.isArray(snapshot?.turns) ? snapshot.turns : []
  return turns.map((turn: any) => {
    const role = typeof turn?.role === 'string' ? turn.role : 'turn'
    const items = Array.isArray(turn?.items) ? turn.items : []
    const text = items
      .map((item: any) => {
        if (item?.kind === 'text' && typeof item.text === 'string') return item.text
        if (item?.kind === 'reasoning' && typeof item.text === 'string') return `[reasoning] ${item.text}`
        if (item?.kind === 'dynamic_tool') return `[tool:${item.tool ?? 'tool'} ${item.status ?? ''}]`
        return ''
      })
      .filter(Boolean)
      .join('\n')
    return `${role}: ${text || (typeof turn?.summary === 'string' ? turn.summary : '')}`.trim()
  }).join('\n\n')
}

function shouldWaitForCodexIdentity(payload: Record<string, unknown>): boolean {
  return truthy(payload.waitForCodexIdentity)
}

function registrySupportsEvents(registry: any): registry is {
  input: (terminalId: string, data: string) => TerminalInputResult
  inputIfSessionMatches?: (
    terminalId: string,
    data: string,
    expectedSessionRef?: ReturnType<typeof sanitizeSessionRef>,
  ) => TerminalInputResult
  on: (event: string, handler: (...args: any[]) => void) => void
  off: (event: string, handler: (...args: any[]) => void) => void
} {
  return typeof registry?.on === 'function' && typeof registry?.off === 'function'
}

async function sendTerminalInput(
  registry: any,
  terminalId: string,
  data: string,
  options: {
    expectedSessionRef?: ReturnType<typeof sanitizeSessionRef>
    waitForCodexIdentity?: boolean
  } = {},
): Promise<TerminalInputResult> {
  const send = () => (
    typeof registry.inputIfSessionMatches === 'function'
      ? registry.inputIfSessionMatches(terminalId, data, options.expectedSessionRef)
      : registry.input(terminalId, data)
  ) as TerminalInputResult
  const first = send()
  if (first.status !== 'blocked_codex_identity_pending' || !options.waitForCodexIdentity) {
    return first
  }
  if (!registrySupportsEvents(registry)) return first

  return new Promise<TerminalInputResult>((resolve) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined

    const cleanup = () => {
      if (timeout) clearTimeout(timeout)
      registry.off('terminal.codex.durability.updated', onDurabilityUpdated)
      registry.off('terminal.exit', onTerminalExit)
    }
    const finish = (result: TerminalInputResult) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }
    const retry = () => {
      if (settled) return
      const next = send()
      if (next.status === 'blocked_codex_identity_pending') return
      finish(next)
    }
    const onDurabilityUpdated = (event: { terminalId?: string }) => {
      if (event?.terminalId !== terminalId) return
      retry()
    }
    const onTerminalExit = (event: { terminalId?: string }) => {
      if (event?.terminalId !== terminalId) return
      finish({ status: 'not_running' })
    }

    registry.on('terminal.codex.durability.updated', onDurabilityUpdated)
    registry.on('terminal.exit', onTerminalExit)
    timeout = setTimeout(() => {
      finish({ status: 'blocked_codex_identity_capture_timeout', terminalId })
    }, CODEX_INPUT_READY_WAIT_TIMEOUT_MS)
    queueMicrotask(retry)
  })
}

async function cleanupCreatedTerminal(registry: any, terminalId: string | undefined): Promise<void> {
  if (!terminalId) return
  if (typeof registry?.killAndWait === 'function') {
    await registry.killAndWait(terminalId)
    return
  }
  if (typeof registry?.kill === 'function') {
    registry.kill(terminalId)
  }
}

async function cleanupFailedCodexCreate(
  registry: any,
  terminalId: string | undefined,
  launch: ResolvedSpawnProviderSettings | undefined,
): Promise<void> {
  const cleanupErrors: string[] = []
  await cleanupCreatedTerminal(registry, terminalId).catch((error) => {
    cleanupErrors.push(`created terminal cleanup failed: ${errorMessage(error)}`)
  })
  await cleanupUnadoptedCodexLaunch(launch).catch((error) => {
    cleanupErrors.push(`Codex sidecar cleanup failed: ${errorMessage(error)}`)
  })
  if (cleanupErrors.length > 0) {
    throw new Error(cleanupErrors.join('; '))
  }
}

type ResizeLayoutStore = {
  getSplitSizes?: (tabId: string | undefined, splitId: string) => [number, number] | undefined
  resolveTarget?: (target: string) => { tabId?: string; paneId?: string; message?: string }
  findSplitForPane?: (paneId: string) => { tabId: string; splitId: string } | undefined
}

type ResolvedResizeTarget = {
  tabId?: string
  splitId: string
  message?: string
}

type CodexPromptBlocker = {
  isPromptBlocked: (terminalId: string, at: number) => boolean
}

type FreshAgentRuntimeManagerLike = {
  create: (input: any) => Promise<{ sessionId: string; sessionType: FreshAgentSessionType; runtimeProvider: FreshAgentRuntimeProvider; sessionRef?: { provider: string; sessionId: string } }>
  send: (locator: FreshAgentSessionLocator, input: { text: string; settings?: any }) => Promise<{ sessionId?: string; sessionRef?: { provider: string; sessionId: string } } | void>
  attach: (locator: FreshAgentSessionLocator) => Promise<{ sessionId: string; sessionRef?: { provider: string; sessionId: string } }>
  getSnapshot: (input: FreshAgentThreadLocator) => Promise<any>
}

const parseRegex = (raw: string) => {
  if (raw.startsWith('/') && raw.lastIndexOf('/') > 0) {
    const last = raw.lastIndexOf('/')
    const body = raw.slice(1, last)
    const flags = raw.slice(last + 1)
    return new RegExp(body, flags)
  }
  return new RegExp(raw)
}

const looksLikePrompt = (text: string) => {
  const lastLine = text.split(/\r?\n/).filter(Boolean).pop() || ''
  return /[#$>] ?$/.test(lastLine.trimEnd())
}

async function writeFileAtomic(filePath: string, content: Buffer) {
  const tempPath = `${filePath}.tmp-${randomUUID()}`
  await fs.writeFile(tempPath, content)
  try {
    await fs.rename(tempPath, filePath)
  } catch (err) {
    await fs.unlink(tempPath).catch(() => undefined)
    throw err
  }
}

export function createAgentApiRouter({
  layoutStore,
  registry,
  wsHandler,
  configStore,
  terminalMetadata,
  codingCliIndexer,
  codexActivityTracker,
  codexLaunchPlanner,
  assertTerminalCreateAccepted,
  freshAgentRuntimeManager,
}: {
  layoutStore: any
  registry: any
  wsHandler?: any
  configStore?: any
  terminalMetadata?: { list: () => Array<{ terminalId: string; provider?: string; sessionId?: string }> }
  codingCliIndexer?: { refresh: () => Promise<void> }
  codexActivityTracker?: CodexPromptBlocker
  codexLaunchPlanner?: CodexLaunchPlanner
  assertTerminalCreateAccepted?: () => void
  freshAgentRuntimeManager?: FreshAgentRuntimeManagerLike
}) {
  const router = Router()
  const assertTerminalAdmission = () => {
    assertTerminalCreateAccepted?.()
  }

  const resolvePaneTarget = (raw: string) => {
    if (layoutStore.resolveTarget) {
      const resolved = layoutStore.resolveTarget(raw)
      if (resolved?.paneId || resolved?.tabId || (resolved?.message && resolved.message !== 'target not resolved')) {
        return resolved
      }
    }
    return { paneId: raw }
  }

  const AGENT_SESSION_TYPES: Record<string, { sessionType: string; provider: string }> = {
    opencode: { sessionType: 'freshopencode', provider: 'opencode' },
    claude: { sessionType: 'freshclaude', provider: 'claude' },
    codex: { sessionType: 'freshcodex', provider: 'codex' },
  }

  const createFreshAgentPane = async (
    res: any,
    allocate: () => { tabId: string; paneId: string } | undefined,
    rollback: (allocation: { tabId: string; paneId: string }) => void,
    broadcast: (info: { tabId: string; paneId: string; paneContent: any }) => void,
    opts: { agent: string; cwd?: string; model?: string; effort?: string; name?: string },
  ): Promise<boolean> => {
    const mapping = AGENT_SESSION_TYPES[opts.agent]
    if (!mapping) { res.status(400).json(fail(`unknown agent "${opts.agent}"`)); return true }
    if (!freshAgentRuntimeManager) { res.status(503).json(fail('fresh-agent runtime not available on this server')); return true }
    const allocation = allocate()
    if (!allocation) { res.status(500).json(fail('failed to allocate fresh-agent pane')); return true }
    const createRequestId = nanoid()
    let created: Awaited<ReturnType<FreshAgentRuntimeManagerLike['create']>> | undefined
    try {
      created = await freshAgentRuntimeManager.create({
        requestId: createRequestId,
        sessionType: mapping.sessionType,
        provider: mapping.provider,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.effort ? { effort: opts.effort } : {}),
      })
    } catch (err: any) {
      rollback(allocation)
      throw err
    }
    const paneContent = {
      kind: 'fresh-agent',
      sessionType: mapping.sessionType,
      provider: mapping.provider,
      sessionId: created.sessionId,
      createRequestId,
      status: 'connected',
      ...(created.sessionRef ? { sessionRef: created.sessionRef } : {}),
      ...(opts.cwd ? { initialCwd: opts.cwd } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.effort ? { effort: opts.effort } : {}),
    }
    layoutStore.attachPaneContent(allocation.tabId, allocation.paneId, paneContent)
    broadcast({ tabId: allocation.tabId, paneId: allocation.paneId, paneContent })
    res.json(ok({ tabId: allocation.tabId, paneId: allocation.paneId, sessionId: created.sessionId, sessionRef: created.sessionRef }, 'fresh-agent pane created'))
    return true
  }

  const rejectPaneTargetError = (res: any, resolved: { paneId?: string; message?: string }) => {
    if (!resolved?.message || resolved.paneId) return false
    const status = resolved.message.includes('ambiguous') ? 409 : 404
    res.status(status).json(fail(resolved.message))
    return true
  }

  const parseOptionalNumber = (value: unknown): number | undefined => {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }

  const parseRequiredName = (value: unknown) => {
    const trimmed = typeof value === 'string' ? value.trim() : ''
    return trimmed.length > 0 ? trimmed : undefined
  }

  const isValidPercent = (value: number) => Number.isFinite(value) && value >= 1 && value <= 99
  const clampPercent = (value: number) => Math.min(99, Math.max(1, value))
  const isAmbiguousTargetMessage = (message: string | undefined) => (
    typeof message === 'string' && message.includes('ambiguous')
  )
  const normalizePairToHundred = (a: number, b: number): [number, number] => {
    const left = clampPercent(a)
    const right = clampPercent(b)
    const total = left + right
    const normalizedLeft = clampPercent(Math.round((left / total) * 100))
    return [normalizedLeft, 100 - normalizedLeft]
  }

  const resolveResizeTarget = (store: ResizeLayoutStore, rawTarget: string, requestedTabId?: string): ResolvedResizeTarget => {
    // Backward compatibility for simple mocks in tests: if we cannot inspect splits,
    // assume the provided target is already a split id.
    if (!store.getSplitSizes) {
      return { tabId: requestedTabId, splitId: rawTarget }
    }

    const directSizes = store.getSplitSizes(requestedTabId, rawTarget)
    if (Array.isArray(directSizes)) {
      return { tabId: requestedTabId, splitId: rawTarget }
    }

    if (store.resolveTarget && store.findSplitForPane) {
      const resolved = store.resolveTarget(rawTarget)
      if (resolved?.paneId) {
        const parent = store.findSplitForPane(resolved.paneId)
        if (parent?.splitId) {
          return { tabId: parent.tabId, splitId: parent.splitId, message: 'pane matched; resized parent split' }
        }
      }
      if (isAmbiguousTargetMessage(resolved?.message)) {
        return { tabId: resolved.tabId, splitId: rawTarget, message: resolved.message }
      }
    }

    return { tabId: requestedTabId, splitId: rawTarget, message: 'split not found' }
  }

  const persistSyncableTerminalRename = async (paneSnapshot: any, title: string) => {
    const paneContent = paneSnapshot?.paneContent
    const terminalId = typeof paneContent?.terminalId === 'string' ? paneContent.terminalId : undefined
    const meta = terminalId
      ? terminalMetadata?.list?.().find((entry) => entry.terminalId === terminalId)
      : undefined
    const resumeSessionId = typeof paneContent?.resumeSessionId === 'string'
      ? paneContent.resumeSessionId
      : undefined
    const modeCandidates = [
      typeof paneContent?.mode === 'string' ? paneContent.mode : undefined,
      terminalId ? registry.get?.(terminalId)?.mode : undefined,
      typeof meta?.provider === 'string' ? meta.provider : undefined,
    ]
    const mode = modeCandidates.find((candidate) => (
      typeof candidate === 'string' && SYNCABLE_TERMINAL_MODES.has(candidate)
    ))

    if (!terminalId || !mode || !SYNCABLE_TERMINAL_MODES.has(mode) || !configStore) {
      return
    }

    try {
      await configStore.patchTerminalOverride?.(terminalId, { titleOverride: title })
      registry.updateTitle?.(terminalId, title)

      const sessionProvider = typeof meta?.provider === 'string' ? meta.provider : mode
      const sessionId = typeof meta?.sessionId === 'string' ? meta.sessionId : resumeSessionId
      if (sessionProvider && sessionId) {
        try {
          await configStore.patchSessionOverride?.(makeSessionKey(sessionProvider as any, sessionId), {
            titleOverride: title,
          })
          await codingCliIndexer?.refresh?.()
        } catch {
          // Match terminals-router semantics: terminal rename persistence is authoritative,
          // but session-title cascade/index refresh is best-effort.
        }
      }

      wsHandler?.broadcastTerminalsChanged?.()
    } catch {
      // Pane rename is authoritative for orchestration; syncable terminal persistence is best-effort.
    }
  }

  router.post('/tabs', async (req, res) => {
    const { name, mode, shell, cwd, browser, editor, resumeSessionId, permissionMode, model, sandbox } = req.body || {}
    const requestedSessionRef = sanitizeSessionRef(req.body?.sessionRef)
    if (typeof req.body?.agent === 'string') {
      const handled = await createFreshAgentPane(
        res,
        () => layoutStore.createTab({ title: name }),
        ({ tabId }) => { layoutStore.closeTab?.(tabId) },
        ({ tabId, paneId, paneContent }) => {
          wsHandler?.broadcastUiCommand({ command: 'tab.create', payload: { id: tabId, title: name, paneId, paneContent } })
        },
        { agent: req.body.agent, cwd, model, name, effort: req.body?.effort },
      ).catch((err: any) => { res.status(agentRouteErrorStatus(err)).json(fail(err?.message || 'Failed to create fresh-agent tab')); return true })
      if (handled) return
    }
    const wantsBrowser = !!browser
    const wantsEditor = !!editor
    let launch: ResolvedSpawnProviderSettings | undefined
    let createdTerminalId: string | undefined
    let createdTabId: string | undefined

    try {
      let paneContent: any
      let terminalId: string | undefined

      if (wantsBrowser) {
        paneContent = { kind: 'browser', url: browser, devToolsOpen: false }
      } else if (wantsEditor) {
        paneContent = { kind: 'editor', filePath: editor, language: null, readOnly: false, content: '', viewMode: 'source', wordWrap: true }
      } else {
        const effectiveMode = mode || 'shell'
        const acceptedSessionRef = acceptedSessionRefForMode(requestedSessionRef, effectiveMode)
        const requestedResumeSessionId = requestedResumeSessionIdForMode(
          requestedSessionRef,
          effectiveMode,
          resumeSessionId,
        )
        assertTerminalAdmission()
        launch = await resolveSpawnProviderSettings(
          effectiveMode,
          configStore,
          { permissionMode, model, sandbox },
          { cwd, resumeSessionId: requestedResumeSessionId, codexLaunchPlanner, assertTerminalCreateAccepted: assertTerminalAdmission },
        )
        assertTerminalAdmission()
        const { tabId, paneId } = layoutStore.createTab({ title: name, browser, editor })
        createdTabId = tabId
        const sessionBindingReason = getCodexSessionBindingReason(effectiveMode, requestedResumeSessionId)
        assertTerminalAdmission()
        const terminal = registry.create({
          mode: effectiveMode,
          shell,
          cwd,
          resumeSessionId: launch.resumeSessionId,
          ...(sessionBindingReason ? { sessionBindingReason } : {}),
          providerSettings: launch.providerSettings,
          envContext: { tabId, paneId },
        })
        createdTerminalId = terminal.terminalId
        const launchResumeSessionId = launch.resumeSessionId
        assertTerminalAdmission()
        await adoptCodexLaunch(launch, terminal.terminalId)
        assertCodexCreateTerminalRunning(terminal)
        assertTerminalAdmission()
        publishCodexLaunch(registry, launch, terminal.terminalId)
        launch = undefined
        terminalId = terminal.terminalId
        paneContent = {
          kind: 'terminal',
          terminalId,
          status: 'running',
          mode: mode || 'shell',
          shell: shell || 'system',
          ...(acceptedSessionRef ? { sessionRef: acceptedSessionRef } : {}),
          ...(launchResumeSessionId && !acceptedSessionRef ? { resumeSessionId: launchResumeSessionId } : {}),
          initialCwd: cwd,
        }

        layoutStore.attachPaneContent(tabId, paneId, paneContent)

        wsHandler?.broadcastUiCommand({
          command: 'tab.create',
          payload: {
            id: tabId,
            title: name,
            mode: mode || 'shell',
            shell,
            terminalId,
            initialCwd: cwd,
            ...(paneContent?.resumeSessionId ? { resumeSessionId: paneContent.resumeSessionId } : {}),
            ...(paneContent?.sessionRef ? { sessionRef: paneContent.sessionRef } : {}),
            paneId,
            paneContent,
          },
        })

        res.json(ok({ tabId, paneId, terminalId }, 'tab created'))
        createdTerminalId = undefined
        return
      }

      const { tabId, paneId } = layoutStore.createTab({ title: name, browser, editor })
      createdTabId = tabId
      layoutStore.attachPaneContent(tabId, paneId, paneContent)

      wsHandler?.broadcastUiCommand({
        command: 'tab.create',
        payload: {
          id: tabId,
          title: name,
          mode: mode || 'shell',
          shell,
          terminalId,
          initialCwd: cwd,
          resumeSessionId: paneContent?.resumeSessionId,
          sessionRef: paneContent?.sessionRef,
          paneId,
          paneContent,
        },
      })

      res.json(ok({ tabId, paneId, terminalId }, 'tab created'))
    } catch (err: any) {
      let responseError = err
      await cleanupFailedCodexCreate(registry, createdTerminalId ?? terminalIdFromCreateError(err), launch).catch((cleanupError) => {
        responseError = combineWithCleanupError(err, cleanupError)
      })
      if (createdTabId && typeof layoutStore.closeTab === 'function') {
        try {
          layoutStore.closeTab(createdTabId)
        } catch {
          // best-effort cleanup; terminal/sidecar cleanup errors above remain authoritative
        }
      }
      const status = agentRouteErrorStatus(responseError)
      res.status(status).json(fail(responseError?.message || 'Failed to create tab'))
    }
  })

  router.post('/tabs/:id/select', (req, res) => {
    const result = layoutStore.selectTab(req.params.id)
    wsHandler?.broadcastUiCommand({ command: 'tab.select', payload: { id: req.params.id } })
    res.json(ok(result, result.message || 'tab selected'))
  })

  router.patch('/tabs/:id', (req, res) => {
    const name = parseRequiredName(req.body?.name)
    if (!name) return res.status(400).json(fail('name required'))

    const result = layoutStore.renameTab(req.params.id, name)
    if (result?.tabId) {
      wsHandler?.broadcastUiCommand({ command: 'tab.rename', payload: { id: req.params.id, title: name } })
    }
    res.json(ok(result, result.message || 'tab renamed'))
  })

  router.delete('/tabs/:id', (req, res) => {
    const result = layoutStore.closeTab(req.params.id)
    wsHandler?.broadcastUiCommand({ command: 'tab.close', payload: { id: req.params.id } })
    res.json(ok(result, result.message || 'tab closed'))
  })

  router.get('/tabs/has', (req, res) => {
    const target = (req.query.target as string | undefined) || ''
    const exists = target ? layoutStore.hasTab?.(target) : false
    res.json(ok({ exists }))
  })

  router.post('/tabs/next', (_req, res) => {
    const result = layoutStore.selectNextTab?.()
    if (result?.tabId) {
      wsHandler?.broadcastUiCommand({ command: 'tab.select', payload: { id: result.tabId } })
    }
    res.json(ok(result, result?.message || 'tab selected'))
  })

  router.post('/tabs/prev', (_req, res) => {
    const result = layoutStore.selectPrevTab?.()
    if (result?.tabId) {
      wsHandler?.broadcastUiCommand({ command: 'tab.select', payload: { id: result.tabId } })
    }
    res.json(ok(result, result?.message || 'tab selected'))
  })

  router.get('/tabs', (_req, res) => {
    const tabs = layoutStore.listTabs?.() || []
    const activeTabId = layoutStore.getActiveTabId?.() || null
    res.json(ok({ tabs, activeTabId }))
  })

  router.get('/layout/snapshot', (req, res) => {
    const tabId = typeof req.query.tabId === 'string' ? req.query.tabId : undefined
    const snapshot = layoutStore.getNormalizedSnapshot?.(tabId) || {
      tabs: [],
      activeTabId: null,
      layouts: {},
      activePane: {},
      paneTitles: {},
      paneTitleSetByUser: {},
    }
    res.json(ok(snapshot))
  })

  router.get('/panes', (req, res) => {
    const tabId = req.query.tabId as string | undefined
    const panes = layoutStore.listPanes?.(tabId) || []
    res.json(ok({ panes }))
  })

  router.get('/panes/:id/capture', async (req, res) => {
    const rawTarget = req.params.id
    const resolved = resolvePaneTarget(rawTarget)
    if (rejectPaneTargetError(res, resolved)) return
    const paneId = resolved.paneId || rawTarget
    const paneSnapshot = layoutStore.getPaneSnapshot?.(paneId)
    if (paneSnapshot?.kind === 'fresh-agent') {
      const c = paneSnapshot.paneContent || {}
      if (!freshAgentRuntimeManager) return res.status(503).json(fail('fresh-agent runtime not available on this server'))
      try {
        const snapshot = await freshAgentRuntimeManager.getSnapshot({ sessionType: c.sessionType, provider: c.provider, threadId: c.sessionId })
        return res.type('text/plain').send(renderFreshAgentTranscript(snapshot))
      } catch (err: any) {
        return res.status(agentRouteErrorStatus(err)).json(fail(err?.message || 'fresh-agent capture failed'))
      }
    }
    let terminalId = paneSnapshot?.terminalId || layoutStore.resolvePaneToTerminal?.(paneId)
    const term = terminalId ? registry.get?.(terminalId) : undefined

    const rawStart = req.query.S
    const start = typeof rawStart === 'string' ? Number(rawStart) : undefined
    const joinLines = req.query.J === 'true' || req.query.J === '1'
    const includeAnsi = req.query.e === 'true' || req.query.e === '1'

    if (term) {
      const output = renderCapture(term.buffer.snapshot(), { includeAnsi, joinLines, start })
      return res.type('text/plain').send(output)
    }

    if (paneSnapshot?.kind === 'editor') {
      const editorBuffer = typeof paneSnapshot.paneContent?.content === 'string'
        ? paneSnapshot.paneContent.content
        : ''
      const output = renderCapture(editorBuffer, { includeAnsi, joinLines, start })
      return res.type('text/plain').send(output)
    }

    if (paneSnapshot?.kind && paneSnapshot.kind !== 'terminal') {
      return res.status(422).json(
        fail(`pane kind "${paneSnapshot.kind}" does not support capture-pane; use screenshot-pane`),
      )
    }

    if (terminalId || paneSnapshot?.kind === 'terminal') {
      return res.status(404).json(fail('terminal not found'))
    }

    return res.status(404).json(fail('pane not found'))
  })

  router.get('/panes/:id/wait-for', async (req, res) => {
    const resolved = resolvePaneTarget(req.params.id)
    if (rejectPaneTargetError(res, resolved)) return
    const paneId = resolved.paneId || req.params.id

    const faSnap = layoutStore.getPaneSnapshot?.(paneId)
    if (faSnap?.kind === 'fresh-agent') {
      const c = faSnap.paneContent || {}
      if (!freshAgentRuntimeManager) return res.status(503).json(fail('fresh-agent runtime not available on this server'))
      const rawT = req.query.T || req.query.timeout
      const tSec = typeof rawT === 'string' ? Number(rawT) : Number.NaN
      const deadline = Date.now() + (Number.isFinite(tSec) ? tSec * 1000 : 30000)
      while (true) {
        let status: string | undefined
        try {
          const snap = await freshAgentRuntimeManager.getSnapshot({ sessionType: c.sessionType, provider: c.provider, threadId: c.sessionId })
          status = snap?.status
        } catch (err) {
          return res.status(freshAgentErrorStatus(err)).json(fail(errorMessage(err)))
        }
        if (status === 'idle') return res.json(ok({ matched: true, reason: 'idle' }, 'session idle'))
        if (Date.now() >= deadline) return res.json(approx({ matched: false }, 'timeout'))
        await new Promise((r) => setTimeout(r, 200))
      }
    }

    let terminalId = layoutStore.resolvePaneToTerminal?.(paneId)
    const term = terminalId ? registry.get?.(terminalId) : undefined
    if (!term) return res.status(404).json(fail('terminal not found'))

    const rawPattern = (req.query.pattern || req.query.p) as string | undefined
    let pattern: RegExp | undefined
    if (rawPattern) {
      try {
        pattern = parseRegex(rawPattern)
      } catch {
        return res.status(400).json(fail('invalid pattern'))
      }
    }

    const rawStable = req.query.stable || req.query.s
    const stableSeconds = typeof rawStable === 'string' ? Number(rawStable) : Number.NaN
    let stableMs = Number.isFinite(stableSeconds) ? stableSeconds * 1000 : undefined

    const waitExit = truthy(req.query.exit)
    const waitPrompt = truthy(req.query.prompt)

    const rawTimeout = req.query.T || req.query.timeout
    const timeoutSeconds = typeof rawTimeout === 'string' ? Number(rawTimeout) : Number.NaN
    const timeoutMs = Number.isFinite(timeoutSeconds) ? timeoutSeconds * 1000 : 30000

    let usedFallback = false
    if (waitPrompt && stableMs === undefined) {
      stableMs = 1000
      usedFallback = true
    }
    if (!pattern && !waitExit && !waitPrompt && stableMs === undefined) {
      stableMs = 1000
      usedFallback = true
    }

    const getText = () => renderCapture(term.buffer.snapshot(), { includeAnsi: false })
    const start = Date.now()
    let lastText = getText()
    let stableSince = Date.now()

    while (true) {
      const text = getText()
      if (pattern) {
        pattern.lastIndex = 0
        if (pattern.test(text)) return res.json(ok({ matched: true, reason: 'pattern' }, 'pattern matched'))
      }
      if (waitExit && term.status === 'exited') {
        return res.json(ok({ matched: true, reason: 'exit', exitCode: term.exitCode }, 'terminal exited'))
      }
      if (
        waitPrompt
        && term.mode === 'codex'
        && codexActivityTracker?.isPromptBlocked(terminalId, Date.now())
      ) {
        lastText = text
        stableSince = Date.now()
        if (Date.now() - start >= timeoutMs) return res.json(approx({ matched: false }, 'timeout'))
        await new Promise((resolve) => setTimeout(resolve, 200))
        continue
      }
      if (waitPrompt && looksLikePrompt(text)) {
        return res.json(ok({ matched: true, reason: 'prompt' }, 'prompt detected'))
      }
      if (stableMs !== undefined) {
        if (text === lastText) {
          if (Date.now() - stableSince >= stableMs) {
            const responder = usedFallback ? approx : ok
            const message = waitPrompt && usedFallback ? 'prompt not detected; output stable' : usedFallback ? 'no wait condition; output stable' : 'output stable'
            return res.json(responder({ matched: true, reason: 'stable' }, message))
          }
        } else {
          lastText = text
          stableSince = Date.now()
        }
      }
      if (Date.now() - start >= timeoutMs) return res.json(approx({ matched: false }, 'timeout'))
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  })

  router.post('/screenshots', async (req, res) => {
    const rawScope = req.body?.scope
    const nameRaw = req.body?.name
    const pathInput = typeof req.body?.path === 'string' ? req.body.path : undefined
    const overwrite = truthy(req.body?.overwrite)
    const paneId = typeof req.body?.paneId === 'string' ? req.body.paneId : undefined
    const tabId = typeof req.body?.tabId === 'string' ? req.body.tabId : undefined

    if (rawScope !== 'pane' && rawScope !== 'tab' && rawScope !== 'view') {
      return res.status(400).json(fail('scope must be pane, tab, or view'))
    }

    const scope: 'pane' | 'tab' | 'view' = rawScope

    if (scope === 'pane' && !paneId) {
      return res.status(400).json(fail('paneId required for pane scope'))
    }

    if (scope === 'tab' && !tabId) {
      return res.status(400).json(fail('tabId required for tab scope'))
    }

    if (!wsHandler?.requestUiScreenshot) {
      return res.status(503).json(fail('ui screenshot channel unavailable'))
    }

    let outputPath: string
    try {
      outputPath = await resolveScreenshotOutputPath({
        name: String(nameRaw || ''),
        pathInput,
      })
    } catch (err: any) {
      return res.status(400).json(fail(err?.message || 'invalid screenshot options'))
    }

    try {
      if (!overwrite) {
        try {
          await fs.access(outputPath)
          return res.status(409).json(fail('output file already exists (use --overwrite)'))
        } catch {
          // File does not exist, continue.
        }
      }

      const ui = await wsHandler.requestUiScreenshot({ scope, tabId, paneId })
      if (!ui?.ok || !ui?.imageBase64) {
        return res.status(422).json(fail(ui?.error || 'ui screenshot failed'))
      }

      await writeFileAtomic(outputPath, Buffer.from(ui.imageBase64, 'base64'))

      return res.json(
        ok(
          {
            path: outputPath,
            scope,
            tabId,
            paneId,
            width: ui.width,
            height: ui.height,
            changedFocus: !!ui.changedFocus,
            restoredFocus: !!ui.restoredFocus,
            timestamp: Date.now(),
          },
          'screenshot saved',
        ),
      )
    } catch (err: any) {
      const code = (err as { code?: string })?.code
      if (code === 'NO_SCREENSHOT_CLIENT') {
        return res.status(503).json(fail(err?.message || 'No screenshot-capable UI client connected'))
      }
      if (code === 'SCREENSHOT_TIMEOUT') {
        return res.status(504).json(fail(err?.message || 'Timed out waiting for UI screenshot response'))
      }
      if (code === 'SCREENSHOT_CONNECTION_CLOSED') {
        return res.status(503).json(fail(err?.message || 'UI connection closed before screenshot response'))
      }
      return res.status(500).json(fail(err?.message || 'failed to capture screenshot'))
    }
  })

  router.post('/run', async (req, res) => {
    const payload = req.body || {}
    const command = payload.command || payload.cmd
    if (!command) return res.status(400).json(fail('command required'))

    const title = payload.name || payload.title
    const mode = payload.mode || 'shell'
    const shell = payload.shell
    const cwd = payload.cwd
    const capture = truthy(payload.capture)
    const detached = truthy(payload.detached) || truthy(payload.detach) || truthy(payload.background)
    const rawTimeout = payload.timeout || payload.T
    const timeoutSeconds = typeof rawTimeout === 'number' ? rawTimeout : Number(rawTimeout)
    const timeoutMs = Number.isFinite(timeoutSeconds) ? timeoutSeconds * 1000 : 30000
    let launch: ResolvedSpawnProviderSettings | undefined
    let createdTerminalId: string | undefined
    let createdTabId: string | undefined
    try {
      assertTerminalAdmission()
      launch = await resolveSpawnProviderSettings(mode, configStore, {}, {
        cwd,
        codexLaunchPlanner,
        assertTerminalCreateAccepted: assertTerminalAdmission,
      })
      assertTerminalAdmission()
      const created = layoutStore.createTab?.({ title })
      const tabId = created?.tabId || nanoid()
      const paneId = created?.paneId || nanoid()
      createdTabId = created?.tabId
      const sessionBindingReason = getCodexSessionBindingReason(mode)
      assertTerminalAdmission()
      const terminal = registry.create({
        mode,
        shell,
        cwd,
        resumeSessionId: launch.resumeSessionId,
        ...(sessionBindingReason ? { sessionBindingReason } : {}),
        providerSettings: launch.providerSettings,
        envContext: { tabId, paneId },
      })
      createdTerminalId = terminal.terminalId
      assertTerminalAdmission()
      await adoptCodexLaunch(launch, terminal.terminalId)
      assertTerminalAdmission()
      publishCodexLaunch(registry, launch, terminal.terminalId)
      launch = undefined
      layoutStore.attachPaneContent?.(tabId, paneId, { kind: 'terminal', terminalId: terminal.terminalId })
      wsHandler?.broadcastUiCommand({
        command: 'tab.create',
        payload: { id: tabId, title, mode, shell, terminalId: terminal.terminalId, initialCwd: cwd },
      })

      const sentinel = `__FRESHELL_DONE_${nanoid()}__`
      const input = capture ? `${command}; echo ${sentinel}\r` : `${command}\r`
      const inputResult = await sendTerminalInput(registry, terminal.terminalId, input, {
        waitForCodexIdentity: mode === 'codex',
      })
      if (inputResult.status !== 'written') {
        throw new Error(terminalInputFailureMessage(inputResult))
      }

      if (!capture || detached) {
        const message = detached ? 'command started (detached)' : 'command sent'
        createdTerminalId = undefined
        return res.json(ok({ terminalId: terminal.terminalId, tabId, paneId }, message))
      }

      const escaped = sentinel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const result = await waitForMatch(
        () => renderCapture(registry.get(terminal.terminalId)?.buffer.snapshot() || '', { includeAnsi: false }),
        new RegExp(escaped),
        { timeoutMs },
      )
      const rawOutput = renderCapture(registry.get(terminal.terminalId)?.buffer.snapshot() || '', { includeAnsi: false })
      const output = rawOutput.split(sentinel).join('').trim()
      const responder = result.matched ? ok : approx
      const message = result.matched ? 'run complete' : 'timeout waiting for command'
      createdTerminalId = undefined
      return res.json(responder({ terminalId: terminal.terminalId, tabId, paneId, output }, message))
    } catch (err: any) {
      let responseError = err
      await cleanupFailedCodexCreate(registry, createdTerminalId ?? terminalIdFromCreateError(err), launch).catch((cleanupError) => {
        responseError = combineWithCleanupError(err, cleanupError)
      })
      if (createdTabId && typeof layoutStore.closeTab === 'function') {
        try {
          layoutStore.closeTab(createdTabId)
        } catch {
          // best-effort cleanup; terminal/sidecar cleanup errors above remain authoritative
        }
      }
      const status = agentRouteErrorStatus(responseError)
      return res.status(status).json(fail(responseError?.message || 'Failed to run command'))
    }
  })

  router.post('/panes/:id/split', async (req, res) => {
    let launch: ResolvedSpawnProviderSettings | undefined
    let createdTerminalId: string | undefined
    try {
      const rawPaneId = req.params.id
      const resolved = resolvePaneTarget(rawPaneId)
      if (rejectPaneTargetError(res, resolved)) return
      const paneId = resolved.paneId || rawPaneId
      if (typeof req.body?.agent === 'string') {
        const direction: 'horizontal' | 'vertical' = req.body?.direction || 'horizontal'
        let snapshotBefore: ReturnType<LayoutStore['getNormalizedSnapshot']> | undefined
        const handled = await createFreshAgentPane(
          res,
          () => {
            snapshotBefore = layoutStore.getNormalizedSnapshot()
            const result = layoutStore.splitPane({ paneId, direction })
            if (!result?.tabId || !result?.newPaneId) {
              snapshotBefore = undefined
              return undefined
            }
            return { tabId: result.tabId, paneId: result.newPaneId }
          },
          () => {
            if (snapshotBefore) {
              layoutStore.updateFromUi(snapshotBefore, 'fresh-agent-split-rollback')
            } else if (typeof layoutStore.closePane === 'function') {
              try { layoutStore.closePane(paneId) } catch { /* ignore */ }
            }
          },
          ({ tabId, paneId: newPaneId, paneContent }) => {
            wsHandler?.broadcastUiCommand({ command: 'pane.split', payload: { tabId, paneId, direction, newPaneId, newContent: paneContent } })
          },
          { agent: req.body.agent, cwd: req.body?.cwd, model: req.body?.model, effort: req.body?.effort },
        ).catch((err: any) => { res.status(agentRouteErrorStatus(err)).json(fail(err?.message || 'Failed to split fresh-agent pane')); return true })
        if (handled) return
      }
      const direction = req.body?.direction || 'horizontal'
      const wantsBrowser = !!req.body?.browser
      const wantsEditor = !!req.body?.editor
      const splitMode = !wantsBrowser && !wantsEditor ? req.body?.mode || 'shell' : undefined
      const requestedSessionRef = splitMode ? sanitizeSessionRef(req.body?.sessionRef) : undefined
      const acceptedSessionRef = splitMode
        ? acceptedSessionRefForMode(requestedSessionRef, splitMode)
        : undefined
      const requestedResumeSessionId = splitMode
        ? requestedResumeSessionIdForMode(
          requestedSessionRef,
          splitMode,
          req.body?.resumeSessionId,
        )
        : undefined
      if (!wantsBrowser && !wantsEditor) {
        assertTerminalAdmission()
      }

      const result = layoutStore.splitPane({
        paneId,
        direction,
        browser: wantsBrowser ? req.body?.browser : undefined,
        editor: wantsEditor ? req.body?.editor : undefined,
      })

      if (!result?.tabId || !result?.newPaneId) {
        res.json(approx(result, 'pane split requested; not applied'))
        return
      }

      const tabId = result.tabId
      const newPaneId = result.newPaneId

      let content: any
      let terminalId: string | undefined
      if (wantsBrowser) {
        content = { kind: 'browser', url: req.body.browser, devToolsOpen: false }
      } else if (wantsEditor) {
        content = { kind: 'editor', filePath: req.body.editor, language: null, readOnly: false, content: '', viewMode: 'source', wordWrap: true }
      } else {
        const terminalMode = splitMode ?? 'shell'
        launch = await resolveSpawnProviderSettings(
          terminalMode,
          configStore,
          {},
          {
            cwd: req.body?.cwd,
            resumeSessionId: requestedResumeSessionId,
            codexLaunchPlanner,
            assertTerminalCreateAccepted: assertTerminalAdmission,
          },
        )
        assertTerminalAdmission()
        const sessionBindingReason = getCodexSessionBindingReason(terminalMode, requestedResumeSessionId)
        assertTerminalAdmission()
        const terminal = registry.create({
          mode: terminalMode,
          shell: req.body?.shell,
          cwd: req.body?.cwd,
          resumeSessionId: launch.resumeSessionId,
          ...(sessionBindingReason ? { sessionBindingReason } : {}),
          providerSettings: launch.providerSettings,
          envContext: { tabId, paneId: newPaneId },
        })
        createdTerminalId = terminal.terminalId
        const launchResumeSessionId = launch.resumeSessionId
        assertTerminalAdmission()
        await adoptCodexLaunch(launch, terminal.terminalId)
        assertCodexCreateTerminalRunning(terminal)
        assertTerminalAdmission()
        publishCodexLaunch(registry, launch, terminal.terminalId)
        launch = undefined
        terminalId = terminal.terminalId
        content = {
          kind: 'terminal',
          terminalId,
          status: 'running',
          mode: req.body?.mode || 'shell',
          shell: req.body?.shell || 'system',
          ...(acceptedSessionRef ? { sessionRef: acceptedSessionRef } : {}),
          ...(launchResumeSessionId && !acceptedSessionRef ? { resumeSessionId: launchResumeSessionId } : {}),
        }
      }

      layoutStore.attachPaneContent(tabId, newPaneId, content)

      wsHandler?.broadcastUiCommand({
        command: 'pane.split',
        payload: {
          tabId,
          paneId,
          direction,
          newPaneId,
          newContent: content,
        },
      })

      const message = wantsBrowser || wantsEditor ? 'pane split (non-terminal)' : 'pane split'
      createdTerminalId = undefined
      res.json(ok({ paneId: newPaneId, terminalId }, message))
    } catch (err: any) {
      let responseError = err
      await cleanupFailedCodexCreate(registry, createdTerminalId ?? terminalIdFromCreateError(err), launch).catch((cleanupError) => {
        responseError = combineWithCleanupError(err, cleanupError)
      })
      res.status(agentRouteErrorStatus(responseError)).json(fail(responseError?.message || 'Failed to split pane'))
    }
  })

  router.patch('/panes/:id', async (req, res) => {
    try {
      const name = parseRequiredName(req.body?.name)
      if (!name) return res.status(400).json(fail('name required'))
      if (name.length > MAX_TERMINAL_TITLE_OVERRIDE_LENGTH) {
        return res.status(400).json(fail(`name must be ${MAX_TERMINAL_TITLE_OVERRIDE_LENGTH} characters or fewer`))
      }

      const resolved = resolvePaneTarget(req.params.id)
      if (rejectPaneTargetError(res, resolved)) return
      const paneId = resolved.paneId || req.params.id
      const paneSnapshot = layoutStore.getPaneSnapshot?.(paneId)
      const result = layoutStore.renamePane(paneId, name)
      let responseData = result

      if (result?.tabId) {
        await persistSyncableTerminalRename(paneSnapshot, name)

        const tabRenamed = (layoutStore.listPanes?.(result.tabId) || []).length === 1
        responseData = { ...result, tabRenamed }

        wsHandler?.broadcastUiCommand({
          command: 'pane.rename',
          payload: { tabId: result.tabId, paneId: result.paneId || paneId, title: name },
        })
      }

      res.json(ok(responseData, resolved.message || result?.message || 'pane renamed'))
    } catch (err: any) {
      res.status(500).json(fail(err?.message || 'Failed to rename pane'))
    }
  })

  router.post('/panes/:id/close', (req, res) => {
    const rawPaneId = req.params.id
    const resolved = resolvePaneTarget(rawPaneId)
    if (rejectPaneTargetError(res, resolved)) return
    const paneId = resolved.paneId || rawPaneId
    const result = layoutStore.closePane(paneId)
    wsHandler?.broadcastUiCommand({ command: 'pane.close', payload: { tabId: result?.tabId, paneId } })
    res.json(ok(result, resolved.message || result?.message || 'pane closed'))
  })

  router.post('/panes/:id/select', (req, res) => {
    const rawPaneId = req.params.id
    const resolved = resolvePaneTarget(rawPaneId)
    if (rejectPaneTargetError(res, resolved)) return
    const paneId = resolved.paneId || rawPaneId
    const tabId = req.body?.tabId || resolved.tabId
    const result = layoutStore.selectPane(tabId, paneId)
    if (result?.tabId) {
      wsHandler?.broadcastUiCommand({ command: 'pane.select', payload: { tabId: result.tabId, paneId } })
    }
    res.json(ok(result, resolved.message || result?.message || 'pane selected'))
  })

  router.post('/panes/:id/resize', (req, res) => {
    const rawTarget = req.params.id
    const resolved = resolveResizeTarget(layoutStore as ResizeLayoutStore, rawTarget, req.body?.tabId)
    if (isAmbiguousTargetMessage(resolved.message) && rejectPaneTargetError(res, { message: resolved.message })) {
      return
    }
    if (resolved.message === 'split not found') {
      return res.json(ok({ message: 'split not found' }, 'split not found'))
    }

    const current = layoutStore.getSplitSizes?.(resolved.tabId, resolved.splitId)
    const body = req.body || {}
    const explicitX = parseOptionalNumber(body.x)
    const explicitY = parseOptionalNumber(body.y)
    const hasExplicitTuple = Array.isArray(body.sizes)

    if (hasExplicitTuple && body.sizes.length !== 2) {
      return res.status(400).json(fail('sizes must contain exactly two values'))
    }

    const explicitTuple = hasExplicitTuple
      ? [parseOptionalNumber(body.sizes[0]), parseOptionalNumber(body.sizes[1])] as const
      : undefined

    if (hasExplicitTuple && (explicitTuple?.[0] === undefined || explicitTuple?.[1] === undefined)) {
      return res.status(400).json(fail('sizes values must be numeric'))
    }
    if (hasExplicitTuple && (!isValidPercent(explicitTuple![0] as number) || !isValidPercent(explicitTuple![1] as number))) {
      return res.status(400).json(fail('sizes values must be within 1..99'))
    }

    const hasX = Object.prototype.hasOwnProperty.call(body, 'x')
    const hasY = Object.prototype.hasOwnProperty.call(body, 'y')

    if (hasX && explicitX === undefined) {
      return res.status(400).json(fail('x must be numeric'))
    }
    if (hasY && explicitY === undefined) {
      return res.status(400).json(fail('y must be numeric'))
    }
    if (explicitX !== undefined && !isValidPercent(explicitX)) {
      return res.status(400).json(fail('x must be within 1..99'))
    }
    if (explicitY !== undefined && !isValidPercent(explicitY)) {
      return res.status(400).json(fail('y must be within 1..99'))
    }

    const boundedX = explicitX === undefined ? undefined : clampPercent(explicitX)
    const boundedY = explicitY === undefined ? undefined : clampPercent(explicitY)

    const normalizedSizes: [number, number] = hasExplicitTuple
      ? normalizePairToHundred(
          explicitTuple?.[0] ?? current?.[0] ?? 50,
          explicitTuple?.[1] ?? current?.[1] ?? 50,
        )
      : boundedX !== undefined && boundedY !== undefined
        ? normalizePairToHundred(boundedX, boundedY)
        : boundedX !== undefined
          ? normalizePairToHundred(boundedX, 100 - boundedX)
          : boundedY !== undefined
            ? normalizePairToHundred(100 - boundedY, boundedY)
            : normalizePairToHundred(current?.[0] ?? 50, current?.[1] ?? 50)

    const result = layoutStore.resizePane(resolved.tabId, resolved.splitId, normalizedSizes)
    const message = resolved.message || result?.message
    if (result?.tabId) {
      wsHandler?.broadcastUiCommand({
        command: 'pane.resize',
        payload: { tabId: result.tabId, splitId: resolved.splitId, sizes: normalizedSizes },
      })
    }
    res.json(ok(result, message || result?.message || 'pane resized'))
  })

  router.post('/panes/:id/swap', (req, res) => {
    const rawPaneId = req.params.id
    const otherRaw = req.body?.target || req.body?.otherId
    if (!otherRaw) return res.json(approx(undefined, 'swap target missing'))

    const resolved = resolvePaneTarget(rawPaneId)
    if (rejectPaneTargetError(res, resolved)) return
    const paneId = resolved.paneId || rawPaneId
    const otherResolved = resolvePaneTarget(otherRaw)
    if (rejectPaneTargetError(res, otherResolved)) return
    const otherId = otherResolved.paneId || otherRaw
    if (!otherId) return res.json(approx(undefined, 'swap target missing'))
    const result = layoutStore.swapPane(req.body?.tabId, paneId, otherId)
    if (result?.tabId) {
      wsHandler?.broadcastUiCommand({ command: 'pane.swap', payload: { tabId: result.tabId, paneId, otherId } })
    }
    const message = resolved.message || otherResolved.message || result?.message || 'panes swapped'
    res.json(ok(result, message))
  })

  router.post('/panes/:id/respawn', async (req, res) => {
    let launch: ResolvedSpawnProviderSettings | undefined
    let createdTerminalId: string | undefined
    try {
      const resolved = resolvePaneTarget(req.params.id)
      if (rejectPaneTargetError(res, resolved)) return
      const paneId = resolved.paneId || req.params.id
      const target = resolved.tabId ? resolved : layoutStore.resolveTarget(paneId)
      const tabId = target?.tabId
      if (!tabId) return res.status(404).json(fail('pane not found'))
      const effectiveMode = req.body?.mode || 'shell'
      const requestedSessionRef = sanitizeSessionRef(req.body?.sessionRef)
      const acceptedSessionRef = acceptedSessionRefForMode(requestedSessionRef, effectiveMode)
      const requestedResumeSessionId = requestedResumeSessionIdForMode(
        requestedSessionRef,
        effectiveMode,
        req.body?.resumeSessionId,
      )
      assertTerminalAdmission()
      launch = await resolveSpawnProviderSettings(
        effectiveMode,
        configStore,
        {},
        {
          cwd: req.body?.cwd,
          resumeSessionId: requestedResumeSessionId,
          codexLaunchPlanner,
          assertTerminalCreateAccepted: assertTerminalAdmission,
        },
      )
      assertTerminalAdmission()
      const sessionBindingReason = getCodexSessionBindingReason(effectiveMode, requestedResumeSessionId)
      assertTerminalAdmission()
      const terminal = registry.create({
        mode: effectiveMode,
        shell: req.body?.shell,
        cwd: req.body?.cwd,
        resumeSessionId: launch.resumeSessionId,
        ...(sessionBindingReason ? { sessionBindingReason } : {}),
        providerSettings: launch.providerSettings,
        envContext: { tabId, paneId },
      })
      createdTerminalId = terminal.terminalId
      const launchResumeSessionId = launch.resumeSessionId
      assertTerminalAdmission()
      await adoptCodexLaunch(launch, terminal.terminalId)
      assertCodexCreateTerminalRunning(terminal)
      assertTerminalAdmission()
      publishCodexLaunch(registry, launch, terminal.terminalId)
      launch = undefined
      const content = {
        kind: 'terminal',
        terminalId: terminal.terminalId,
        status: 'running',
        mode: req.body?.mode || 'shell',
        shell: req.body?.shell || 'system',
        createRequestId: nanoid(),
        ...(acceptedSessionRef ? { sessionRef: acceptedSessionRef } : {}),
        ...(launchResumeSessionId && !acceptedSessionRef ? { resumeSessionId: launchResumeSessionId } : {}),
      }
      layoutStore.attachPaneContent(tabId, paneId, content)
      wsHandler?.broadcastUiCommand({ command: 'pane.attach', payload: { tabId, paneId, content } })
      createdTerminalId = undefined
      res.json(ok({ terminalId: terminal.terminalId }, 'pane respawned'))
    } catch (err: any) {
      let responseError = err
      await cleanupFailedCodexCreate(registry, createdTerminalId ?? terminalIdFromCreateError(err), launch).catch((cleanupError) => {
        responseError = combineWithCleanupError(err, cleanupError)
      })
      res.status(agentRouteErrorStatus(responseError)).json(fail(responseError?.message || 'Failed to respawn pane'))
    }
  })

  router.post('/panes/:id/attach', (req, res) => {
    const resolved = resolvePaneTarget(req.params.id)
    if (rejectPaneTargetError(res, resolved)) return
    const paneId = resolved.paneId || req.params.id
    const terminalId = req.body?.terminalId
    if (!terminalId) return res.status(400).json(fail('terminalId required'))
    const target = resolved.tabId ? resolved : layoutStore.resolveTarget(paneId)
    const tabId = target?.tabId
    if (!tabId) return res.status(404).json(fail('pane not found'))
    const attachedTerminal = registry.get?.(terminalId)
    const requestedSessionRef = sanitizeSessionRef(req.body?.sessionRef)
    const expectedSessionRef = expectedPaneSessionRefForTerminal(
      layoutStore,
      paneId,
      attachedTerminal?.mode ?? req.body?.mode,
      requestedSessionRef,
    )
    if (attachedTerminal && expectedSessionRef && !terminalMatchesExpectedSession(attachedTerminal, expectedSessionRef)) {
      const { actualSessionRef } = buildSessionIdentityMismatchDetails(attachedTerminal, expectedSessionRef)
      return res.status(409).json(fail(sessionIdentityMismatchMessage(expectedSessionRef, actualSessionRef)))
    }
    const content = {
      kind: 'terminal',
      terminalId,
      status: 'running',
      mode: req.body?.mode || attachedTerminal?.mode || 'shell',
      shell: req.body?.shell || attachedTerminal?.shell || 'system',
      createRequestId: nanoid(),
      ...(expectedSessionRef ? { sessionRef: expectedSessionRef } : {}),
    }
    layoutStore.attachPaneContent(tabId, paneId, content)
    wsHandler?.broadcastUiCommand({ command: 'pane.attach', payload: { tabId, paneId, content } })
    res.json(ok({ terminalId }, 'terminal attached'))
  })

  router.post('/panes/:id/navigate', (req, res) => {
    const resolved = resolvePaneTarget(req.params.id)
    if (rejectPaneTargetError(res, resolved)) return
    const paneId = resolved.paneId || req.params.id
    const url = req.body?.url || req.body?.target
    if (!url) return res.status(400).json(fail('url required'))
    const target = resolved.tabId ? resolved : layoutStore.resolveTarget(paneId)
    const tabId = target?.tabId
    if (!tabId) return res.status(404).json(fail('pane not found'))
    const content = { kind: 'browser', url, devToolsOpen: false }
    layoutStore.attachPaneContent(tabId, paneId, content)
    wsHandler?.broadcastUiCommand({ command: 'pane.attach', payload: { tabId, paneId, content } })
    res.json(ok(undefined, 'navigate requested'))
  })

  router.post('/panes/:id/send-keys', async (req, res) => {
    const resolved = resolvePaneTarget(req.params.id)
    if (rejectPaneTargetError(res, resolved)) return
    const paneId = resolved.paneId || req.params.id
    const faSnapshot = layoutStore.getPaneSnapshot?.(paneId)
    if (faSnapshot?.kind === 'fresh-agent') {
      const c = faSnapshot.paneContent || {}
      const text = String(req.body?.data ?? req.body?.keys ?? req.body?.text ?? '')
      if (!text) return res.status(400).json(fail('text is required'))
      if (!freshAgentRuntimeManager) return res.status(503).json(fail('fresh-agent runtime not available on this server'))
      const locator = { sessionId: c.sessionId as string, sessionType: c.sessionType as string, provider: c.provider as string } as FreshAgentSessionLocator
      const runSend = () => freshAgentRuntimeManager.send(locator, { text })
      const snapshotLocator = { sessionType: c.sessionType as string, provider: c.provider as string, threadId: c.sessionId as string }
      try {
        let result
        try {
          result = await runSend()
        } catch (err: any) {
          if (err?.name === 'FreshAgentLostSessionError' && freshAgentRuntimeManager.attach) {
            await freshAgentRuntimeManager.attach(locator)
            result = await runSend()
          } else {
            throw err
          }
        }

        // Block until the turn completes. OpenCode's send already awaits idle;
        // Claude/Codex return when the turn starts, so we poll until idle.
        const rawTimeout = req.body?.timeout
        const timeoutSec = typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) ? rawTimeout : (typeof rawTimeout === 'string' ? Number(rawTimeout) : Number.NaN)
        const deadline = Date.now() + (Number.isFinite(timeoutSec) ? timeoutSec * 1000 : FRESH_AGENT_SEND_IDLE_TIMEOUT_MS)
        const idle = await waitForFreshAgentIdle(freshAgentRuntimeManager, snapshotLocator, deadline)
        if (idle.deadlineMissed) {
          return res.json(approx({ paneId, sessionId: result?.sessionId ?? locator.sessionId, sessionRef: result?.sessionRef, status: idle.status }, 'prompt sent; turn did not complete within deadline'))
        }

        const finalSessionId = result?.sessionId ?? locator.sessionId
        const finalSessionRef = result?.sessionRef

        // Persist a materialized durable session back into the pane so reloads
        // don't fall back to fragile legacy resolution.
        if (finalSessionRef && finalSessionId !== locator.sessionId && faSnapshot.tabId) {
          const updatedContent = { ...c, sessionId: finalSessionId, sessionRef: finalSessionRef, resumeSessionId: finalSessionId }
          layoutStore.attachPaneContent(faSnapshot.tabId, paneId, updatedContent)
          wsHandler?.broadcast?.({
            type: 'freshAgent.session.materialized',
            tabId: faSnapshot.tabId,
            paneId,
            sessionType: c.sessionType,
            provider: c.provider,
            previousSessionId: locator.sessionId,
            sessionId: finalSessionId,
            sessionRef: finalSessionRef,
          })
        }

        return res.json(ok({ paneId, sessionId: finalSessionId, sessionRef: finalSessionRef, status: idle.status }, 'prompt sent'))
      } catch (err: any) {
        return res.status(agentRouteErrorStatus(err)).json(fail(err?.message || 'fresh-agent send failed'))
      }
    }
    const payload = req.body || {}
    const data = payload.data ?? payload.keys ?? payload.text ?? ''
    const paneSnapshot = layoutStore.getPaneSnapshot?.(paneId)
    let terminalId = paneSnapshot?.terminalId || layoutStore.resolvePaneToTerminal?.(paneId)
    if (!terminalId && layoutStore.resolveTarget) {
      const target = layoutStore.resolveTarget(paneId)
      if (target?.paneId) terminalId = layoutStore.resolvePaneToTerminal?.(target.paneId)
    }
    if (!terminalId) return res.status(404).json(fail('terminal not found'))
    const terminal = registry.get?.(terminalId)
    const requestedSessionRef = sanitizeSessionRef(payload.sessionRef)
    const expectedSessionRef = expectedPaneSessionRefForTerminal(
      layoutStore,
      paneId,
      terminal?.mode ?? paneSnapshot?.paneContent?.mode,
      requestedSessionRef,
    )
    const inputResult = await sendTerminalInput(registry, terminalId, data, {
      expectedSessionRef,
      waitForCodexIdentity: shouldWaitForCodexIdentity(payload),
    })
    if (inputResult.status !== 'written') {
      return res.status(409).json(fail(terminalInputFailureMessage(inputResult)))
    }
    res.json(ok({ terminalId }, 'input sent'))
  })

  return router
}
