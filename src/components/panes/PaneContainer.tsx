import { Suspense, lazy, useRef, useCallback, useMemo, useState, useEffect } from 'react'
import { useAppDispatch, useAppSelector, useAppStore } from '@/store/hooks'
import { setActivePane, updatePaneContent, clearPaneRenameRequest, toggleZoom, requestPaneRefresh } from '@/store/panesSlice'
import { closePaneWithCleanup } from '@/store/tabsSlice'
import type { PaneNode, PaneContent } from '@/store/paneTypes'
import Pane from './Pane'
import PaneDivider from './PaneDivider'
import TerminalView from '../TerminalView'
import BrowserPane from './BrowserPane'
import FreshAgentView from '../fresh-agent/FreshAgentView'
import ExtensionPane from './ExtensionPane'
import HostStatsPane from './HostStatsPane'
import PanePicker, { type PanePickerType } from './PanePicker'
import DirectoryPicker from './DirectoryPicker'
import { getProviderLabel, isCodingCliProviderName } from '@/lib/coding-cli-utils'
import { isFreshAgentProviderName, getFreshAgentProviderConfig } from '@/lib/fresh-agent-provider-utils'
import { normalizeFreshAgentEffort, resolveFreshAgentPaneCreateEffort, resolveFreshAgentPaneModelDefaults, resolveFreshAgentType } from '@/lib/fresh-agent-registry'
import { clearDraft } from '@/lib/draft-store'
import { getTerminalActions } from '@/lib/pane-action-registry'
import { renamePaneAfterMirrorReady } from '@/lib/pane-rename'
import { buildPaneRefreshTarget } from '@/lib/pane-utils'
import { cn } from '@/lib/utils'
import { withChunkErrorRecovery } from '@/lib/import-retry'
import { getWsClient } from '@/lib/ws-client'
import { KILL_ACK_TIMEOUT_MESSAGE, KILL_FAILED_MESSAGE, sendFreshAgentKillAndAwait } from '@/lib/kill-ack'
import { selectPaneOwnerFence } from '@/store/selectors/runtimeOwner'
import { api } from '@/lib/api'
import { isTrulyIdleCliMode, resolvePaneActivity, resolvePaneIdleGreen } from '@/lib/pane-activity'
import { getTabDirectoryPreference } from '@/lib/tab-directory-preference'
import {
  formatPaneRuntimeLabel,
  formatPaneRuntimeTooltip,
  type PaneRuntimeMeta,
} from '@/lib/format-terminal-title-meta'
import { usePaneSplitResize } from './usePaneSplitResize'
import { nanoid } from 'nanoid'
import { ContextIds } from '@/components/context-menu/context-menu-constants'
import type { CodingCliProviderName } from '@/lib/coding-cli-types'
import type { FreshAgentPendingCreate, FreshAgentSessionState } from '@/store/freshAgentTypes'
import type { FreshAgentPaneContent } from '@/store/paneTypes'
import { normalizeFreshAgentEffortOverride, normalizeFreshAgentModelSelection } from '@/store/paneTypes'
import { dismissTabGreen } from '@/store/turnCompletionAttention'
import {
  clearPendingCreate as clearFreshAgentPendingCreate,
  removeSession as removeFreshAgentSession,
  sessionError as freshAgentSessionError,
} from '@/store/freshAgentSlice'
import { DEFAULT_FRESH_AGENT_STYLE } from '@shared/settings'
import { cancelCreate } from '@/lib/create-cancellation'
import { getFreshOpenCodeRouteCwd } from '@/lib/fresh-opencode-route'
import type { PaneRuntimeActivityRecord } from '@/store/paneRuntimeActivitySlice'
import type { TerminalMetaRecord } from '@/store/terminalMetaSlice'
import type { ProjectGroup } from '@/store/types'
import type { ClientExtensionEntry } from '@shared/extension-types'
import { ErrorBoundary } from '@/components/ui/error-boundary'
import { applyPaneRename } from '@/store/titleSync'
import { receiveSessionNameProjections, receiveSessionNames } from '@/store/sessionNamesSlice'
import {
  isScopedPaneContent,
  resolvePaneRenameCapture,
  selectPaneDisplayName,
  selectPaneNativeSync,
} from '@/store/selectors/sessionNameSelectors'
import { parseSessionNameRecordOrUpdate, parseSessionNameUpdate } from '@/lib/session-names'
import type { SessionNameRef } from '@shared/session-names'
import { saveServerSettingsPatch } from '@/store/settingsThunks'
import { getPreferredResumeSessionId } from '@/store/persistControl'
import { findIndexedSessionById } from '@/lib/fresh-agent-context-usage'
import type { SessionLocator } from '@shared/ws-protocol'

// Stable empty object to avoid selector memoization issues
const EMPTY_TERMINAL_META_BY_ID: Record<string, TerminalMetaRecord> = {}
const EMPTY_PROJECTS: ProjectGroup[] = []
const EMPTY_FRESH_AGENT_SESSIONS: Record<string, FreshAgentSessionState> = {}
const EMPTY_CODEX_ACTIVITY_BY_ID = {}
const EMPTY_CLAUDE_ACTIVITY_BY_ID = {}
const EMPTY_AMPLIFIER_ACTIVITY_BY_ID = {}
const EMPTY_OPENCODE_ACTIVITY_BY_ID = {}
const EMPTY_PANE_RUNTIME_ACTIVITY_BY_ID: Record<string, PaneRuntimeActivityRecord> = {}
const EMPTY_ATTENTION_BY_PANE: Record<string, boolean> = {}
const EMPTY_FRESH_AGENT_PENDING_CREATES: Record<string, FreshAgentPendingCreate> = {}
const EMPTY_EXTENSION_ENTRIES: ClientExtensionEntry[] = []
const EditorPane = lazy(() => withChunkErrorRecovery(import('./EditorPane')))

interface PaneContainerProps {
  tabId: string
  node: PaneNode
  hidden?: boolean
}

function normalizePathForMatch(value?: string): string | undefined {
  if (!value) return undefined
  return value.replace(/[\\/]+$/, '')
}

function resolvePaneRuntimeMeta(
  terminalMetaById: Record<string, TerminalMetaRecord>,
  options: {
    terminalId?: string
    isOnlyPane: boolean
    sessionRef?: SessionLocator
    provider?: CodingCliProviderName
    initialCwd?: string
  },
): TerminalMetaRecord | undefined {
  if (options.terminalId) {
    const byTerminalId = terminalMetaById[options.terminalId]
    if (byTerminalId) return byTerminalId
  }

  const sessionRef = options.sessionRef
  if (sessionRef && sessionRef.provider && sessionRef.sessionId) {
    return Object.values(terminalMetaById).find((record) => (
      record.provider === sessionRef.provider && record.sessionId === sessionRef.sessionId
    ))
  }

  if (options.provider && options.initialCwd) {
    const normalizedInitialCwd = normalizePathForMatch(options.initialCwd)
    if (normalizedInitialCwd) {
      const byCwd = Object.values(terminalMetaById).find((record) => {
        if (record.provider !== options.provider) return false
        const candidates = [
          normalizePathForMatch(record.cwd),
          normalizePathForMatch(record.checkoutRoot),
          normalizePathForMatch(record.repoRoot),
        ].filter(Boolean)
        return candidates.includes(normalizedInitialCwd)
      })
      if (byCwd) return byCwd
    }
  }

  if (options.provider && options.isOnlyPane) {
    const providerMatches = Object.values(terminalMetaById).filter((record) => record.provider === options.provider)
    if (providerMatches.length === 1) return providerMatches[0]
  }

  return undefined
}

function resolveFreshAgentRuntimeMeta(
  indexedProjects: ProjectGroup[],
  content: FreshAgentPaneContent,
  session: FreshAgentSessionState | undefined,
): PaneRuntimeMeta | undefined {
  const provider = content.provider
  const sessionId = getPreferredResumeSessionId(session) ?? content.resumeSessionId

  if (provider && sessionId) {
    const indexed = findIndexedSessionById(indexedProjects, provider, sessionId)
    if (indexed) {
      // Fresh-agent pane headers carry dir+branch only — context usage lives
      // in the session status strip between transcript and composer.
      return {
        cwd: indexed.cwd,
        checkoutRoot: indexed.projectPath,
        repoRoot: indexed.projectPath,
        branch: indexed.gitBranch,
        isDirty: indexed.isDirty,
      }
    }
  }

  if (!session) {
    return content.initialCwd
      ? {
          cwd: content.initialCwd,
          checkoutRoot: content.initialCwd,
        }
      : undefined
  }

  let branch: string | undefined
  if (session.snapshot?.worktrees?.length) {
    branch = session.snapshot.worktrees[0].branch
  }

  const cwd = session.cwd ?? content.initialCwd
  return {
    cwd,
    checkoutRoot: cwd,
    branch,
  }
}

export default function PaneContainer({ tabId, node, hidden }: PaneContainerProps) {
  const dispatch = useAppDispatch()
  // b8ke ext r6 F4: the store for at-click fence reads (the close's
  // observed epoch/generation pair).
  const appStore = useAppStore()
  const activePane = useAppSelector((s) => s.panes.activePane[tabId])
  const tab = useAppSelector((s) => s.tabs.tabs.find((t) => t.id === tabId))
  // Per-leaf focus-epoch subscription: an explicit select nudges ONE pane's
  // epoch (see PanesState.focusEpochByPaneId); subscribing per leaf means a
  // select re-renders only that pane's container. (The previous whole-map
  // subscription re-rendered every mounted pane tree on each select.)
  const focusEpoch = useAppSelector((s) =>
    node.type === 'leaf' ? (s.panes?.focusEpochByPaneId?.[node.id] ?? 0) : 0
  )
  const terminalMetaById = useAppSelector(
    (s) => s.terminalMeta?.byTerminalId ?? EMPTY_TERMINAL_META_BY_ID
  )
  const indexedProjects = useAppSelector((s) => s.sessions?.projects ?? EMPTY_PROJECTS)
  const freshAgentSessions = useAppSelector((s) => s.freshAgent?.sessions ?? EMPTY_FRESH_AGENT_SESSIONS)
  const codexActivityByTerminalId = useAppSelector(
    (s) => s.codexActivity?.byTerminalId ?? EMPTY_CODEX_ACTIVITY_BY_ID
  )
  const claudeActivityByTerminalId = useAppSelector(
    (s) => s.claudeActivity?.byTerminalId ?? EMPTY_CLAUDE_ACTIVITY_BY_ID
  )
  const amplifierActivityByTerminalId = useAppSelector(
    (s) => s.amplifierActivity?.byTerminalId ?? EMPTY_AMPLIFIER_ACTIVITY_BY_ID
  )
  const opencodeActivityByTerminalId = useAppSelector(
    (s) => s.opencodeActivity?.byTerminalId ?? EMPTY_OPENCODE_ACTIVITY_BY_ID
  )
  const paneRuntimeActivityByPaneId = useAppSelector(
    (s) => s.paneRuntimeActivity?.byPaneId ?? EMPTY_PANE_RUNTIME_ACTIVITY_BY_ID
  )
  const zoomedPaneId = useAppSelector((s) => s.panes.zoomedPane?.[tabId])
  const attentionByPane = useAppSelector(
    (s) => s.turnCompletion?.attentionByPane ?? EMPTY_ATTENTION_BY_PANE
  )
  const tabAttentionStyle = useAppSelector(
    (s) => s.settings?.settings?.panes?.tabAttentionStyle ?? 'highlight'
  )
  const containerRef = useRef<HTMLDivElement>(null)
  const ws = useMemo(() => getWsClient(), [])
  const snapThreshold = useAppSelector((s) => s.settings?.settings?.panes?.snapThreshold ?? 2)
  const freshAgentPendingCreates = useAppSelector(
    (s) => s.freshAgent?.pendingCreates ?? EMPTY_FRESH_AGENT_PENDING_CREATES
  )

  // Check if this is the only pane (root is a leaf)
  const rootNode = useAppSelector((s) => s.panes.layouts[tabId])
  const isOnlyPane = rootNode?.type === 'leaf'

  // Inline rename state (local to this PaneContainer instance)
  const [renamingPaneId, setRenamingPaneId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)
  const renameAbortRef = useRef<{ paneId: string; controller: AbortController } | null>(null)
  // Unified agent names (Task 5): the editor's captured naming target +
  // revision, taken when the editor OPENS. A commit that lands after the pane
  // switched conversations carries the capture (expectedNameRef/ifRevision) so
  // the server refuses to retitle the new conversation.
  const renameCaptureRef = useRef<{ ref?: SessionNameRef; revision?: number } | null>(null)

  // The scoped pane display title (canonical name with legacy fallback) —
  // one hook-level subscription so both the header and the rename editor
  // read the same projection.
  const leafPaneId = node.type === 'leaf' ? node.id : null
  const paneDisplayName = useAppSelector((s) => (leafPaneId ? selectPaneDisplayName(s, tabId, leafPaneId) : ''))
  const paneNativeSyncStatus = useAppSelector((s) => (leafPaneId ? selectPaneNativeSync(s, tabId, leafPaneId) : undefined))

  useEffect(() => () => {
    renameAbortRef.current?.controller.abort()
  }, [])

  // Listen for rename requests from Redux (context menu trigger)
  const renameRequestTabId = useAppSelector((s) => s.panes.renameRequestTabId)
  const renameRequestPaneId = useAppSelector((s) => s.panes.renameRequestPaneId)

  useEffect(() => {
    if (!renameRequestTabId || !renameRequestPaneId) return
    if (renameRequestTabId !== tabId) return
    // Only handle the request if this PaneContainer renders the target pane as a leaf
    if (node.type !== 'leaf' || node.id !== renameRequestPaneId) return

    setRenamingPaneId(node.id)
    setRenameValue(paneDisplayName)
    setRenameError(null)
    // Capture the naming target + revision at editor open.
    renameCaptureRef.current = resolvePaneRenameCapture(appStore.getState(), tabId, node.id)
    dispatch(clearPaneRenameRequest())
  }, [renameRequestTabId, renameRequestPaneId, tabId, node, paneDisplayName, appStore, dispatch])

  const startRename = useCallback((paneId: string, currentTitle: string) => {
    setRenamingPaneId(paneId)
    setRenameValue(currentTitle)
    setRenameError(null)
    renameCaptureRef.current = resolvePaneRenameCapture(appStore.getState(), tabId, paneId)
  }, [appStore, tabId])

  const handleRenameChange = useCallback((value: string) => {
    setRenameValue(value)
    if (renameError) setRenameError(null)
  }, [renameError])

  const commitRename = useCallback(() => {
    if (!renamingPaneId) return
    const paneId = renamingPaneId
    const trimmed = renameValue.trim()
    if (!trimmed) {
      setRenameError(null)
      setRenamingPaneId(null)
      setRenameValue('')
      renameCaptureRef.current = null
      return
    }
    if (node.type !== 'leaf') return
    renameAbortRef.current?.controller.abort()
    const controller = new AbortController()
    renameAbortRef.current = { paneId, controller }
    // Unified agent names (Task 5): a scoped pane's rename is the ONE
    // canonical session rename with explicit user intent and the captured
    // target/revision — the response folds the accepted record into the
    // canonical cache; NO local pane/tab alias is written. Legacy panes
    // keep the existing layout-label path unchanged.
    const scoped = isScopedPaneContent(node.content)
    const capture = renameCaptureRef.current
    void (async () => {
      try {
        const result = await renamePaneAfterMirrorReady(tabId, paneId, trimmed, {
          signal: controller.signal,
          get: (path, options) => api.get(path, options),
          patch: (path, body, options) => api.patch(path, body, options),
          ...(scoped
            ? {
              nameIntent: 'user' as const,
              ...(capture?.ref !== undefined ? { expectedNameRef: capture.ref } : {}),
              ...(capture?.revision !== undefined ? { ifRevision: capture.revision } : {}),
            }
            : {}),
        })
        if (controller.signal.aborted) return
        if (!result.ok) {
          setRenameError(result.message)
          return
        }
        if (scoped) {
          const accepted = parseSessionNameUpdate(result.response?.data?.sessionName)
          if (accepted) dispatch(receiveSessionNames([accepted]))
        } else {
          dispatch(applyPaneRename({ tabId, paneId, title: trimmed }))
        }
        setRenameError(null)
        setRenamingPaneId(null)
        setRenameValue('')
        renameCaptureRef.current = null
      } catch (error: any) {
        if (controller.signal.aborted) return
        // A conflict carries the server's accepted record: fold it so the
        // winning name is visible everywhere while the error stays shown,
        // and REFRESH the editor's capture from the accepted record (its
        // new revision) so a resubmit from the still-open editor can
        // succeed — the stale edit-start revision would conflict forever.
        // The editor seeds the accepted text. The real ApiError carries
        // the parsed body in `details` (never `.data`), and the scoped
        // routes answer the accepted CURRENT record as a bare
        // `sessionName` (the record-or-update extraction).
        const accepted = parseSessionNameRecordOrUpdate(error?.details?.sessionName)
        if (accepted) {
          dispatch(receiveSessionNameProjections([{ record: accepted, ref: accepted.ref }]))
          if (scoped) {
            renameCaptureRef.current = resolvePaneRenameCapture(appStore.getState(), tabId, paneId)
            setRenameValue(accepted.name)
          }
        }
        const message = typeof error?.message === 'string' && error.message
          ? error.message
          : 'Failed to rename pane'
        setRenameError(message)
      } finally {
        if (renameAbortRef.current?.controller === controller) {
          renameAbortRef.current = null
        }
      }
    })()
  }, [dispatch, appStore, tabId, renamingPaneId, renameValue, node])

  const handleRenameKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault()
      ;(e.target as HTMLInputElement).blur()
    }
  }, [])

  const handleClose = useCallback((paneId: string, content: PaneContent) => {
    if (renameAbortRef.current?.paneId === paneId) {
      renameAbortRef.current.controller.abort()
    }
    // Terminal detach is handled by terminalDetachMiddleware, which reconciles
    // dropped terminal references on the resulting layout change.
    if (content.kind === 'fresh-agent') {
      clearDraft(paneId)
      const pendingCreate = freshAgentPendingCreates[content.createRequestId]
      const pendingSessionId = pendingCreate?.sessionId
      // b8ke ext r6 F3: the kill target is the pane's DURABLE session —
      // content.sessionId OR the provider-matched sessionRef.sessionId
      // (pre-r6 a sessionRef-only restored pane skipped the kill and
      // removed the pane while its runtime kept running — the same
      // fallback the replacement/restart actions took in ext F2).
      const sessionId = content.sessionId
        || pendingSessionId
        || (content.sessionRef?.provider === content.provider
          ? content.sessionRef.sessionId
          : undefined)
      if (sessionId) {
        const cwd = getFreshOpenCodeRouteCwd(content, { freshAgentSessions, sessionId })
        // b8ke ext r6 F4: the close carries the pane's observed
        // (epoch, generation) fence so the server's generation fencing
        // typed-refuses a stale close — the WS client queues across
        // disconnects, and an old close arriving after a
        // handoff-away-and-back must never kill the NEWER generation's
        // runtime.
        const fence = selectPaneOwnerFence(appStore.getState(), content)
        // Focused-episode-6 round 2 (Finding 6): AWAIT the killed answer
        // before dropping the pane — a close the server did NOT confirm
        // durable is not a close. `success:false` (and the bounded 5s
        // timeout) leaves the pane standing: the server-answered failure
        // already surfaces through the pane's ordinary session-error banner
        // (the freshAgent.killed fold writes it); an unanswered wait
        // surfaces there too (same banner surface, timeout copy).
        void sendFreshAgentKillAndAwait({
          sessionId,
          sessionType: content.sessionType,
          provider: content.provider,
          ...(cwd ? { cwd } : {}),
          ...(fence ? { observedEpoch: fence.epoch, observedGeneration: fence.generation } : {}),
        }).then((ack) => {
          if (!ack.ok) {
            // The pane's ordinary session-error banner carries the failure
            // (idempotent with the freshAgent.killed fold's own write — one
            // shared copy, kill-ack.ts).
            dispatch(freshAgentSessionError({
              sessionId,
              sessionType: content.sessionType,
              provider: content.provider,
              code: 'KILL_FAILED',
              message: ack.timedOut ? KILL_ACK_TIMEOUT_MESSAGE : KILL_FAILED_MESSAGE,
            }))
            return
          }
          if (!content.sessionId && pendingSessionId) {
            dispatch(removeFreshAgentSession({
              sessionId: pendingSessionId,
              sessionType: content.sessionType,
              provider: content.provider,
            }))
            dispatch(clearFreshAgentPendingCreate({ requestId: content.createRequestId }))
          }
          dispatch(closePaneWithCleanup({ tabId, paneId }))
        })
        return
      }
      cancelCreate(content.createRequestId)
      ws.cancelCreate(content.createRequestId)
    }
    // Extension panes: V1 leaves server extensions running until freshell shutdown.
    // Future: stop singleton server when its last pane closes.
    dispatch(closePaneWithCleanup({ tabId, paneId }))
  }, [appStore, dispatch, freshAgentPendingCreates, freshAgentSessions, tabId, ws])

  const handleFocus = useCallback((paneId: string) => {
    // Decision 1: visiting any pane of the tab (a click into it) dismisses the
    // tab's green AND every pane's green in that tab, in BOTH attentionDismiss
    // modes. (attentionDismiss governs only background-tab navigation clearing.)
    dispatch(dismissTabGreen(tabId))
    dispatch(setActivePane({ tabId, paneId }))
  }, [dispatch, tabId])

  const handleToggleZoom = useCallback((paneId: string) => {
    dispatch(toggleZoom({ tabId, paneId }))
  }, [dispatch, tabId])

  const { handleResizeStart, handleResize, handleResizeEnd } = usePaneSplitResize({
    tabId, node, rootNode, containerRef, snapThreshold,
  })

  // Render a leaf pane
  if (node.type === 'leaf') {
    // Unified agent names (Task 5): the pane's display title comes from the
    // ONE scoped selector — for scoped agent panes that is the canonical
    // session name (legacy sticky flags/inventory strings are fallback-only);
    // every other pane keeps the legacy derivation inside the selector.
    const paneTitle = paneDisplayName
    const paneStatus = node.content.kind === 'terminal'
      ? node.content.status
      : node.content.kind === 'fresh-agent'
        ? (node.content.status === 'exited' ? 'exited' : 'running')
        : 'running'
    const isRenaming = renamingPaneId === node.id
    const paneProvider: CodingCliProviderName | undefined =
      node.content.kind === 'terminal'
        ? (
            node.content.mode !== 'shell'
              ? node.content.mode
              : (tab?.mode !== 'shell' ? tab?.mode : undefined)
          )
        : undefined
    const paneSessionRef =
      node.content.kind === 'terminal'
        ? (
            node.content.sessionRef
            ?? (paneProvider && tab?.sessionRef?.provider === paneProvider
              ? tab.sessionRef
              : (paneProvider && tab?.resumeSessionId
                ? { provider: paneProvider, sessionId: tab.resumeSessionId }
                : undefined))
          )
        : undefined
    const paneInitialCwd =
      node.content.kind === 'terminal'
        ? (node.content.initialCwd || tab?.initialCwd)
        : undefined
    const paneRuntimeMeta: PaneRuntimeMeta | undefined =
      node.content.kind === 'terminal'
        ? resolvePaneRuntimeMeta(terminalMetaById, {
          terminalId: node.content.terminalId,
          isOnlyPane,
          sessionRef: paneSessionRef,
          provider: paneProvider,
          initialCwd: paneInitialCwd,
        })
        : node.content.kind === 'fresh-agent'
          ? resolveFreshAgentRuntimeMeta(
            indexedProjects,
            {
              ...node.content,
              effort: normalizeFreshAgentEffort(
                node.content.sessionType,
                node.content.provider,
                node.content.model,
                node.content.effort,
              ),
            },
            node.content.sessionId
              ? freshAgentSessions[`${node.content.sessionType}:${node.content.provider}:${node.content.sessionId}`]
              : undefined,
          )
        : undefined
    const paneMetaLabel =
      paneRuntimeMeta
        ? formatPaneRuntimeLabel(paneRuntimeMeta)
        : undefined
    const paneMetaTooltip =
      paneRuntimeMeta
        ? formatPaneRuntimeTooltip(paneRuntimeMeta)
        : undefined
    const paneActivityInput = {
      paneId: node.id,
      content: node.content,
      tabMode: tab?.mode,
      isOnlyPane,
      codexActivityByTerminalId,
      claudeActivityByTerminalId,
      amplifierActivityByTerminalId,
      opencodeActivityByTerminalId,
      paneRuntimeActivityByPaneId,
      freshAgentSessions,
    }
    const paneBusy = resolvePaneActivity(paneActivityInput).isBusy

    // Terminal CLI panes (claude/codex/opencode/amplifier): green is a PERSISTENT
    // idle state (session known and not busy), independent of tab shading and its
    // click-clearing. Everything else keeps the one-shot needs-attention green.
    const effectiveTerminalMode = node.content.kind === 'terminal'
      ? (node.content.mode !== 'shell' ? node.content.mode : tab?.mode)
      : undefined
    const needsAttention = node.content.kind === 'terminal' && isTrulyIdleCliMode(effectiveTerminalMode)
      ? resolvePaneIdleGreen(paneActivityInput)
      : tabAttentionStyle !== 'none' && !!attentionByPane[node.id]

    const refreshTarget = buildPaneRefreshTarget(node.content)
    const handleRefresh = refreshTarget
      ? () => dispatch(requestPaneRefresh({ tabId, paneId: node.id }))
      : undefined

    // focusEligible: this pane may auto-focus DOM when it mounts. Requires the
    // VISIBLE tab (!hidden) AND this tab's active pane. Agent-created tabs land
    // hidden (Task 1 keeps Redux activeTabId on the user's tab), so their panes
    // mount without stealing keyboard focus.
    const focusEligible = !hidden && activePane === node.id

    return (
      <Pane
        tabId={tabId}
        paneId={node.id}
        isActive={activePane === node.id}
        isOnlyPane={isOnlyPane}
        title={paneTitle}
        status={paneStatus}
        content={node.content}
        metaLabel={paneMetaLabel}
        metaTooltip={paneMetaTooltip}
        busy={paneBusy}
        needsAttention={needsAttention}
        onClose={() => handleClose(node.id, node.content)}
        onFocus={() => handleFocus(node.id)}
        onToggleZoom={() => handleToggleZoom(node.id)}
        isZoomed={zoomedPaneId === node.id}
        isRenaming={isRenaming}
        renameValue={isRenaming ? renameValue : undefined}
        renameError={isRenaming ? renameError || undefined : undefined}
        onRenameChange={isRenaming ? handleRenameChange : undefined}
        onRenameBlur={isRenaming ? commitRename : undefined}
        onRenameKeyDown={isRenaming ? handleRenameKeyDown : undefined}
        onSearch={node.content.kind === 'terminal' ? () => getTerminalActions(node.id)?.openSearch() : undefined}
        onRefresh={handleRefresh}
        onDoubleClickTitle={
          node.content.kind === 'host-stats' ? undefined : () => startRename(node.id, paneTitle)
        }
      >
        {isScopedPaneContent(node.content) && paneNativeSyncStatus && paneNativeSyncStatus.status !== 'synced' ? (
          <div
            className="border-b border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            Native sync: {paneNativeSyncStatus.status}
            {paneNativeSyncStatus.reason ? ` — ${paneNativeSyncStatus.reason}` : ''}
          </div>
        ) : null}
        {renderContent(tabId, node.id, node.content, isOnlyPane, hidden, focusEligible, focusEpoch)}
      </Pane>
    )
  }

  // Render a split: RECURSIVE COMPATIBILITY RENDERER. In production
  // PaneLayout always renders StablePaneLayout, which only ever hands
  // PaneContainer leaf nodes; this branch survives solely to serve the pane
  // unit suite's split-shaped fixtures. Do not extend it for new behavior —
  // new split-path behavior belongs in StablePaneLayout/StablePaneDivider
  // (and its tests in StablePaneLayout.test.tsx).
  const [size1, size2] = node.sizes

  return (
    <div
      ref={containerRef}
      className={cn(
        'flex h-full w-full',
        node.direction === 'horizontal' ? 'flex-row' : 'flex-col'
      )}
    >
      <div style={{ [node.direction === 'horizontal' ? 'width' : 'height']: `${size1}%` }} className="min-w-0 min-h-0">
        <PaneContainer tabId={tabId} node={node.children[0]} hidden={hidden} />
      </div>

      <PaneDivider
        direction={node.direction}
        onResizeStart={handleResizeStart}
        onResize={(delta, shiftHeld) => handleResize(node.id, delta, node.direction, shiftHeld)}
        onResizeEnd={handleResizeEnd}
        dataContext={ContextIds.PaneDivider}
        dataTabId={tabId}
        dataSplitId={node.id}
      />

      <div style={{ [node.direction === 'horizontal' ? 'width' : 'height']: `${size2}%` }} className="min-w-0 min-h-0">
        <PaneContainer tabId={tabId} node={node.children[1]} hidden={hidden} />
      </div>
    </div>
  )
}

function PickerWrapper({
  tabId,
  paneId,
  isOnlyPane,
  focusEligible = true,
  focusEpoch = 0,
}: {
  tabId: string
  paneId: string
  isOnlyPane: boolean
  focusEligible?: boolean
  focusEpoch?: number
}) {
  const dispatch = useAppDispatch()
  const settings = useAppSelector((s) => s.settings?.settings)
  const freshAgentSettings = useAppSelector((s) => s.settings?.settings?.freshAgent ?? s.settings?.serverSettings?.freshAgent)
  const paneLayout = useAppSelector((s) => s.panes.layouts[tabId])
  const extensionEntries = useAppSelector((s) => s.extensions?.entries ?? EMPTY_EXTENSION_ENTRIES)
  const tabPref = useMemo(
    () => paneLayout ? getTabDirectoryPreference(paneLayout) : { defaultCwd: undefined, tabDirectories: [] },
    [paneLayout],
  )
  const [step, setStep] = useState<
    | { step: 'type' }
    | { step: 'directory'; providerType: PanePickerType }
  >({ step: 'type' })

  const getRuntimeSettingsKey = useCallback((providerType: PanePickerType): CodingCliProviderName => {
    const freshAgentType = resolveFreshAgentType(providerType)
    if (freshAgentType) return freshAgentType.runtimeProvider as CodingCliProviderName
    const freshAgentProviderConfig = getFreshAgentProviderConfig(providerType)
    return (freshAgentProviderConfig ? freshAgentProviderConfig.codingCliProvider : providerType) as CodingCliProviderName
  }, [])

  const createContentForType = useCallback((
    type: PanePickerType,
    cwd?: string,
    checkpointWorkspace?: { path: string; provenance: 'directory-picker' },
  ): PaneContent => {
    if (typeof type === 'string' && type.startsWith('ext:')) {
      const extensionName = type.slice(4)
      return {
        kind: 'extension' as const,
        extensionName,
        props: {},
      }
    }

    const freshAgentType = resolveFreshAgentType(type)
    if (freshAgentType) {
      const providerConfig = freshAgentType.runtimeProvider === 'claude' && isFreshAgentProviderName(type)
        ? getFreshAgentProviderConfig(type)
        : undefined
      const providerSettings = freshAgentSettings?.providers?.[type]
      const { model, persistModel: shouldPersistPaneModel } = resolveFreshAgentPaneModelDefaults({
        entry: freshAgentType,
        providerSettings,
        runtimeProviderModel: settings?.codingCli?.providers?.[freshAgentType.runtimeProvider]?.model,
      })
      const permissionMode = freshAgentType.settingsVisibility.permissionMode === false
        ? undefined
        : providerSettings?.defaultPermissionMode
          ?? (freshAgentType.runtimeProvider === 'codex'
            ? settings?.codingCli?.providers?.[freshAgentType.runtimeProvider]?.permissionMode
            : undefined)
          ?? providerConfig?.defaultPermissionMode
          ?? freshAgentType.defaultPermissionMode
      const createEffort = resolveFreshAgentPaneCreateEffort({
        sessionType: freshAgentType.sessionType,
        provider: freshAgentType.runtimeProvider,
        model,
        providerEffort: normalizeFreshAgentEffortOverride(providerSettings?.effort),
        fallbackEffort: freshAgentType.defaultEffort,
      })
      return {
        kind: 'fresh-agent',
        sessionType: freshAgentType.sessionType,
        provider: freshAgentType.runtimeProvider,
        createRequestId: nanoid(),
        status: 'creating',
        modelSelection: normalizeFreshAgentModelSelection(providerSettings?.modelSelection),
        ...(shouldPersistPaneModel ? { model } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        sandbox: freshAgentType.runtimeProvider === 'codex'
          ? settings?.codingCli?.providers?.[freshAgentType.runtimeProvider]?.sandbox
          : undefined,
        // Undefined effort is meaningful for opencode live-catalog models:
        // the Default row (no variant) persists as the provider default.
        ...(createEffort ? { effort: createEffort } : {}),
        plugins: freshAgentType.runtimeProvider === 'claude' ? freshAgentSettings?.defaultPlugins : undefined,
        style: providerSettings?.style ?? DEFAULT_FRESH_AGENT_STYLE,
        ...(cwd ? { initialCwd: cwd } : {}),
        ...(checkpointWorkspace ? { checkpointWorkspace } : {}),
      }
    }

    if (isCodingCliProviderName(type, extensionEntries)) {
      return {
        kind: 'terminal',
        mode: type,
        shell: 'system',
        createRequestId: nanoid(),
        status: 'creating',
        ...(cwd ? { initialCwd: cwd } : {}),
      }
    }

    switch (type) {
      case 'shell':
        return {
          kind: 'terminal',
          mode: 'shell',
          shell: 'system',
          createRequestId: nanoid(),
          status: 'creating',
        }
      case 'cmd':
        return {
          kind: 'terminal',
          mode: 'shell',
          shell: 'cmd',
          createRequestId: nanoid(),
          status: 'creating',
        }
      case 'powershell':
        return {
          kind: 'terminal',
          mode: 'shell',
          shell: 'powershell',
          createRequestId: nanoid(),
          status: 'creating',
        }
      case 'wsl':
        return {
          kind: 'terminal',
          mode: 'shell',
          shell: 'wsl',
          createRequestId: nanoid(),
          status: 'creating',
        }
      case 'browser':
        return {
          kind: 'browser',
          browserInstanceId: nanoid(),
          url: '',
          devToolsOpen: false,
        }
      case 'editor':
        return {
          kind: 'editor',
          filePath: null,
          language: null,
          readOnly: false,
          content: '',
          viewMode: 'source',
          wordWrap: true,
        }
      case 'host-stats':
        return { kind: 'host-stats' }
      default:
        throw new Error(`Unsupported pane type: ${String(type)}`)
    }
  }, [freshAgentSettings, extensionEntries, settings?.codingCli?.providers])

  const handleSelect = useCallback((type: PanePickerType) => {
    if (resolveFreshAgentType(type)) {
      setStep({ step: 'directory', providerType: type })
      return
    }

    if (isCodingCliProviderName(type, extensionEntries)) {
      setStep({ step: 'directory', providerType: type })
      return
    }

    const newContent = createContentForType(type)
    dispatch(updatePaneContent({ tabId, paneId, content: newContent }))
  }, [createContentForType, dispatch, tabId, paneId, extensionEntries])

  const handleDirectoryConfirm = useCallback((
    cwd: string,
    checkpointWorkspace?: { path: string; provenance: 'directory-picker' },
  ) => {
    if (step.step !== 'directory') return

    const providerType = step.providerType
    const newContent = createContentForType(providerType, cwd, checkpointWorkspace)
    dispatch(updatePaneContent({ tabId, paneId, content: newContent }))

    // Save the selected directory for the provider
    const settingsKey = getRuntimeSettingsKey(providerType)
    const existingProviderSettings = settings?.codingCli?.providers?.[settingsKey] || {}
    const patch = {
      codingCli: { providers: { [settingsKey]: { ...existingProviderSettings, cwd } } },
    }
    void dispatch(saveServerSettingsPatch(patch))
  }, [createContentForType, dispatch, getRuntimeSettingsKey, paneId, settings, step, tabId])

  const handleCancel = useCallback(() => {
    dispatch(closePaneWithCleanup({ tabId, paneId }))
  }, [dispatch, tabId, paneId])

  if (step.step === 'directory') {
    const providerType = step.providerType
    const freshAgentProviderConfig = getFreshAgentProviderConfig(providerType)
    const freshAgentType = resolveFreshAgentType(providerType)
    const providerLabel = freshAgentProviderConfig ? freshAgentProviderConfig.label : getProviderLabel(providerType, extensionEntries)
    const settingsKey = getRuntimeSettingsKey(providerType)
    const globalDefault = settings?.codingCli?.providers?.[settingsKey]?.cwd
    const defaultCwd = tabPref.defaultCwd ?? globalDefault
    return (
      <DirectoryPicker
        providerType={providerType}
        providerLabel={freshAgentType?.label ?? providerLabel}
        defaultCwd={defaultCwd}
        tabDirectories={tabPref.tabDirectories}
        globalDefault={globalDefault}
        onConfirm={handleDirectoryConfirm}
        onBack={() => setStep({ step: 'type' })}
        paneId={paneId}
        focusEligible={focusEligible}
        focusEpoch={focusEpoch}
      />
    )
  }

  return (
    <PanePicker
      onSelect={handleSelect}
      onCancel={handleCancel}
      isOnlyPane={isOnlyPane}
      tabId={tabId}
      paneId={paneId}
      focusEligible={focusEligible}
      focusEpoch={focusEpoch}
    />
  )
}

function renderContent(
  tabId: string,
  paneId: string,
  content: PaneContent,
  isOnlyPane: boolean,
  hidden?: boolean,
  focusEligible = true,
  focusEpoch = 0,
) {
  if (content.kind === 'terminal') {
    return (
      <ErrorBoundary key={paneId} label="Terminal">
        <TerminalView tabId={tabId} paneId={paneId} paneContent={content} hidden={hidden} focusEpoch={focusEpoch} />
      </ErrorBoundary>
    )
  }

  if (content.kind === 'browser') {
    return (
      <ErrorBoundary key={`${paneId}:${content.browserInstanceId}`} label="Browser">
        <BrowserPane
          paneId={paneId}
          tabId={tabId}
          browserInstanceId={content.browserInstanceId}
          url={content.url}
          devToolsOpen={content.devToolsOpen}
          focusEligible={focusEligible}
          focusEpoch={focusEpoch}
        />
      </ErrorBoundary>
    )
  }

  if (content.kind === 'editor') {
    return (
      <ErrorBoundary key={paneId} label="Editor">
        <Suspense fallback={(
          <div
            data-testid="editor-pane-loading"
            role="status"
            aria-live="polite"
            className="flex h-full items-center justify-center text-sm text-muted-foreground"
          >
            Loading editor...
          </div>
        )}
        >
          <EditorPane
            paneId={paneId}
            tabId={tabId}
            filePath={content.filePath}
            language={content.language}
            readOnly={content.readOnly}
            content={content.content}
            viewMode={content.viewMode}
            wordWrap={content.wordWrap}
            focusEligible={focusEligible}
            focusEpoch={focusEpoch}
          />
        </Suspense>
      </ErrorBoundary>
    )
  }

  if (content.kind === 'fresh-agent') {
    return (
      <ErrorBoundary key={paneId} label="Fresh Agent">
        <FreshAgentView
          tabId={tabId}
          paneId={paneId}
          paneContent={content}
          hidden={hidden}
          focusEpoch={focusEpoch}
        />
      </ErrorBoundary>
    )
  }

  if (content.kind === 'host-stats') {
    return (
      <ErrorBoundary key={paneId} label="System Status">
        <HostStatsPane tabId={tabId} paneId={paneId} />
      </ErrorBoundary>
    )
  }

  if (content.kind === 'picker') {
    return (
      <PickerWrapper
        tabId={tabId}
        paneId={paneId}
        isOnlyPane={isOnlyPane}
        focusEpoch={focusEpoch}
        focusEligible={focusEligible}
      />
    )
  }

  if (content.kind === 'extension') {
    return (
      <ErrorBoundary key={paneId} label="Extension">
        <ExtensionPane tabId={tabId} paneId={paneId} content={content} focusEligible={focusEligible} focusEpoch={focusEpoch} />
      </ErrorBoundary>
    )
  }

  return null
}
