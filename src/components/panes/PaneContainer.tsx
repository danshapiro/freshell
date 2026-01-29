import { useRef, useCallback, useMemo } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { closePane, setActivePane, resizePanes } from '@/store/panesSlice'
import type { PaneNode, PaneContent } from '@/store/paneTypes'
import Pane from './Pane'
import PaneDivider from './PaneDivider'
import TerminalView from '../TerminalView'
import BrowserPane from './BrowserPane'
import { cn } from '@/lib/utils'
import { getWsClient } from '@/lib/ws-client'

interface PaneContainerProps {
  tabId: string
  node: PaneNode
}

export default function PaneContainer({ tabId, node }: PaneContainerProps) {
  const dispatch = useAppDispatch()
  const activePane = useAppSelector((s) => s.panes.activePane[tabId])
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

    const [size1, size2] = node.sizes
    const newSize1 = Math.max(10, Math.min(90, size1 + percentDelta))
    const newSize2 = 100 - newSize1

    dispatch(resizePanes({ tabId, splitId, sizes: [newSize1, newSize2] }))
  }, [dispatch, tabId, node])

  const handleResizeEnd = useCallback(() => {
    // Could trigger terminal resize here if needed
  }, [])

  // Render a leaf pane
  if (node.type === 'leaf') {
    return (
      <Pane
        isActive={activePane === node.id}
        isOnlyPane={isOnlyPane}
        onClose={() => handleClose(node.id, node.content)}
        onFocus={() => handleFocus(node.id)}
      >
        {renderContent(tabId, node.id, node.content)}
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
        <PaneContainer tabId={tabId} node={node.children[0]} />
      </div>

      <PaneDivider
        direction={node.direction}
        onResize={(delta) => handleResize(node.id, delta, node.direction)}
        onResizeEnd={handleResizeEnd}
      />

      <div style={{ [node.direction === 'horizontal' ? 'width' : 'height']: `${size2}%` }} className="min-w-0 min-h-0">
        <PaneContainer tabId={tabId} node={node.children[1]} />
      </div>
    </div>
  )
}

function renderContent(tabId: string, paneId: string, content: PaneContent) {
  if (content.kind === 'terminal') {
    // Terminal panes need a unique key based on paneId for proper lifecycle
    // Pass paneContent directly to avoid redundant tree traversal in TerminalView
    return <TerminalView key={paneId} tabId={tabId} paneId={paneId} paneContent={content} hidden={false} />
  }

  if (content.kind === 'browser') {
    return <BrowserPane paneId={paneId} tabId={tabId} url={content.url} devToolsOpen={content.devToolsOpen} />
  }

  return null
}
