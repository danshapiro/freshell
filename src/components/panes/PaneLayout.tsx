import { useCallback, useEffect, useRef } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { initLayout, addPane, splitPane } from '@/store/panesSlice'
import type { PaneContentInput } from '@/store/paneTypes'
import StablePaneLayout from './StablePaneLayout'
import { collectSurfaceLeaves, resolveSurfaceZoom } from '@/lib/pane-surface-layout'
import FloatingActionButton from './FloatingActionButton'
import IntersectionDragOverlay from './IntersectionDragOverlay'

interface PaneLayoutProps {
  tabId: string
  defaultContent: PaneContentInput
  hidden?: boolean
}

export default function PaneLayout({ tabId, defaultContent, hidden }: PaneLayoutProps) {
  const dispatch = useAppDispatch()
  const layout = useAppSelector((s) => s.panes.layouts[tabId])
  const zoomedPaneId = useAppSelector((s) => s.panes.zoomedPane?.[tabId])
  const settings = useAppSelector((s) => s.settings.settings)
  const activePaneId = useAppSelector((s) => s.panes.activePane[tabId])
  const containerRef = useRef<HTMLDivElement>(null)

  // Initialize layout if not exists
  useEffect(() => {
    if (!layout) {
      dispatch(initLayout({ tabId, content: defaultContent }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, tabId, layout])

  const buildNewPaneContent = useCallback((): PaneContentInput => {
    const defaultNewPane = settings.panes?.defaultNewPane || 'ask'
    if (defaultNewPane === 'ask') return { kind: 'picker' }
    if (defaultNewPane === 'browser') return { kind: 'browser', url: '', devToolsOpen: false }
    if (defaultNewPane === 'editor') return { kind: 'editor', filePath: null, language: null, readOnly: false, content: '', viewMode: 'source', wordWrap: true }
    return { kind: 'terminal', mode: 'shell', shell: 'system', initialCwd: settings.defaultCwd }
  }, [settings])

  const handleAddPane = useCallback(() => {
    dispatch(addPane({
      tabId,
      newContent: buildNewPaneContent(),
    }))
  }, [dispatch, tabId, buildNewPaneContent])

  const handleSplit = useCallback((direction: 'horizontal' | 'vertical') => {
    if (!activePaneId) return
    dispatch(splitPane({
      tabId,
      paneId: activePaneId,
      direction,
      newContent: buildNewPaneContent(),
    }))
  }, [dispatch, tabId, activePaneId, buildNewPaneContent])

  if (!layout) {
    return <div className="h-full w-full" /> // Loading state
  }

  // Invalid/stale zoom IDs use the normal layout, including its dividers.
  const effectiveZoom = resolveSurfaceZoom(collectSurfaceLeaves(layout), zoomedPaneId)

  return (
    <div ref={containerRef} data-pane-root className="relative h-full w-full">
      <StablePaneLayout tabId={tabId} layout={layout} zoomedPaneId={effectiveZoom} hidden={hidden} />
      {!effectiveZoom && (
        <IntersectionDragOverlay tabId={tabId} containerRef={containerRef} />
      )}
      <FloatingActionButton
        onAdd={handleAddPane}
        onSplitHorizontal={() => handleSplit('horizontal')}
        onSplitVertical={() => handleSplit('vertical')}
      />
    </div>
  )
}
