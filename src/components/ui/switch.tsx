import * as React from 'react'
import { cn } from '@/lib/utils'

export interface SwitchProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
}

export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ className, checked = false, onCheckedChange, disabled, ...props }, ref) => {
    return (
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={(e) => {
          if (disabled) return
          onCheckedChange?.(!checked)
          props.onClick?.(e)
        }}
        className={cn(
          'relative inline-flex h-5 w-9 items-center rounded-full border border-border transition-colors',
          checked ? 'bg-primary' : 'bg-muted',
          disabled ? 'opacity-50' : 'cursor-pointer',
          className,
        )}
        {...props}
      >
        <span
          className={cn(
            'inline-block h-4 w-4 transform rounded-full bg-background shadow transition-transform',
            checked ? 'translate-x-4' : 'translate-x-1',
          )}
        />
      </button>
    )
  },
)
Switch.displayName = 'Switch'
