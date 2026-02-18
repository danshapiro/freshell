import * as React from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { OVERLAY_Z } from '@/components/ui/overlay'

type TooltipContextValue = {
  open: boolean
  setOpen: (v: boolean) => void
  triggerRef: React.RefObject<HTMLElement>
}

const TooltipContext = React.createContext<TooltipContextValue | null>(null)

export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

export function Tooltip({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  const triggerRef = React.useRef<HTMLElement>(null)
  return (
    <TooltipContext.Provider value={{ open, setOpen, triggerRef }}>
      {children}
    </TooltipContext.Provider>
  )
}

export function TooltipTrigger({
  children,
  asChild,
}: {
  children: React.ReactElement
  asChild?: boolean
}) {
  const ctx = React.useContext(TooltipContext)
  if (!ctx) return children

  const child = React.cloneElement(children, {
    ref: ctx.triggerRef,
    onMouseEnter: (e: React.MouseEvent) => {
      ctx.setOpen(true)
      children.props.onMouseEnter?.(e)
    },
    onMouseLeave: (e: React.MouseEvent) => {
      ctx.setOpen(false)
      children.props.onMouseLeave?.(e)
    },
    onFocus: (e: React.FocusEvent) => {
      ctx.setOpen(true)
      children.props.onFocus?.(e)
    },
    onBlur: (e: React.FocusEvent) => {
      ctx.setOpen(false)
      children.props.onBlur?.(e)
    },
  })
  return asChild ? child : <span>{child}</span>
}

export function TooltipContent({
  children,
  className,
  side = 'top',
  sideOffset = 4,
}: {
  children: React.ReactNode
  className?: string
  side?: 'top' | 'bottom'
  sideOffset?: number
}) {
  const ctx = React.useContext(TooltipContext)
  const [position, setPosition] = React.useState({ top: 0, left: 0 })

  const contentRef = React.useRef<HTMLDivElement>(null)

  React.useLayoutEffect(() => {
    if (ctx?.open && ctx.triggerRef.current) {
      const rect = ctx.triggerRef.current.getBoundingClientRect()
      const contentHeight = contentRef.current?.offsetHeight || 24
      setPosition({
        top: side === 'bottom'
          ? rect.bottom + sideOffset
          : rect.top - contentHeight - sideOffset,
        left: rect.left,
      })
    }
  }, [ctx?.open, ctx?.triggerRef, side, sideOffset])

  if (!ctx?.open) return null

  return createPortal(
    <div
      ref={contentRef}
      className={cn(
        `fixed rounded-md border px-2 py-1 text-xs shadow-lg animate-in fade-in-0 zoom-in-95 ${OVERLAY_Z.tooltip}`,
        'bg-zinc-100 text-zinc-900 border-zinc-300',
        'dark:bg-zinc-800 dark:text-zinc-100 dark:border-zinc-700',
        className
      )}
      style={{ top: position.top, left: position.left }}
    >
      {children}
    </div>,
    document.body
  )
}
