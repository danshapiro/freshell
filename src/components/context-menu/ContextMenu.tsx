import React, { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { clampToViewport } from './context-menu-utils'
import type { MenuItem } from './context-menu-types'
import { cn } from '@/lib/utils'
import { OVERLAY_Z } from '@/components/ui/overlay'

export type ContextMenuProps = {
  open: boolean
  items: MenuItem[]
  position: { x: number; y: number }
  onClose: () => void
}

export const ContextMenu = forwardRef<HTMLDivElement, ContextMenuProps>(function ContextMenu(
  { open, items, position, onClose },
  ref
) {
  const innerRef = useRef<HTMLDivElement | null>(null)
  const mergedRef = (node: HTMLDivElement | null) => {
    innerRef.current = node
    if (typeof ref === 'function') ref(node)
    else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node
  }

  const [pos, setPos] = useState(position)
  const [ready, setReady] = useState(false)
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])

  const enabledIndices = useMemo(() => {
    return items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.type === 'item' && !item.disabled)
      .map(({ index }) => index)
  }, [items])

  useLayoutEffect(() => {
    if (!open) return
    const node = innerRef.current
    if (!node) return
    const rect = node.getBoundingClientRect()
    setPos(clampToViewport(position.x, position.y, rect.width, rect.height))
    setReady(true)
  }, [open, position])

  useEffect(() => {
    if (!open) return
    const first = enabledIndices[0]
    if (typeof first === 'number') {
      setActiveIndex(first)
      requestAnimationFrame(() => itemRefs.current[first]?.focus())
    }
  }, [open, enabledIndices])

  if (!open) return null

  return createPortal(
    <div
      ref={mergedRef}
      role="menu"
      tabIndex={-1}
      aria-orientation="vertical"
      className={cn(
        'fixed min-w-[200px] rounded-md border border-border bg-card shadow-lg py-1',
        OVERLAY_Z.menu
      )}
      style={{
        left: pos.x,
        top: pos.y,
        visibility: ready ? 'visible' : 'hidden',
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
          return
        }
        if (e.key === 'Tab') {
          e.preventDefault()
          onClose()
          return
        }
        if (enabledIndices.length === 0) return

        const currentIndex = activeIndex ?? enabledIndices[0]
        const currentPos = enabledIndices.indexOf(currentIndex)
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          const nextPos = (currentPos + 1) % enabledIndices.length
          const nextIndex = enabledIndices[nextPos]
          setActiveIndex(nextIndex)
          itemRefs.current[nextIndex]?.focus()
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          const nextPos = (currentPos - 1 + enabledIndices.length) % enabledIndices.length
          const nextIndex = enabledIndices[nextPos]
          setActiveIndex(nextIndex)
          itemRefs.current[nextIndex]?.focus()
        } else if (e.key === 'Home') {
          e.preventDefault()
          const nextIndex = enabledIndices[0]
          setActiveIndex(nextIndex)
          itemRefs.current[nextIndex]?.focus()
        } else if (e.key === 'End') {
          e.preventDefault()
          const nextIndex = enabledIndices[enabledIndices.length - 1]
          setActiveIndex(nextIndex)
          itemRefs.current[nextIndex]?.focus()
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          const item = items[currentIndex]
          if (item?.type === 'item' && !item.disabled) {
            void item.onSelect()
            onClose()
          }
        }
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, index) => {
        if (item.type === 'separator') {
          return <div key={item.id} role="separator" className="my-1 h-px bg-border" />
        }
        return (
          <button
            key={item.id}
            ref={(node) => {
              itemRefs.current[index] = node
            }}
            role="menuitem"
            tabIndex={-1}
            aria-disabled={item.disabled || undefined}
            disabled={item.disabled}
            className={cn(
              'flex w-full items-center gap-2 px-4 py-3 md:px-3 md:py-2 text-left text-sm transition-colors',
              item.disabled
                ? 'text-muted-foreground/60 cursor-not-allowed'
                : 'hover:bg-muted',
              item.danger && !item.disabled && 'text-destructive'
            )}
            onClick={() => {
              if (item.disabled) return
              void item.onSelect()
              onClose()
            }}
            onMouseEnter={() => {
              if (!item.disabled) setActiveIndex(index)
            }}
          >
            {item.icon ? <span className="text-xs opacity-80">{item.icon}</span> : null}
            <span className="flex-1">{item.label}</span>
            {item.shortcut ? (
              <span className="text-xs text-muted-foreground/70">{item.shortcut}</span>
            ) : null}
          </button>
        )
      })}
    </div>,
    document.body
  )
})
