import { useCallback, useRef, type RefObject } from 'react'
import { useAppDispatch } from '@/store/hooks'
import { resizePanes } from '@/store/panesSlice'
import type { PaneNode } from '@/store/paneTypes'
import { snap1D, collectCollinearSnapTargets, convertThresholdToLocal } from '@/lib/pane-snap'

/** Shared by the recursive compatibility renderer and the stable divider layer.
 * Keep drag, Shift bypass, keyboard deltas, and snapping in one implementation.
 */
export function usePaneSplitResize({ tabId, node, rootNode, containerRef, snapThreshold }: {
  tabId: string
  node: PaneNode
  rootNode?: PaneNode
  containerRef: RefObject<HTMLDivElement | null>
  snapThreshold: number
}) {
  const dispatch = useAppDispatch()
  const dragStartSizeRef = useRef<number>(0)
  const accumulatedDeltaRef = useRef<number>(0)

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
    // A hidden/zero-sized container has no meaningful pixel-to-percent mapping.
    if (totalSize <= 0 || !Number.isFinite(delta)) return
    const percentDelta = (delta / totalSize) * 100
    let newSize: number
    if (dragStartSizeRef.current === 0) {
      newSize = node.sizes[0] + percentDelta
    } else {
      accumulatedDeltaRef.current += percentDelta
      const rawNewSize = dragStartSizeRef.current + accumulatedDeltaRef.current
      const rootContainer = container.closest('[data-pane-root]') as HTMLElement | null
      const rootW = rootContainer?.offsetWidth ?? container.offsetWidth
      const rootH = rootContainer?.offsetHeight ?? container.offsetHeight
      const collinearPositions = rootNode
        ? collectCollinearSnapTargets(rootNode, direction, splitId, rootW, rootH)
        : []
      const localThreshold = convertThresholdToLocal(snapThreshold, rootW, rootH, totalSize)
      newSize = snap1D(rawNewSize, dragStartSizeRef.current, collinearPositions, localThreshold, shiftHeld ?? false)
    }
    const clampedSize = Math.max(10, Math.min(90, newSize))
    dispatch(resizePanes({ tabId, splitId, sizes: [clampedSize, 100 - clampedSize] }))
  }, [dispatch, tabId, node, rootNode, containerRef, snapThreshold])

  const handleResizeEnd = useCallback(() => {
    dragStartSizeRef.current = 0
    accumulatedDeltaRef.current = 0
  }, [])

  return { handleResizeStart, handleResize, handleResizeEnd }
}
