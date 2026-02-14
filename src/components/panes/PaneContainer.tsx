import { useRef, useCallback, useMemo, useState, useEffect } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { setActivePane, resizePanes, updatePaneContent, updatePaneTitle, clearPaneRenameRequest, toggleZoom } from '@/store/panesSlice'
import { updateTab, closePaneWithCleanup } from '@/store/tabsSlice'
import type { PaneNode, PaneContent } from '@/store/paneTypes'
import Pane from './Pane'
import PaneDivider from './PaneDivider'
import TerminalView from '../TerminalView'
import BrowserPane from './BrowserPane'
import EditorPane from './EditorPane'
import ClaudeChatView from '../claude-chat/ClaudeChatView'
import PanePicker, { type PanePickerType } from './PanePicker'
import DirectoryPicker from './DirectoryPicker'
import { getProviderLabel, isCodingCliProviderName } from '@/lib/coding-cli-utils'
import { cn } from '@/lib/utils'
import { getWsClient } from '@/lib/ws-client'
import { api } from '@/lib/api'
import { derivePaneTitle } from '@/lib/derivePaneTitle'
import { getTabDirectoryPreference } from '@/lib/tab-directory-preference'
import { formatPaneRuntimeLabel, formatPaneRuntimeTooltip } from '@/lib/format-terminal-title-meta'
import { snap1D, collectCollinearSnapTargets, convertThresholdToLocal } from '@/lib/pane-snap'
import { nanoid } from 'nanoid'
import { ContextIds } from '@/components/context-menu/context-menu-constants'
import type { CodingCliProviderName } from '@/lib/coding-cli-types'
import { updateSettingsLocal } from '@/store/settingsSlice'
import { clearPaneAttention, clearTabAttention } from '@/store/turnCompletionSlice'
import { clearPendingCreate, removeSession } from '@/store/claudeChatSlice'
import { cancelCreate } from '@/lib/sdk-message-handler'
import type { TerminalMetaRecord } from '@/store/terminalMetaSlice'

// Stable empty object to avoid selector memoization issues
const EMPTY_PANE_TITLES: Record<string, string> = {}
const EMPTY_TERMINAL_META_BY_ID: Record<string, TerminalMetaRecord> = {}
const EMPTY_ATTENTION_BY_PANE: Record<string, boolean> = {}
const EMPTY_PENDING_CREATES: Record<string, string> = {}

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
    tabTerminalId?: string
    isOnlyPane: boolean
    provider?: CodingCliProviderName
    resumeSessionId?: string
    initialCwd?: string
  },
): TerminalMetaRecord | undefined {
  if (options.terminalId) {
    const byTerminalId = terminalMetaById[options.terminalId]
    if (byTerminalId) return byTerminalId
  }

  // During refresh/rehydration, single-pane tabs can briefly have tab-level
  // terminal IDs before the pane content is fully reattached.
  if (!options.terminalId && options.isOnlyPane && options.tabTerminalId) {
    const byTabTerminalId = terminalMetaById[options.tabTerminalId]
    if (byTabTerminalId) return byTabTerminalId
  }

  if (options.resumeSessionId && options.provider) {
    return Object.values(terminalMetaById).find((record) => (
      record.provider === options.provider && record.sessionId === options.resumeSessionId
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

export default function PaneContainer({ tabId, node, hidden }: PaneContainerProps) {
  const dispatch = useAppDispatch()
  const activePane = useAppSelector((s) => s.panes.activePane[tabId])
  const tab = useAppSelector((s) => s.tabs.tabs.find((t) => t.id === tabId))
  const tabTerminalId = tab?.terminalId
  const paneTitles = useAppSelector((s) => s.panes.paneTitles[tabId] ?? EMPTY_PANE_TITLES)
  const terminalMetaById = useAppSelector(
    (s) => s.terminalMeta?.byTerminalId ?? EMPTY_TERMINAL_META_BY_ID
  )
  const zoomedPaneId = useAppSelector((s) => s.panes.zoomedPane?.[tabId])
  const attentionByPane = useAppSelector(
    (s) => s.turnCompletion?.attentionByPane ?? EMPTY_ATTENTION_BY_PANE
  )
  const tabAttentionStyle = useAppSelector(
    (s) => s.settings?.settings?.panes?.tabAttentionStyle ?? 'highlight'
  )
  const attentionDismiss = useAppSelector(
    (s) => s.settings?.settings?.panes?.attentionDismiss ?? 'click'
  )
  const containerRef = useRef<HTMLDivElement>(null)
  const ws = useMemo(() => getWsClient(), [])
  const snapThreshold = useAppSelector((s) => s.settings?.settings?.panes?.snapThreshold ?? 2)
  const sdkPendingCreates = useAppSelector(
    (s) => s.claudeChat?.pendingCreates ?? EMPTY_PENDING_CREATES
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

  // Listen for rename requests from Redux (context menu trigger)
  const renameRequestTabId = useAppSelector((s) => s.panes.renameRequestTabId)
  const renameRequestPaneId = useAppSelector((s) => s.panes.renameRequestPaneId)

  useEffect(() => {
    if (!renameRequestTabId || !renameRequestPaneId) return
    if (renameRequestTabId !== tabId) return
    // Only handle the request if this PaneContainer renders the target pane as a leaf
    if (node.type !== 'leaf' || node.id !== renameRequestPaneId) return

    const currentTitle = paneTitles[node.id] ?? derivePaneTitle(node.content)
    setRenamingPaneId(node.id)
    setRenameValue(currentTitle)
    dispatch(clearPaneRenameRequest())
  }, [renameRequestTabId, renameRequestPaneId, tabId, node, paneTitles, dispatch])

  const startRename = useCallback((paneId: string, currentTitle: string) => {
    setRenamingPaneId(paneId)
    setRenameValue(currentTitle)
  }, [])

  const commitRename = useCallback(() => {
    if (!renamingPaneId) return
    const trimmed = renameValue.trim()
    if (trimmed) {
      dispatch(updatePaneTitle({ tabId, paneId: renamingPaneId, title: trimmed }))
    }
    // Empty value keeps the original title (no dispatch)
    setRenamingPaneId(null)
    setRenameValue('')
  }, [dispatch, tabId, renamingPaneId, renameValue])

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
      // Clear stale tab.terminalId so background-terminal dedup doesn't
      // focus this tab after the pane's terminal has been detached
      if (tabTerminalId === content.terminalId) {
        dispatch(updateTab({ id: tabId, updates: { terminalId: undefined } }))
      }
    }
    // Clean up SDK session if this pane has one
    if (content.kind === 'claude-chat') {
      const sessionId = content.sessionId || sdkPendingCreates[content.createRequestId]
      if (sessionId) {
        ws.send({ type: 'sdk.kill', sessionId })
      } else {
        // No sessionId yet — sdk.created hasn't arrived. Mark the createRequestId as
        // cancelled so the message handler will kill the orphan when it does arrive.
        cancelCreate(content.createRequestId)
      }
      // Clean up Redux state for orphaned pending creates
      if (!content.sessionId && sdkPendingCreates[content.createRequestId]) {
        dispatch(removeSession({ sessionId: sdkPendingCreates[content.createRequestId] }))
        dispatch(clearPendingCreate({ requestId: content.createRequestId }))
      }
    }
    dispatch(closePaneWithCleanup({ tabId, paneId }))
  }, [dispatch, tabId, tabTerminalId, ws, sdkPendingCreates])

  const handleFocus = useCallback((paneId: string) => {
    if (attentionDismiss === 'click' && attentionByPane[paneId]) {
      dispatch(clearPaneAttention({ paneId }))
      dispatch(clearTabAttention({ tabId }))
    }
    dispatch(setActivePane({ tabId, paneId }))
  }, [dispatch, tabId, attentionDismiss, attentionByPane])

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
    const paneTitle = explicitTitle ?? derivePaneTitle(node.content)
    const paneStatus = node.content.kind === 'terminal'
      ? node.content.status
      : node.content.kind === 'claude-chat'
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
    const paneResumeSessionId =
      node.content.kind === 'terminal'
        ? (node.content.resumeSessionId || tab?.resumeSessionId)
        : undefined
    const paneInitialCwd =
      node.content.kind === 'terminal'
        ? (node.content.initialCwd || tab?.initialCwd)
        : undefined
    const paneRuntimeMeta =
      node.content.kind === 'terminal'
        ? resolvePaneRuntimeMeta(terminalMetaById, {
          terminalId: node.content.terminalId,
          tabTerminalId,
          isOnlyPane,
          provider: paneProvider,
          resumeSessionId: paneResumeSessionId,
          initialCwd: paneInitialCwd,
        })
        : undefined
    const paneMetaLabel =
      paneRuntimeMeta
        ? formatPaneRuntimeLabel(paneRuntimeMeta)
        : undefined
    const paneMetaTooltip =
      paneRuntimeMeta
        ? formatPaneRuntimeTooltip(paneRuntimeMeta)
        : undefined

    const needsAttention = tabAttentionStyle !== 'none' && !!attentionByPane[node.id]

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
        needsAttention={needsAttention}
        onClose={() => handleClose(node.id, node.content)}
        onFocus={() => handleFocus(node.id)}
        onToggleZoom={() => handleToggleZoom(node.id)}
        isZoomed={zoomedPaneId === node.id}
        isRenaming={isRenaming}
        renameValue={isRenaming ? renameValue : undefined}
        onRenameChange={isRenaming ? setRenameValue : undefined}
        onRenameBlur={isRenaming ? commitRename : undefined}
        onRenameKeyDown={isRenaming ? handleRenameKeyDown : undefined}
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
  const paneLayout = useAppSelector((s) => s.panes.layouts[tabId])
  const tabPref = useMemo(
    () => paneLayout ? getTabDirectoryPreference(paneLayout) : { defaultCwd: undefined, tabDirectories: [] },
    [paneLayout],
  )
  const [step, setStep] = useState<
    | { step: 'type' }
    | { step: 'directory'; providerType: CodingCliProviderName }
    | { step: 'directory'; providerType: 'claude-web' }
  >({ step: 'type' })

  const createContentForType = useCallback((type: PanePickerType, cwd?: string): PaneContent => {
    if (type === 'claude-web') {
      const defaults = settings?.freshclaude
      return {
        kind: 'claude-chat',
        createRequestId: nanoid(),
        status: 'creating',
        model: defaults?.defaultModel,
        permissionMode: defaults?.defaultPermissionMode,
        effort: defaults?.defaultEffort,
        ...(cwd ? { initialCwd: cwd } : {}),
      }
    }

    if (isCodingCliProviderName(type)) {
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
        }
      default:
        throw new Error(`Unsupported pane type: ${String(type)}`)
    }
  }, [])

  const handleSelect = useCallback((type: PanePickerType) => {
    if (type === 'claude-web') {
      setStep({ step: 'directory', providerType: 'claude-web' })
      return
    }

    if (isCodingCliProviderName(type)) {
      setStep({ step: 'directory', providerType: type })
      return
    }

    const newContent = createContentForType(type)
    dispatch(updatePaneContent({ tabId, paneId, content: newContent }))
  }, [createContentForType, dispatch, tabId, paneId])

  const handleDirectoryConfirm = useCallback((cwd: string) => {
    if (step.step !== 'directory') return

    const providerType = step.providerType
    const newContent = createContentForType(providerType, cwd)
    dispatch(updatePaneContent({ tabId, paneId, content: newContent }))

    // Save the selected directory for the provider (use 'claude' key for claude-web)
    const settingsKey = providerType === 'claude-web' ? 'claude' : providerType
    const existingProviderSettings = settings?.codingCli?.providers?.[settingsKey] || {}
    const patch = {
      codingCli: { providers: { [settingsKey]: { ...existingProviderSettings, cwd } } },
    }
    dispatch(updateSettingsLocal(patch as any))
    void api.patch('/api/settings', patch).catch((err) => {
      console.warn('Failed to save provider starting directory', err)
    })
  }, [createContentForType, dispatch, paneId, settings, step, tabId])

  const handleCancel = useCallback(() => {
    dispatch(closePaneWithCleanup({ tabId, paneId }))
  }, [dispatch, tabId, paneId])

  if (step.step === 'directory') {
    const providerType = step.providerType
    const providerLabel = providerType === 'claude-web' ? 'freshclaude' : getProviderLabel(providerType)
    const settingsKey = providerType === 'claude-web' ? 'claude' : providerType
    const globalDefault = settings?.codingCli?.providers?.[settingsKey]?.cwd
    const defaultCwd = tabPref.defaultCwd ?? globalDefault
    return (
      <DirectoryPicker
        providerType={providerType}
        providerLabel={providerLabel}
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

function renderContent(tabId: string, paneId: string, content: PaneContent, isOnlyPane: boolean, hidden?: boolean) {
  if (content.kind === 'terminal') {
    // Terminal panes need a unique key based on paneId for proper lifecycle
    // Pass paneContent directly to avoid redundant tree traversal in TerminalView
    return <TerminalView key={paneId} tabId={tabId} paneId={paneId} paneContent={content} hidden={hidden} />
  }

  if (content.kind === 'browser') {
    return <BrowserPane paneId={paneId} tabId={tabId} url={content.url} devToolsOpen={content.devToolsOpen} />
  }

  if (content.kind === 'editor') {
    return (
      <EditorPane
        paneId={paneId}
        tabId={tabId}
        filePath={content.filePath}
        language={content.language}
        readOnly={content.readOnly}
        content={content.content}
        viewMode={content.viewMode}
      />
    )
  }

  if (content.kind === 'claude-chat') {
    return <ClaudeChatView key={paneId} tabId={tabId} paneId={paneId} paneContent={content} hidden={hidden} />
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

  return null
}
