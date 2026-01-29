import * as React from 'react'
import { cn } from '@/lib/utils'

export interface ScrollAreaProps extends React.HTMLAttributes<HTMLDivElement> {
  heightClassName?: string
}

export const ScrollArea = React.forwardRef<HTMLDivElement, ScrollAreaProps>(
  ({ className, heightClassName, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('relative overflow-auto', heightClassName, className)}
      {...props}
    />
  ),
)
ScrollArea.displayName = 'ScrollArea'
