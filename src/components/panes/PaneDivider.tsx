import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

interface PaneDividerProps {
  direction: 'horizontal' | 'vertical'
  onResize: (delta: number, shiftHeld?: boolean) => void
  onResizeStart?: () => void
  onResizeEnd: () => void
  dataContext?: string
  dataTabId?: string
  dataSplitId?: string
}

export default function PaneDivider({
  direction,
  onResize,
  onResizeStart,
  onResizeEnd,
  dataContext,
  dataTabId,
  dataSplitId,
}: PaneDividerProps) {
  const [isDragging, setIsDragging] = useState(false)
  const startPosRef = useRef(0)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    onResizeStart?.()
    setIsDragging(true)
    startPosRef.current = direction === 'horizontal' ? e.clientX : e.clientY
  }, [direction, onResizeStart])

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    e.preventDefault()
    if (e.touches.length === 0) return
    onResizeStart?.()
    setIsDragging(true)
    const touch = e.touches[0]
    startPosRef.current = direction === 'horizontal' ? touch.clientX : touch.clientY
  }, [direction, onResizeStart])

  // Lock cursor globally during drag so it doesn't flicker over other elements
  useEffect(() => {
    if (!isDragging) return
    const cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize'
    const style = document.createElement('style')
    style.setAttribute('data-drag-cursor', '')
    style.textContent = `* { cursor: ${cursor} !important; }`
    document.head.appendChild(style)
    return () => { style.remove() }
  }, [isDragging, direction])

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      const currentPos = direction === 'horizontal' ? e.clientX : e.clientY
      const delta = currentPos - startPosRef.current
      startPosRef.current = currentPos
      onResize(delta, e.shiftKey)
    }

    const handleMouseUp = () => {
      setIsDragging(false)
      onResizeEnd()
    }

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 0) return
      e.preventDefault()
      const touch = e.touches[0]
      const currentPos = direction === 'horizontal' ? touch.clientX : touch.clientY
      const delta = currentPos - startPosRef.current
      startPosRef.current = currentPos
      onResize(delta, false)
    }

    const handleTouchEnd = () => {
      setIsDragging(false)
      onResizeEnd()
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    document.addEventListener('touchmove', handleTouchMove, { passive: false })
    document.addEventListener('touchend', handleTouchEnd)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.removeEventListener('touchmove', handleTouchMove)
      document.removeEventListener('touchend', handleTouchEnd)
    }
  }, [isDragging, direction, onResize, onResizeEnd])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = 10 // keyboard resize step in pixels
    let handled = false

    if (direction === 'horizontal') {
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        onResize(-step)
        handled = true
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        onResize(step)
        handled = true
      }
    } else {
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        onResize(-step)
        handled = true
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        onResize(step)
        handled = true
      }
    }

    if (handled) {
      onResizeEnd()
    }
  }, [direction, onResize, onResizeEnd])

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'}
      aria-label={`Pane divider (${direction === 'horizontal' ? 'horizontal' : 'vertical'} resize)`}
      onMouseDown={handleMouseDown}
      onTouchStart={handleTouchStart}
      onKeyDown={handleKeyDown}
      data-context={dataContext}
      data-tab-id={dataTabId}
      data-split-id={dataSplitId}
      className={cn(
        'flex-shrink-0 relative group touch-none',
        direction === 'horizontal'
          ? 'w-3 cursor-col-resize'
          : 'h-3 cursor-row-resize',
      )}
    >
      {/* Visible bar */}
      <div
        data-visible-bar
        className={cn(
          'absolute bg-border transition-all',
          direction === 'horizontal'
            ? 'w-px h-full left-1/2 -translate-x-1/2 group-hover:w-[3px]'
            : 'h-px w-full top-1/2 -translate-y-1/2 group-hover:h-[3px]',
          isDragging && (direction === 'horizontal' ? 'w-[3px]' : 'h-[3px]'),
          isDragging ? 'bg-muted-foreground' : 'group-hover:bg-muted-foreground',
        )}
      />
      {/* Grab dots (visible on hover and during drag) */}
      <div
        data-grab-handle
        className={cn(
          'absolute inset-0 flex items-center justify-center',
          'opacity-0 group-hover:opacity-40 transition-opacity',
          isDragging && 'opacity-40',
        )}
      >
        <div className={cn(
          'flex gap-0.5',
          direction === 'horizontal' ? 'flex-col' : 'flex-row',
        )}>
          <div className="w-1 h-1 rounded-full bg-muted-foreground" />
          <div className="w-1 h-1 rounded-full bg-muted-foreground" />
          <div className="w-1 h-1 rounded-full bg-muted-foreground" />
        </div>
      </div>
    </div>
  )
}
