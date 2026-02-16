import { cn } from '@/lib/utils'

function usageColor(percent: number): string {
  if (percent >= 90) return 'bg-destructive'
  if (percent >= 70) return 'bg-warning'
  return 'bg-success'
}

interface UsageBarProps {
  percent: number
  className?: string
}

export default function UsageBar({ percent, className }: UsageBarProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)))

  return (
    <div
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`Context usage: ${clamped}%`}
      className={cn('w-10 h-1 rounded-full bg-muted shrink-0', className)}
    >
      <div
        className={cn(
          'h-full rounded-full transition-all duration-300',
          usageColor(clamped),
        )}
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}
