import { useRef, useCallback, useMemo } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { closePane, setActivePane, resizePanes, updatePaneContent } from '@/store/panesSlice'
import type { PaneNode, PaneContent } from '@/store/paneTypes'
import Pane from './Pane'
import PaneDivider from './PaneDivider'
import TerminalView from '../TerminalView'
import BrowserPane from './BrowserPane'
import EditorPane from './EditorPane'
import PanePicker, { type PanePickerType } from './PanePicker'
import { isCodingCliProviderName } from '@/lib/coding-cli-utils'
import { cn } from '@/lib/utils'
import { getWsClient } from '@/lib/ws-client'
import { derivePaneTitle } from '@/lib/derivePaneTitle'
import { nanoid } from 'nanoid'
import { ContextIds } from '@/components/context-menu/context-menu-constants'

// Stable empty object to avoid selector memoization issues
const EMPTY_PANE_TITLES: Record<string, string> = {}

interface PaneContainerProps {
  tabId: string
  node: PaneNode
  hidden?: boolean
}

export default function PaneContainer({ tabId, node, hidden }: PaneContainerProps) {
  const dispatch = useAppDispatch()
  const activePane = useAppSelector((s) => s.panes.activePane[tabId])
  const paneTitles = useAppSelector((s) => s.panes.paneTitles[tabId] ?? EMPTY_PANE_TITLES)
  const containerRef = useRef<HTMLDivElement>(null)
  const ws = useMemo(() => getWsClient(), [])

  // Check if this is the only pane (root is a leaf)
  const rootNode = useAppSelector((s) => s.panes.layouts[tabId])
  const isOnlyPane = rootNode?.type === 'leaf'

  const handleClose = useCallback((paneId: string, content: PaneContent) => {
    // Clean up terminal process if this pane has one
    if (content.kind === 'terminal' && content.terminalId) {
      ws.send({
        type: 'terminal.detach',
        terminalId: content.terminalId,
      })
    }
    dispatch(closePane({ tabId, paneId }))
  }, [dispatch, tabId, ws])

  const handleFocus = useCallback((paneId: string) => {
    dispatch(setActivePane({ tabId, paneId }))
  }, [dispatch, tabId])

  const handleResize = useCallback((splitId: string, delta: number, direction: 'horizontal' | 'vertical') => {
    if (!containerRef.current) return

    const container = containerRef.current
    const totalSize = direction === 'horizontal' ? container.offsetWidth : container.offsetHeight
    const percentDelta = (delta / totalSize) * 100

    // Get current sizes from the node
    if (node.type !== 'split' || node.id !== splitId) return

    const [size1] = node.sizes
    const newSize1 = Math.max(10, Math.min(90, size1 + percentDelta))
    const newSize2 = 100 - newSize1

    dispatch(resizePanes({ tabId, splitId, sizes: [newSize1, newSize2] }))
  }, [dispatch, tabId, node])

  const handleResizeEnd = useCallback(() => {
    // Could trigger terminal resize here if needed
  }, [])

  // Render a leaf pane
  if (node.type === 'leaf') {
    const explicitTitle = paneTitles[node.id]
    const paneTitle = explicitTitle ?? derivePaneTitle(node.content)
    const paneStatus = node.content.kind === 'terminal' ? node.content.status : 'running'

    return (
      <Pane
        tabId={tabId}
        paneId={node.id}
        isActive={activePane === node.id}
        isOnlyPane={isOnlyPane}
        title={paneTitle}
        status={paneStatus}
        onClose={() => handleClose(node.id, node.content)}
        onFocus={() => handleFocus(node.id)}
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
        onResize={(delta) => handleResize(node.id, delta, node.direction)}
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

  const handleSelect = useCallback((type: PanePickerType) => {
    let newContent: PaneContent

    if (isCodingCliProviderName(type)) {
      const providerCwd = settings?.codingCli?.providers?.[type]?.cwd
      newContent = {
        kind: 'terminal',
        mode: type,
        shell: 'system',
        createRequestId: nanoid(),
        status: 'creating',
        ...(providerCwd ? { initialCwd: providerCwd } : {}),
      }
    } else {
      switch (type) {
        case 'shell':
          newContent = {
            kind: 'terminal',
            mode: 'shell',
            shell: 'system',
            createRequestId: nanoid(),
            status: 'creating',
          }
          break
        case 'cmd':
          newContent = {
            kind: 'terminal',
            mode: 'shell',
            shell: 'cmd',
            createRequestId: nanoid(),
            status: 'creating',
          }
          break
        case 'powershell':
          newContent = {
            kind: 'terminal',
            mode: 'shell',
            shell: 'powershell',
            createRequestId: nanoid(),
            status: 'creating',
          }
          break
        case 'wsl':
          newContent = {
            kind: 'terminal',
            mode: 'shell',
            shell: 'wsl',
            createRequestId: nanoid(),
            status: 'creating',
          }
          break
        case 'browser':
          newContent = {
            kind: 'browser',
            url: '',
            devToolsOpen: false,
          }
          break
        case 'editor':
          newContent = {
            kind: 'editor',
            filePath: null,
            language: null,
            readOnly: false,
            content: '',
            viewMode: 'source',
          }
          break
      }
    }

    dispatch(updatePaneContent({ tabId, paneId, content: newContent }))
  }, [dispatch, tabId, paneId, settings])

  const handleCancel = useCallback(() => {
    dispatch(closePane({ tabId, paneId }))
  }, [dispatch, tabId, paneId])

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
