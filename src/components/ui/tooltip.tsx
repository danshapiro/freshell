import * as React from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

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
  sideOffset = 4,
}: {
  children: React.ReactNode
  className?: string
  sideOffset?: number
}) {
  const ctx = React.useContext(TooltipContext)
  const [position, setPosition] = React.useState({ top: 0, left: 0 })

  React.useLayoutEffect(() => {
    if (ctx?.open && ctx.triggerRef.current) {
      const rect = ctx.triggerRef.current.getBoundingClientRect()
      setPosition({
        top: rect.bottom + sideOffset,
        left: rect.left,
      })
    }
  }, [ctx?.open, sideOffset])

  if (!ctx?.open) return null

  return createPortal(
    <div
      className={cn(
        'fixed z-50 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-100 shadow-lg animate-in fade-in-0 zoom-in-95',
        className
      )}
      style={{ top: position.top, left: position.left }}
    >
      {children}
    </div>,
    document.body
  )
}
