import * as React from 'react'
import { cn } from '@/lib/utils'

type SelectContextValue = {
  value?: string
  setValue: (v: string) => void
  open: boolean
  setOpen: (v: boolean) => void
}

const SelectContext = React.createContext<SelectContextValue | null>(null)

export function Select({
  value,
  defaultValue,
  onValueChange,
  children,
}: {
  value?: string
  defaultValue?: string
  onValueChange?: (v: string) => void
  children: React.ReactNode
}) {
  const [internalValue, setInternalValue] = React.useState<string | undefined>(defaultValue)
  const [open, setOpen] = React.useState(false)

  const currentValue = value !== undefined ? value : internalValue

  const setValue = (v: string) => {
    if (value === undefined) setInternalValue(v)
    onValueChange?.(v)
  }

  return (
    <SelectContext.Provider value={{ value: currentValue, setValue, open, setOpen }}>
      <div className="relative">{children}</div>
    </SelectContext.Provider>
  )
}

export function SelectTrigger({
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const ctx = React.useContext(SelectContext)
  if (!ctx) throw new Error('SelectTrigger must be used within Select')

  return (
    <button
      type="button"
      className={cn(
        'flex h-9 w-full items-center justify-between rounded-md border border-border bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        className,
      )}
      onClick={(e) => {
        ctx.setOpen(!ctx.open)
        props.onClick?.(e)
      }}
      {...props}
    >
      {children}
      <span className="opacity-60">▾</span>
    </button>
  )
}

export function SelectValue({ placeholder }: { placeholder?: string }) {
  const ctx = React.useContext(SelectContext)
  if (!ctx) throw new Error('SelectValue must be used within Select')
  return <span className={cn(!ctx.value ? 'text-muted-foreground' : '')}>{ctx.value || placeholder}</span>
}

export function SelectContent({ className, children }: { className?: string; children: React.ReactNode }) {
  const ctx = React.useContext(SelectContext)
  if (!ctx) throw new Error('SelectContent must be used within Select')
  if (!ctx.open) return null

  return (
    <div
      className={cn(
        'absolute left-0 right-0 top-full z-50 mt-1 rounded-md border border-border bg-card p-1 shadow-md',
        className,
      )}
    >
      {children}
    </div>
  )
}

export function SelectItem({
  value,
  className,
  children,
}: {
  value: string
  className?: string
  children: React.ReactNode
}) {
  const ctx = React.useContext(SelectContext)
  if (!ctx) throw new Error('SelectItem must be used within Select')

  const isSelected = ctx.value === value

  return (
    <button
      type="button"
      className={cn(
        'flex w-full items-center rounded px-2 py-1.5 text-sm hover:bg-muted',
        isSelected ? 'bg-muted' : '',
        className,
      )}
      onClick={() => {
        ctx.setValue(value)
        ctx.setOpen(false)
      }}
    >
      <span className="flex-1 text-left">{children}</span>
      {isSelected ? <span className="opacity-60">✓</span> : null}
    </button>
  )
}
