import { useCallback, useEffect, useRef } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { initLayout, splitPane } from '@/store/panesSlice'
import type { PaneContentInput } from '@/store/paneTypes'
import PaneContainer from './PaneContainer'
import FloatingActionButton from './FloatingActionButton'

interface PaneLayoutProps {
  tabId: string
  defaultContent: PaneContentInput
}

export default function PaneLayout({ tabId, defaultContent }: PaneLayoutProps) {
  const dispatch = useAppDispatch()
  const layout = useAppSelector((s) => s.panes.layouts[tabId])
  const activePane = useAppSelector((s) => s.panes.activePane[tabId])
  const containerRef = useRef<HTMLDivElement>(null)

  // Debug: check what's in the store
  const allLayouts = useAppSelector((s) => s.panes.layouts)

  // Initialize layout if not exists
  useEffect(() => {
    if (!layout) {
      // Only log when actually creating a new layout
      console.log('[PaneLayout] Creating new layout for tabId:', tabId)
      console.log('[PaneLayout] Available layout keys:', Object.keys(allLayouts))
      dispatch(initLayout({ tabId, content: defaultContent }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, tabId, layout])

  // Determine split direction based on container dimensions
  const getSplitDirection = useCallback((): 'horizontal' | 'vertical' => {
    if (!containerRef.current) return 'horizontal'
    const { width, height } = containerRef.current.getBoundingClientRect()
    return width >= height ? 'horizontal' : 'vertical'
  }, [])

  const handleAddTerminal = useCallback(() => {
    if (!activePane) return
    dispatch(splitPane({
      tabId,
      paneId: activePane,
      direction: getSplitDirection(),
      newContent: { kind: 'terminal', mode: 'shell' },
    }))
  }, [dispatch, tabId, activePane, getSplitDirection])

  const handleAddBrowser = useCallback(() => {
    if (!activePane) return
    dispatch(splitPane({
      tabId,
      paneId: activePane,
      direction: getSplitDirection(),
      newContent: { kind: 'browser', url: '', devToolsOpen: false },
    }))
  }, [dispatch, tabId, activePane, getSplitDirection])

  if (!layout) {
    return <div className="h-full w-full" /> // Loading state
  }

  return (
    <div ref={containerRef} className="relative h-full w-full">
      <PaneContainer tabId={tabId} node={layout} />
      <FloatingActionButton
        onAddTerminal={handleAddTerminal}
        onAddBrowser={handleAddBrowser}
      />
    </div>
  )
}
