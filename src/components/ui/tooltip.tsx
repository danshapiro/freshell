import * as React from 'react'
import { cn } from '@/lib/utils'

type TooltipContextValue = {
  open: boolean
  setOpen: (v: boolean) => void
}

const TooltipContext = React.createContext<TooltipContextValue | null>(null)

export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

export function Tooltip({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  return <TooltipContext.Provider value={{ open, setOpen }}>{children}</TooltipContext.Provider>
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
    onMouseEnter: (e: any) => {
      ctx.setOpen(true)
      children.props.onMouseEnter?.(e)
    },
    onMouseLeave: (e: any) => {
      ctx.setOpen(false)
      children.props.onMouseLeave?.(e)
    },
    onFocus: (e: any) => {
      ctx.setOpen(true)
      children.props.onFocus?.(e)
    },
    onBlur: (e: any) => {
      ctx.setOpen(false)
      children.props.onBlur?.(e)
    },
  })
  return asChild ? child : <span>{child}</span>
}

export function TooltipContent({
  children,
  className,
  sideOffset = 6,
}: {
  children: React.ReactNode
  className?: string
  sideOffset?: number
}) {
  const ctx = React.useContext(TooltipContext)
  if (!ctx?.open) return null
  // Render in place (no portal) for simplicity.
  return (
    <span
      className={cn(
        'absolute z-50 rounded-md border border-border bg-card px-2 py-1 text-xs shadow-md',
        className,
      )}
      style={{ marginTop: sideOffset }}
    >
      {children}
    </span>
  )
}
