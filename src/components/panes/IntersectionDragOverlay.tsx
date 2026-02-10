import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { resizeMultipleSplits } from '@/store/panesSlice'
import type { PaneNode } from '@/store/paneTypes'
import {
  computeDividerSegments,
  findIntersections,
  snap2D,
  type Intersection,
} from '@/lib/pane-snap'

/** Size of each invisible hot zone centered on an intersection (px). */
const HOT_ZONE_SIZE = 24

interface IntersectionDragOverlayProps {
  tabId: string
  containerRef: React.RefObject<HTMLDivElement | null>
}

/**
 * Transparent overlay that renders invisible hot zones at divider bar
 * intersections. Dragging a hot zone moves all connected divider bars
 * simultaneously in 2D, with independent axis snapping.
 */
export default function IntersectionDragOverlay({
  tabId,
  containerRef,
}: IntersectionDragOverlayProps) {
  const dispatch = useAppDispatch()
  const layout = useAppSelector((s) => s.panes.layouts[tabId])
  const snapThreshold = useAppSelector(
    (s) => s.settings?.settings?.panes?.snapThreshold ?? 2,
  )

  // Dragging state
  const [dragging, setDragging] = useState<{
    intersection: Intersection
    startMouseX: number
    startMouseY: number
    /** Original intersection position at drag start */
    originalX: number
    originalY: number
    /** Snapshot of each split's sizes[0] at drag start, keyed by splitId */
    startSizes: Record<string, number>
    /** Snapshot of each split's container dimension along the resize axis (px) */
    splitDimensions: Record<string, { totalSize: number; direction: 'horizontal' | 'vertical' }>
  } | null>(null)

  // Track container dimensions so intersections recompute on resize
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        setContainerSize((prev) =>
          prev.w === width && prev.h === height ? prev : { w: width, h: height },
        )
      }
    })

    observer.observe(container)
    // Initialize from current dimensions
    setContainerSize({ w: container.offsetWidth, h: container.offsetHeight })

    return () => observer.disconnect()
  }, [containerRef])

  // Compute intersections from the layout tree and container dimensions
  const intersections = useMemo(() => {
    if (!layout || layout.type === 'leaf') return []
    if (containerSize.w === 0 || containerSize.h === 0) return []

    const segments = computeDividerSegments(layout, containerSize.w, containerSize.h)
    return findIntersections(segments)
  }, [layout, containerSize])

  // Collect the total pixel dimension for each split involved in an intersection.
  // This is needed to convert pixel deltas to percentage changes during dragging.
  const getSplitInfo = useCallback(
    (splitIds: string[]): Record<string, { totalSize: number; direction: 'horizontal' | 'vertical'; currentSize: number }> => {
      if (!layout || layout.type === 'leaf') return {}
      const container = containerRef.current
      if (!container) return {}

      const result: Record<string, { totalSize: number; direction: 'horizontal' | 'vertical'; currentSize: number }> = {}

      // Walk the tree to find each split and compute its parent container dimension
      function walk(
        node: PaneNode,
        boundsWidth: number,
        boundsHeight: number,
      ): void {
        if (node.type === 'leaf') return

        if (splitIds.includes(node.id)) {
          const totalSize = node.direction === 'horizontal' ? boundsWidth : boundsHeight
          result[node.id] = {
            totalSize,
            direction: node.direction,
            currentSize: node.sizes[0],
          }
        }

        if (node.direction === 'horizontal') {
          const leftWidth = (node.sizes[0] / 100) * boundsWidth
          const rightWidth = (node.sizes[1] / 100) * boundsWidth
          walk(node.children[0], leftWidth, boundsHeight)
          walk(node.children[1], rightWidth, boundsHeight)
        } else {
          const topHeight = (node.sizes[0] / 100) * boundsHeight
          const botHeight = (node.sizes[1] / 100) * boundsHeight
          walk(node.children[0], boundsWidth, topHeight)
          walk(node.children[1], boundsWidth, botHeight)
        }
      }

      walk(layout, container.offsetWidth, container.offsetHeight)
      return result
    },
    [layout, containerRef],
  )

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, intersection: Intersection) => {
      e.preventDefault()
      e.stopPropagation()

      const info = getSplitInfo(intersection.splitIds)
      const startSizes: Record<string, number> = {}
      const splitDimensions: Record<string, { totalSize: number; direction: 'horizontal' | 'vertical' }> = {}

      for (const [splitId, data] of Object.entries(info)) {
        startSizes[splitId] = data.currentSize
        splitDimensions[splitId] = { totalSize: data.totalSize, direction: data.direction }
      }

      setDragging({
        intersection,
        startMouseX: e.clientX,
        startMouseY: e.clientY,
        originalX: intersection.x,
        originalY: intersection.y,
        startSizes,
        splitDimensions,
      })
    },
    [getSplitInfo],
  )

  // Lock cursor globally during drag so it doesn't flicker over other elements
  useEffect(() => {
    if (!dragging) return
    const style = document.createElement('style')
    style.setAttribute('data-drag-cursor', '')
    style.textContent = `* { cursor: move !important; }`
    document.head.appendChild(style)
    return () => { style.remove() }
  }, [dragging])

  // Global mouse move/up handlers during drag
  useEffect(() => {
    if (!dragging) return

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - dragging.startMouseX
      const deltaY = e.clientY - dragging.startMouseY

      // Convert snap threshold from "% of smallest dimension" to pixels
      const container = containerRef.current
      const rootW = container?.offsetWidth ?? 800
      const rootH = container?.offsetHeight ?? 600
      const thresholdPx = (snapThreshold / 100) * Math.min(rootW, rootH)

      // Apply 2D snap
      const snapped = snap2D(
        dragging.originalX + deltaX,
        dragging.originalY + deltaY,
        dragging.originalX,
        dragging.originalY,
        thresholdPx,
        e.shiftKey,
      )

      const effectiveDeltaX = snapped.x - dragging.originalX
      const effectiveDeltaY = snapped.y - dragging.originalY

      // Compute new sizes for each involved split
      const resizes: Array<{ splitId: string; sizes: [number, number] }> = []

      for (const splitId of dragging.intersection.splitIds) {
        const dim = dragging.splitDimensions[splitId]
        const startSize = dragging.startSizes[splitId]
        if (!dim || startSize === undefined) continue

        // For horizontal splits, the divider moves along X axis
        // For vertical splits, the divider moves along Y axis
        const pixelDelta = dim.direction === 'horizontal' ? effectiveDeltaX : effectiveDeltaY
        const percentDelta = (pixelDelta / dim.totalSize) * 100
        const newSize = Math.max(10, Math.min(90, startSize + percentDelta))

        resizes.push({ splitId, sizes: [newSize, 100 - newSize] })
      }

      if (resizes.length > 0) {
        dispatch(resizeMultipleSplits({ tabId, resizes }))
      }
    }

    const handleMouseUp = () => {
      setDragging(null)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [dragging, dispatch, tabId, snapThreshold])

  if (intersections.length === 0) return null

  return (
    <div
      data-testid="intersection-drag-overlay"
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 10 }}
    >
      {intersections.map((intersection) => {
        const key = `${intersection.x},${intersection.y}`
        return (
          <div
            key={key}
            data-testid={`intersection-hotzone-${key}`}
            aria-hidden="true"
            className="absolute pointer-events-auto cursor-move"
            style={{
              left: intersection.x - HOT_ZONE_SIZE / 2,
              top: intersection.y - HOT_ZONE_SIZE / 2,
              width: HOT_ZONE_SIZE,
              height: HOT_ZONE_SIZE,
            }}
            onMouseDown={(e) => handleMouseDown(e, intersection)}
          />
        )
      })}
    </div>
  )
}
