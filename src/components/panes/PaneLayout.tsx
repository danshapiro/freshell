import { useCallback, useEffect, useRef } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { initLayout, addPane } from '@/store/panesSlice'
import type { PaneContentInput } from '@/store/paneTypes'
import PaneContainer from './PaneContainer'
import FloatingActionButton from './FloatingActionButton'

interface PaneLayoutProps {
  tabId: string
  defaultContent: PaneContentInput
  hidden?: boolean
}

export default function PaneLayout({ tabId, defaultContent, hidden }: PaneLayoutProps) {
  const dispatch = useAppDispatch()
  const layout = useAppSelector((s) => s.panes.layouts[tabId])
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

  const handleAddTerminal = useCallback(() => {
    dispatch(addPane({
      tabId,
      newContent: { kind: 'terminal', mode: 'shell' },
    }))
  }, [dispatch, tabId])

  const handleAddBrowser = useCallback(() => {
    dispatch(addPane({
      tabId,
      newContent: { kind: 'browser', url: '', devToolsOpen: false },
    }))
  }, [dispatch, tabId])

  const handleAddEditor = useCallback(() => {
    dispatch(addPane({
      tabId,
      newContent: {
        kind: 'editor',
        filePath: null,
        language: null,
        readOnly: false,
        content: '',
        viewMode: 'source',
      },
    }))
  }, [dispatch, tabId])

  if (!layout) {
    return <div className="h-full w-full" /> // Loading state
  }

  return (
    <div ref={containerRef} className="relative h-full w-full">
      <PaneContainer tabId={tabId} node={layout} hidden={hidden} />
      <FloatingActionButton
        onAddTerminal={handleAddTerminal}
        onAddBrowser={handleAddBrowser}
        onAddEditor={handleAddEditor}
      />
    </div>
  )
}
