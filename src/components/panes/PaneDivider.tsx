import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

interface PaneDividerProps {
  direction: 'horizontal' | 'vertical'
  onResize: (delta: number) => void
  onResizeEnd: () => void
}

export default function PaneDivider({ direction, onResize, onResizeEnd }: PaneDividerProps) {
  const [isDragging, setIsDragging] = useState(false)
  const startPosRef = useRef(0)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
    startPosRef.current = direction === 'horizontal' ? e.clientX : e.clientY
  }, [direction])

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      const currentPos = direction === 'horizontal' ? e.clientX : e.clientY
      const delta = currentPos - startPosRef.current
      startPosRef.current = currentPos
      onResize(delta)
    }

    const handleMouseUp = () => {
      setIsDragging(false)
      onResizeEnd()
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, direction, onResize, onResizeEnd])

  return (
    <div
      onMouseDown={handleMouseDown}
      className={cn(
        'flex-shrink-0 bg-border hover:bg-muted-foreground transition-colors',
        direction === 'horizontal'
          ? 'w-1 cursor-col-resize'
          : 'h-1 cursor-row-resize',
        isDragging && 'bg-muted-foreground'
      )}
    />
  )
}
