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
  /** Monotonic counter — keys the animated spans so a change that lands
   * mid-animation remounts them and the CSS animation restarts from frame 0.
   * (The previous transition-based approach left the outgoing span stuck at
   * its translated end state when values changed faster than the animation,
   * so rapid tool sequences froze instead of rolling.) */
  serial: number
}

function useReelSlot(value: string): ReelSlot {
  const [slot, setSlot] = useState<ReelSlot>({
    current: value,
    previous: null,
    animating: false,
    serial: 0,
  })
  const prevValueRef = useRef(value)

  useEffect(() => {
    if (value === prevValueRef.current) return
    const prev = prevValueRef.current
    prevValueRef.current = value

    setSlot((s) => ({
      current: value,
      // If a roll is already in flight, the in-flight target becomes the
      // outgoing value so the reel never skips a frame backwards.
      previous: s.animating ? s.current : prev,
      animating: true,
      serial: s.serial + 1,
    }))

    const timer = setTimeout(() => {
      setSlot((s) => ({ ...s, previous: null, animating: false }))
    }, 150)
    return () => clearTimeout(timer)
  }, [value])

  return slot
}

function ReelCell({ slot, className }: { slot: ReelSlot; className?: string }) {
  return (
    <span className={cn('relative inline-flex overflow-hidden', className)}>
      {slot.animating && slot.previous !== null ? (
        <>
          <span key={`out-${slot.serial}`} className="inline-block animate-reel-out">
            {slot.previous}
          </span>
          <span
            key={`in-${slot.serial}`}
            className="absolute left-0 top-0 inline-block animate-reel-in"
          >
            {slot.current}
          </span>
        </>
      ) : (
        <span className="inline-block">{slot.current}</span>
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
