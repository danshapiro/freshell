// Reusable form controls for settings pages — sections, rows, toggles, sliders, etc.

import { useState } from 'react'
import { cn } from '@/lib/utils'

export function SettingsSection({
  id,
  title,
  description,
  children,
}: {
  id?: string
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div id={id}>
      <div className="mb-4">
        <h2 className="text-sm font-medium">{title}</h2>
        {description && (
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        )}
      </div>
      <div className="space-y-4 pl-0.5">
        {children}
      </div>
    </div>
  )
}

export function SettingsRow({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex w-full flex-col items-start gap-2 md:flex-row md:items-center md:justify-between md:gap-4">
      {description ? (
        <div className="flex flex-col gap-0.5">
          <span className="text-sm text-muted-foreground">{label}</span>
          <span className="text-xs text-muted-foreground/60">{description}</span>
        </div>
      ) : (
        <span className="text-sm text-muted-foreground">{label}</span>
      )}
      <div className="w-full md:w-auto">{children}</div>
    </div>
  )
}

export function SegmentedControl({
  value,
  options,
  onChange,
}: {
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  return (
    <div className="flex w-full flex-wrap bg-muted rounded-md p-0.5 md:w-auto">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            'min-h-10 flex-1 px-3 py-1 text-xs rounded-md transition-colors md:min-h-0 md:flex-none',
            value === opt.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  disabled,
  'aria-label': ariaLabel,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  'aria-label'?: string
}) {
  return (
    <button
      role="switch"
      onClick={() => { if (!disabled) onChange(!checked) }}
      disabled={disabled}
      aria-label={ariaLabel ?? (checked ? 'Toggle off' : 'Toggle on')}
      aria-checked={checked}
      className={cn(
        'relative w-9 h-5 rounded-full transition-colors',
        checked ? 'bg-foreground' : 'bg-muted',
        disabled && 'opacity-50 cursor-not-allowed'
      )}
    >
      <div
        className={cn(
          'absolute top-0.5 h-4 w-4 rounded-full transition-all',
          checked ? 'left-[1.125rem] bg-background' : 'left-0.5 bg-muted-foreground'
        )}
        aria-hidden="true"
      />
    </button>
  )
}

function KeyCombo({ keys }: { keys: string[] }) {
  return (
    <>
      {keys.map((key, i) => (
        <span key={i}>
          {i > 0 && <span className="text-muted-foreground/40 mx-0.5">+</span>}
          <kbd className="px-1.5 py-0.5 text-2xs bg-muted rounded font-mono">
            {key}
          </kbd>
        </span>
      ))}
    </>
  )
}

export function ShortcutRow({
  keys,
  alternateKeys,
  description,
}: {
  keys: string[]
  alternateKeys?: string[]
  description: string
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{description}</span>
      <div className="flex items-center gap-1">
        <KeyCombo keys={keys} />
        {alternateKeys && (
          <>
            <span className="text-muted-foreground/40 mx-1">/</span>
            <KeyCombo keys={alternateKeys} />
          </>
        )}
      </div>
    </div>
  )
}

export function RangeSlider({
  value,
  min,
  max,
  step,
  onChange,
  format,
  width = 'w-full md:w-32',
  labelWidth = 'w-14',
}: {
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  format: (value: number) => string
  width?: string
  labelWidth?: string
}) {
  const [dragging, setDragging] = useState<number | null>(null)
  const displayValue = dragging ?? value

  return (
    <div className="flex w-full items-center gap-3 md:w-auto">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={displayValue}
        onChange={(e) => setDragging(Number(e.target.value))}
        onPointerUp={() => {
          if (dragging !== null) {
            onChange(dragging)
            setDragging(null)
          }
        }}
        onPointerLeave={() => {
          if (dragging !== null) {
            onChange(dragging)
            setDragging(null)
          }
        }}
        className={cn(
          width,
          'h-1.5 bg-muted rounded-full appearance-none cursor-pointer',
          '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-foreground'
        )}
      />
      <span className={cn('text-sm tabular-nums', labelWidth)}>{format(displayValue)}</span>
    </div>
  )
}
