import { useCallback, useEffect, useRef } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { initLayout, addPane } from '@/store/panesSlice'
import type { PaneContentInput, PaneNode } from '@/store/paneTypes'
import PaneContainer from './PaneContainer'
import FloatingActionButton from './FloatingActionButton'
import IntersectionDragOverlay from './IntersectionDragOverlay'

/** Find a leaf node by id in the pane tree. */
function findLeaf(node: PaneNode, id: string): Extract<PaneNode, { type: 'leaf' }> | null {
  if (node.type === 'leaf') return node.id === id ? node : null
  return findLeaf(node.children[0], id) || findLeaf(node.children[1], id)
}

interface PaneLayoutProps {
  tabId: string
  defaultContent: PaneContentInput
  hidden?: boolean
}

export default function PaneLayout({ tabId, defaultContent, hidden }: PaneLayoutProps) {
  const dispatch = useAppDispatch()
  const layout = useAppSelector((s) => s.panes.layouts[tabId])
  const zoomedPaneId = useAppSelector((s) => s.panes.zoomedPane?.[tabId])
  const containerRef = useRef<HTMLDivElement>(null)

  // Initialize layout if not exists
  useEffect(() => {
    if (!layout) {
      dispatch(initLayout({ tabId, content: defaultContent }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, tabId, layout])

  const handleAddPane = useCallback(() => {
    dispatch(addPane({
      tabId,
      newContent: { kind: 'picker' },
    }))
  }, [dispatch, tabId])

  if (!layout) {
    return <div className="h-full w-full" /> // Loading state
  }

  // When zoomed, find the leaf and render only that pane
  const zoomedLeaf = zoomedPaneId ? findLeaf(layout, zoomedPaneId) : null
  const nodeToRender = zoomedLeaf ?? layout

  return (
    <div ref={containerRef} data-pane-root className="relative h-full w-full">
      <PaneContainer tabId={tabId} node={nodeToRender} hidden={hidden} />
      {!zoomedPaneId && (
        <IntersectionDragOverlay tabId={tabId} containerRef={containerRef} />
      )}
      <FloatingActionButton onAdd={handleAddPane} />
    </div>
  )
}
