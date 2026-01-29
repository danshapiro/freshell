import * as React from 'react'
import { cn } from '@/lib/utils'

export interface SliderProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  value?: number[] | number
  onValueChange?: (value: number[]) => void
}

export const Slider = React.forwardRef<HTMLInputElement, SliderProps>(
  ({ className, value, onValueChange, min = 0, max = 100, step = 1, disabled, ...props }, ref) => {
    const valArray = Array.isArray(value) ? value : [typeof value === 'number' ? value : Number(min)]
    const val = valArray[0] ?? Number(min)
    return (
      <input
        ref={ref}
        type="range"
        min={min}
        max={max}
        step={step}
        value={val}
        disabled={disabled}
        onChange={(e) => onValueChange?.([Number(e.target.value)])}
        className={cn('w-full accent-primary', className)}
        {...props}
      />
    )
  },
)
Slider.displayName = 'Slider'
