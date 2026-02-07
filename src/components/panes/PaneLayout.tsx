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

  return (
    <div ref={containerRef} className="relative h-full w-full">
      <PaneContainer tabId={tabId} node={layout} hidden={hidden} />
      <FloatingActionButton onAdd={handleAddPane} />
    </div>
  )
}
