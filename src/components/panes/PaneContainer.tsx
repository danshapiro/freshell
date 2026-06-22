import { Suspense, lazy, useRef, useCallback, useMemo, useState, useEffect } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { setActivePane, resizePanes, updatePaneContent, clearPaneRenameRequest, toggleZoom, requestPaneRefresh } from '@/store/panesSlice'
import { closePaneWithCleanup } from '@/store/tabsSlice'
import type { PaneNode, PaneContent } from '@/store/paneTypes'
import Pane from './Pane'
import PaneDivider from './PaneDivider'
import TerminalView from '../TerminalView'
import BrowserPane from './BrowserPane'
import FreshAgentView from '../fresh-agent/FreshAgentView'
import ExtensionPane from './ExtensionPane'
import PanePicker, { type PanePickerType } from './PanePicker'
import DirectoryPicker from './DirectoryPicker'
import { getProviderLabel, isCodingCliProviderName } from '@/lib/coding-cli-utils'
import { isFreshAgentProviderName, getFreshAgentProviderConfig } from '@/lib/fresh-agent-provider-utils'
import { normalizeFreshAgentEffort, normalizeFreshAgentModel, resolveFreshAgentType } from '@/lib/fresh-agent-registry'
import { clearDraft } from '@/lib/draft-store'
import { getTerminalActions } from '@/lib/pane-action-registry'
import { buildPaneRefreshTarget } from '@/lib/pane-utils'
import { cn } from '@/lib/utils'
import { withChunkErrorRecovery } from '@/lib/import-retry'
import { getWsClient } from '@/lib/ws-client'
import { api } from '@/lib/api'
import { resolvePaneActivity } from '@/lib/pane-activity'
import { getPaneDisplayTitle } from '@/lib/pane-title'
import { getTabDirectoryPreference } from '@/lib/tab-directory-preference'
import {
  formatPaneRuntimeLabel,
  formatPaneRuntimeTooltip,
  type PaneRuntimeMeta,
} from '@/lib/format-terminal-title-meta'
import { snap1D, collectCollinearSnapTargets, convertThresholdToLocal } from '@/lib/pane-snap'
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
} from '@/store/freshAgentSlice'
import { DEFAULT_FRESH_AGENT_STYLE } from '@shared/settings'
import { cancelCreate } from '@/lib/create-cancellation'
import { getFreshOpenCodeRouteCwd } from '@/lib/fresh-opencode-route'
import type { PaneRuntimeActivityRecord } from '@/store/paneRuntimeActivitySlice'
import type { TerminalMetaRecord } from '@/store/terminalMetaSlice'
import type { ProjectGroup, CodingCliSession } from '@/store/types'
import type { ClientExtensionEntry } from '@shared/extension-types'
import { ErrorBoundary } from '@/components/ui/error-boundary'
import { applyPaneRename } from '@/store/titleSync'
import { saveServerSettingsPatch } from '@/store/settingsThunks'
import { getPreferredResumeSessionId } from '@/store/persistControl'
import type { SessionLocator } from '@shared/ws-protocol'

// Stable empty object to avoid selector memoization issues
const EMPTY_PANE_TITLES: Record<string, string> = {}
const EMPTY_TERMINAL_META_BY_ID: Record<string, TerminalMetaRecord> = {}
const EMPTY_PROJECTS: ProjectGroup[] = []
const EMPTY_FRESH_AGENT_SESSIONS: Record<string, FreshAgentSessionState> = {}
const EMPTY_CODEX_ACTIVITY_BY_ID = {}
const EMPTY_CLAUDE_ACTIVITY_BY_ID = {}
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

function findIndexedSessionById(
  projects: ProjectGroup[],
  provider: CodingCliProviderName,
  sessionId: string,
): CodingCliSession | undefined {
  for (const project of projects) {
    const match = project.sessions.find((session) => (
      session.provider === provider && session.sessionId === sessionId
    ))
    if (match) return match
  }
  return undefined
}

function resolveFreshClaudeRuntimeMeta(
  indexedProjects: ProjectGroup[],
  content: FreshAgentPaneContent,
  session: FreshAgentSessionState | undefined,
): PaneRuntimeMeta | undefined {
  if (content.provider !== 'claude') return undefined

  const provider = content.provider
  const indexedSessionId = getPreferredResumeSessionId(session) ?? content.resumeSessionId
  if (!provider || !indexedSessionId) return undefined

  const indexed = findIndexedSessionById(indexedProjects, provider, indexedSessionId)
  if (!indexed) return undefined

  return {
    cwd: indexed.cwd,
    checkoutRoot: indexed.projectPath,
    repoRoot: indexed.projectPath,
    branch: indexed.gitBranch,
    isDirty: indexed.isDirty,
    tokenUsage: indexed.tokenUsage,
  }
}

export default function PaneContainer({ tabId, node, hidden }: PaneContainerProps) {
  const dispatch = useAppDispatch()
  const activePane = useAppSelector((s) => s.panes.activePane[tabId])
  const tab = useAppSelector((s) => s.tabs.tabs.find((t) => t.id === tabId))
  const paneTitles = useAppSelector((s) => s.panes.paneTitles[tabId] ?? EMPTY_PANE_TITLES)
  const extensionEntries = useAppSelector((s) => s.extensions?.entries ?? EMPTY_EXTENSION_ENTRIES)
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

  // Drag state for snapping: track the original size and accumulated delta
  const dragStartSizeRef = useRef<number>(0)
  const accumulatedDeltaRef = useRef<number>(0)

  // Check if this is the only pane (root is a leaf)
  const rootNode = useAppSelector((s) => s.panes.layouts[tabId])
  const isOnlyPane = rootNode?.type === 'leaf'

  // Inline rename state (local to this PaneContainer instance)
  const [renamingPaneId, setRenamingPaneId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)

  // Listen for rename requests from Redux (context menu trigger)
  const renameRequestTabId = useAppSelector((s) => s.panes.renameRequestTabId)
  const renameRequestPaneId = useAppSelector((s) => s.panes.renameRequestPaneId)

  useEffect(() => {
    if (!renameRequestTabId || !renameRequestPaneId) return
    if (renameRequestTabId !== tabId) return
    // Only handle the request if this PaneContainer renders the target pane as a leaf
    if (node.type !== 'leaf' || node.id !== renameRequestPaneId) return

    const currentTitle = getPaneDisplayTitle(node.content, paneTitles[node.id], extensionEntries)
    setRenamingPaneId(node.id)
    setRenameValue(currentTitle)
    setRenameError(null)
    dispatch(clearPaneRenameRequest())
  }, [renameRequestTabId, renameRequestPaneId, tabId, node, paneTitles, extensionEntries, dispatch])

  const startRename = useCallback((paneId: string, currentTitle: string) => {
    setRenamingPaneId(paneId)
    setRenameValue(currentTitle)
    setRenameError(null)
  }, [])

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
      return
    }
    if (node.type !== 'leaf') return
    api.patch(`/api/panes/${encodeURIComponent(paneId)}`, {
      name: trimmed,
    }).then((response: { data?: { paneId?: string; tabRenamed?: boolean }; message?: string } | null | undefined) => {
      if (response?.data?.paneId !== paneId) {
        throw new Error(response?.message || 'Failed to rename pane')
      }
      dispatch(applyPaneRename({ tabId, paneId, title: trimmed }))
      setRenameError(null)
      setRenamingPaneId(null)
      setRenameValue('')
    }).catch((error: any) => {
      const message = typeof error?.message === 'string' && error.message
        ? error.message
        : 'Failed to rename pane'
      setRenameError(message)
    })
  }, [dispatch, tabId, renamingPaneId, renameValue, node])

  const handleRenameKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault()
      ;(e.target as HTMLInputElement).blur()
    }
  }, [])

  const handleClose = useCallback((paneId: string, content: PaneContent) => {
    // Clean up terminal process if this pane has one
    if (content.kind === 'terminal' && content.terminalId) {
      ws.send({
        type: 'terminal.detach',
        terminalId: content.terminalId,
      })
    }
    if (content.kind === 'fresh-agent') {
      clearDraft(paneId)
      const pendingCreate = freshAgentPendingCreates[content.createRequestId]
      const pendingSessionId = pendingCreate?.sessionId
      const sessionId = content.sessionId || pendingSessionId
      if (sessionId) {
        const cwd = getFreshOpenCodeRouteCwd(content, { freshAgentSessions, sessionId })
        ws.send({
          type: 'freshAgent.kill',
          sessionId,
          sessionType: content.sessionType,
          provider: content.provider,
          ...(cwd ? { cwd } : {}),
        })
      } else {
        cancelCreate(content.createRequestId)
        ws.cancelCreate(content.createRequestId)
      }
      if (!content.sessionId && pendingSessionId) {
        dispatch(removeFreshAgentSession({
          sessionId: pendingSessionId,
          sessionType: content.sessionType,
          provider: content.provider,
        }))
        dispatch(clearFreshAgentPendingCreate({ requestId: content.createRequestId }))
      }
    }
    // Extension panes: V1 leaves server extensions running until freshell shutdown.
    // Future: stop singleton server when its last pane closes.
    dispatch(closePaneWithCleanup({ tabId, paneId }))
  }, [dispatch, freshAgentPendingCreates, freshAgentSessions, tabId, ws])

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

  const handleResizeStart = useCallback(() => {
    if (node.type !== 'split') return
    dragStartSizeRef.current = node.sizes[0]
    accumulatedDeltaRef.current = 0
  }, [node])

  const handleResize = useCallback((splitId: string, delta: number, direction: 'horizontal' | 'vertical', shiftHeld?: boolean) => {
    if (!containerRef.current) return
    if (node.type !== 'split' || node.id !== splitId) return

    const container = containerRef.current
    const totalSize = direction === 'horizontal' ? container.offsetWidth : container.offsetHeight
    const percentDelta = (delta / totalSize) * 100

    let newSize: number

    if (dragStartSizeRef.current === 0) {
      // Keyboard resize (no drag start): apply delta directly without snapping
      newSize = node.sizes[0] + percentDelta
    } else {
      // Mouse/touch drag: accumulate delta and apply snapping
      accumulatedDeltaRef.current += percentDelta
      const rawNewSize = dragStartSizeRef.current + accumulatedDeltaRef.current

      // Get root container dimensions for coordinate conversion
      const rootContainer = containerRef.current.closest('[data-pane-root]') as HTMLElement | null
      const rootW = rootContainer?.offsetWidth ?? container.offsetWidth
      const rootH = rootContainer?.offsetHeight ?? container.offsetHeight

      // Collect snap targets in local % space using absolute coordinate conversion
      const collinearPositions = rootNode
        ? collectCollinearSnapTargets(rootNode, direction, splitId, rootW, rootH)
        : []

      // Convert snap threshold from "% of smallest dimension" to local split %
      const localThreshold = convertThresholdToLocal(snapThreshold, rootW, rootH, totalSize)

      // Apply snapping
      newSize = snap1D(
        rawNewSize,
        dragStartSizeRef.current,
        collinearPositions,
        localThreshold,
        shiftHeld ?? false,
      )
    }

    const clampedSize = Math.max(10, Math.min(90, newSize))
    const newSize2 = 100 - clampedSize

    dispatch(resizePanes({ tabId, splitId, sizes: [clampedSize, newSize2] }))
  }, [dispatch, tabId, node, rootNode, snapThreshold])

  const handleResizeEnd = useCallback(() => {
    dragStartSizeRef.current = 0
    accumulatedDeltaRef.current = 0
  }, [])

  // Render a leaf pane
  if (node.type === 'leaf') {
    const explicitTitle = paneTitles[node.id]
    const paneTitle = getPaneDisplayTitle(node.content, explicitTitle, extensionEntries)
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
          ? (
            node.content.provider === 'claude'
          )
            ? resolveFreshClaudeRuntimeMeta(
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
        : undefined
    const paneMetaLabel =
      paneRuntimeMeta
        ? formatPaneRuntimeLabel(paneRuntimeMeta)
        : undefined
    const paneMetaTooltip =
      paneRuntimeMeta
        ? formatPaneRuntimeTooltip(paneRuntimeMeta)
        : undefined
    const paneBusy = resolvePaneActivity({
      paneId: node.id,
      content: node.content,
      tabMode: tab?.mode,
      isOnlyPane,
      codexActivityByTerminalId,
      claudeActivityByTerminalId,
      opencodeActivityByTerminalId,
      paneRuntimeActivityByPaneId,
      freshAgentSessions,
    }).isBusy

    const needsAttention = tabAttentionStyle !== 'none' && !!attentionByPane[node.id]

    const refreshTarget = buildPaneRefreshTarget(node.content)
    const handleRefresh = refreshTarget
      ? () => dispatch(requestPaneRefresh({ tabId, paneId: node.id }))
      : undefined

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
        onDoubleClickTitle={() => startRename(node.id, paneTitle)}
      >
        {renderContent(tabId, node.id, node.content, isOnlyPane, hidden)}
      </Pane>
    )
  }

  // Render a split
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
}: {
  tabId: string
  paneId: string
  isOnlyPane: boolean
}) {
  const dispatch = useAppDispatch()
  const settings = useAppSelector((s) => s.settings?.settings)
  const freshAgentSettings = useAppSelector((s) => s.settings?.settings?.freshAgent ?? s.settings?.serverSettings?.freshAgent)
  const extensionEntries = useAppSelector((s) => s.extensions?.entries ?? EMPTY_EXTENSION_ENTRIES)
  const paneLayout = useAppSelector((s) => s.panes.layouts[tabId])
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

  const createContentForType = useCallback((type: PanePickerType, cwd?: string): PaneContent => {
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
      const providerDefaultModel = typeof providerSettings?.modelSelection?.modelId === 'string'
        ? providerSettings.modelSelection.modelId
        : undefined
      const configuredModel = freshAgentType.runtimeProvider === 'codex' || freshAgentType.runtimeProvider === 'opencode'
        ? providerDefaultModel
          ?? settings?.codingCli?.providers?.[freshAgentType.runtimeProvider]?.model
          ?? freshAgentType.defaultModel
        : freshAgentType.defaultModel
      const model = normalizeFreshAgentModel(freshAgentType.sessionType, freshAgentType.runtimeProvider, configuredModel) ?? configuredModel
      const permissionMode = freshAgentType.settingsVisibility.permissionMode === false
        ? undefined
        : providerSettings?.defaultPermissionMode
          ?? (freshAgentType.runtimeProvider === 'codex'
            ? settings?.codingCli?.providers?.[freshAgentType.runtimeProvider]?.permissionMode
            : undefined)
          ?? providerConfig?.defaultPermissionMode
          ?? freshAgentType.defaultPermissionMode
      return {
        kind: 'fresh-agent',
        sessionType: freshAgentType.sessionType,
        provider: freshAgentType.runtimeProvider,
        createRequestId: nanoid(),
        status: 'creating',
        modelSelection: normalizeFreshAgentModelSelection(providerSettings?.modelSelection),
        model,
        ...(permissionMode ? { permissionMode } : {}),
        sandbox: freshAgentType.runtimeProvider === 'codex'
          ? settings?.codingCli?.providers?.[freshAgentType.runtimeProvider]?.sandbox
          : undefined,
        effort: normalizeFreshAgentEffort(
          freshAgentType.sessionType,
          freshAgentType.runtimeProvider,
          model,
          normalizeFreshAgentEffortOverride(providerSettings?.effort) ?? freshAgentType.defaultEffort,
        ) ?? freshAgentType.defaultEffort,
        plugins: freshAgentType.runtimeProvider === 'claude' ? freshAgentSettings?.defaultPlugins : undefined,
        style: providerSettings?.style ?? DEFAULT_FRESH_AGENT_STYLE,
        ...(cwd ? { initialCwd: cwd } : {}),
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

  const handleDirectoryConfirm = useCallback((cwd: string) => {
    if (step.step !== 'directory') return

    const providerType = step.providerType
    const newContent = createContentForType(providerType, cwd)
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
    />
  )
}

function renderContent(
  tabId: string,
  paneId: string,
  content: PaneContent,
  isOnlyPane: boolean,
  hidden?: boolean,
) {
  if (content.kind === 'terminal') {
    return (
      <ErrorBoundary key={paneId} label="Terminal">
        <TerminalView tabId={tabId} paneId={paneId} paneContent={content} hidden={hidden} />
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
        />
      </ErrorBoundary>
    )
  }

  if (content.kind === 'picker') {
    return (
      <PickerWrapper
        tabId={tabId}
        paneId={paneId}
        isOnlyPane={isOnlyPane}
      />
    )
  }

  if (content.kind === 'extension') {
    return (
      <ErrorBoundary key={paneId} label="Extension">
        <ExtensionPane tabId={tabId} paneId={paneId} content={content} />
      </ErrorBoundary>
    )
  }

  return null
}
