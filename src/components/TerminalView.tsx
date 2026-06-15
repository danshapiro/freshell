import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
} from 'react'
import { shallowEqual } from 'react-redux'
import { useAppDispatch, useAppSelector, useAppStore } from '@/store/hooks'
import { updateTab, switchToNextTab, switchToPrevTab } from '@/store/tabsSlice'
import {
  consumePaneRefreshRequest,
  repairCodexIdentityMismatch,
  splitPane,
  updatePaneContent,
  updatePaneTitle,
} from '@/store/panesSlice'
import { updateSessionActivity } from '@/store/sessionActivitySlice'
import { recordPaneTabActivity } from '@/store/tabRecencySlice'
import { updateSettingsLocal } from '@/store/settingsSlice'
import { clearPaneRuntimeActivity } from '@/store/paneRuntimeActivitySlice'
import { recordTurnComplete } from '@/store/turnCompletionSlice'
import { dismissTabGreen } from '@/store/turnCompletionAttention'
import { focusNextTerminalSearchMatch, focusPreviousTerminalSearchMatch, loadTerminalSearch } from '@/store/terminalDirectoryThunks'
import { isFatalConnectionErrorCode } from '@/store/connectionSlice'
import { flushPersistedLayoutNow } from '@/store/persistControl'
import { getWsClient } from '@/lib/ws-client'
import { getTerminalTheme } from '@/lib/terminal-themes'
import {
  buildCodexIdentityMismatchRepairContent,
  buildTerminalAttachMessage,
  buildTerminalInputMessage,
  buildTerminalResizeMessage,
  getCreateSessionStateFromRef,
} from '@/components/terminal-view-utils'
import { reconcileTerminalSessionAssociation } from '@/lib/terminal-session-association'
import { copyText, readText } from '@/lib/clipboard'
import { registerTerminalActions } from '@/lib/pane-action-registry'
import { registerTerminalCaptureHandler } from '@/lib/screenshot-capture-env'
import {
  addTerminalFreshRecoveryRequestId,
  addTerminalRestoreRequestId,
  consumeTerminalFreshRecoveryRequest,
  consumeTerminalRestoreRequestId,
  type TerminalFreshRecoveryIntent,
} from '@/lib/terminal-restore'
import { isTerminalPasteShortcut } from '@/lib/terminal-input-policy'
import { terminalFollowsOscTitle } from '@/lib/terminal-title-policy'
import {
  clearTerminalCursor,
  loadTerminalSurfaceCheckpoint,
  saveTerminalSurfaceCheckpoint,
} from '@/lib/terminal-cursor'
import {
  canUseCheckpointForDeltaReplay,
  type TerminalGeometryAuthority,
} from '@/lib/terminal-surface-checkpoint'
import {
  resolveRevealAttachPlan,
  type DeferredAttachReason,
  type TerminalAttachPriority,
} from '@/lib/terminal-attach-policy'
import { paneRefreshTargetMatchesContent } from '@/lib/pane-utils'
import { getInstalledPerfAuditBridge } from '@/lib/perf-audit-bridge'
import {
  beginAttach,
  createAttachSeqState,
  markOutputRangeUnapplied,
  markParserAppliedSeq,
  onAttachReady,
  onOutputBatchSegments,
  onOutputFrame,
  onOutputGap,
  type AttachSeqState,
  type OutputBatchAcceptedSegment,
} from '@/lib/terminal-attach-seq-state'
import { useMobile } from '@/hooks/useMobile'
import { useKeyboardInset } from '@/hooks/useKeyboardInset'
import { useEnsureExtensionsRegistry } from '@/hooks/useEnsureExtensionsRegistry'
import { findLocalFilePaths } from '@/lib/path-utils'
import { findUrls } from '@/lib/url-utils'
import { setHoveredUrl, clearHoveredUrl } from '@/lib/terminal-hovered-url'
import { getTabSwitchShortcutDirection, getTabLifecycleAction } from '@/lib/tab-switch-shortcuts'
import { bucketTabRecencyAt } from '@/lib/tab-recency'
import {
  createTurnCompleteSignalParserState,
  extractTurnCompleteSignals,
} from '@/lib/turn-complete-signal'
import {
  createOsc52ParserState,
  extractOsc52Events,
  shouldAllowOsc52ClipboardWrite,
  shouldAllowOsc52Prompt,
  type Osc52Event,
  type Osc52Policy,
} from '@/lib/terminal-osc52'
import {
  beginTerminalOutputWriteScope,
  getTerminalOutputWriteScope,
  shouldAllowTerminalOutputSideEffect,
  type TerminalOutputSource,
} from '@/lib/terminal-output-write-scope'
import {
  createTerminalStartupProbeState,
  extractTerminalStartupProbes,
  getTerminalStartupProbeReplayBoundary,
  type TerminalStartupProbeState,
} from '@/lib/terminal-startup-probes'
import { ContextIds } from '@/components/context-menu/context-menu-constants'
import { resolveTerminalFontFamily } from '@/lib/terminal-fonts'
import { ConnectionErrorOverlay } from '@/components/terminal/ConnectionErrorOverlay'
import { Osc52PromptModal } from '@/components/terminal/Osc52PromptModal'
import { TerminalSearchBar } from '@/components/terminal/TerminalSearchBar'
import { registerTerminalRequestModeBypass } from '@/components/terminal/request-mode-bypass'
import {
  createTerminalRuntime,
  type TerminalRuntime,
} from '@/components/terminal/terminal-runtime'
import { createLayoutScheduler } from '@/components/terminal/layout-scheduler'
import {
  createTerminalWriteQueue,
  type TerminalWriteQueue,
  type TerminalWriteQueueOptions,
} from '@/components/terminal/terminal-write-queue'
import { nanoid } from 'nanoid'
import { cn } from '@/lib/utils'
import { Terminal } from '@xterm/xterm'
import { Loader2 } from 'lucide-react'
import { ConfirmModal } from '@/components/ui/confirm-modal'
import type { PaneContent, PaneContentInput, PaneRefreshRequest, TerminalPaneContent } from '@/store/paneTypes'
import '@xterm/xterm/css/xterm.css'
import { getHydrationQueue } from '@/lib/hydration-queue'
import { createLogger } from '@/lib/client-logger'
import {
  getProviderTerminalBehavior,
  prefersCanvasRenderer,
  providerUsesExtensionTerminalBehavior,
  scrollLinesToCursorKeys,
  shouldTranslateScrollToCursorKeys,
} from '@/lib/terminal-behavior'
import { buildRestoreError, sanitizeSessionRef } from '@shared/session-contract'

const log = createLogger('TerminalView')

const SESSION_ACTIVITY_THROTTLE_MS = 5000
const TERMINAL_CHECKPOINT_XTERM_VERSION = '6.0.0'
const QUARANTINE_REPAIR_POLL_MS = 16
const QUARANTINE_REPAIR_TIMEOUT_MS = 2000
export const RATE_LIMIT_RETRY_MAX_ATTEMPTS = 5
export const RATE_LIMIT_RETRY_BASE_MS = 2000
export const RATE_LIMIT_RETRY_MAX_MS = 12000
const MOBILE_KEYBAR_HEIGHT_PX = 40
const MOBILE_KEY_REPEAT_INITIAL_DELAY_MS = 320
const MOBILE_KEY_REPEAT_INTERVAL_MS = 70
const TAP_MULTI_INTERVAL_MS = 350
const TAP_MAX_DISTANCE_PX = 24
const TOUCH_SCROLL_PIXELS_PER_LINE = 18
const LIGHT_THEME_MIN_CONTRAST_RATIO = 4.5
const DEFAULT_MIN_CONTRAST_RATIO = 1
const MAX_LAST_SENT_VIEWPORT_CACHE_ENTRIES = 200
const TRUNCATED_REPLAY_BYTES = 128 * 1024
const INPUT_BLOCKED_NOTICE_THROTTLE_MS = 2000
const TERMINAL_OUTPUT_BATCH_BARRIER_REASONS = new Set([
  'control',
  'startup_probe',
  'osc52',
  'request_mode',
  'turn_complete',
  'gap',
  'geometry',
])

function viewportHydrateReplayOptions(content?: TerminalPaneContent | null): { maxReplayBytes: number } | undefined {
  return content?.mode === 'opencode'
    ? undefined
    : { maxReplayBytes: TRUNCATED_REPLAY_BYTES }
}

function buildSessionAssociationContentUpdates(
  content: TerminalPaneContent | null | undefined,
  rawSessionRef: unknown,
): Pick<TerminalPaneContent, 'sessionRef' | 'resumeSessionId' | 'codexDurability'> | undefined {
  const sessionRef = sanitizeSessionRef(rawSessionRef)
  if (!content || !sessionRef) return undefined

  const codexDurability = sessionRef.provider === 'codex'
    && content.codexDurability?.state === 'durable'
    && (
      content.codexDurability.durableThreadId === sessionRef.sessionId
      || content.codexDurability.candidate?.candidateThreadId === sessionRef.sessionId
    )
    ? content.codexDurability
    : undefined

  return {
    sessionRef,
    resumeSessionId: undefined,
    codexDurability,
  }
}

function sessionRefsEqual(
  left?: { provider?: string; sessionId?: string },
  right?: { provider?: string; sessionId?: string },
): boolean {
  return left?.provider === right?.provider && left?.sessionId === right?.sessionId
}

type TerminalInputBlockedReason =
  | 'codex_identity_pending'
  | 'codex_identity_capture_timeout'
  | 'codex_identity_unavailable'
  | 'codex_recovery_pending'
  | 'codex_clean_exit_decision_pending'
  | 'codex_lifecycle_loss_pending'

function terminalInputBlockedNotice(reason: TerminalInputBlockedReason): string {
  switch (reason) {
    case 'codex_identity_pending':
      return 'Input not sent: Codex is still saving restore state. Try again in a moment.'
    case 'codex_recovery_pending':
      return 'Input not sent: Codex is still reconnecting. Try again in a moment.'
    case 'codex_clean_exit_decision_pending':
      return 'Input not sent: Codex is checking whether the session is still active. Try again in a moment.'
    case 'codex_lifecycle_loss_pending':
      return 'Input not sent: Codex is resolving a worker disconnect. Try again in a moment.'
    case 'codex_identity_capture_timeout':
      return 'Input not sent: Codex did not provide restore state before startup timed out. Start a new Codex pane or resume inside Codex.'
    case 'codex_identity_unavailable':
      return 'Input not sent: Codex did not provide restorable session state. Start a new Codex pane or resume inside Codex.'
  }
}

type StartupProbeReplayDiscardState = {
  remainder: string | null
  buffered: string
  resumeState: TerminalStartupProbeState | null
}

type TerminalOutputSubmission = {
  submittedWrite: boolean
  submittedBytesEqualInput: boolean
}

function resolveMinimumContrastRatio(theme?: { isDark?: boolean } | null): number {
  return theme?.isDark === false ? LIGHT_THEME_MIN_CONTRAST_RATIO : DEFAULT_MIN_CONTRAST_RATIO
}

function isUtf16SurrogateSplitOffset(data: string, offset: number): boolean {
  if (offset <= 0 || offset >= data.length) return false
  const previous = data.charCodeAt(offset - 1)
  const next = data.charCodeAt(offset)
  return previous >= 0xD800
    && previous <= 0xDBFF
    && next >= 0xDC00
    && next <= 0xDFFF
}

function consumeStartupProbeReplayDiscard(
  raw: string,
  state: StartupProbeReplayDiscardState,
): {
  raw: string
  resumeState: TerminalStartupProbeState | null
} {
  const remainder = state.remainder
  if (!remainder) {
    state.buffered = ''
    return { raw, resumeState: null }
  }

  let matched = state.buffered
  let index = 0
  while (
    index < raw.length
    && matched.length < remainder.length
    && raw[index] === remainder[matched.length]
  ) {
    matched += raw[index]
    index += 1
  }

  if (matched.length === remainder.length) {
    const resumeState = state.resumeState
    state.remainder = null
    state.buffered = ''
    state.resumeState = null
    return { raw: raw.slice(index), resumeState }
  }

  if (index < raw.length) {
    state.remainder = null
    state.buffered = ''
    state.resumeState = null
    return { raw: `${matched}${raw.slice(index)}`, resumeState: null }
  }

  if (index === raw.length) {
    state.buffered = matched
    return { raw: '', resumeState: null }
  }

  return { raw, resumeState: null }
}

function deferTerminalPointerMutation(callback: () => void): void {
  // xterm link activation runs inside element-level mouse handlers while it may
  // still have document-level mouseup/move listeners in flight. Reparenting the
  // terminal synchronously can dispose the renderer before those listeners finish.
  queueMicrotask(callback)
}

function createNoopRuntime(): TerminalRuntime {
  return {
    attachAddons: () => {},
    fit: () => {},
    findNext: () => false,
    findPrevious: () => false,
    clearDecorations: () => {},
    onDidChangeResults: () => ({ dispose: () => {} }),
    dispose: () => {},
    webglActive: () => false,
    suspendWebgl: () => false,
    resumeWebgl: () => {},
  }
}

interface TerminalViewProps {
  tabId: string
  paneId: string
  paneContent: PaneContent
  hidden?: boolean
}

type AttachIntent = 'viewport_hydrate' | 'keepalive_delta' | 'transport_reconnect'

type DeferredAttachState = {
  mode: 'none' | 'waiting_for_geometry' | 'attaching' | 'live'
  pendingIntent: AttachIntent | null
  pendingSinceSeq: number
  pendingReason: DeferredAttachReason
}

type LaunchAttemptState = {
  requestId: string
  terminalId?: string
  restore: boolean
  recoveryIntent?: TerminalFreshRecoveryIntent
  attachReady: boolean
}

type PendingDurableReplacement = {
  terminalId: string
  requestId: string
  reason: 'opencode_replay_window_exceeded'
}

type AttachTerminalOptions = {
  clearViewportFirst?: boolean
  suppressNextMatchingResize?: boolean
  skipPreAttachFit?: boolean
  maxReplayBytes?: number
  priority?: TerminalAttachPriority
  sinceSeq?: number
}

type SentViewport = {
  terminalId: string
  cols: number
  rows: number
}

function parseTerminalGeometryAuthority(value: unknown): TerminalGeometryAuthority | null {
  return value === 'single_client' || value === 'server_stream' || value === 'multi_client_unknown'
    ? value
    : null
}

function normalizeGeometryEpoch(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value))
  }
  return Math.max(0, Math.floor(Number.isFinite(fallback) ? fallback : 1))
}

const lastSentViewportByTerminal = new Map<string, { cols: number; rows: number }>()

function rememberSentViewport(terminalId: string, cols: number, rows: number): void {
  if (lastSentViewportByTerminal.has(terminalId)) {
    lastSentViewportByTerminal.delete(terminalId)
  }
  lastSentViewportByTerminal.set(terminalId, { cols, rows })
  if (lastSentViewportByTerminal.size > MAX_LAST_SENT_VIEWPORT_CACHE_ENTRIES) {
    const oldestTerminalId = lastSentViewportByTerminal.keys().next().value
    if (typeof oldestTerminalId === 'string') {
      lastSentViewportByTerminal.delete(oldestTerminalId)
    }
  }
}

function forgetSentViewport(terminalId?: string): void {
  if (!terminalId) return
  lastSentViewportByTerminal.delete(terminalId)
}

export function __resetLastSentViewportCacheForTests(): void {
  lastSentViewportByTerminal.clear()
}

export function __getLastSentViewportCacheSizeForTests(): number {
  return lastSentViewportByTerminal.size
}

type MobileToolbarKeyId = 'esc' | 'tab' | 'ctrl' | 'up' | 'down' | 'left' | 'right'
type RepeatableMobileToolbarKeyId = Extract<MobileToolbarKeyId, 'up' | 'down' | 'left' | 'right'>

const MOBILE_TOOLBAR_KEYS: Array<{ id: MobileToolbarKeyId; label: string; ariaLabel: string; isArrow?: boolean }> = [
  { id: 'esc', label: 'Esc', ariaLabel: 'Esc key' },
  { id: 'tab', label: 'Tab', ariaLabel: 'Tab key' },
  { id: 'ctrl', label: 'Ctrl', ariaLabel: 'Toggle Ctrl modifier' },
  { id: 'up', label: '↑', ariaLabel: 'Up key', isArrow: true },
  { id: 'down', label: '↓', ariaLabel: 'Down key', isArrow: true },
  { id: 'left', label: '←', ariaLabel: 'Left key', isArrow: true },
  { id: 'right', label: '→', ariaLabel: 'Right key', isArrow: true },
]

function isRepeatableMobileToolbarKey(keyId: MobileToolbarKeyId): keyId is RepeatableMobileToolbarKeyId {
  return keyId === 'up' || keyId === 'down' || keyId === 'left' || keyId === 'right'
}

function resolveMobileToolbarInput(keyId: Exclude<MobileToolbarKeyId, 'ctrl'>, ctrlActive: boolean): string {
  if (ctrlActive) {
    if (keyId === 'up') return '\u001b[1;5A'
    if (keyId === 'down') return '\u001b[1;5B'
    if (keyId === 'right') return '\u001b[1;5C'
    if (keyId === 'left') return '\u001b[1;5D'
    // Ctrl+Esc and Ctrl+Tab do not have canonical terminal sequences; send plain key input.
  }

  if (keyId === 'esc') return '\u001b'
  if (keyId === 'tab') return '\t'
  if (keyId === 'up') return '\u001b[A'
  if (keyId === 'down') return '\u001b[B'
  if (keyId === 'right') return '\u001b[C'
  if (keyId === 'left') return '\u001b[D'
  const unreachableKey: never = keyId
  throw new Error(`Unsupported mobile toolbar key: ${unreachableKey}`)
}

// Real user engagement = a printable character or Enter, NOT a bare navigation /
// escape sequence. Strips recognized ANSI escapes first so an arrow key (ESC [ A,
// which contains the printable bytes "[A") does not count as engagement.
export function isEngagementInput(data: string): boolean {
  /* eslint-disable no-control-regex -- intentionally matching ANSI/control bytes */
  const stripped = data
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI ... final (incl. bracketed-paste markers)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC ... BEL/ST
    .replace(/\x1bO[@-~]/g, '') // SS3 application cursor / function keys
    .replace(/\x1b[@-Z\\-_]/g, '') // other 2-byte escapes
  return /[^\x00-\x1f\x7f]/.test(stripped) || /[\r\n]/.test(stripped)
  /* eslint-enable no-control-regex */
}

function TerminalView({ tabId, paneId, paneContent, hidden }: TerminalViewProps) {
  const dispatch = useAppDispatch()
  const appStore = useAppStore()
  const isMobile = useMobile()
  const connectionStatus = useAppSelector((s) => s.connection.status)
  const serverInstanceId = useAppSelector((s) => s.connection.serverInstanceId)
  const tab = useAppSelector((s) => s.tabs.tabs.find((t) => t.id === tabId))
  const tabHasSinglePane = useAppSelector((s) => s.panes.layouts[tabId]?.type === 'leaf')
  const activeTabId = useAppSelector((s) => s.tabs.activeTabId)
  const tabOrder = useAppSelector((s) => s.tabs.tabs.map((t) => t.id), shallowEqual)
  const activePaneId = useAppSelector((s) => s.panes.activePane[tabId])
  const paneLastInputAt = useAppSelector((s) => s.tabRecency?.paneLastInputAt?.[paneId])
  const refreshRequest = useAppSelector((s) => s.panes.refreshRequestsByPane?.[tabId]?.[paneId] ?? null)
  const connectionErrorCode = useAppSelector((s) => s.connection.lastErrorCode)
  const settings = useAppSelector((s) => s.settings.settings)

  // All hooks MUST be called before any conditional returns
  const ws = useMemo(() => getWsClient(), [])
  // Playwright can opt a pane into state-only mode so activity chrome tests
  // don't race the live terminal create/attach lifecycle.
  const suppressNetworkEffects = typeof window !== 'undefined'
    && window.__FRESHELL_TEST_HARNESS__?.isTerminalNetworkEffectsSuppressed?.(paneId) === true
  const [isAttaching, setIsAttaching] = useState(false)
  const [truncatedHistoryGap, setTruncatedHistoryGap] = useState<{ fromSeq: number; toSeq: number } | null>(null)
  const [backgroundHydrationTriggered, setBackgroundHydrationTriggered] = useState(false)
  const wasCreatedFreshRef = useRef(paneContent.kind === 'terminal' && paneContent.status === 'creating')
  const [pendingLinkUri, setPendingLinkUri] = useState<string | null>(null)
  const [pendingOsc52Event, setPendingOsc52Event] = useState<Osc52Event | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const keyboardInsetPx = useKeyboardInset()
  const [mobileCtrlActive, setMobileCtrlActive] = useState(false)
  const setPendingLinkUriRef = useRef(setPendingLinkUri)
  const mobileCtrlActiveRef = useRef(false)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const terminalInstanceIdRef = useRef(`terminal-surface:${nanoid()}`)
  const runtimeRef = useRef<TerminalRuntime | null>(null)
  const writeQueueRef = useRef<TerminalWriteQueue | null>(null)
  const layoutSchedulerRef = useRef<ReturnType<typeof createLayoutScheduler> | null>(null)
  const pendingLayoutWorkRef = useRef({
    fit: false,
    resize: false,
    scrollToBottom: false,
    focus: false,
  })
  const mountedRef = useRef(false)
  const hiddenRef = useRef(hidden)
  const hydrationRegisteredRef = useRef(false)
  const lastSessionActivityAtRef = useRef(0)
  const paneLastInputAtRef = useRef<number | undefined>(paneLastInputAt)
  const rateLimitRetryRef = useRef<{ count: number; timer: ReturnType<typeof setTimeout> | null }>({ count: 0, timer: null })
  const restoreRequestIdRef = useRef<string | null>(null)
  const restoreFlagRef = useRef(false)
  const freshRecoveryRequestIdRef = useRef<string | null>(null)
  const freshRecoveryIntentRef = useRef<TerminalFreshRecoveryIntent | undefined>(undefined)
  const turnCompleteSignalStateRef = useRef(createTurnCompleteSignalParserState())
  const startupProbeStateRef = useRef(createTerminalStartupProbeState())
  const startupProbeReplayDiscardStateRef = useRef<StartupProbeReplayDiscardState>({
    remainder: null,
    buffered: '',
    resumeState: null,
  })
  const osc52ParserRef = useRef(createOsc52ParserState())
  const settingsRef = useRef(settings)
  const resolvedThemeRef = useRef(getTerminalTheme(settings.terminal.theme, settings.theme))
  const osc52PolicyRef = useRef<Osc52Policy>(settings.terminal.osc52Clipboard)
  const pendingOsc52EventRef = useRef<Osc52Event | null>(null)
  const osc52QueueRef = useRef<Osc52Event[]>([])
  const warnExternalLinksRef = useRef(settings.terminal.warnExternalLinks)
  const debugRef = useRef(!!settings.logging?.debug)
  const touchActiveRef = useRef(false)
  const touchSelectionModeRef = useRef(false)
  const touchStartYRef = useRef(0)
  const touchLastYRef = useRef(0)
  const touchScrollAccumulatorRef = useRef(0)
  const touchStartXRef = useRef(0)
  const touchMovedRef = useRef(false)
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mobileKeyRepeatDelayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mobileKeyRepeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastTapAtRef = useRef(0)
  const lastTapPointRef = useRef<{ x: number; y: number } | null>(null)
  const tapCountRef = useRef(0)
  const terminalFirstOutputMarkedRef = useRef(false)
  const lastInputBlockedNoticeRef = useRef<{ reason: TerminalInputBlockedReason; at: number } | null>(null)

  // Extract terminal-specific fields (safe because we check kind later)
  const isTerminal = paneContent.kind === 'terminal'
  const terminalContent = isTerminal ? paneContent : null
  const extensions = useAppSelector((s) => s.extensions?.entries ?? [], shallowEqual)
  const shouldResolveProviderBehavior = isTerminal && providerUsesExtensionTerminalBehavior(terminalContent?.mode)
  const extensionRegistryReady = useEnsureExtensionsRegistry(shouldResolveProviderBehavior)
  const providerBehavior = useMemo(
    () => getProviderTerminalBehavior(terminalContent?.mode, extensions),
    [terminalContent?.mode, extensions],
  )
  const shouldWaitForProviderBehavior = shouldResolveProviderBehavior && !extensionRegistryReady
  const terminalSearchState = useAppSelector((state) => {
    const terminalId = terminalContent?.terminalId
    if (!terminalId) return null
    return (state as any).terminalDirectory?.searches?.[terminalId] ?? null
  }) as {
    query: string
    matches: Array<unknown>
    activeIndex?: number
    loading: boolean
  } | null

  // Refs for terminal lifecycle (only meaningful if isTerminal)
  // CRITICAL: Use refs to avoid callback/effect dependency on changing content
  const requestIdRef = useRef<string>(terminalContent?.createRequestId || '')
  const terminalIdRef = useRef<string | undefined>(terminalContent?.terminalId)
  const seqStateRef = useRef<AttachSeqState>(createAttachSeqState())
  const parserAppliedSeqRef = useRef(0)
  const surfaceEpochRef = useRef(0)
  const geometryEpochRef = useRef(1)
  const geometryAuthorityRef = useRef<TerminalGeometryAuthority>('single_client')
  const attachTerminalRef = useRef<((tid: string, intent: AttachIntent, opts?: AttachTerminalOptions) => void) | null>(null)
  const quarantineRepairRef = useRef<{
    terminalId: string
    attachRequestId: string
    queue: TerminalWriteQueue
    startedAt: number
    timedOut: boolean
    timer: ReturnType<typeof setTimeout> | null
  } | null>(null)
  const abandonedAttachRequestIdsRef = useRef(new Set<string>())
  const attachCounterRef = useRef(0)
  const currentAttachRef = useRef<{
    requestId: string
    intent: AttachIntent
    terminalId: string
    sinceSeq: number
    cols: number
    rows: number
    surfaceQuarantined: boolean
    streamId?: string | null
    expectedStreamId?: string | null
    geometryEpoch: number
    geometryAuthority: TerminalGeometryAuthority
    expectedGeometryEpoch: number
    expectedGeometryAuthority: TerminalGeometryAuthority
  } | null>(null)
  const launchAttemptRef = useRef<LaunchAttemptState | null>(null)
  const suppressNextMatchingResizeRef = useRef<{
    terminalId: string
    cols: number
    rows: number
  } | null>(null)
  const lastSentViewportRef = useRef<SentViewport | null>(null)
  const handledCreatedMessageRef = useRef<{
    requestId: string
    terminalId: string
  } | null>(null)
  const pendingDurableReplacementRef = useRef<PendingDurableReplacement | null>(null)
  const serverInstanceIdRef = useRef(serverInstanceId)
  const searchTerminalIdCleanupRef = useRef<string | null>(terminalContent?.terminalId ?? null)
  const deferredAttachStateRef = useRef<DeferredAttachState>({
    mode: 'none',
    pendingIntent: null,
    pendingSinceSeq: 0,
    pendingReason: 'initial_hydrate',
  })
  const contentRef = useRef<TerminalPaneContent | null>(terminalContent)
  const providerBehaviorRef = useRef(providerBehavior)
  const refreshRequestRef = useRef<PaneRefreshRequest | null>(refreshRequest)
  const handledRefreshRequestIdRef = useRef<string | null>(null)
  const hasMountedRefreshEffectRef = useRef(false)

  const applySeqState = useCallback((nextState: AttachSeqState) => {
    seqStateRef.current = nextState
  }, [])

  const getTerminalCheckpointStreamId = useCallback((): string | null => {
    const streamId = contentRef.current?.streamId
    return typeof streamId === 'string' && streamId.length > 0
      ? streamId
      : null
  }, [])

  const getTerminalCheckpointServerInstanceId = useCallback((): string | null => {
    const contentServerInstanceId = contentRef.current?.serverInstanceId
    if (typeof contentServerInstanceId === 'string' && contentServerInstanceId.length > 0) {
      return contentServerInstanceId
    }
    return typeof serverInstanceIdRef.current === 'string' && serverInstanceIdRef.current.length > 0
      ? serverInstanceIdRef.current
      : null
  }, [])

  const buildCheckpointReplayInput = useCallback((terminalId: string, dimensions?: { cols?: number; rows?: number }) => {
    const serverInstanceId = getTerminalCheckpointServerInstanceId()
    if (!terminalId || !serverInstanceId) return null
    const term = termRef.current
    const normalizeDimension = (value: number | undefined, fallback: number) => {
      const resolved = typeof value === 'number' && Number.isFinite(value) ? value : fallback
      return Math.max(2, Math.floor(resolved))
    }
    const normalizeScrollback = (value: number) => (
      Math.max(0, Math.floor(Number.isFinite(value) ? value : 0))
    )
    return {
      terminalId,
      streamId: getTerminalCheckpointStreamId(),
      serverInstanceId,
      surfaceEpoch: surfaceEpochRef.current,
      cols: normalizeDimension(dimensions?.cols, term?.cols ?? 80),
      rows: normalizeDimension(dimensions?.rows, term?.rows ?? 24),
      geometryEpoch: geometryEpochRef.current,
      geometryAuthority: geometryAuthorityRef.current,
      scrollback: normalizeScrollback(settingsRef.current.terminal.scrollback),
      xtermVersion: TERMINAL_CHECKPOINT_XTERM_VERSION,
      requireParserIdle: true,
    }
  }, [
    getTerminalCheckpointServerInstanceId,
    getTerminalCheckpointStreamId,
  ])

  const getCheckpointDeltaReplayDecision = useCallback((terminalId: string, dimensions?: { cols?: number; rows?: number }) => {
    const checkpointInput = buildCheckpointReplayInput(terminalId, dimensions)
    if (!checkpointInput) {
      return { ok: false as const, reason: 'missing_checkpoint' as const }
    }
    const checkpoint = loadTerminalSurfaceCheckpoint(terminalId, {
      streamId: checkpointInput.streamId,
      serverInstanceId: checkpointInput.serverInstanceId,
    })
    return canUseCheckpointForDeltaReplay(checkpoint, checkpointInput)
  }, [buildCheckpointReplayInput])

  const resetParserAppliedSurface = useCallback((seq = 0, opts?: { incrementEpoch?: boolean }) => {
    parserAppliedSeqRef.current = Math.max(0, Math.floor(Number.isFinite(seq) ? seq : 0))
    if (opts?.incrementEpoch !== false) {
      surfaceEpochRef.current += 1
    }
  }, [])

  const syncGeometryEpochForViewport = useCallback((terminalId: string, cols: number, rows: number) => {
    const lastSentViewport = lastSentViewportRef.current
    if (
      lastSentViewport
      && lastSentViewport.terminalId === terminalId
      && (lastSentViewport.cols !== cols || lastSentViewport.rows !== rows)
    ) {
      geometryEpochRef.current += 1
    }
  }, [])

  const clearQuarantineRepair = useCallback((attachRequestId?: string) => {
    const pending = quarantineRepairRef.current
    if (!pending) {
      if (attachRequestId) {
        abandonedAttachRequestIdsRef.current.delete(attachRequestId)
      }
      return
    }
    if (attachRequestId && pending.attachRequestId !== attachRequestId) return
    if (pending.timer) {
      clearTimeout(pending.timer)
    }
    abandonedAttachRequestIdsRef.current.delete(pending.attachRequestId)
    quarantineRepairRef.current = null
  }, [])

  const recordTerminalPerfAuditEvent = useCallback((event: string, data: Record<string, unknown> = {}) => {
    const payload = Object.fromEntries(Object.entries({
      event,
      timestamp: typeof performance !== 'undefined' ? performance.now() : Date.now(),
      tabId,
      paneId: paneIdRef.current,
      ...data,
    }).filter(([, value]) => value !== undefined))
    getInstalledPerfAuditBridge()?.addPerfEvent(payload)
  }, [tabId])

  const scheduleQuarantineRepair = useCallback((terminalId: string, attachRequestId: string) => {
    clearQuarantineRepair()
    const queue = writeQueueRef.current
    if (!queue) return
    const startedAt = Date.now()
    const poll = () => {
      const pending = quarantineRepairRef.current
      if (!pending || pending.attachRequestId !== attachRequestId) return
      const activeAttach = currentAttachRef.current
      if (
        !mountedRef.current
        || pending.terminalId !== terminalId
        || terminalIdRef.current !== terminalId
        || !activeAttach
        || activeAttach.terminalId !== terminalId
        || activeAttach.requestId !== attachRequestId
        || writeQueueRef.current !== pending.queue
      ) {
        clearQuarantineRepair(attachRequestId)
        return
      }
      if (!pending.queue.hasInFlightWrites()) {
        clearQuarantineRepair(attachRequestId)
        attachTerminalRef.current?.(terminalId, 'viewport_hydrate', {
          clearViewportFirst: true,
          ...viewportHydrateReplayOptions(contentRef.current),
        })
        return
      }
      if (!pending.timedOut && Date.now() - pending.startedAt >= QUARANTINE_REPAIR_TIMEOUT_MS) {
        log.warn('Terminal quarantine repair timed out while writes remained in flight', {
          paneId: paneIdRef.current,
          terminalId,
          attachRequestId,
        })
        abandonedAttachRequestIdsRef.current.add(attachRequestId)
        pending.timedOut = true
        pending.queue.setActiveGeneration(`${attachRequestId}:quarantine-timeout`, {
          dropQueuedStaleWrites: true,
        })
        recordTerminalPerfAuditEvent('terminal.catchup.surface_quarantine_timeout', {
          terminalId,
          attachRequestId,
          parserAppliedSeq: parserAppliedSeqRef.current,
          reason: 'in_flight_writes_timeout',
        })
      }
      pending.timer = setTimeout(poll, QUARANTINE_REPAIR_POLL_MS)
    }
    quarantineRepairRef.current = {
      terminalId,
      attachRequestId,
      queue,
      startedAt,
      timedOut: false,
      timer: setTimeout(poll, QUARANTINE_REPAIR_POLL_MS),
    }
  }, [clearQuarantineRepair, recordTerminalPerfAuditEvent])

  const markParserAppliedFrame = useCallback((terminalId: string | undefined, seq: number, attachContext?: {
    requestId: string
    terminalId: string
    cols: number
    rows: number
    surfaceQuarantined?: boolean
    streamId?: string | null
  }) => {
    if (!terminalId || !Number.isFinite(seq)) return
    const parserAppliedSeq = Math.max(0, Math.floor(seq))
    const attach = attachContext ?? currentAttachRef.current
    const surfaceQuarantined = attach?.surfaceQuarantined === true
    if (parserAppliedSeq <= parserAppliedSeqRef.current) {
      return
    }
    const previousParserAppliedSeq = parserAppliedSeqRef.current
    parserAppliedSeqRef.current = parserAppliedSeq
    recordTerminalPerfAuditEvent('terminal.parser_applied', {
      terminalId,
      attachRequestId: attach?.requestId,
      activeAttachRequestId: currentAttachRef.current?.requestId,
      streamId: attach?.streamId ?? getTerminalCheckpointStreamId(),
      parserAppliedSeq,
      previousParserAppliedSeq,
      surfaceEpoch: surfaceEpochRef.current,
      surfaceQuarantined,
    })

    if (surfaceQuarantined) return
    if (!attach || attach.terminalId !== terminalId) return
    if (typeof attach.streamId !== 'string' || attach.streamId.length === 0) return
    const checkpointInput = buildCheckpointReplayInput(terminalId, {
      cols: attach.cols,
      rows: attach.rows,
    })
    if (!checkpointInput) return

    saveTerminalSurfaceCheckpoint({
      terminalId: checkpointInput.terminalId,
      streamId: checkpointInput.streamId,
      serverInstanceId: checkpointInput.serverInstanceId,
      surfaceEpoch: checkpointInput.surfaceEpoch,
      attachRequestId: attach.requestId,
      parserAppliedSeq,
      cols: checkpointInput.cols,
      rows: checkpointInput.rows,
      geometryEpoch: checkpointInput.geometryEpoch,
      geometryAuthority: checkpointInput.geometryAuthority,
      scrollback: checkpointInput.scrollback,
      xtermVersion: checkpointInput.xtermVersion,
      // Task 3 cannot yet prove normal vs alternate buffer. Keep checkpoints conservative
      // until the geometry/buffer authority work supplies this context.
      bufferType: 'unknown',
      parserIdle: true,
    })
  }, [buildCheckpointReplayInput, getTerminalCheckpointStreamId, recordTerminalPerfAuditEvent])

  const writeLocalXtermNotice = useCallback((term: Terminal, data: string) => {
    const terminalInstanceId = terminalInstanceIdRef.current
    if (!shouldAllowTerminalOutputSideEffect({
      terminalInstanceId,
      source: 'live',
      effect: 'local_xterm_notice',
      mode: contentRef.current?.mode,
    })) {
      return
    }
    const invalidateAppliedSurface = () => {
      resetParserAppliedSurface(parserAppliedSeqRef.current)
    }
    const generation = currentAttachRef.current?.requestId
    const queue = writeQueueRef.current
    if (queue) {
      queue.enqueue(data, invalidateAppliedSurface, { mode: 'live', generation })
      return
    }
    const scope = beginTerminalOutputWriteScope({
      terminalInstanceId,
      source: 'live',
      attachRequestId: generation,
      generation: generation ?? 'local-notice',
      suppressExternalSideEffects: false,
    })
    let didComplete = false
    const complete = () => {
      if (didComplete) return
      didComplete = true
      scope.complete()
    }
    try {
      term.write(data, () => {
        try {
          invalidateAppliedSurface()
        } finally {
          complete()
        }
      })
    } catch {
      // disposed
      complete()
    }
  }, [resetParserAppliedSurface])

  useEffect(() => () => {
    clearQuarantineRepair()
  }, [clearQuarantineRepair])

  // Keep refs in sync with props
  useEffect(() => {
    if (terminalContent) {
      const prev = contentRef.current
      const prevTerminalId = terminalIdRef.current
      if (prev && terminalContent.resumeSessionId !== prev.resumeSessionId) {
        if (debugRef.current) log.debug('[TRACE resumeSessionId] ref sync from props CHANGED resumeSessionId', {
          paneId,
          from: prev.resumeSessionId,
          to: terminalContent.resumeSessionId,
          createRequestId: terminalContent.createRequestId,
        })
      }
      terminalIdRef.current = terminalContent.terminalId
      if (terminalContent.terminalId !== prevTerminalId) {
        resetParserAppliedSurface()
        geometryEpochRef.current = 1
        geometryAuthorityRef.current = 'single_client'
        clearQuarantineRepair()
        forgetSentViewport(prevTerminalId)
        const cachedViewport = terminalContent.terminalId
          ? lastSentViewportByTerminal.get(terminalContent.terminalId)
          : undefined
        lastSentViewportRef.current = terminalContent.terminalId && cachedViewport
          ? { terminalId: terminalContent.terminalId, cols: cachedViewport.cols, rows: cachedViewport.rows }
          : null
        applySeqState(createAttachSeqState())
      }
      requestIdRef.current = terminalContent.createRequestId
      contentRef.current = terminalContent
    }
  }, [terminalContent, paneId, applySeqState, clearQuarantineRepair, resetParserAppliedSurface])

  // Register terminal buffer accessor with test harness (for E2E tests).
  // Uses xterm.js Terminal.buffer.active API which works with all renderers
  // (WebGL, canvas, DOM) — unlike DOM scraping via .xterm-rows which only
  // works with the DOM renderer.
  //
  // This must be a useEffect watching terminalContent?.terminalId because:
  // 1. When the xterm Terminal is first created, terminalId is undefined
  //    (the server hasn't responded with terminal.created yet)
  // 2. terminalId becomes defined asynchronously via a WS message handler
  // 3. The useEffect fires when terminalId transitions from undefined to a
  //    real value, which is exactly when we can register the buffer
  useEffect(() => {
    const tid = terminalContent?.terminalId
    if (!window.__FRESHELL_TEST_HARNESS__ || !tid) return

    window.__FRESHELL_TEST_HARNESS__.registerTerminalBuffer(
      tid,
      () => {
        const t = termRef.current
        if (!t) return ''
        const buf = t.buffer.active
        const lines: string[] = []
        for (let y = 0; y < buf.length; y++) {
          const line = buf.getLine(y)
          if (line) lines.push(line.translateToString(true))
        }
        return lines.join('\n')
      },
    )

    return () => {
      window.__FRESHELL_TEST_HARNESS__?.unregisterTerminalBuffer(tid)
    }
  }, [terminalContent?.terminalId])

  useEffect(() => {
    hiddenRef.current = hidden
    if (hidden) {
      clearHoveredUrl(paneId)
      if (wrapperRef.current) {
        delete wrapperRef.current.dataset.hoveredUrl
      }
    }
  }, [hidden, paneId])

  useEffect(() => {
    warnExternalLinksRef.current = settings.terminal.warnExternalLinks
  }, [settings.terminal.warnExternalLinks])

  useEffect(() => {
    osc52PolicyRef.current = settings.terminal.osc52Clipboard
  }, [settings.terminal.osc52Clipboard])

  useEffect(() => {
    pendingOsc52EventRef.current = pendingOsc52Event
  }, [pendingOsc52Event])

  // Sync during render (not in useEffect) so refs always have latest values
  paneLastInputAtRef.current = paneLastInputAt
  settingsRef.current = settings
  debugRef.current = !!settings.logging?.debug
  refreshRequestRef.current = refreshRequest
  providerBehaviorRef.current = providerBehavior

  useEffect(() => {
    serverInstanceIdRef.current = serverInstanceId
  }, [serverInstanceId])

  const shouldFocusActiveTerminal = !hidden && activeTabId === tabId && activePaneId === paneId

  // Keep the active pane's terminal focused when tabs/panes switch so typing works immediately.
  useEffect(() => {
    if (!isTerminal) return
    if (!shouldFocusActiveTerminal) return
    const term = termRef.current
    if (!term) return

    requestAnimationFrame(() => {
      if (termRef.current !== term) return
      term.focus()
    })
  }, [isTerminal, shouldFocusActiveTerminal])

  useEffect(() => {
    lastSessionActivityAtRef.current = 0
  }, [terminalContent?.resumeSessionId])

  // Attention clearing is NOT done here: sendInput is shared by synthetic callers
  // (scroll-translation, DECRQM/startup auto-replies) that must not dismiss green.
  // Real-engagement clearing lives in the term.onData handler (see clearAttentionOnEngagement).
  const sendInput = useCallback((data: string) => {
    const tid = terminalIdRef.current
    if (!tid) return
    ws.send(buildTerminalInputMessage(contentRef.current, tid, data))
  }, [ws])

  const translateScrollLinesToInput = useCallback((term: Terminal, lines: number): boolean => {
    if (!terminalIdRef.current || lines === 0) return false

    const shouldTranslate = shouldTranslateScrollToCursorKeys({
      scrollInputPolicy: providerBehaviorRef.current.scrollInputPolicy,
      altBufferActive: term.buffer.active.type === 'alternate',
      mouseTrackingMode: term.modes.mouseTrackingMode,
    })
    if (!shouldTranslate) return false

    const sequence = scrollLinesToCursorKeys(lines, term.modes.applicationCursorKeysMode)
    if (!sequence) return false

    sendInput(sequence)
    return true
  }, [sendInput])

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }, [])

  const getCellFromClientPoint = useCallback((clientX: number, clientY: number) => {
    const term = termRef.current
    const container = containerRef.current
    if (!term || !container) return null
    if (term.cols <= 0 || term.rows <= 0) return null

    const rect = container.getBoundingClientRect()
    const relativeX = clientX - rect.left
    const relativeY = clientY - rect.top
    if (relativeX < 0 || relativeY < 0 || relativeX > rect.width || relativeY > rect.height) return null

    const columnWidth = rect.width / term.cols
    const rowHeight = rect.height / term.rows
    if (columnWidth <= 0 || rowHeight <= 0) return null

    const col = Math.max(0, Math.min(term.cols - 1, Math.floor(relativeX / columnWidth)))
    const viewportRow = Math.max(0, Math.min(term.rows - 1, Math.floor(relativeY / rowHeight)))
    const baseRow = term.buffer.active?.viewportY ?? 0
    const row = baseRow + viewportRow
    return { col, row }
  }, [])

  const selectWordAtPoint = useCallback((clientX: number, clientY: number) => {
    const term = termRef.current
    if (!term) return
    const cell = getCellFromClientPoint(clientX, clientY)
    if (!cell) return

    const line = term.buffer.active?.getLine(cell.row)
    const text = line?.translateToString(true) ?? ''
    if (!text) return

    const isWordChar = (char: string | undefined) => !!char && /[A-Za-z0-9_$./-]/.test(char)
    let start = Math.min(cell.col, Math.max(0, text.length - 1))
    let end = start

    if (!isWordChar(text[start])) {
      term.select(start, cell.row, 1)
      return
    }

    while (start > 0 && isWordChar(text[start - 1])) start -= 1
    while (end < text.length && isWordChar(text[end])) end += 1

    term.select(start, cell.row, Math.max(1, end - start))
  }, [getCellFromClientPoint])

  const selectLineAtPoint = useCallback((clientX: number, clientY: number) => {
    const term = termRef.current
    if (!term) return
    const cell = getCellFromClientPoint(clientX, clientY)
    if (!cell) return
    term.selectLines(cell.row, cell.row)
  }, [getCellFromClientPoint])

  const handleMobileTouchStart = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    if (!isMobile) return
    const touch = event.touches[0]
    if (!touch) return

    touchActiveRef.current = true
    touchSelectionModeRef.current = false
    touchMovedRef.current = false
    touchStartYRef.current = touch.clientY
    touchLastYRef.current = touch.clientY
    touchStartXRef.current = touch.clientX
    touchScrollAccumulatorRef.current = 0
    clearLongPressTimer()
    longPressTimerRef.current = setTimeout(() => {
      touchSelectionModeRef.current = true
    }, 350)
  }, [clearLongPressTimer, isMobile])

  const handleMobileTouchMove = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    if (!isMobile || !touchActiveRef.current) return
    const touch = event.touches[0]
    if (!touch) return
    const term = termRef.current
    if (!term) return

    const deltaX = Math.abs(touch.clientX - touchStartXRef.current)
    const deltaYFromStart = Math.abs(touch.clientY - touchStartYRef.current)
    if (!touchMovedRef.current && (deltaX > 8 || deltaYFromStart > 8)) {
      touchMovedRef.current = true
      clearLongPressTimer()
    }

    if (touchSelectionModeRef.current) return

    const deltaY = touch.clientY - touchLastYRef.current
    touchLastYRef.current = touch.clientY
    // Match native touch behavior: content follows drag direction.
    touchScrollAccumulatorRef.current -= deltaY

    const rawLines = touchScrollAccumulatorRef.current / TOUCH_SCROLL_PIXELS_PER_LINE
    const lines = rawLines > 0 ? Math.floor(rawLines) : Math.ceil(rawLines)
    if (lines !== 0) {
      const policy = providerBehaviorRef.current.scrollInputPolicy
      if (!translateScrollLinesToInput(term, lines)) {
        const el = term.element
        if (policy === 'native' && el && term.buffer.active.type === 'alternate' && term.modes.mouseTrackingMode !== 'none') {
          // Dispatch synthetic wheel events so xterm.js handles them natively
          // (sends mouse-wheel CSI sequences to the PTY).
          const absLines = Math.abs(lines)
          const scrollDirection = lines < 0 ? -1 : 1
          for (let i = 0; i < absLines; i++) {
            el.dispatchEvent(new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              clientX: touch.clientX,
              clientY: touch.clientY,
              deltaY: scrollDirection,
              deltaMode: WheelEvent.DOM_DELTA_LINE,
            }))
          }
        } else {
          term.scrollLines(lines)
        }
      }

      touchScrollAccumulatorRef.current -= lines * TOUCH_SCROLL_PIXELS_PER_LINE
    }
  }, [clearLongPressTimer, isMobile, translateScrollLinesToInput])

  const handleMobileTouchEnd = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    if (!isMobile) return
    clearLongPressTimer()

    const changed = event.changedTouches[0]
    const wasSelectionMode = touchSelectionModeRef.current
    const moved = touchMovedRef.current

    touchActiveRef.current = false
    touchSelectionModeRef.current = false
    touchMovedRef.current = false
    touchScrollAccumulatorRef.current = 0

    if (!changed || wasSelectionMode || moved) return

    const now = Date.now()
    const lastTapPoint = lastTapPointRef.current
    const lastTapAt = lastTapAtRef.current
    const withinInterval = now - lastTapAt <= TAP_MULTI_INTERVAL_MS
    const withinDistance = !!lastTapPoint
      && Math.abs(changed.clientX - lastTapPoint.x) <= TAP_MAX_DISTANCE_PX
      && Math.abs(changed.clientY - lastTapPoint.y) <= TAP_MAX_DISTANCE_PX

    if (withinInterval && withinDistance) {
      tapCountRef.current += 1
    } else {
      tapCountRef.current = 1
    }

    lastTapAtRef.current = now
    lastTapPointRef.current = { x: changed.clientX, y: changed.clientY }

    if (tapCountRef.current === 2) {
      selectWordAtPoint(changed.clientX, changed.clientY)
      return
    }
    if (tapCountRef.current >= 3) {
      selectLineAtPoint(changed.clientX, changed.clientY)
      tapCountRef.current = 0
    }
  }, [clearLongPressTimer, isMobile, selectLineAtPoint, selectWordAtPoint])

  useEffect(() => {
    return () => {
      clearLongPressTimer()
    }
  }, [clearLongPressTimer])

  useEffect(() => {
    const terminalId = terminalContent?.terminalId ?? null
    const previousTerminalId = searchTerminalIdCleanupRef.current
    if (previousTerminalId && previousTerminalId !== terminalId) {
      void dispatch(loadTerminalSearch({ terminalId: previousTerminalId, query: '' }) as any).catch(() => {})
      setSearchQuery('')
    }
    searchTerminalIdCleanupRef.current = terminalId
  }, [dispatch, terminalContent?.terminalId])

  useEffect(() => {
    return () => {
      const terminalId = searchTerminalIdCleanupRef.current
      if (!terminalId) return
      void dispatch(loadTerminalSearch({ terminalId, query: '' }) as any).catch(() => {})
    }
  }, [dispatch])

  // Helper to update pane content - uses ref to avoid recreation on content changes
  // This is CRITICAL: if updateContent depended on terminalContent directly,
  // it would be recreated on every status update, causing the effect to re-run
  const updateContent = useCallback((updates: Partial<TerminalPaneContent>) => {
    const current = contentRef.current
    if (!current) return
    const next = { ...current, ...updates }
    // Trace resumeSessionId changes
    if ('resumeSessionId' in updates && updates.resumeSessionId !== current.resumeSessionId) {
      if (debugRef.current) log.debug('[TRACE resumeSessionId] updateContent CHANGING resumeSessionId', {
        paneId,
        from: current.resumeSessionId,
        to: updates.resumeSessionId,
        stack: new Error().stack?.split('\n').slice(1, 5).join('\n'),
      })
    }
    contentRef.current = next
    dispatch(updatePaneContent({
      tabId,
      paneId,
      content: next,
    }))
  }, [dispatch, tabId, paneId]) // NO terminalContent dependency - uses ref

  const syncContentRefWithSessionAssociation = useCallback((rawSessionRef: unknown) => {
    const current = contentRef.current
    const updates = buildSessionAssociationContentUpdates(current, rawSessionRef)
    if (!current || !updates) return false
    contentRef.current = {
      ...current,
      ...updates,
    }
    return true
  }, [])

  const requestTerminalLayout = useCallback((options: {
    fit?: boolean
    resize?: boolean
    scrollToBottom?: boolean
    focus?: boolean
  }) => {
    const pending = pendingLayoutWorkRef.current
    if (options.fit || options.resize) pending.fit = true
    if (options.resize) pending.resize = true
    if (options.scrollToBottom) pending.scrollToBottom = true
    if (options.focus) pending.focus = true
    layoutSchedulerRef.current?.request()
  }, [])

  const flushScheduledLayout = useCallback(() => {
    const term = termRef.current
    if (!term) return

    const runtime = runtimeRef.current
    const pending = pendingLayoutWorkRef.current
    const shouldFit = pending.fit
    const shouldResize = pending.resize
    const shouldScrollToBottom = pending.scrollToBottom
    const shouldFocus = pending.focus
    pending.fit = false
    pending.resize = false
    pending.scrollToBottom = false
    pending.focus = false

    if (shouldFit && !hiddenRef.current && runtime) {
      try {
        runtime.fit()
      } catch {
        // disposed
      }

      if (shouldResize) {
        const tid = terminalIdRef.current
        if (tid) {
          const suppressedResize = suppressNextMatchingResizeRef.current
          const matchesSuppressedViewport = suppressedResize
            && suppressedResize.terminalId === tid
            && suppressedResize.cols === term.cols
            && suppressedResize.rows === term.rows
          const lastSentViewport = lastSentViewportRef.current
          const matchesLastSentViewport = lastSentViewport
            && lastSentViewport.terminalId === tid
            && lastSentViewport.cols === term.cols
            && lastSentViewport.rows === term.rows
          if (matchesSuppressedViewport) {
            suppressNextMatchingResizeRef.current = null
          } else if (!matchesLastSentViewport && !suppressNetworkEffects) {
            syncGeometryEpochForViewport(tid, term.cols, term.rows)
            ws.send(buildTerminalResizeMessage(contentRef.current, tid, term.cols, term.rows))
            rememberSentViewport(tid, term.cols, term.rows)
            lastSentViewportRef.current = { terminalId: tid, cols: term.cols, rows: term.rows }
          }
        }
      }
    }

    if (shouldScrollToBottom) {
      try { term.scrollToBottom() } catch { /* disposed */ }
    }
    if (shouldFocus) {
      term.focus()
    }
  }, [suppressNetworkEffects, syncGeometryEpochForViewport, ws])

  const enqueueTerminalWrite = useCallback((data: string, onWritten?: () => void, options?: TerminalWriteQueueOptions): boolean => {
    if (!data) return false
    const queue = writeQueueRef.current
    if (queue) {
      queue.enqueue(data, onWritten, options)
      return true
    }
    const term = termRef.current
    if (!term) return false
    const mode = options?.mode ?? 'live'
    const generation = options?.generation ?? 'no-attach'
    const scope = beginTerminalOutputWriteScope({
      terminalInstanceId: terminalInstanceIdRef.current,
      source: mode,
      attachRequestId: options?.generation,
      generation,
      suppressExternalSideEffects: mode === 'replay',
    })
    try {
      term.write(data, () => {
        try {
          onWritten?.()
        } finally {
          scope.complete()
        }
      })
      return true
    } catch {
      // disposed
      scope.complete()
      return false
    }
  }, [])

  const attemptOsc52ClipboardWrite = useCallback((text: string) => {
    void copyText(text).catch(() => {})
  }, [])

  const persistOsc52Policy = useCallback((policy: Osc52Policy) => {
    osc52PolicyRef.current = policy
    dispatch(updateSettingsLocal({ terminal: { osc52Clipboard: policy } }))
  }, [dispatch])

  const advanceOsc52Prompt = useCallback(() => {
    const next = osc52QueueRef.current.shift() ?? null
    pendingOsc52EventRef.current = next
    setPendingOsc52Event(next)
  }, [])

  const closeOsc52Prompt = useCallback(() => {
    pendingOsc52EventRef.current = null
    setPendingOsc52Event(null)
  }, [])

  const handleOsc52Event = useCallback((event: Osc52Event, source: TerminalOutputSource, mode: TerminalPaneContent['mode']) => {
    const policy = osc52PolicyRef.current
    if (policy === 'always') {
      if (shouldAllowOsc52ClipboardWrite({
        terminalInstanceId: terminalInstanceIdRef.current,
        source,
        mode,
      })) {
        attemptOsc52ClipboardWrite(event.text)
      }
      return
    }
    if (policy === 'never') {
      return
    }
    if (!shouldAllowOsc52Prompt({
      terminalInstanceId: terminalInstanceIdRef.current,
      source,
      mode,
    })) {
      return
    }
    if (pendingOsc52EventRef.current) {
      osc52QueueRef.current.push(event)
      return
    }
    pendingOsc52EventRef.current = event
    setPendingOsc52Event(event)
  }, [attemptOsc52ClipboardWrite])

  const resetStartupProbeParser = useCallback((opts?: { discardReplayRemainder?: boolean }) => {
    const pendingProbe = startupProbeStateRef.current
    if (opts?.discardReplayRemainder) {
      const boundary = getTerminalStartupProbeReplayBoundary(pendingProbe)
      startupProbeReplayDiscardStateRef.current = {
        remainder: boundary.remainder,
        buffered: '',
        resumeState: boundary.remainder ? boundary.resumeState : null,
      }
      startupProbeStateRef.current = boundary.remainder
        ? createTerminalStartupProbeState()
        : (boundary.resumeState ?? createTerminalStartupProbeState())
    } else {
      startupProbeReplayDiscardStateRef.current = { remainder: null, buffered: '', resumeState: null }
      startupProbeStateRef.current = createTerminalStartupProbeState()
    }
  }, [])

  const handleTerminalOutput = useCallback((
    raw: string,
    mode: TerminalPaneContent['mode'],
    tid: string | undefined,
    allowReplies: boolean,
    onParserApplied?: () => void,
    writeOptions?: TerminalWriteQueueOptions,
  ): TerminalOutputSubmission => {
    const outputSource = writeOptions?.mode ?? 'live'
    const startup = extractTerminalStartupProbes(raw, startupProbeStateRef.current, {
      foreground: resolvedThemeRef.current.foreground,
      background: resolvedThemeRef.current.background,
      cursor: resolvedThemeRef.current.cursor,
    })

    if (allowReplies && shouldAllowTerminalOutputSideEffect({
      terminalInstanceId: terminalInstanceIdRef.current,
      source: outputSource,
      effect: 'startup_reply',
      mode,
    })) {
      for (const reply of startup.replies) {
        sendInput(reply)
      }
    }

    const osc = extractOsc52Events(startup.cleaned, osc52ParserRef.current)
    const { cleaned, count } = extractTurnCompleteSignals(osc.cleaned, mode, turnCompleteSignalStateRef.current)

    // claude and codex turn-completion are server-authoritative (terminal.turn.complete
    // broadcast). The client must not mint a completion from output (live or replayed)
    // for those modes — only opencode/other modes still use the client BEL path.
    if (count > 0 && tid && shouldAllowTerminalOutputSideEffect({
      terminalInstanceId: terminalInstanceIdRef.current,
      source: outputSource,
      effect: 'turn_complete',
      mode,
    })) {
      dispatch(recordTurnComplete({
        tabId,
        paneId: paneIdRef.current,
        terminalId: tid,
        at: Date.now(),
      }))
    }

    const submittedBytesEqualInput = cleaned === raw
    const submittedWrite = cleaned
      ? enqueueTerminalWrite(
          cleaned,
          submittedBytesEqualInput ? onParserApplied : undefined,
          writeOptions,
        )
      : false

    for (const event of osc.events) {
      handleOsc52Event(event, outputSource, mode)
    }
    return { submittedWrite, submittedBytesEqualInput: submittedWrite && submittedBytesEqualInput }
  }, [dispatch, enqueueTerminalWrite, handleOsc52Event, sendInput, tabId])

  const findNext = useCallback((value: string = searchQuery) => {
    const terminalId = terminalIdRef.current
    const query = value.trim()
    if (!terminalId || !query) return
    if (terminalSearchState?.query !== query || terminalSearchState.loading) {
      void dispatch(loadTerminalSearch({ terminalId, query }) as any).catch(() => {})
      return
    }
    void dispatch(focusNextTerminalSearchMatch(terminalId) as any)
  }, [dispatch, searchQuery, terminalSearchState?.loading, terminalSearchState?.query])

  const findPrevious = useCallback((value: string = searchQuery) => {
    const terminalId = terminalIdRef.current
    const query = value.trim()
    if (!terminalId || !query) return
    if (terminalSearchState?.query !== query || terminalSearchState.loading) {
      void dispatch(loadTerminalSearch({ terminalId, query }) as any).catch(() => {})
      return
    }
    void dispatch(focusPreviousTerminalSearchMatch(terminalId) as any)
  }, [dispatch, searchQuery, terminalSearchState?.loading, terminalSearchState?.query])

  const handleSearchQueryChange = useCallback((value: string) => {
    setSearchQuery(value)
    const terminalId = terminalIdRef.current
    if (!terminalId) return
    void dispatch(loadTerminalSearch({ terminalId, query: value }) as any).catch(() => {})
  }, [dispatch])

  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setSearchQuery('')
    const terminalId = terminalIdRef.current
    if (terminalId) {
      void dispatch(loadTerminalSearch({ terminalId, query: '' }) as any).catch(() => {})
    }
    requestAnimationFrame(() => {
      termRef.current?.focus()
    })
  }, [dispatch])

  const sendMobileToolbarKey = useCallback((keyId: MobileToolbarKeyId) => {
    if (keyId === 'ctrl') {
      setMobileCtrlActive((prev) => {
        const next = !prev
        mobileCtrlActiveRef.current = next
        return next
      })
      return
    }

    const input = resolveMobileToolbarInput(keyId, mobileCtrlActiveRef.current)
    sendInput(input)
    termRef.current?.focus()
  }, [sendInput])

  const clearMobileToolbarRepeat = useCallback(() => {
    if (mobileKeyRepeatDelayTimerRef.current) {
      clearTimeout(mobileKeyRepeatDelayTimerRef.current)
      mobileKeyRepeatDelayTimerRef.current = null
    }
    if (mobileKeyRepeatIntervalRef.current) {
      clearInterval(mobileKeyRepeatIntervalRef.current)
      mobileKeyRepeatIntervalRef.current = null
    }
  }, [])

  const handleMobileToolbarPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>, keyId: MobileToolbarKeyId) => {
    if (!isRepeatableMobileToolbarKey(keyId)) return

    event.preventDefault()
    event.stopPropagation()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Ignore capture failures (e.g. unsupported pointer source)
    }
    sendMobileToolbarKey(keyId)
    clearMobileToolbarRepeat()
    mobileKeyRepeatDelayTimerRef.current = setTimeout(() => {
      mobileKeyRepeatIntervalRef.current = setInterval(() => {
        sendMobileToolbarKey(keyId)
      }, MOBILE_KEY_REPEAT_INTERVAL_MS)
    }, MOBILE_KEY_REPEAT_INITIAL_DELAY_MS)
  }, [clearMobileToolbarRepeat, sendMobileToolbarKey])

  const handleMobileToolbarPointerEnd = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    clearMobileToolbarRepeat()
  }, [clearMobileToolbarRepeat])

  const handleMobileToolbarClick = useCallback((event: ReactMouseEvent<HTMLButtonElement>, keyId: MobileToolbarKeyId) => {
    // Pointer interactions are handled via pointerdown to support press-and-hold repeat.
    // Keep click handling for non-repeatable keys and keyboard activation (detail === 0).
    if (isRepeatableMobileToolbarKey(keyId) && event.detail !== 0) return
    sendMobileToolbarKey(keyId)
  }, [sendMobileToolbarKey])

  const handleMobileToolbarContextMenu = useCallback((event: ReactMouseEvent<HTMLButtonElement>, keyId: MobileToolbarKeyId) => {
    if (!isRepeatableMobileToolbarKey(keyId)) return
    event.preventDefault()
    event.stopPropagation()
  }, [])

  const queuePaneSplit = useCallback((newContent: PaneContentInput) => {
    deferTerminalPointerMutation(() => {
      dispatch(splitPane({
        tabId,
        paneId,
        direction: 'horizontal',
        newContent,
      }))
    })
  }, [dispatch, paneId, tabId])

  useEffect(() => {
    return () => {
      clearMobileToolbarRepeat()
    }
  }, [clearMobileToolbarRepeat])

  // Init xterm once
  useEffect(() => {
    if (!isTerminal) return
    if (shouldWaitForProviderBehavior) return
    if (!containerRef.current) return
    if (mountedRef.current && termRef.current) return
    mountedRef.current = true

    if (termRef.current) {
      runtimeRef.current?.dispose()
      runtimeRef.current = null
      termRef.current.dispose()
      termRef.current = null
    }

    const resolvedTheme = getTerminalTheme(settings.terminal.theme, settings.theme)
    resolvedThemeRef.current = resolvedTheme
    const terminalInstanceId = `terminal-surface:${nanoid()}`
    terminalInstanceIdRef.current = terminalInstanceId
    const allowCurrentLinkAction = () => (
      terminalInstanceIdRef.current === terminalInstanceId
      && shouldAllowTerminalOutputSideEffect({
        terminalInstanceId,
        source: 'live',
        effect: 'link_action',
        mode: contentRef.current?.mode,
      })
    )

    const term = new Terminal({
      allowProposedApi: true,
      convertEol: true,
      cursorBlink: settings.terminal.cursorBlink,
      fontSize: settings.terminal.fontSize,
      fontFamily: resolveTerminalFontFamily(settings.terminal.fontFamily),
      lineHeight: settings.terminal.lineHeight,
      scrollback: settings.terminal.scrollback,
      theme: resolvedTheme,
      minimumContrastRatio: resolveMinimumContrastRatio(resolvedTheme),
      linkHandler: {
        activate: (event: MouseEvent, uri: string) => {
          if (!allowCurrentLinkAction()) return
          if (event.button !== 0) return
          // Only open http/https URLs. Block javascript:, data:, and other
          // potentially dangerous schemes from OSC 8 links.
          if (!/^https?:\/\//i.test(uri)) return
          if (warnExternalLinksRef.current !== false) {
            setPendingLinkUriRef.current(uri)
          } else {
            queuePaneSplit({ kind: 'browser', url: uri, devToolsOpen: false })
          }
        },
        hover: (_event: MouseEvent, text: string, _range: import('@xterm/xterm').IBufferRange) => {
          if (!allowCurrentLinkAction()) return
          setHoveredUrl(paneId, text)
          if (wrapperRef.current) {
            wrapperRef.current.dataset.hoveredUrl = text
          }
        },
        leave: () => {
          if (!allowCurrentLinkAction()) return
          clearHoveredUrl(paneId)
          if (wrapperRef.current) {
            delete wrapperRef.current.dataset.hoveredUrl
          }
        },
      },
    })
    const rendererMode = settings.terminal.renderer ?? 'auto'
    const enableWebgl = rendererMode === 'webgl'
      || (rendererMode === 'auto' && !prefersCanvasRenderer(paneContent.mode, extensions))
    let runtime = createNoopRuntime()
    try {
      runtime = createTerminalRuntime({ terminal: term, enableWebgl })
      runtime.attachAddons()
    } catch {
      // Renderer/addon failures should not prevent terminal availability.
      runtime = createNoopRuntime()
    }

    termRef.current = term
    runtimeRef.current = runtime
    const writeQueue = createTerminalWriteQueue({
      terminalInstanceId,
      write: (data, onWritten) => {
        try {
          term.write(data, onWritten)
        } catch {
          // disposed
          onWritten?.()
        }
      },
    })
    writeQueueRef.current = writeQueue
    const layoutScheduler = createLayoutScheduler(flushScheduledLayout)
    layoutSchedulerRef.current = layoutScheduler

    term.open(containerRef.current)
    const requestModeBypass = registerTerminalRequestModeBypass(term, sendInput, { terminalInstanceId })
    term.attachCustomWheelEventHandler((event) => {
      const lines = event.deltaY < 0 ? -1 : event.deltaY > 0 ? 1 : 0
      if (!translateScrollLinesToInput(term, lines)) {
        return true
      }

      event.preventDefault()
      event.stopPropagation()
      return false
    })

    // Register custom link provider for clickable local file paths
    const linkProviderTerminalInstanceId = terminalInstanceId
    const filePathLinkDisposable = typeof term.registerLinkProvider === 'function'
      ? term.registerLinkProvider({
        provideLinks(bufferLineNumber: number, callback: (links: import('@xterm/xterm').ILink[] | undefined) => void) {
          const bufferLine = term.buffer.active.getLine(bufferLineNumber - 1)
          if (!bufferLine) { callback(undefined); return }
          const text = bufferLine.translateToString()
          const matches = findLocalFilePaths(text)
          if (matches.length === 0) { callback(undefined); return }
          callback(matches.map((m) => ({
            range: {
              start: { x: m.startIndex + 1, y: bufferLineNumber },
              end: { x: m.endIndex, y: bufferLineNumber },
            },
            text: m.path,
            activate: (event: MouseEvent) => {
              if (event && event.button !== 0) return
              if (terminalInstanceIdRef.current !== linkProviderTerminalInstanceId) return
              queuePaneSplit({
                kind: 'editor',
                filePath: m.path,
                language: null,
                readOnly: false,
                content: '',
                viewMode: 'source',
                wordWrap: true,
              })
            },
          })))
        },
      })
      : { dispose: () => {} }

    // Register custom link provider for clickable URLs in terminal output
    const urlLinkDisposable = typeof term.registerLinkProvider === 'function'
      ? term.registerLinkProvider({
        provideLinks(bufferLineNumber: number, callback: (links: import('@xterm/xterm').ILink[] | undefined) => void) {
          const bufferLine = term.buffer.active.getLine(bufferLineNumber - 1)
          if (!bufferLine) { callback(undefined); return }
          const text = bufferLine.translateToString()
          const urls = findUrls(text)
          if (urls.length === 0) { callback(undefined); return }
          callback(urls.map((m) => ({
            range: {
              start: { x: m.startIndex + 1, y: bufferLineNumber },
              end: { x: m.endIndex, y: bufferLineNumber },
            },
            text: m.url,
            activate: (event: MouseEvent) => {
              if (event && event.button !== 0) return
              if (terminalInstanceIdRef.current !== linkProviderTerminalInstanceId) return
              if (warnExternalLinksRef.current !== false) {
                setPendingLinkUriRef.current(m.url)
              } else {
                queuePaneSplit({ kind: 'browser', url: m.url, devToolsOpen: false })
              }
            },
            hover: () => {
              if (terminalInstanceIdRef.current !== linkProviderTerminalInstanceId) return
              setHoveredUrl(paneId, m.url)
              if (wrapperRef.current) {
                wrapperRef.current.dataset.hoveredUrl = m.url
              }
            },
            leave: () => {
              if (terminalInstanceIdRef.current !== linkProviderTerminalInstanceId) return
              clearHoveredUrl(paneId)
              if (wrapperRef.current) {
                delete wrapperRef.current.dataset.hoveredUrl
              }
            },
          })))
        },
      })
      : { dispose: () => {} }

    const allowCurrentTerminalAction = () => (
      terminalInstanceIdRef.current === terminalInstanceId
      && shouldAllowTerminalOutputSideEffect({
        terminalInstanceId,
        source: 'live',
        effect: 'terminal_action',
        mode: contentRef.current?.mode,
      })
    )
    const unregisterActions = registerTerminalActions(paneId, {
      copySelection: async () => {
        if (!allowCurrentTerminalAction()) return
        const selection = term.getSelection()
        if (selection && allowCurrentTerminalAction()) {
          await copyText(selection)
        }
      },
      paste: async () => {
        if (!allowCurrentTerminalAction()) return
        const text = await readText()
        if (!allowCurrentTerminalAction()) return
        if (!text) return
        term.paste(text)
      },
      selectAll: () => {
        if (!allowCurrentTerminalAction()) return
        term.selectAll()
      },
      clearScrollback: () => {
        if (!allowCurrentTerminalAction()) return
        term.clear()
      },
      reset: () => {
        if (!allowCurrentTerminalAction()) return
        term.reset()
      },
      scrollToBottom: () => {
        if (!allowCurrentTerminalAction()) return
        try { term.scrollToBottom() } catch { /* disposed */ }
      },
      hasSelection: () => allowCurrentTerminalAction() && term.getSelection().length > 0,
      openSearch: () => {
        if (!allowCurrentTerminalAction()) return
        setSearchOpen(true)
      },
    })
    const unregisterCaptureHandler = registerTerminalCaptureHandler(paneId, {
      suspendWebgl: () => runtimeRef.current?.suspendWebgl?.() ?? false,
      resumeWebgl: () => {
        runtimeRef.current?.resumeWebgl?.()
      },
    })

    requestTerminalLayout({ fit: true, focus: true })

    term.onData((data) => {
      sendInput(data)
      // Decision 1: a real keystroke (printable / Enter) dismisses this tab's green
      // in BOTH attentionDismiss modes. Bare arrows / synthetic sequences do not.
      if (isEngagementInput(data)) {
        dispatch(dismissTabGreen(tabId))
      }
      const currentTab = tabRef.current
      const currentContent = contentRef.current
      if (currentTab) {
        const now = Date.now()
        const bucket = bucketTabRecencyAt(now)
        if (
          bucket !== undefined
          && (
            paneLastInputAtRef.current === undefined
            || bucket > paneLastInputAtRef.current
          )
        ) {
          paneLastInputAtRef.current = bucket
          dispatch(recordPaneTabActivity({ paneId: paneIdRef.current, at: now }))
        }
        const resumeSessionId = currentContent?.resumeSessionId
        if (resumeSessionId && currentContent?.mode && currentContent.mode !== 'shell') {
          if (now - lastSessionActivityAtRef.current >= SESSION_ACTIVITY_THROTTLE_MS) {
            lastSessionActivityAtRef.current = now
            const provider = currentContent.mode
            dispatch(updateSessionActivity({ sessionId: resumeSessionId, provider, lastInputAt: now }))
          }
        }
      }
    })

    term.attachCustomKeyEventHandler((event) => {
      if (
        event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        event.type === 'keydown' &&
        event.key.toLowerCase() === 'f'
      ) {
        event.preventDefault()
        setSearchOpen(true)
        return false
      }

      // Ctrl+Shift+C to copy (ignore key repeat)
      if (event.ctrlKey && event.shiftKey && event.key === 'C' && event.type === 'keydown' && !event.repeat) {
        const selection = term.getSelection()
        if (selection) {
          void navigator.clipboard.writeText(selection).catch(() => {})
        }
        return false
      }

      if (isTerminalPasteShortcut(event)) {
        // Policy-only: block xterm key translation (for example Ctrl+V -> ^V)
        // and allow native/browser paste path to feed xterm.
        return false
      }

      if (
        event.key === 'Escape' &&
        event.type === 'keydown' &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey
      ) {
        event.preventDefault()
        sendInput('\u001b')
        return false
      }

      const tabSwitchDirection = getTabSwitchShortcutDirection(event)
      if (tabSwitchDirection && event.type === 'keydown' && !event.repeat) {
        event.preventDefault()
        dispatch(tabSwitchDirection === 'prev' ? switchToPrevTab() : switchToNextTab())
        return false
      }

      // Ctrl+Shift+Arrow is tab reorder (handled by TabBar on window).
      // Alt+T/W is new/close tab (handled by App on window).
      // Return false so xterm doesn't consume the event and block propagation.
      if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey
        && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        return false
      }
      if (getTabLifecycleAction(event)) {
        return false
      }

      // Shift+Enter -> send newline (same as Ctrl+J)
      if (event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && event.key === 'Enter' && event.type === 'keydown' && !event.repeat) {
        event.preventDefault()
        const tid = terminalIdRef.current
        if (tid) {
          ws.send({ type: 'terminal.input', terminalId: tid, data: '\n' })
        }
        return false
      }

      // Scroll to bottom: Cmd+End (macOS) / Ctrl+End (other)
      if ((event.metaKey || event.ctrlKey) && event.code === 'End' && event.type === 'keydown' && !event.repeat) {
        event.preventDefault()
        try { term.scrollToBottom() } catch { /* disposed */ }
        return false
      }

      return true
    })

    const ro = new ResizeObserver(() => {
      if (hiddenRef.current || termRef.current !== term) return
      requestTerminalLayout({ fit: true, resize: true })
    })
    ro.observe(containerRef.current)

    const wrapperEl = wrapperRef.current
    return () => {
      clearQuarantineRepair()
      requestModeBypass.dispose()
      filePathLinkDisposable?.dispose()
      urlLinkDisposable?.dispose()
      clearHoveredUrl(paneId)
      if (wrapperEl) {
        delete wrapperEl.dataset.hoveredUrl
      }
      ro.disconnect()
      unregisterActions()
      unregisterCaptureHandler()
      if (writeQueueRef.current === writeQueue) {
        writeQueue.clear()
        writeQueueRef.current = null
      }
      if (layoutSchedulerRef.current === layoutScheduler) {
        layoutScheduler.cancel()
        layoutSchedulerRef.current = null
      }
      pendingLayoutWorkRef.current = {
        fit: false,
        resize: false,
        scrollToBottom: false,
        focus: false,
      }
      if (termRef.current === term) {
        if (terminalInstanceIdRef.current === terminalInstanceId) {
          terminalInstanceIdRef.current = `terminal-surface:disposed:${nanoid()}`
        }
        runtime.dispose()
        runtimeRef.current = null
        term.dispose()
        termRef.current = null
        mountedRef.current = false
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTerminal, providerBehavior.preferredRenderer, shouldWaitForProviderBehavior])

  // Ref for tab to avoid re-running effects when tab changes
  const tabRef = useRef(tab)
  useEffect(() => {
    tabRef.current = tab
  }, [tab])
  const tabHasSinglePaneRef = useRef(tabHasSinglePane)
  useEffect(() => {
    tabHasSinglePaneRef.current = tabHasSinglePane
  }, [tabHasSinglePane])

  // Ref for paneId to avoid stale closures in title handlers
  const paneIdRef = useRef(paneId)
  useEffect(() => {
    paneIdRef.current = paneId
  }, [paneId])

  // Track last title we set to avoid churn from spinner animations
  const lastTitleRef = useRef<string | null>(null)
  const lastTitleUpdateRef = useRef<number>(0)
  const TITLE_UPDATE_THROTTLE_MS = 2000

  // Handle xterm title changes (from terminal escape sequences)
  useEffect(() => {
    if (!isTerminal) return
    const term = termRef.current
    if (!term) return
    const titleTerminalInstanceId = terminalInstanceIdRef.current

    const disposable = term.onTitleChange((rawTitle: string) => {
      // Only shell terminals follow the program's OSC window title. Coding-agent
      // terminals are named from the server session (working dir / first message
      // / Gemini) and must stay stable, so they ignore OSC titles entirely.
      if (!terminalFollowsOscTitle(contentRef.current?.mode)) return
      if (terminalInstanceIdRef.current !== titleTerminalInstanceId) return
      if (!shouldAllowTerminalOutputSideEffect({
        terminalInstanceId: titleTerminalInstanceId,
        source: getTerminalOutputWriteScope(titleTerminalInstanceId) ? undefined : 'live',
        effect: 'title_update',
        mode: contentRef.current?.mode,
      })) {
        return
      }
      // Strip prefix noise (spinners, status chars) - everything before first letter
      const match = rawTitle.match(/[a-zA-Z]/)
      if (!match) return // No letters = all noise, ignore
      const cleanTitle = rawTitle.slice(match.index)
      if (!cleanTitle) return

      // Only update if the cleaned title actually changed
      if (cleanTitle === lastTitleRef.current) return

      // Throttle updates to avoid churn from rapid title changes (e.g., spinner animations)
      const now = Date.now()
      if (now - lastTitleUpdateRef.current < TITLE_UPDATE_THROTTLE_MS) return

      lastTitleRef.current = cleanTitle
      lastTitleUpdateRef.current = now

      // Tab and pane titles are independently guarded:
      // - Tab title gated by tab.titleSetByUser
      // - Pane title gated by paneTitleSetByUser (in the reducer)
      const currentTab = tabRef.current
      if (currentTab && !currentTab.titleSetByUser) {
        dispatch(updateTab({ id: currentTab.id, updates: { title: cleanTitle } }))
      }
      dispatch(updatePaneTitle({ tabId, paneId: paneIdRef.current, title: cleanTitle, setByUser: false }))
    })

    return () => disposable.dispose()
  }, [isTerminal, dispatch, tabId])

  const tabOrderRef = useRef(tabOrder)
  tabOrderRef.current = tabOrder
  const markAttachComplete = useCallback(() => {
    wasCreatedFreshRef.current = false
    deferredAttachStateRef.current = {
      mode: 'live',
      pendingIntent: null,
      pendingSinceSeq: 0,
      pendingReason: 'initial_hydrate',
    }
    const queue = getHydrationQueue()
    if (hiddenRef.current) {
      queue.onHydrationComplete(paneId)
    } else {
      queue.onActiveTabReady(tabId, tabOrderRef.current)
    }
  }, [paneId, tabId])

  const markTerminalOutputRangeLost = useCallback((input: {
    terminalId: string
    messageType: string
    attachRequestId?: string
    streamId?: unknown
    fromSeq?: unknown
    toSeq?: unknown
    reason: string
    invalidReason?: string
  }) => {
    const previousSeqState = seqStateRef.current
    const explicitFromSeq = input.fromSeq
    const explicitToSeq = input.toSeq
    const hasExplicitRange = typeof explicitFromSeq === 'number'
      && typeof explicitToSeq === 'number'
      && Number.isFinite(explicitFromSeq)
      && Number.isFinite(explicitToSeq)
      && Number.isInteger(explicitFromSeq)
      && Number.isInteger(explicitToSeq)
      && explicitFromSeq >= 0
      && explicitToSeq >= explicitFromSeq
      && explicitToSeq > 0
    const fromSeq = hasExplicitRange
      ? Math.max(0, Math.floor(explicitFromSeq))
      : previousSeqState.highestObservedSeq + 1
    const toSeq = hasExplicitRange
      ? Math.max(fromSeq, Math.floor(explicitToSeq))
      : fromSeq
    const gapDecision = onOutputGap(previousSeqState, { fromSeq, toSeq })
    const nextSeqState = gapDecision.state
    applySeqState(nextSeqState)
    resetParserAppliedSurface(parserAppliedSeqRef.current)
    recordTerminalPerfAuditEvent('terminal.catchup.surface_quarantined', {
      terminalId: input.terminalId,
      messageType: input.messageType,
      attachRequestId: input.attachRequestId,
      activeAttachRequestId: currentAttachRef.current?.requestId,
      streamId: typeof input.streamId === 'string' ? input.streamId : undefined,
      fromSeq,
      toSeq,
      syntheticLostRange: !hasExplicitRange,
      parserAppliedSeq: parserAppliedSeqRef.current,
      highestObservedSeq: nextSeqState.highestObservedSeq,
      reason: input.reason,
      invalidReason: input.invalidReason,
    })
    const completedAttachOnGap = !nextSeqState.pendingReplay
      && (Boolean(previousSeqState.pendingReplay) || previousSeqState.awaitingFreshSequence)
    if (completedAttachOnGap) {
      resetStartupProbeParser({ discardReplayRemainder: Boolean(previousSeqState.pendingReplay) })
      setIsAttaching(false)
      markAttachComplete()
    }
  }, [
    applySeqState,
    markAttachComplete,
    recordTerminalPerfAuditEvent,
    resetParserAppliedSurface,
    resetStartupProbeParser,
  ])

  const registerForBackgroundHydration = useCallback((options?: { queueIfStarted?: boolean }) => {
    if (hydrationRegisteredRef.current) return
    hydrationRegisteredRef.current = true
    const setBgTriggered = setBackgroundHydrationTriggered
    getHydrationQueue().register({
      tabId,
      paneId: paneIdRef.current,
      trigger: () => setBgTriggered(true),
    }, options)
  }, [tabId])

  const isCurrentAttachMessage = useCallback((msg: {
    type: string
    terminalId: string
    attachRequestId?: string
  }) => {
    const current = currentAttachRef.current
    if (!current) return true
    if (!msg.attachRequestId) {
      recordTerminalPerfAuditEvent('terminal.attach_generation_stale_rejected', {
        terminalId: msg.terminalId,
        messageType: msg.type,
        activeAttachRequestId: current.requestId,
        reason: 'missing_attach_request_id',
      })
      if (debugRef.current) {
        log.debug('Ignoring untagged stream message for active attach generation', {
          paneId: paneIdRef.current,
          terminalId: msg.terminalId,
          type: msg.type,
          currentAttachRequestId: current.requestId,
        })
      }
      return false
    }
    if (abandonedAttachRequestIdsRef.current.has(msg.attachRequestId)) {
      recordTerminalPerfAuditEvent('terminal.attach_generation_stale_rejected', {
        terminalId: msg.terminalId,
        messageType: msg.type,
        attachRequestId: msg.attachRequestId,
        activeAttachRequestId: current.requestId,
        reason: 'abandoned_attach_request_id',
      })
      if (debugRef.current) {
        log.debug('Ignoring abandoned attach generation message', {
          paneId: paneIdRef.current,
          terminalId: msg.terminalId,
          type: msg.type,
          attachRequestId: msg.attachRequestId,
          currentAttachRequestId: current.requestId,
        })
      }
      return false
    }
    const isCurrent = msg.attachRequestId === current.requestId
    if (!isCurrent) {
      recordTerminalPerfAuditEvent('terminal.attach_generation_stale_rejected', {
        terminalId: msg.terminalId,
        messageType: msg.type,
        attachRequestId: msg.attachRequestId,
        activeAttachRequestId: current.requestId,
        reason: 'stale_attach_request_id',
      })
    }
    return isCurrent
  }, [recordTerminalPerfAuditEvent])

  const isCurrentAttachStreamMessage = useCallback((msg: {
    type: string
    terminalId: string
    attachRequestId?: string
    streamId?: unknown
    seqStart?: unknown
    seqEnd?: unknown
    fromSeq?: unknown
    toSeq?: unknown
  }) => {
    if (!isCurrentAttachMessage(msg)) return false

    const current = currentAttachRef.current
    const activeStreamId = current?.streamId
    const messageStreamId = typeof msg.streamId === 'string' && msg.streamId.length > 0
      ? msg.streamId
      : null
    if (activeStreamId === undefined) {
      return true
    }
    if (typeof activeStreamId === 'string' && messageStreamId === activeStreamId) {
      return true
    }

    const fromSeq = typeof msg.seqStart === 'number'
      ? msg.seqStart
      : (typeof msg.fromSeq === 'number' ? msg.fromSeq : undefined)
    const toSeq = typeof msg.seqEnd === 'number'
      ? msg.seqEnd
      : (typeof msg.toSeq === 'number' ? msg.toSeq : undefined)
    if (typeof fromSeq === 'number' && typeof toSeq === 'number') {
      const previousSeqState = seqStateRef.current
      const gapDecision = onOutputGap(previousSeqState, { fromSeq, toSeq })
      const nextSeqState = gapDecision.state
      applySeqState(nextSeqState)
      resetParserAppliedSurface(parserAppliedSeqRef.current)
      recordTerminalPerfAuditEvent('terminal.catchup.surface_quarantined', {
        terminalId: msg.terminalId,
        messageType: msg.type,
        attachRequestId: msg.attachRequestId,
        activeAttachRequestId: current?.requestId,
        activeStreamId,
        streamId: messageStreamId,
        fromSeq,
        toSeq,
        parserAppliedSeq: parserAppliedSeqRef.current,
        highestObservedSeq: nextSeqState.highestObservedSeq,
        reason: 'stream_identity_mismatch',
      })
      const completedAttachOnGap = !nextSeqState.pendingReplay
        && (Boolean(previousSeqState.pendingReplay) || previousSeqState.awaitingFreshSequence)
      if (completedAttachOnGap) {
        resetStartupProbeParser({ discardReplayRemainder: Boolean(previousSeqState.pendingReplay) })
        setIsAttaching(false)
        markAttachComplete()
      }
    } else {
      resetParserAppliedSurface(parserAppliedSeqRef.current)
      recordTerminalPerfAuditEvent('terminal.catchup.surface_quarantined', {
        terminalId: msg.terminalId,
        messageType: msg.type,
        attachRequestId: msg.attachRequestId,
        activeAttachRequestId: current?.requestId,
        activeStreamId,
        streamId: messageStreamId,
        parserAppliedSeq: parserAppliedSeqRef.current,
        reason: 'stream_identity_mismatch',
      })
    }

    log.warn('Ignoring terminal stream message with mismatched stream identity', {
      paneId: paneIdRef.current,
      terminalId: msg.terminalId,
      type: msg.type,
      attachRequestId: msg.attachRequestId,
      activeStreamId,
      messageStreamId,
      fromSeq,
      toSeq,
    })
    return false
  }, [
    applySeqState,
    isCurrentAttachMessage,
    markAttachComplete,
    recordTerminalPerfAuditEvent,
    resetParserAppliedSurface,
    resetStartupProbeParser,
  ])

  const attachTerminal = useCallback((
    tid: string,
    intent: AttachIntent,
    opts?: AttachTerminalOptions,
  ) => {
    if (suppressNetworkEffects) return
    const term = termRef.current
    if (!term) return
    const runtime = runtimeRef.current
    if (runtime && !hiddenRef.current && !opts?.skipPreAttachFit) {
      try {
        runtime.fit()
      } catch {
        // disposed
      }
    }
    const cols = Math.max(2, term.cols || 80)
    const rows = Math.max(2, term.rows || 24)
    syncGeometryEpochForViewport(tid, cols, rows)
    const attachRequestId = `${paneIdRef.current}:${++attachCounterRef.current}:${nanoid(6)}`
    const writeQueue = writeQueueRef.current
    const hasInFlightWrites = writeQueue?.hasInFlightWrites() === true
    const expectedStreamId = getTerminalCheckpointStreamId()
    const checkpointInput = buildCheckpointReplayInput(tid, { cols, rows })
    const checkpointDecision = getCheckpointDeltaReplayDecision(tid, { cols, rows })
    const expectedGeometryEpoch = checkpointInput?.geometryEpoch ?? geometryEpochRef.current
    const expectedGeometryAuthority = checkpointInput?.geometryAuthority ?? geometryAuthorityRef.current
    const explicitSinceSeq = typeof opts?.sinceSeq === 'number'
      ? Math.max(0, Math.floor(opts.sinceSeq))
      : undefined
    let effectiveIntent = intent
    let clearViewportFirst = opts?.clearViewportFirst === true
    let fullHydrateFallbackReason: string | null = null
    if (hasInFlightWrites && effectiveIntent !== 'viewport_hydrate') {
      effectiveIntent = 'viewport_hydrate'
      clearViewportFirst = true
      fullHydrateFallbackReason = 'in_flight_writes'
    } else if (effectiveIntent !== 'viewport_hydrate' && explicitSinceSeq === undefined && !checkpointDecision.ok) {
      effectiveIntent = 'viewport_hydrate'
      clearViewportFirst = true
      fullHydrateFallbackReason = checkpointDecision.reason
    }
    const deltaSeq = Math.max(0, Math.floor(explicitSinceSeq ?? (checkpointDecision.ok ? checkpointDecision.sinceSeq : 0)))
    const sinceSeq = effectiveIntent === 'viewport_hydrate' ? 0 : deltaSeq
    const surfaceQuarantined = hasInFlightWrites
    writeQueue?.setActiveGeneration(attachRequestId, { dropQueuedStaleWrites: true })
    if (!surfaceQuarantined) {
      clearQuarantineRepair()
    }
    if (surfaceQuarantined) {
      log.warn('Quarantining terminal attach while writes are still in flight', {
        paneId: paneIdRef.current,
        terminalId: tid,
        attachRequestId,
        intent: effectiveIntent,
        requestedIntent: intent,
        sinceSeq,
        clearViewportFirst,
      })
    }

    setIsAttaching(true)
    setTruncatedHistoryGap(null)

    // Startup probes must not leak across attach generations.
    resetStartupProbeParser()

    if (effectiveIntent === 'viewport_hydrate') {
      resetParserAppliedSurface()
      if (clearViewportFirst && !surfaceQuarantined) {
        try {
          termRef.current?.clear()
        } catch {
          // disposed
        }
      }
      applySeqState(beginAttach(createAttachSeqState({ lastSeq: 0 })))
    } else {
      applySeqState(beginAttach(createAttachSeqState({
        lastSeq: deltaSeq,
        parserAppliedSeq: deltaSeq,
      })))
    }

    deferredAttachStateRef.current = {
      mode: 'attaching',
      pendingIntent: effectiveIntent,
      pendingSinceSeq: sinceSeq,
      pendingReason: opts?.priority === 'background' ? 'background_catchup' : 'initial_hydrate',
    }

    currentAttachRef.current = {
      requestId: attachRequestId,
      intent: effectiveIntent,
      terminalId: tid,
      sinceSeq,
      cols,
      rows,
      surfaceQuarantined,
      expectedStreamId,
      geometryEpoch: expectedGeometryEpoch,
      geometryAuthority: expectedGeometryAuthority,
      expectedGeometryEpoch,
      expectedGeometryAuthority,
    }
    if (fullHydrateFallbackReason) {
      recordTerminalPerfAuditEvent('terminal.catchup.full_hydrate_fallback', {
        terminalId: tid,
        attachRequestId,
        requestedIntent: intent,
        intent: effectiveIntent,
        sinceSeq,
        deltaSeq,
        streamId: expectedStreamId,
        reason: fullHydrateFallbackReason,
        hasInFlightWrites,
      })
    }
    if (surfaceQuarantined) {
      recordTerminalPerfAuditEvent('terminal.catchup.surface_quarantined', {
        terminalId: tid,
        attachRequestId,
        requestedIntent: intent,
        intent: effectiveIntent,
        sinceSeq,
        streamId: expectedStreamId,
        parserAppliedSeq: parserAppliedSeqRef.current,
        reason: 'in_flight_writes',
      })
    }
    suppressNextMatchingResizeRef.current = opts?.suppressNextMatchingResize
      ? { terminalId: tid, cols, rows }
      : null

    ws.send(buildTerminalAttachMessage({
      content: contentRef.current,
      terminalId: tid,
      intent: effectiveIntent,
      cols,
      rows,
      sinceSeq,
      attachRequestId,
      priority: opts?.priority ?? 'foreground',
      ...(opts?.maxReplayBytes ? { maxReplayBytes: opts.maxReplayBytes } : {}),
    }))
    rememberSentViewport(tid, cols, rows)
    lastSentViewportRef.current = { terminalId: tid, cols, rows }
    if (surfaceQuarantined) {
      scheduleQuarantineRepair(tid, attachRequestId)
    }
  }, [
    suppressNetworkEffects,
    ws,
    applySeqState,
    buildCheckpointReplayInput,
    clearQuarantineRepair,
    getCheckpointDeltaReplayDecision,
    getTerminalCheckpointStreamId,
    recordTerminalPerfAuditEvent,
    resetParserAppliedSurface,
    scheduleQuarantineRepair,
    resetStartupProbeParser,
    syncGeometryEpochForViewport,
  ])
  attachTerminalRef.current = attachTerminal

  const runRefreshAttach = useCallback((request: PaneRefreshRequest | null | undefined) => {
    if (suppressNetworkEffects) return false
    if (!request) return false
    if (handledRefreshRequestIdRef.current === request.requestId) return true

    const tid = terminalIdRef.current
    const currentContent = contentRef.current
    if (!tid || !currentContent) return false
    if (!paneRefreshTargetMatchesContent(request.target, currentContent)) return false

    handledRefreshRequestIdRef.current = request.requestId
    ws.send({ type: 'terminal.detach', terminalId: tid })

    if (hiddenRef.current) {
      currentAttachRef.current = null
      deferredAttachStateRef.current = {
        mode: 'waiting_for_geometry',
        pendingIntent: 'viewport_hydrate',
        pendingSinceSeq: 0,
        pendingReason: 'explicit_refresh',
      }
      setIsAttaching(false)
    } else {
      attachTerminal(tid, 'viewport_hydrate', {
        clearViewportFirst: true,
        ...viewportHydrateReplayOptions(currentContent),
      })
    }

    dispatch(consumePaneRefreshRequest({ tabId, paneId, requestId: request.requestId }))
    return true
  }, [attachTerminal, dispatch, paneId, suppressNetworkEffects, tabId, ws])

  // Apply settings changes
  useEffect(() => {
    if (!isTerminal) return
    const term = termRef.current
    if (!term) return
    const resolvedTheme = getTerminalTheme(settings.terminal.theme, settings.theme)
    resolvedThemeRef.current = resolvedTheme
    term.options.cursorBlink = settings.terminal.cursorBlink
    term.options.fontSize = settings.terminal.fontSize
    term.options.fontFamily = resolveTerminalFontFamily(settings.terminal.fontFamily)
    term.options.lineHeight = settings.terminal.lineHeight
    term.options.scrollback = settings.terminal.scrollback
    term.options.theme = resolvedTheme
    term.options.minimumContrastRatio = resolveMinimumContrastRatio(resolvedTheme)
    if (!hiddenRef.current) {
      const deferred = deferredAttachStateRef.current
      if (deferred.mode === 'waiting_for_geometry' && deferred.pendingIntent) {
        requestTerminalLayout({ fit: true })
      } else {
        requestTerminalLayout({ fit: true, resize: true })
      }
    }
  }, [isTerminal, settings, requestTerminalLayout])

  // When becoming visible, fit and send size
  // Note: With visibility:hidden CSS, dimensions are always stable, so no RAF needed
  useEffect(() => {
    if (!isTerminal) return
    if (!hidden) {
      const tid = terminalIdRef.current
      const deferred = deferredAttachStateRef.current
      if (tid && deferred.mode === 'waiting_for_geometry' && deferred.pendingIntent) {
        // Unregister from background queue — this tab is now being directly hydrated
        if (hydrationRegisteredRef.current) {
          getHydrationQueue().unregister(paneId)
          hydrationRegisteredRef.current = false
        }
        getHydrationQueue().onActiveTabChanged(tabId, tabOrderRef.current)
        const checkpointDecision = getCheckpointDeltaReplayDecision(tid)
        const revealPlan = resolveRevealAttachPlan({
          pendingIntent: deferred.pendingIntent,
          pendingReason: deferred.pendingReason,
          checkpointDecision,
        })
        attachTerminal(tid, revealPlan.intent, {
          clearViewportFirst: revealPlan.clearViewportFirst,
          priority: revealPlan.priority,
          ...(typeof revealPlan.sinceSeq === 'number' ? { sinceSeq: revealPlan.sinceSeq } : {}),
          suppressNextMatchingResize: true,
          skipPreAttachFit: true,
          ...(revealPlan.intent === 'viewport_hydrate'
            ? viewportHydrateReplayOptions(contentRef.current)
            : undefined),
        })
        return
      }
      requestTerminalLayout({ fit: true, resize: true })
    }
  }, [hidden, isTerminal, paneId, requestTerminalLayout, tabId, attachTerminal, getCheckpointDeltaReplayDecision])

  // Background hydration: triggered by the hydration queue for hidden tabs
  useEffect(() => {
    if (!backgroundHydrationTriggered) return
    setBackgroundHydrationTriggered(false)
    const tid = terminalIdRef.current
    if (!tid || !hiddenRef.current) return
    const checkpointDecision = getCheckpointDeltaReplayDecision(tid)
    if (checkpointDecision.ok) {
      attachTerminal(tid, 'keepalive_delta', {
        clearViewportFirst: false,
        priority: 'background',
        sinceSeq: checkpointDecision.sinceSeq,
      })
      return
    }
    attachTerminal(tid, 'viewport_hydrate', {
      clearViewportFirst: true,
      priority: 'background',
      ...viewportHydrateReplayOptions(contentRef.current),
    })
  }, [backgroundHydrationTriggered, attachTerminal, getCheckpointDeltaReplayDecision])

  // Create or attach to backend terminal
  useEffect(() => {
    if (suppressNetworkEffects) return
    if (!isTerminal || !terminalContent) return
    const termCandidate = termRef.current
    if (!termCandidate) return
    const term = termCandidate
    turnCompleteSignalStateRef.current = createTurnCompleteSignalParserState()
    resetStartupProbeParser()
    osc52ParserRef.current = createOsc52ParserState()
    osc52QueueRef.current = []
    pendingOsc52EventRef.current = null
    setPendingOsc52Event(null)

    // NOTE: We intentionally don't destructure terminalId here.
    // We read it from terminalIdRef.current to avoid stale closures.
    const { createRequestId, mode, shell, initialCwd } = terminalContent

    let unsub = () => {}
    let unsubReconnect = () => {}

    const clearRateLimitRetry = () => {
      const retryState = rateLimitRetryRef.current
      if (retryState.timer) {
        clearTimeout(retryState.timer)
        retryState.timer = null
      }
      retryState.count = 0
    }

    const getRestoreFlag = (requestId: string) => {
      if (restoreRequestIdRef.current !== requestId) {
        restoreRequestIdRef.current = requestId
        restoreFlagRef.current = consumeTerminalRestoreRequestId(requestId)
      }
      return restoreFlagRef.current
    }

    const getFreshRecoveryIntent = (requestId: string) => {
      if (freshRecoveryRequestIdRef.current !== requestId) {
        freshRecoveryRequestIdRef.current = requestId
        freshRecoveryIntentRef.current = consumeTerminalFreshRecoveryRequest(requestId)
      }
      return freshRecoveryIntentRef.current
    }

    const sendCreate = (requestId: string) => {
      const recoveryIntent = getFreshRecoveryIntent(requestId)
      const restore = recoveryIntent ? false : getRestoreFlag(requestId)
      const createSessionState = getCreateSessionStateFromRef(contentRef)
      launchAttemptRef.current = {
        requestId,
        restore,
        ...(recoveryIntent ? { recoveryIntent } : {}),
        attachReady: false,
      }
      if (handledCreatedMessageRef.current?.requestId === requestId) {
        handledCreatedMessageRef.current = null
      }
      if (debugRef.current) log.debug('[TRACE resumeSessionId] sendCreate', {
        paneId: paneIdRef.current,
        requestId,
        sessionRef: createSessionState.sessionRef,
        liveTerminal: createSessionState.liveTerminal,
        contentRefResumeSessionId: contentRef.current?.resumeSessionId,
        codexDurability: createSessionState.codexDurability,
        mode,
        recoveryIntent,
      })
      ws.send({
        type: 'terminal.create',
        requestId,
        mode,
        shell: shell || 'system',
        cwd: initialCwd,
        ...(!recoveryIntent && createSessionState.sessionRef ? { sessionRef: createSessionState.sessionRef } : {}),
        ...(!recoveryIntent && createSessionState.codexDurability ? { codexDurability: createSessionState.codexDurability } : {}),
        ...(!recoveryIntent && createSessionState.liveTerminal ? { liveTerminal: createSessionState.liveTerminal } : {}),
        tabId,
        paneId: paneIdRef.current,
        ...(restore ? { restore: true } : {}),
        ...(recoveryIntent ? { recoveryIntent } : {}),
      })
    }

    const scheduleRateLimitRetry = (requestId: string) => {
      const retryState = rateLimitRetryRef.current
      if (retryState.count >= RATE_LIMIT_RETRY_MAX_ATTEMPTS) return false
      retryState.count += 1
      const delayMs = Math.min(
        RATE_LIMIT_RETRY_BASE_MS * (2 ** (retryState.count - 1)),
        RATE_LIMIT_RETRY_MAX_MS
      )
      if (retryState.timer) clearTimeout(retryState.timer)
      retryState.timer = setTimeout(() => {
        retryState.timer = null
        if (requestIdRef.current !== requestId) return
        sendCreate(requestId)
      }, delayMs)
      writeLocalXtermNotice(term, `\r\n[Rate limited - retrying in ${(delayMs / 1000).toFixed(0)}s]\r\n`)
      return true
    }

    const completeDurableReplacement = (pending: PendingDurableReplacement) => {
      if (pendingDurableReplacementRef.current?.requestId !== pending.requestId) {
        return
      }
      pendingDurableReplacementRef.current = null
      addTerminalRestoreRequestId(pending.requestId)
      requestIdRef.current = pending.requestId
      terminalIdRef.current = undefined
      launchAttemptRef.current = null
      clearQuarantineRepair()
      currentAttachRef.current = null
      deferredAttachStateRef.current = {
        mode: 'none',
        pendingIntent: null,
        pendingSinceSeq: 0,
        pendingReason: 'initial_hydrate',
      }
      setIsAttaching(false)
      setTruncatedHistoryGap(null)
      dispatch(clearPaneRuntimeActivity({ paneId: paneIdRef.current }))
      applySeqState(createAttachSeqState())
      updateContent({
        terminalId: undefined,
        serverInstanceId: undefined,
        streamId: undefined,
        createRequestId: pending.requestId,
        status: 'creating',
        restoreError: undefined,
      })
      const currentTab = tabRef.current
      if (currentTab) {
        dispatch(updateTab({ id: currentTab.id, updates: { status: 'creating' } }))
      }
    }

    const beginOpenCodeReplacementAfterExit = (terminalId: string) => {
      const current = contentRef.current
      const sessionRef = current?.sessionRef
      if (
        current?.mode !== 'opencode'
        || sessionRef?.provider !== 'opencode'
        || !sessionRef.sessionId
      ) {
        return false
      }

      const existing = pendingDurableReplacementRef.current
      if (existing?.terminalId === terminalId) {
        return true
      }

      const requestId = nanoid()
      pendingDurableReplacementRef.current = {
        terminalId,
        requestId,
        reason: 'opencode_replay_window_exceeded',
      }
      clearRateLimitRetry()
      clearQuarantineRepair()
      currentAttachRef.current = null
      launchAttemptRef.current = null
      deferredAttachStateRef.current = {
        mode: 'none',
        pendingIntent: null,
        pendingSinceSeq: 0,
        pendingReason: 'initial_hydrate',
      }
      setIsAttaching(true)
      setTruncatedHistoryGap(null)
      dispatch(clearPaneRuntimeActivity({ paneId: paneIdRef.current }))
      clearTerminalCursor(terminalId)
      resetParserAppliedSurface()
      forgetSentViewport(terminalId)
      lastSentViewportRef.current = null
      applySeqState(createAttachSeqState())
      writeLocalXtermNotice(term, '\r\n[Restarting OpenCode session because the saved terminal replay is no longer available]\r\n')
      ws.send({ type: 'terminal.kill', terminalId })
      return true
    }

    async function ensure() {
      clearRateLimitRetry()
      // Connection is owned by App.tsx; messages will queue until ready

      const failLaunch = (message: string, restore: boolean, terminalId?: string) => {
        clearRateLimitRetry()
        clearQuarantineRepair()
        setIsAttaching(false)
        currentAttachRef.current = null
        deferredAttachStateRef.current = {
          mode: 'none',
          pendingIntent: null,
          pendingSinceSeq: 0,
          pendingReason: 'initial_hydrate',
        }
        dispatch(clearPaneRuntimeActivity({ paneId: paneIdRef.current }))
        if (terminalId) {
          clearTerminalCursor(terminalId)
          resetParserAppliedSurface()
          forgetSentViewport(terminalId)
        }
        lastSentViewportRef.current = null
        terminalIdRef.current = undefined
        launchAttemptRef.current = null
        applySeqState(createAttachSeqState())
        updateContent({ terminalId: undefined, streamId: undefined, status: 'error' })
        const currentTab = tabRef.current
        if (currentTab) {
          dispatch(updateTab({ id: currentTab.id, updates: { status: 'error' } }))
        }
        const prefix = restore ? '[Restore failed]' : '[Launch failed]'
        writeLocalXtermNotice(term, `\r\n${prefix} ${message}\r\n`)
      }

      unsub = ws.onMessage((msg) => {
        const tid = terminalIdRef.current
        const reqId = requestIdRef.current

        const markFirstOutputIfNeeded = (raw: string) => {
          if (
            raw.length > 0
            && !terminalFirstOutputMarkedRef.current
            && activeTabId === tabId
            && activePaneId === paneId
            && !hiddenRef.current
          ) {
            getInstalledPerfAuditBridge()?.mark('terminal.first_output', {
              tabId,
              paneId,
              terminalId: tid,
            })
            terminalFirstOutputMarkedRef.current = true
          }
        }

        const completeParserAppliedFrame = (input: {
          attachRequestId?: string
          mode: TerminalPaneContent['mode']
          terminalInstanceId: string
          parserAppliedSeq: number
          completedAttach: boolean
        }) => {
          const activeAttach = currentAttachRef.current
          if (!activeAttach || activeAttach.requestId !== input.attachRequestId) return
          if (terminalInstanceIdRef.current !== input.terminalInstanceId) return
          if (!shouldAllowTerminalOutputSideEffect({
            terminalInstanceId: input.terminalInstanceId,
            effect: 'parser_applied_checkpoint',
            mode: input.mode,
            generation: input.attachRequestId,
          })) {
            return
          }
          const nextSeqState = markParserAppliedSeq(seqStateRef.current, input.parserAppliedSeq)
          applySeqState(nextSeqState)
          markParserAppliedFrame(tid, nextSeqState.parserAppliedSeq, activeAttach)
          if (input.completedAttach) {
            completeAttachGeneration({
              attachRequestId: input.attachRequestId,
              mode: input.mode,
              terminalInstanceId: input.terminalInstanceId,
              terminalId: tid,
              allowWithoutWriteScope: false,
            })
          }
        }

        const completeAttachGeneration = (input: {
          attachRequestId?: string
          mode: TerminalPaneContent['mode']
          terminalInstanceId: string
          terminalId?: string
          allowWithoutWriteScope: boolean
        }) => {
          const activeAttach = currentAttachRef.current
          if (!activeAttach || activeAttach.requestId !== input.attachRequestId) return false
          if (input.terminalId && activeAttach.terminalId !== input.terminalId) return false
          if (terminalInstanceIdRef.current !== input.terminalInstanceId) return false
          const allowedByWriteScope = shouldAllowTerminalOutputSideEffect({
            terminalInstanceId: input.terminalInstanceId,
            effect: 'attach_completion',
            mode: input.mode,
            generation: input.attachRequestId,
          })
          if (!allowedByWriteScope) {
            const activeScope = getTerminalOutputWriteScope(input.terminalInstanceId)
            if (!input.allowWithoutWriteScope || activeScope) return false
          }
          setIsAttaching(false)
          markAttachComplete()
          return true
        }

        const submitAcceptedOutput = (input: {
          raw: string
          seqStart: number
          seqEnd: number
          attachRequestId?: string
          mode: TerminalPaneContent['mode']
          previousSeqState: AttachSeqState
          outputSource: TerminalOutputSource
          parserAppliedSeq: number
          completedAttach: boolean
          disableWriteCoalescing?: boolean
        }) => {
          let raw = input.raw
          const frameOverlapsReplay = input.outputSource === 'replay' || Boolean(
            input.previousSeqState.pendingReplay
            && input.seqEnd >= input.previousSeqState.pendingReplay.fromSeq
            && input.seqStart <= input.previousSeqState.pendingReplay.toSeq,
          )
          const enteringFreshLiveOutput = input.outputSource === 'live'
            && !frameOverlapsReplay
            && (Boolean(input.previousSeqState.pendingReplay) || input.previousSeqState.awaitingFreshSequence)
          if (
            enteringFreshLiveOutput
            && !startupProbeReplayDiscardStateRef.current.remainder
            && !startupProbeReplayDiscardStateRef.current.buffered
          ) {
            resetStartupProbeParser({ discardReplayRemainder: Boolean(input.previousSeqState.pendingReplay) })
          }
          const replayDiscard = consumeStartupProbeReplayDiscard(raw, startupProbeReplayDiscardStateRef.current)
          if (replayDiscard.resumeState) {
            startupProbeStateRef.current = replayDiscard.resumeState
          }
          raw = replayDiscard.raw
          const inputBytesEqualSubmission = raw === input.raw
          const outputTerminalInstanceId = terminalInstanceIdRef.current
          const completeNoWriteReplayAttach = () => {
            completeAttachGeneration({
              attachRequestId: input.attachRequestId,
              mode: input.mode,
              terminalInstanceId: outputTerminalInstanceId,
              terminalId: tid,
              allowWithoutWriteScope: true,
            })
          }
          const queueNoWriteReplayAttachCompletion = () => {
            const queue = writeQueueRef.current
            if (queue) {
              queue.enqueueTask(completeNoWriteReplayAttach, {
                mode: input.outputSource,
                generation: input.attachRequestId,
              })
              return
            }
            completeNoWriteReplayAttach()
          }
          const submission = handleTerminalOutput(
            raw,
            input.mode,
            tid,
            input.outputSource === 'live',
            inputBytesEqualSubmission
              ? () => completeParserAppliedFrame({
                  attachRequestId: input.attachRequestId,
                  mode: input.mode,
                  terminalInstanceId: outputTerminalInstanceId,
                  parserAppliedSeq: input.parserAppliedSeq,
                  completedAttach: input.completedAttach,
                })
              : undefined,
            {
              mode: input.outputSource,
              generation: input.attachRequestId,
              coalesce: input.disableWriteCoalescing ? false : undefined,
            },
          )
          if (
            !submission.submittedWrite
            || !inputBytesEqualSubmission
            || !submission.submittedBytesEqualInput
          ) {
            applySeqState(markOutputRangeUnapplied(seqStateRef.current, {
              fromSeq: input.seqStart,
              toSeq: input.seqEnd,
            }))
            if (input.completedAttach && frameOverlapsReplay) {
              queueNoWriteReplayAttachCompletion()
            }
          }
          if (input.completedAttach && frameOverlapsReplay) {
            resetStartupProbeParser({ discardReplayRemainder: true })
          }
          markFirstOutputIfNeeded(raw)
        }

        if (msg.type === 'terminal.output.batch' && msg.terminalId === tid) {
          if (!isCurrentAttachStreamMessage(msg)) {
            if (debugRef.current) {
              log.debug('Ignoring stale attach generation message', {
                paneId: paneIdRef.current,
                terminalId: msg.terminalId,
                attachRequestId: msg.attachRequestId,
                currentAttachRequestId: currentAttachRef.current?.requestId,
                currentAttachStreamId: currentAttachRef.current?.streamId,
                streamId: msg.streamId,
                type: msg.type,
              })
            }
            return
          }

          const outputSource = msg.source === 'live' || msg.source === 'replay'
            ? msg.source
            : null
          const batchDataInput = msg.data
          const batchData = typeof batchDataInput === 'string' ? batchDataInput : ''
          const rawSegmentsInput = Array.isArray(msg.segments) ? msg.segments : []
          const batchSeqStart = msg.seqStart
          const batchSeqEnd = msg.seqEnd
          const batchSerializedBytes = msg.serializedBytes
          const batchSegments: Array<{
            seqStart: number
            seqEnd: number
            data: string
            barrier: boolean
          }> = []
          let previousEndOffset = 0
          let previousSeqEnd: number | null = null
          let invalidBatchReason: string | null = null

          if (!outputSource) {
            invalidBatchReason = 'invalid_source'
          } else if (typeof batchDataInput !== 'string') {
            invalidBatchReason = 'invalid_batch_data'
          } else if (rawSegmentsInput.length === 0) {
            invalidBatchReason = 'missing_segments'
          } else if (
            typeof batchSeqStart !== 'number'
            || typeof batchSeqEnd !== 'number'
            || !Number.isFinite(batchSeqStart)
            || !Number.isFinite(batchSeqEnd)
            || !Number.isInteger(batchSeqStart)
            || !Number.isInteger(batchSeqEnd)
            || batchSeqStart < 0
            || batchSeqEnd < batchSeqStart
          ) {
            invalidBatchReason = 'invalid_batch_range'
          } else if (
            typeof batchSerializedBytes !== 'number'
            || !Number.isFinite(batchSerializedBytes)
            || !Number.isInteger(batchSerializedBytes)
            || batchSerializedBytes < 0
          ) {
            invalidBatchReason = 'invalid_batch_serialized_bytes'
          }

          for (const rawSegment of rawSegmentsInput) {
            if (invalidBatchReason) break
            const seqStart = rawSegment?.seqStart
            const seqEnd = rawSegment?.seqEnd
            const endOffset = rawSegment?.endOffset
            const rawFrameCount = rawSegment?.rawFrameCount
            if (
              typeof seqStart !== 'number'
              || typeof seqEnd !== 'number'
              || typeof endOffset !== 'number'
              || typeof rawFrameCount !== 'number'
              || !Number.isFinite(seqStart)
              || !Number.isFinite(seqEnd)
              || !Number.isFinite(endOffset)
              || !Number.isFinite(rawFrameCount)
              || !Number.isInteger(seqStart)
              || !Number.isInteger(seqEnd)
              || !Number.isInteger(endOffset)
              || !Number.isInteger(rawFrameCount)
              || seqStart < 0
              || seqEnd < seqStart
              || endOffset < 0
              || rawFrameCount <= 0
              || rawFrameCount !== seqEnd - seqStart + 1
            ) {
              invalidBatchReason = 'invalid_segment_range'
              break
            }
            const barrier = rawSegment?.barrier
            if (
              barrier !== undefined
              && (
                typeof barrier !== 'string'
                || !TERMINAL_OUTPUT_BATCH_BARRIER_REASONS.has(barrier)
              )
            ) {
              invalidBatchReason = 'invalid_segment_barrier'
              break
            }
            if (previousSeqEnd !== null && seqStart !== previousSeqEnd + 1) {
              invalidBatchReason = 'non_contiguous_segment_range'
              break
            }
            const normalizedEndOffset = endOffset
            if (
              normalizedEndOffset < previousEndOffset
              || normalizedEndOffset > batchData.length
            ) {
              invalidBatchReason = 'invalid_segment_offset'
              break
            }
            if (
              isUtf16SurrogateSplitOffset(batchData, previousEndOffset)
              || isUtf16SurrogateSplitOffset(batchData, normalizedEndOffset)
            ) {
              invalidBatchReason = 'invalid_segment_offset'
              break
            }
            const segmentData = batchData.slice(previousEndOffset, normalizedEndOffset)
            if (typeof rawSegment.data === 'string' && rawSegment.data !== segmentData) {
              invalidBatchReason = 'segment_data_mismatch'
              break
            }
            batchSegments.push({
              seqStart,
              seqEnd,
              data: segmentData,
              barrier: typeof barrier === 'string' && barrier.length > 0,
            })
            previousEndOffset = normalizedEndOffset
            previousSeqEnd = seqEnd
          }

          if (!invalidBatchReason && previousEndOffset !== batchData.length) {
            invalidBatchReason = 'trailing_batch_data'
          }
          if (
            !invalidBatchReason
            && (
              batchSegments[0]?.seqStart !== batchSeqStart
              || batchSegments[batchSegments.length - 1]?.seqEnd !== batchSeqEnd
            )
          ) {
            invalidBatchReason = 'batch_range_mismatch'
          }

          if (invalidBatchReason) {
            markTerminalOutputRangeLost({
              terminalId: tid,
              messageType: msg.type,
              attachRequestId: msg.attachRequestId,
              streamId: msg.streamId,
              fromSeq: batchSeqStart,
              toSeq: batchSeqEnd,
              reason: 'invalid_terminal_output_batch',
              invalidReason: invalidBatchReason,
            })
            if (import.meta.env.DEV) {
              log.warn('Ignoring invalid terminal.output.batch', {
                paneId: paneIdRef.current,
                terminalId: tid,
                reason: invalidBatchReason,
              })
            }
            return
          }
          if (!outputSource) return

          const previousSeqState = seqStateRef.current
          const batchDecision = onOutputBatchSegments(previousSeqState, batchSegments)
          if (!batchDecision.accept) {
            if (import.meta.env.DEV) {
              log.warn('Ignoring overlapping terminal.output.batch sequence range', {
                paneId: paneIdRef.current,
                terminalId: tid,
                rejectedSegment: batchDecision.rejectedSegment,
                lastSeq: previousSeqState.lastSeq,
              })
            }
            return
          }

          if (tid && batchDecision.freshReset) {
            clearTerminalCursor(tid)
            resetParserAppliedSurface()
          }

          const mode = contentRef.current?.mode || 'shell'
          const completedAttachOnBatch = !batchDecision.state.pendingReplay
            && (Boolean(previousSeqState.pendingReplay) || previousSeqState.awaitingFreshSequence)
          applySeqState(batchDecision.state)

          const containsBarrier = batchSegments.some((segment) => segment.barrier)
          if (!containsBarrier) {
            submitAcceptedOutput({
              raw: batchData,
              seqStart: msg.seqStart,
              seqEnd: msg.seqEnd,
              attachRequestId: msg.attachRequestId,
              mode,
              previousSeqState,
              outputSource,
              parserAppliedSeq: batchDecision.state.highestObservedSeq,
              completedAttach: completedAttachOnBatch,
            })
            return
          }

          batchSegments.forEach((segment, index) => {
            const acceptedSegment: OutputBatchAcceptedSegment | undefined = batchDecision.segments[index]
            if (!acceptedSegment) return
            submitAcceptedOutput({
              raw: segment.data,
              seqStart: segment.seqStart,
              seqEnd: segment.seqEnd,
              attachRequestId: msg.attachRequestId,
              mode,
              previousSeqState: acceptedSegment.previousState,
              outputSource,
              parserAppliedSeq: acceptedSegment.parserAppliedSeq,
              completedAttach: completedAttachOnBatch && index === batchSegments.length - 1,
              disableWriteCoalescing: true,
            })
          })
          return
        }

        if (msg.type === 'terminal.output' && msg.terminalId === tid) {
          if (!isCurrentAttachStreamMessage(msg)) {
            if (debugRef.current) {
              log.debug('Ignoring stale attach generation message', {
                paneId: paneIdRef.current,
                terminalId: msg.terminalId,
                attachRequestId: msg.attachRequestId,
                currentAttachRequestId: currentAttachRef.current?.requestId,
                currentAttachStreamId: currentAttachRef.current?.streamId,
                streamId: msg.streamId,
                type: msg.type,
              })
            }
            return
          }

          if (typeof msg.seqStart !== 'number' || typeof msg.seqEnd !== 'number') {
            if (import.meta.env.DEV) {
              log.warn('Ignoring terminal.output without sequence range', {
                paneId: paneIdRef.current,
                terminalId: tid,
              })
            }
            return
          }
          const previousSeqState = seqStateRef.current
          const frameDecision = onOutputFrame(previousSeqState, {
            seqStart: msg.seqStart,
            seqEnd: msg.seqEnd,
          })
          if (!frameDecision.accept) {
            if (import.meta.env.DEV) {
              log.warn('Ignoring overlapping terminal.output sequence range', {
                paneId: paneIdRef.current,
                terminalId: tid,
                seqStart: msg.seqStart,
                seqEnd: msg.seqEnd,
                lastSeq: previousSeqState.lastSeq,
              })
            }
            return
          }

          if (tid && frameDecision.freshReset) {
            clearTerminalCursor(tid)
            resetParserAppliedSurface()
          }
          const mode = contentRef.current?.mode || 'shell'
          const frameOverlapsReplay = Boolean(
            previousSeqState.pendingReplay
            && msg.seqEnd >= previousSeqState.pendingReplay.fromSeq
            && msg.seqStart <= previousSeqState.pendingReplay.toSeq,
          )
          const completedAttachOnFrame = !frameDecision.state.pendingReplay
            && (Boolean(previousSeqState.pendingReplay) || previousSeqState.awaitingFreshSequence)
          applySeqState(frameDecision.state)
          submitAcceptedOutput({
            raw: msg.data || '',
            seqStart: msg.seqStart,
            seqEnd: msg.seqEnd,
            attachRequestId: msg.attachRequestId,
            mode,
            previousSeqState,
            outputSource: frameOverlapsReplay ? 'replay' : 'live',
            parserAppliedSeq: frameDecision.state.highestObservedSeq,
            completedAttach: completedAttachOnFrame,
          })
        }

        if (msg.type === 'terminal.output.gap' && msg.terminalId === tid) {
          if (!isCurrentAttachStreamMessage(msg)) {
            if (debugRef.current) {
              log.debug('Ignoring stale attach generation message', {
                paneId: paneIdRef.current,
                terminalId: msg.terminalId,
                attachRequestId: msg.attachRequestId,
                currentAttachRequestId: currentAttachRef.current?.requestId,
                currentAttachStreamId: currentAttachRef.current?.streamId,
                streamId: msg.streamId,
                type: msg.type,
              })
            }
            return
          }

          // Only show "load more" when the server confirms the gap is from
          // byte-budget truncation (recoverable), not ring overflow (data gone).
          const isTruncatedReplay = msg.reason === 'replay_budget_exceeded'
            && seqStateRef.current.pendingReplay
          const isUnrecoverableOpenCodeViewportHydrate = msg.reason === 'replay_window_exceeded'
            && currentAttachRef.current?.intent === 'viewport_hydrate'
            && currentAttachRef.current.sinceSeq === 0
            && !hiddenRef.current
            && contentRef.current?.mode === 'opencode'
            && contentRef.current.sessionRef?.provider === 'opencode'
          if (isUnrecoverableOpenCodeViewportHydrate && beginOpenCodeReplacementAfterExit(tid)) {
            return
          }

          if (isTruncatedReplay) {
            setTruncatedHistoryGap({ fromSeq: msg.fromSeq, toSeq: msg.toSeq })
          } else {
            const reason = msg.reason === 'replay_window_exceeded'
              ? 'reconnect window exceeded'
              : 'slow link backlog'
            writeLocalXtermNotice(term, `\r\n[Output gap ${msg.fromSeq}-${msg.toSeq}: ${reason}]\r\n`)
          }
          const previousSeqState = seqStateRef.current
          const gapDecision = onOutputGap(previousSeqState, { fromSeq: msg.fromSeq, toSeq: msg.toSeq })
          const nextSeqState = gapDecision.state
          applySeqState(nextSeqState)
          resetParserAppliedSurface(parserAppliedSeqRef.current)
          if (gapDecision.requiresSurfaceQuarantine) {
            recordTerminalPerfAuditEvent('terminal.catchup.surface_quarantined', {
              terminalId: tid,
              attachRequestId: msg.attachRequestId,
              activeAttachRequestId: currentAttachRef.current?.requestId,
              streamId: msg.streamId,
              fromSeq: msg.fromSeq,
              toSeq: msg.toSeq,
              parserAppliedSeq: parserAppliedSeqRef.current,
              highestObservedSeq: nextSeqState.highestObservedSeq,
              reason: msg.reason ?? 'output_gap',
            })
          }
          const completedAttachOnGap = !nextSeqState.pendingReplay
            && (Boolean(previousSeqState.pendingReplay) || previousSeqState.awaitingFreshSequence)
          if (completedAttachOnGap) {
            resetStartupProbeParser({ discardReplayRemainder: Boolean(previousSeqState.pendingReplay) })
            setIsAttaching(false)
            markAttachComplete()
          }
        }

        if (msg.type === 'terminal.stream.changed' && msg.terminalId === tid) {
          if (!isCurrentAttachMessage(msg)) {
            if (debugRef.current) {
              log.debug('Ignoring stale attach generation stream change', {
                paneId: paneIdRef.current,
                terminalId: msg.terminalId,
                attachRequestId: msg.attachRequestId,
                currentAttachRequestId: currentAttachRef.current?.requestId,
                type: msg.type,
              })
            }
            return
          }

          const nextStreamId = typeof msg.streamId === 'string' && msg.streamId.length > 0
            ? msg.streamId
            : null
          const previousStreamId = getTerminalCheckpointStreamId()
          const activeAttach = currentAttachRef.current
          if (activeAttach?.terminalId === tid && activeAttach.requestId === msg.attachRequestId) {
            currentAttachRef.current = {
              ...activeAttach,
              streamId: nextStreamId,
            }
          }
          resetParserAppliedSurface(parserAppliedSeqRef.current)
          if (nextStreamId) {
            if (previousStreamId !== nextStreamId) {
              updateContent({ streamId: nextStreamId })
            }
          } else if (previousStreamId) {
            updateContent({ streamId: undefined })
          }
        }

        if (msg.type === 'terminal.attach.ready' && msg.terminalId === tid) {
          if (!isCurrentAttachMessage(msg)) {
            if (debugRef.current) {
              log.debug('Ignoring stale attach generation message', {
                paneId: paneIdRef.current,
                terminalId: msg.terminalId,
                attachRequestId: msg.attachRequestId,
                currentAttachRequestId: currentAttachRef.current?.requestId,
                type: msg.type,
              })
            }
            return
          }

          const readyStreamId = typeof msg.streamId === 'string' && msg.streamId.length > 0
            ? msg.streamId
            : null
          const readyGeometryAuthority = parseTerminalGeometryAuthority(
            (msg as { geometryAuthority?: unknown }).geometryAuthority,
          ) ?? geometryAuthorityRef.current
          const readyGeometryEpoch = normalizeGeometryEpoch(
            (msg as { geometryEpoch?: unknown }).geometryEpoch,
            geometryEpochRef.current,
          )
          const previousStreamId = getTerminalCheckpointStreamId()
          const activeAttach = currentAttachRef.current
          const expectedStreamId = activeAttach?.expectedStreamId ?? previousStreamId
          const expectedGeometryAuthority = activeAttach?.expectedGeometryAuthority ?? geometryAuthorityRef.current
          const expectedGeometryEpoch = activeAttach?.expectedGeometryEpoch ?? geometryEpochRef.current
          const incompatibleDeltaStream = activeAttach?.terminalId === tid
            && activeAttach.requestId === msg.attachRequestId
            && activeAttach.sinceSeq > 0
            && typeof expectedStreamId === 'string'
            && expectedStreamId.length > 0
            && readyStreamId !== expectedStreamId
          const incompatibleDeltaGeometry = activeAttach?.terminalId === tid
            && activeAttach.requestId === msg.attachRequestId
            && activeAttach.sinceSeq > 0
            && (
              readyGeometryAuthority === 'multi_client_unknown'
              || readyGeometryAuthority !== expectedGeometryAuthority
              || readyGeometryEpoch !== expectedGeometryEpoch
            )
          geometryAuthorityRef.current = readyGeometryAuthority
          geometryEpochRef.current = readyGeometryEpoch
          if (incompatibleDeltaStream) {
            log.warn('Rejecting warm-delta terminal attach after stream identity changed', {
              paneId: paneIdRef.current,
              terminalId: tid,
              attachRequestId: msg.attachRequestId,
              expectedStreamId,
              readyStreamId,
              sinceSeq: activeAttach.sinceSeq,
            })
            recordTerminalPerfAuditEvent('terminal.catchup.full_hydrate_fallback', {
              terminalId: tid,
              attachRequestId: msg.attachRequestId,
              activeAttachRequestId: activeAttach.requestId,
              streamId: readyStreamId,
              expectedStreamId,
              sinceSeq: activeAttach.sinceSeq,
              reason: 'stream_identity_changed',
            })
            resetParserAppliedSurface(parserAppliedSeqRef.current)
            updateContent({ streamId: undefined })
            attachTerminal(tid, 'viewport_hydrate', {
              clearViewportFirst: true,
              ...viewportHydrateReplayOptions(contentRef.current),
            })
            return
          }
          if (incompatibleDeltaGeometry) {
            const reason = readyGeometryAuthority === 'multi_client_unknown'
              ? 'geometry_authority_unknown'
              : 'geometry_changed'
            log.warn('Rejecting warm-delta terminal attach after geometry authority changed', {
              paneId: paneIdRef.current,
              terminalId: tid,
              attachRequestId: msg.attachRequestId,
              expectedGeometryAuthority,
              expectedGeometryEpoch,
              geometryAuthority: readyGeometryAuthority,
              geometryEpoch: readyGeometryEpoch,
              sinceSeq: activeAttach.sinceSeq,
              reason,
            })
            recordTerminalPerfAuditEvent('terminal.catchup.full_hydrate_fallback', {
              terminalId: tid,
              attachRequestId: msg.attachRequestId,
              activeAttachRequestId: activeAttach.requestId,
              streamId: readyStreamId,
              expectedStreamId,
              geometryAuthority: readyGeometryAuthority,
              geometryEpoch: readyGeometryEpoch,
              expectedGeometryAuthority,
              expectedGeometryEpoch,
              sinceSeq: activeAttach.sinceSeq,
              reason,
            })
            resetParserAppliedSurface(parserAppliedSeqRef.current)
            attachTerminal(tid, 'viewport_hydrate', {
              clearViewportFirst: true,
              ...viewportHydrateReplayOptions(contentRef.current),
            })
            return
          }
          if (activeAttach?.terminalId === tid && activeAttach.requestId === msg.attachRequestId) {
            currentAttachRef.current = {
              ...activeAttach,
              streamId: readyStreamId,
              geometryAuthority: readyGeometryAuthority,
              geometryEpoch: readyGeometryEpoch,
            }
          }
          if (readyStreamId) {
            if (previousStreamId !== readyStreamId) {
              if (previousStreamId) {
                resetParserAppliedSurface(parserAppliedSeqRef.current)
              }
              updateContent({ streamId: readyStreamId })
            }
          } else {
            resetParserAppliedSurface(parserAppliedSeqRef.current)
            if (previousStreamId) {
              updateContent({ streamId: undefined })
            }
          }

          if (launchAttemptRef.current?.terminalId === tid) {
            launchAttemptRef.current = {
              ...launchAttemptRef.current,
              attachReady: true,
            }
          }

          const attachSessionRef = (msg as { sessionRef?: TerminalPaneContent['sessionRef'] }).sessionRef
          if (attachSessionRef) {
            const associationResult = reconcileTerminalSessionAssociation({
              dispatch,
              getState: appStore.getState,
              terminalId: tid,
              sessionRef: attachSessionRef,
            })
            if (associationResult === 'reconciled') {
              syncContentRefWithSessionAssociation(attachSessionRef)
            }
          }

          const nextSeqState = onAttachReady(seqStateRef.current, {
            headSeq: msg.headSeq,
            replayFromSeq: msg.replayFromSeq,
            replayToSeq: msg.replayToSeq,
          })
          applySeqState(nextSeqState)
          setIsAttaching(Boolean(nextSeqState.pendingReplay))
          if (!nextSeqState.pendingReplay) {
            markAttachComplete()
          }
        }

        if (msg.type === 'terminal.created' && msg.requestId === reqId) {
          clearRateLimitRetry()
          const newId = msg.terminalId as string
          const handled = handledCreatedMessageRef.current
          if (handled?.requestId === reqId && handled.terminalId === newId) {
            if (debugRef.current) {
              log.debug('Ignoring duplicate terminal.created for handled request', {
                paneId: paneIdRef.current,
                requestId: reqId,
                terminalId: newId,
              })
            }
            return
          }
          handledCreatedMessageRef.current = {
            requestId: reqId,
            terminalId: newId,
          }
          const pendingLaunch = launchAttemptRef.current
          launchAttemptRef.current = {
            requestId: reqId,
            terminalId: newId,
            restore: pendingLaunch?.requestId === reqId ? pendingLaunch.restore : false,
            ...(pendingLaunch?.requestId === reqId && pendingLaunch.recoveryIntent
              ? { recoveryIntent: pendingLaunch.recoveryIntent }
              : {}),
            attachReady: false,
          }
          clearQuarantineRepair()
          currentAttachRef.current = null
          if (debugRef.current) log.debug('[TRACE resumeSessionId] terminal.created received', {
            paneId: paneIdRef.current,
            requestId: reqId,
            terminalId: newId,
            currentResumeSessionId: contentRef.current?.resumeSessionId,
          })
          const createdSessionRef = (msg as { sessionRef?: TerminalPaneContent['sessionRef'] }).sessionRef
          const createdCwd = typeof msg.cwd === 'string' && msg.cwd.trim() ? msg.cwd : undefined
          const createdSessionUpdates = buildSessionAssociationContentUpdates(contentRef.current, createdSessionRef)
          terminalIdRef.current = newId
          updateContent({
            terminalId: newId,
            serverInstanceId: serverInstanceIdRef.current,
            streamId: undefined,
            status: 'running',
            ...(createdCwd && !contentRef.current?.initialCwd ? { initialCwd: createdCwd } : {}),
            ...(createdSessionUpdates ?? {}),
            ...(msg.clearCodexDurability ? { codexDurability: undefined } : {}),
            ...(msg.restoreError ? { restoreError: msg.restoreError } : {}),
          })
          if (createdSessionRef) {
            const associationResult = reconcileTerminalSessionAssociation({
              dispatch,
              getState: appStore.getState,
              terminalId: newId,
              sessionRef: createdSessionRef,
            })
            if (associationResult === 'reconciled') {
              syncContentRefWithSessionAssociation(createdSessionRef)
            }
          }
          // Also update tab status
          const currentTab = tabRef.current
          if (currentTab) {
            dispatch(updateTab({
              id: currentTab.id,
              updates: {
                status: 'running',
                ...(msg.clearCodexDurability ? { codexDurability: undefined } : {}),
              },
            }))
          }

          applySeqState(createAttachSeqState({ lastSeq: 0 }))
          if (hiddenRef.current) {
            deferredAttachStateRef.current = {
              mode: 'waiting_for_geometry',
              pendingIntent: 'viewport_hydrate',
              pendingSinceSeq: 0,
              pendingReason: 'terminal_created',
            }
            setIsAttaching(false)
          } else {
            attachTerminal(newId, 'viewport_hydrate', { clearViewportFirst: true })
          }
        }

        if (msg.type === 'terminal.status' && msg.terminalId === tid) {
          if (
            msg.status === 'running'
            || msg.status === 'recovering'
          ) {
            updateContent({ status: msg.status })
            const statusTab = tabRef.current
            if (statusTab) {
              dispatch(updateTab({ id: statusTab.id, updates: { status: msg.status } }))
            }
          }
          return
        }

        if (msg.type === 'terminal.exit' && msg.terminalId === tid) {
          const pendingReplacement = pendingDurableReplacementRef.current
          if (pendingReplacement?.terminalId === tid) {
            completeDurableReplacement(pendingReplacement)
            return
          }

          const launchAttempt = launchAttemptRef.current
          const exitedDuringLaunch = launchAttempt?.terminalId === tid && !launchAttempt.attachReady
          if (exitedDuringLaunch) {
            const exitSuffix = typeof msg.exitCode === 'number' ? ` (exit ${msg.exitCode})` : ''
            const message = launchAttempt.restore
              ? `The restored terminal exited before it finished starting${exitSuffix}. Fix the underlying CLI or working directory, then refresh to retry.`
              : `The terminal exited before it finished starting${exitSuffix}. Fix the underlying CLI or working directory, then retry.`
            failLaunch(message, launchAttempt.restore, tid)
            return
          }

          launchAttemptRef.current = null
          clearQuarantineRepair()
          currentAttachRef.current = null
          deferredAttachStateRef.current = {
            mode: 'none',
            pendingIntent: null,
            pendingSinceSeq: 0,
            pendingReason: 'initial_hydrate',
          }
          dispatch(clearPaneRuntimeActivity({ paneId: paneIdRef.current }))
          clearTerminalCursor(tid)
          resetParserAppliedSurface()
          forgetSentViewport(tid)
          lastSentViewportRef.current = null
          // Clear terminalIdRef AND the stored terminalId to prevent any subsequent
          // operations (resize, input) from sending commands to the dead terminal,
          // which would trigger INVALID_TERMINAL_ID and cause a reconnection loop.
          // We must clear both the ref AND the Redux state because the ref sync effect
          // would otherwise reset the ref from the Redux state on re-render.
          terminalIdRef.current = undefined
          applySeqState(createAttachSeqState())
          updateContent({ terminalId: undefined, streamId: undefined, status: 'exited' })
          const exitTab = tabRef.current
          if (exitTab) {
            const code = typeof msg.exitCode === 'number' ? msg.exitCode : undefined
            // Only shell terminals get the "(exit N)" suffix, and only when the
            // user hasn't manually set the title. Coding-agent terminals keep
            // their stable session name on exit.
            const updates: { status: 'exited'; title?: string } = { status: 'exited' }
            if (!exitTab.titleSetByUser && terminalFollowsOscTitle(contentRef.current?.mode)) {
              updates.title = exitTab.title + (code !== undefined ? ` (exit ${code})` : '')
            }
            dispatch(updateTab({ id: exitTab.id, updates }))
          }
        }

        // Auto-update title from Claude session
        // Tab and pane titles are independently guarded
        if (msg.type === 'terminal.title.updated' && msg.terminalId === tid && msg.title) {
          const titleTab = tabRef.current
          if (titleTab && !titleTab.titleSetByUser) {
            dispatch(updateTab({ id: titleTab.id, updates: { title: msg.title } }))
          }
          dispatch(updatePaneTitle({ tabId, paneId: paneIdRef.current, title: msg.title, setByUser: false }))
        }

        // Handle one-time session association from the authoritative canonical sessionRef.
        if (msg.type === 'terminal.session.associated' && msg.terminalId === tid) {
          const associationResult = reconcileTerminalSessionAssociation({
            dispatch,
            getState: appStore.getState,
            terminalId: tid,
            sessionRef: msg.sessionRef,
          })
          if (debugRef.current && associationResult === 'reconciled') {
            log.debug('[TRACE resumeSessionId] terminal.session.associated reconciled', {
              paneId: paneIdRef.current,
              terminalId: tid,
              sessionRef: msg.sessionRef,
            })
          }
          if (associationResult === 'reconciled') {
            syncContentRefWithSessionAssociation(msg.sessionRef)
          }
        }

        if (msg.type === 'terminal.codex.durability.updated' && msg.terminalId === tid) {
          const durability = msg.durability
          const currentSessionRef = contentRef.current?.sessionRef
          const durableMatchesCanonicalSession = currentSessionRef?.provider === 'codex'
            && durability?.state === 'durable'
            && durability.durableThreadId === currentSessionRef.sessionId
          const candidateMatchesCanonicalSession = currentSessionRef?.provider === 'codex'
            && durability?.candidate?.candidateThreadId === currentSessionRef.sessionId
          if (currentSessionRef?.provider === 'codex' && !durableMatchesCanonicalSession && !candidateMatchesCanonicalSession) {
            log.warn('Ignoring stale codex durability update for pane canonical session', {
              tabId,
              paneId: paneIdRef.current,
              terminalId: tid,
              expectedSessionRef: currentSessionRef,
              durability,
            })
            return
          }
          updateContent({ codexDurability: durability })
          const currentTab = tabHasSinglePaneRef.current ? tabRef.current : undefined
          if (currentTab) {
            dispatch(updateTab({ id: currentTab.id, updates: { codexDurability: durability } }))
          }
          dispatch(flushPersistedLayoutNow())
          const candidate = durability?.candidate
          if (candidate) {
            ws.send({
              type: 'terminal.codex.candidate.persisted',
              terminalId: tid,
              candidateThreadId: candidate.candidateThreadId,
              rolloutPath: candidate.rolloutPath,
              capturedAt: candidate.capturedAt,
            })
          }
        }

        if (msg.type === 'terminal.input.blocked' && msg.terminalId === tid) {
          const reason = msg.reason as TerminalInputBlockedReason
          log.warn('terminal_input_blocked', {
            tabId,
            paneId: paneIdRef.current,
            terminalId: tid,
            reason,
          })
          const now = Date.now()
          const previous = lastInputBlockedNoticeRef.current
          if (!previous || previous.reason !== reason || now - previous.at >= INPUT_BLOCKED_NOTICE_THROTTLE_MS) {
            lastInputBlockedNoticeRef.current = { reason, at: now }
            writeLocalXtermNotice(term, `\r\n[${terminalInputBlockedNotice(reason)}]\r\n`)
          }
          return
        }

        if (msg.type === 'error' && msg.code === 'SESSION_IDENTITY_MISMATCH' && msg.terminalId === tid) {
          const staleTerminalId = tid
          const current = contentRef.current
          const expectedSessionRef = sanitizeSessionRef(msg.expectedSessionRef)
          if (!staleTerminalId || !current || current.terminalId !== staleTerminalId || !expectedSessionRef || !sessionRefsEqual(current.sessionRef, expectedSessionRef)) {
            writeLocalXtermNotice(term, `\r\n[Resume blocked] ${msg.message || 'Terminal session identity mismatch.'}\r\n`)
            return
          }

          const newRequestId = nanoid()
          const repairContent = buildCodexIdentityMismatchRepairContent(current, expectedSessionRef, newRequestId)
          if (!repairContent) return

          consumeTerminalRestoreRequestId(requestIdRef.current)
          addTerminalRestoreRequestId(newRequestId)
          requestIdRef.current = newRequestId
          launchAttemptRef.current = null
          clearQuarantineRepair()
          currentAttachRef.current = null
          clearRateLimitRetry()
          setIsAttaching(false)
          dispatch(clearPaneRuntimeActivity({ paneId: paneIdRef.current }))
          clearTerminalCursor(staleTerminalId)
          resetParserAppliedSurface()
          forgetSentViewport(staleTerminalId)
          lastSentViewportRef.current = null
          terminalIdRef.current = undefined
          deferredAttachStateRef.current = {
            mode: 'none',
            pendingIntent: null,
            pendingSinceSeq: 0,
            pendingReason: 'initial_hydrate',
          }
          applySeqState(createAttachSeqState())
          contentRef.current = {
            ...current,
            ...repairContent,
          }
          dispatch(repairCodexIdentityMismatch({
            tabId,
            paneId: paneIdRef.current,
            staleTerminalId,
            expectedSessionRef,
            createRequestId: newRequestId,
          }))
          const currentTab = tabRef.current
          if (currentTab) {
            dispatch(updateTab({ id: currentTab.id, updates: { status: 'creating' } }))
          }
          writeLocalXtermNotice(term, '\r\n[Reconnecting to the expected Codex session...]\r\n')
          return
        }

        if (msg.type === 'error' && msg.requestId === reqId) {
          if (msg.code === 'RATE_LIMITED') {
            const scheduled = scheduleRateLimitRetry(reqId)
            if (scheduled) {
              return
            }
          }
          const launchAttempt = launchAttemptRef.current?.requestId === reqId
            ? launchAttemptRef.current
            : null
          launchAttemptRef.current = null
          clearRateLimitRetry()
          setIsAttaching(false)
          dispatch(clearPaneRuntimeActivity({ paneId: paneIdRef.current }))
          updateContent({
            status: 'error',
            streamId: undefined,
            ...(launchAttempt?.recoveryIntent
              ? { restoreError: buildRestoreError('dead_live_handle') }
              : {}),
          })
          const currentTab = tabRef.current
          if (currentTab) {
            dispatch(updateTab({ id: currentTab.id, updates: { status: 'error' } }))
          }
          const prefix = launchAttempt
            ? (launchAttempt.restore ? '[Restore failed]' : '[Launch failed]')
            : '[Error]'
          writeLocalXtermNotice(term, `\r\n${prefix} ${msg.message || msg.code || 'Unknown error'}\r\n`)
        }

        const activeAttachForInvalidTerminalError = currentAttachRef.current
        const currentAttachInvalidTerminalError = Boolean(
          msg.type === 'error'
          && msg.code === 'INVALID_TERMINAL_ID'
          && typeof msg.requestId === 'string'
          && typeof msg.terminalId === 'string'
          && activeAttachForInvalidTerminalError !== null
          && activeAttachForInvalidTerminalError.requestId === msg.requestId
          && activeAttachForInvalidTerminalError.terminalId === msg.terminalId
        )
        if (
          msg.type === 'error'
          && msg.code === 'INVALID_TERMINAL_ID'
          && (!msg.requestId || currentAttachInvalidTerminalError)
        ) {
          const currentTerminalId = terminalIdRef.current
          const current = contentRef.current
          const launchAttempt = launchAttemptRef.current
          const pendingReplacement = pendingDurableReplacementRef.current
          if (debugRef.current) log.debug('[TRACE resumeSessionId] INVALID_TERMINAL_ID received', {
            paneId: paneIdRef.current,
            msgTerminalId: msg.terminalId,
            requestId: msg.requestId,
            currentAttachRequestId: activeAttachForInvalidTerminalError?.requestId,
            currentTerminalId,
            currentResumeSessionId: current?.resumeSessionId,
            currentStatus: current?.status,
          })
          if (
            pendingReplacement
            && (!msg.terminalId || msg.terminalId === pendingReplacement.terminalId)
          ) {
            completeDurableReplacement(pendingReplacement)
            return
          }
          if (msg.terminalId && msg.terminalId !== currentTerminalId) {
            // Show feedback if the terminal already exited (the ID was cleared by
            // the exit handler, so msg.terminalId no longer matches the ref)
            if (current?.status === 'exited') {
              writeLocalXtermNotice(term, '\r\n[Terminal exited - use the + button or split to start a new session]\r\n')
            }
            return
          }
          const failedDuringLaunch = Boolean(
            launchAttempt
            && currentTerminalId
            && launchAttempt.terminalId === currentTerminalId
            && launchAttempt.terminalId === msg.terminalId
            && !launchAttempt.attachReady
          )
          if (failedDuringLaunch) {
            failLaunch(msg.message || 'The terminal failed before it finished starting.', launchAttempt!.restore, currentTerminalId)
            return
          }
          // Only auto-reconnect if terminal hasn't already exited.
          // This prevents an infinite respawn loop when terminals fail immediately
          // (e.g., due to permission errors on cwd). User must explicitly restart.
          if (currentTerminalId && current?.status !== 'exited') {
            const hasCodexCapturedRestoreState = current?.mode === 'codex' && Boolean(current.codexDurability?.candidate)
            if (!current?.sessionRef && !hasCodexCapturedRestoreState) {
              const restoreDiagnostic = {
                event: 'restore_unavailable' as const,
                reason: 'dead_live_handle' as const,
                terminalId: currentTerminalId,
                tabId,
                paneId: paneIdRef.current,
                mode: current?.mode || (paneContent.kind === 'terminal' ? paneContent.mode : 'shell'),
                hasSessionRef: false as const,
              }
              log.warn('restore_unavailable', {
                ...restoreDiagnostic,
              })
              ws.send({
                type: 'client.diagnostic',
                ...restoreDiagnostic,
              })
              writeLocalXtermNotice(term, '\r\n[Starting a new terminal because the previous live terminal is gone and no durable session identity was saved]\r\n')
              const newRequestId = nanoid()
              launchAttemptRef.current = null
              clearQuarantineRepair()
              currentAttachRef.current = null
              clearRateLimitRetry()
              setIsAttaching(false)
              dispatch(clearPaneRuntimeActivity({ paneId: paneIdRef.current }))
              consumeTerminalRestoreRequestId(requestIdRef.current)
              addTerminalFreshRecoveryRequestId(newRequestId, 'fresh_after_restore_unavailable')
              requestIdRef.current = newRequestId
              clearTerminalCursor(currentTerminalId)
              resetParserAppliedSurface()
              forgetSentViewport(currentTerminalId)
              lastSentViewportRef.current = null
              terminalIdRef.current = undefined
              deferredAttachStateRef.current = {
                mode: 'none',
                pendingIntent: null,
                pendingSinceSeq: 0,
                pendingReason: 'initial_hydrate',
              }
              applySeqState(createAttachSeqState())
              updateContent({
                terminalId: undefined,
                serverInstanceId: undefined,
                streamId: undefined,
                createRequestId: newRequestId,
                status: 'creating',
                restoreError: undefined,
              })
              const currentTab = tabRef.current
              if (currentTab) {
                dispatch(updateTab({ id: currentTab.id, updates: { status: 'creating' } }))
              }
              return
            }
            writeLocalXtermNotice(term, '\r\n[Reconnecting...]\r\n')
            const newRequestId = nanoid()
            if (debugRef.current) log.debug('[TRACE resumeSessionId] INVALID_TERMINAL_ID reconnecting', {
              paneId: paneIdRef.current,
              oldRequestId: requestIdRef.current,
              newRequestId,
              resumeSessionId: current?.resumeSessionId,
            })
            // Any INVALID_TERMINAL_ID reconnect is restoring a terminal that existed
            // before the server lost state. Always mark it as restore so the
            // subsequent terminal.create bypasses the server's rate limit.
            // Consume the old ID's flag (if any) to clean up the set, but mark the
            // new request regardless — non-restore terminals also need rate-limit
            // bypass when burst-reconnecting after a server restart.
            consumeTerminalRestoreRequestId(requestIdRef.current)
            addTerminalRestoreRequestId(newRequestId)
            requestIdRef.current = newRequestId
            clearQuarantineRepair()
            currentAttachRef.current = null
            clearTerminalCursor(currentTerminalId)
            resetParserAppliedSurface()
            forgetSentViewport(currentTerminalId)
            lastSentViewportRef.current = null
            terminalIdRef.current = undefined
            deferredAttachStateRef.current = {
              mode: 'none',
              pendingIntent: null,
              pendingSinceSeq: 0,
              pendingReason: 'initial_hydrate',
            }
            applySeqState(createAttachSeqState())
            updateContent({
              terminalId: undefined,
              serverInstanceId: undefined,
              streamId: undefined,
              createRequestId: newRequestId,
              status: 'creating',
            })
            const currentTab = tabRef.current
            if (currentTab) {
              dispatch(updateTab({ id: currentTab.id, updates: { status: 'creating' } }))
            }
          } else if (current?.status === 'exited') {
            writeLocalXtermNotice(term, '\r\n[Terminal exited - use the + button or split to start a new session]\r\n')
          }
        }
      })

      unsubReconnect = ws.onReconnect(() => {
        const tid = terminalIdRef.current
        if (debugRef.current) log.debug('[TRACE resumeSessionId] onReconnect', {
          paneId: paneIdRef.current,
          terminalId: tid,
          resumeSessionId: contentRef.current?.resumeSessionId,
        })
        if (!tid) return
        if (hiddenRef.current) {
          const checkpointDecision = getCheckpointDeltaReplayDecision(tid)
          const canResumeFromParserAppliedSurface = checkpointDecision.ok
          deferredAttachStateRef.current = deferredAttachStateRef.current.mode === 'live' || canResumeFromParserAppliedSurface
            ? {
                mode: 'waiting_for_geometry',
                pendingIntent: 'transport_reconnect',
                pendingSinceSeq: canResumeFromParserAppliedSurface ? checkpointDecision.sinceSeq : 0,
                pendingReason: 'transport_reconnect',
              }
            : {
                mode: 'waiting_for_geometry',
                pendingIntent: 'viewport_hydrate',
                pendingSinceSeq: 0,
                pendingReason: 'hidden_reveal',
              }
          registerForBackgroundHydration({ queueIfStarted: canResumeFromParserAppliedSurface })
          return
        }
        attachTerminal(tid, 'transport_reconnect')
      })

      // Use paneContent for terminal lifecycle - NOT tab
      // Read terminalId from REF (not from destructured value) to get current value
      // This is critical: we want the effect to run once per createRequestId,
      // not re-run when terminalId changes from undefined to defined
      const currentTerminalId = terminalIdRef.current

      if (debugRef.current) log.debug('[TRACE resumeSessionId] effect initial decision', {
        paneId: paneIdRef.current,
        currentTerminalId,
        createRequestId,
        resumeSessionId: contentRef.current?.resumeSessionId,
        refreshRequestId: refreshRequestRef.current?.requestId,
        action: currentTerminalId
          ? (refreshRequestRef.current
            ? 'refresh_attach'
            : (deferredAttachStateRef.current.mode === 'live' ? 'keepalive_delta' : 'viewport_hydrate'))
          : 'sendCreate',
      })
      if (currentTerminalId && runRefreshAttach(refreshRequestRef.current)) {
        return
      }

      if (currentTerminalId) {
        if (hiddenRef.current) {
          const checkpointDecision = getCheckpointDeltaReplayDecision(currentTerminalId)
          const canResumeFromParserAppliedSurface = checkpointDecision.ok
          deferredAttachStateRef.current = deferredAttachStateRef.current.mode === 'live' || canResumeFromParserAppliedSurface
            ? {
                mode: 'waiting_for_geometry',
                pendingIntent: 'transport_reconnect',
                pendingSinceSeq: canResumeFromParserAppliedSurface ? checkpointDecision.sinceSeq : 0,
                pendingReason: 'transport_reconnect',
              }
            : {
                mode: 'waiting_for_geometry',
                pendingIntent: 'viewport_hydrate',
                pendingSinceSeq: 0,
                pendingReason: 'hidden_reveal',
              }
          setIsAttaching(false)

          // Register with hydration queue for progressive background hydration
          registerForBackgroundHydration()
        } else {
          const intent: AttachIntent = deferredAttachStateRef.current.mode === 'live'
            ? 'keepalive_delta'
            : 'viewport_hydrate'
          attachTerminal(currentTerminalId, intent, intent === 'viewport_hydrate'
            ? viewportHydrateReplayOptions(contentRef.current)
            : undefined)
        }
      } else {
        deferredAttachStateRef.current = {
          mode: 'none',
          pendingIntent: null,
          pendingSinceSeq: 0,
          pendingReason: 'initial_hydrate',
        }
        sendCreate(createRequestId)
      }
    }

    ensure()

    return () => {
      clearRateLimitRetry()
      unsub()
      unsubReconnect()
      if (hydrationRegisteredRef.current) {
        getHydrationQueue().unregister(paneIdRef.current)
        hydrationRegisteredRef.current = false
      }
    }
  // Dependencies explanation:
  // - isTerminal: skip effect for non-terminal panes
  // - paneId: unique identifier for this pane instance
  // - terminalContent?.createRequestId: re-run when createRequestId changes (reconnect after INVALID_TERMINAL_ID)
  // - updateContent: stable callback (uses refs internally)
  // - ws: WebSocket client instance
  //
  // NOTE: terminalId is intentionally NOT in dependencies!
  // - On fresh creation: terminalId=undefined, we create, handler sets terminalId
  //   Effect should NOT re-run (handler already attached)
  // - On hydration: terminalId from storage, we attach once
  // - On reconnect: createRequestId changes, effect re-runs, terminalId is undefined, we create
  // We read terminalId from terminalIdRef.current to get the current value without triggering re-runs
  //
  // NOTE: tab is intentionally NOT in dependencies - we use tabRef to avoid re-attaching
  // when tab properties (like title) change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isTerminal,
    paneId,
    suppressNetworkEffects,
    terminalContent?.createRequestId,
    updateContent,
    ws,
    dispatch,
    handleTerminalOutput,
    attachTerminal,
    clearQuarantineRepair,
    getCheckpointDeltaReplayDecision,
    getTerminalCheckpointStreamId,
    isCurrentAttachMessage,
    isCurrentAttachStreamMessage,
    markAttachComplete,
    markParserAppliedFrame,
    markTerminalOutputRangeLost,
    recordTerminalPerfAuditEvent,
    registerForBackgroundHydration,
    resetParserAppliedSurface,
    resetStartupProbeParser,
    runRefreshAttach,
    syncContentRefWithSessionAssociation,
    writeLocalXtermNotice,
  ])

  useEffect(() => {
    if (!hasMountedRefreshEffectRef.current) {
      hasMountedRefreshEffectRef.current = true
      return
    }
    if (!isTerminal || !refreshRequest) return
    runRefreshAttach(refreshRequest)
  }, [isTerminal, refreshRequest, runRefreshAttach])

  const mobileToolbarBottomPx = isMobile ? keyboardInsetPx : 0
  const mobileBottomInsetPx = isMobile ? keyboardInsetPx + MOBILE_KEYBAR_HEIGHT_PX : 0
  const terminalContainerStyle = useMemo(() => {
    if (!isMobile) return undefined

    return {
      touchAction: 'none' as const,
      height: `calc(100% - ${mobileBottomInsetPx}px)`,
    }
  }, [isMobile, mobileBottomInsetPx])

  const handleLoadMoreHistory = useCallback(() => {
    const tid = terminalIdRef.current
    if (!tid) return
    setTruncatedHistoryGap(null)
    attachTerminal(tid, 'viewport_hydrate', { clearViewportFirst: true })
  }, [attachTerminal])

  // NOW we can do the conditional return - after all hooks
  if (!isTerminal || !terminalContent) {
    return null
  }

  const hasFatalConnectionError = isFatalConnectionErrorCode(connectionErrorCode)
  const showBlockingSpinner = terminalContent.status === 'creating' && !hasFatalConnectionError
  const showInlineOfflineStatus = connectionStatus !== 'ready' && !hasFatalConnectionError
  const showInlineRecoveringStatus = connectionStatus === 'ready' && isAttaching && terminalContent.status !== 'creating' && !wasCreatedFreshRef.current
  const inlineStatusMessage = showInlineOfflineStatus
    ? 'Offline: input will queue until reconnected.'
    : (showInlineRecoveringStatus ? 'Recovering terminal output...' : null)

  return (
    <div
      ref={wrapperRef}
      className={cn('h-full w-full', hidden ? 'tab-hidden' : 'tab-visible relative')}
      data-context={ContextIds.Terminal}
      data-pane-id={paneId}
      data-tab-id={tabId}
    >
      <div
        ref={containerRef}
        data-testid="terminal-xterm-container"
        className="h-full w-full"
        style={terminalContainerStyle}
        onTouchStart={isMobile ? handleMobileTouchStart : undefined}
        onTouchMove={isMobile ? handleMobileTouchMove : undefined}
        onTouchEnd={isMobile ? handleMobileTouchEnd : undefined}
        onTouchCancel={isMobile ? handleMobileTouchEnd : undefined}
      />
      {isMobile && (
        <div
          data-testid="mobile-terminal-toolbar"
          className="absolute inset-x-0 z-20 px-1 pb-1"
          style={{ bottom: `${mobileToolbarBottomPx}px` }}
        >
          <div className="flex h-8 w-full items-center gap-1 rounded-md border border-border/70 bg-background/95 p-1 shadow-sm">
            {MOBILE_TOOLBAR_KEYS.map((key) => {
              const isCtrl = key.id === 'ctrl'
              const ctrlPressed = isCtrl && mobileCtrlActive
              return (
                <button
                  key={key.id}
                  type="button"
                  className={cn(
                    'h-full min-w-0 flex-1 rounded-sm border border-border/60 px-1 text-[11px] font-medium leading-none touch-manipulation select-none',
                    key.isArrow ? 'text-[19px] font-bold' : '',
                    ctrlPressed ? 'bg-primary/20 text-primary border-primary/40' : 'bg-muted/80 text-foreground',
                  )}
                  aria-label={key.ariaLabel}
                  aria-pressed={isCtrl ? ctrlPressed : undefined}
                  onClick={(event) => handleMobileToolbarClick(event, key.id)}
                  onPointerDown={key.isArrow ? (event) => handleMobileToolbarPointerDown(event, key.id) : undefined}
                  onPointerUp={key.isArrow ? handleMobileToolbarPointerEnd : undefined}
                  onPointerCancel={key.isArrow ? handleMobileToolbarPointerEnd : undefined}
                  onPointerLeave={key.isArrow ? handleMobileToolbarPointerEnd : undefined}
                  onContextMenu={(event) => handleMobileToolbarContextMenu(event, key.id)}
                >
                  {key.label}
                </button>
              )
            })}
          </div>
        </div>
      )}
      {showBlockingSpinner && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Starting terminal...</span>
          </div>
        </div>
      )}
      {inlineStatusMessage && (
        <div className="pointer-events-none absolute right-2 top-2 z-10" role="status" aria-live="polite">
          <span className="rounded bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm ring-1 ring-border/60">
            {inlineStatusMessage}
          </span>
        </div>
      )}
      {truncatedHistoryGap && (
        <div className="absolute inset-x-0 top-0 z-10 flex justify-center">
          <button
            type="button"
            className="rounded-b bg-muted/90 px-3 py-1 text-xs text-muted-foreground shadow-sm ring-1 ring-border/60 hover:bg-muted hover:text-foreground transition-colors"
            onClick={handleLoadMoreHistory}
            aria-label="Load earlier terminal history"
          >
            Load more history
          </button>
        </div>
      )}
      <ConnectionErrorOverlay />
      {searchOpen && (
        <TerminalSearchBar
          query={searchQuery}
          onQueryChange={handleSearchQueryChange}
          onFindNext={() => findNext()}
          onFindPrevious={() => findPrevious()}
          onClose={closeSearch}
          resultIndex={terminalSearchState?.activeIndex}
          resultCount={searchQuery.trim() && terminalSearchState && !terminalSearchState.loading
            ? terminalSearchState.matches.length
            : undefined}
        />
      )}
      <Osc52PromptModal
        open={pendingOsc52Event !== null}
        onYes={() => {
          if (pendingOsc52EventRef.current) {
            attemptOsc52ClipboardWrite(pendingOsc52EventRef.current.text)
          }
          advanceOsc52Prompt()
        }}
        onNo={() => {
          advanceOsc52Prompt()
        }}
        onAlways={() => {
          if (pendingOsc52EventRef.current) {
            attemptOsc52ClipboardWrite(pendingOsc52EventRef.current.text)
          }
          for (const queued of osc52QueueRef.current) {
            attemptOsc52ClipboardWrite(queued.text)
          }
          osc52QueueRef.current = []
          persistOsc52Policy('always')
          closeOsc52Prompt()
        }}
        onNever={() => {
          osc52QueueRef.current = []
          persistOsc52Policy('never')
          closeOsc52Prompt()
        }}
      />
      <ConfirmModal
        open={pendingLinkUri !== null}
        title="Open external link?"
        body={
          <>
            <p className="break-all font-mono text-xs bg-muted rounded px-2 py-1 mb-2">{pendingLinkUri}</p>
            <p>Links from terminal output could be dangerous. Only open links you trust.</p>
          </>
        }
        confirmLabel="Open link"
        onConfirm={() => {
          if (pendingLinkUri) {
            dispatch(splitPane({
              tabId,
              paneId,
              direction: 'horizontal',
              newContent: { kind: 'browser', url: pendingLinkUri, devToolsOpen: false },
            }))
          }
          setPendingLinkUri(null)
        }}
        onCancel={() => setPendingLinkUri(null)}
      />
    </div>
  )
}

const MemoizedTerminalView = memo(TerminalView)
MemoizedTerminalView.displayName = 'TerminalView'

export default MemoizedTerminalView
