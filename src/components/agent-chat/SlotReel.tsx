import { memo, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

interface SlotReelProps {
  /** Current tool name, or null when settled */
  toolName: string | null
  /** Current preview/output text, or null when settled */
  previewText: string | null
  /** Text to show when all tools are done (e.g. "5 tools used") */
  settledText?: string
}

interface ReelSlot {
  current: string
  previous: string | null
  animating: boolean
}

function useReelSlot(value: string): ReelSlot {
  const [slot, setSlot] = useState<ReelSlot>({
    current: value,
    previous: null,
    animating: false,
  })
  const prevValueRef = useRef(value)

  useEffect(() => {
    if (value === prevValueRef.current) return
    const prev = prevValueRef.current
    prevValueRef.current = value

    setSlot({ current: value, previous: prev, animating: true })

    const timer = setTimeout(() => {
      setSlot(s => ({ ...s, previous: null, animating: false }))
    }, 150)
    return () => clearTimeout(timer)
  }, [value])

  return slot
}

function ReelCell({ slot, className }: { slot: ReelSlot; className?: string }) {
  return (
    <span className={cn('relative inline-flex overflow-hidden', className)}>
      <span
        className={cn(
          'inline-block transition-transform duration-150 ease-out',
          slot.animating && '-translate-y-full',
        )}
      >
        {slot.previous ?? slot.current}
      </span>
      {slot.animating && (
        <span
          className="absolute left-0 top-full inline-block transition-transform duration-150 ease-out -translate-y-full"
        >
          {slot.current}
        </span>
      )}
    </span>
  )
}

function SlotReel({ toolName, previewText, settledText }: SlotReelProps) {
  const isSettled = toolName == null && settledText != null
  const displayName = toolName ?? ''
  const displayPreview = previewText ?? settledText ?? ''

  const nameSlot = useReelSlot(displayName)
  const previewSlot = useReelSlot(displayPreview)

  return (
    <span
      role="status"
      className="inline-flex items-center gap-1.5 min-w-0 text-xs font-mono truncate"
    >
      {!isSettled && displayName && (
        <span
          data-slot="name"
          className="inline-flex shrink-0 items-center rounded bg-muted px-1 py-0.5 text-2xs font-semibold"
        >
          <ReelCell slot={nameSlot} />
        </span>
      )}
      <span className="truncate">
        <ReelCell slot={previewSlot} />
      </span>
    </span>
  )
}

export default memo(SlotReel)
