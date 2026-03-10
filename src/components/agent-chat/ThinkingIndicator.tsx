import { memo, useState, useEffect } from 'react'

/** Delay before showing indicator, prevents flash during brief SDK message gaps. */
const RENDER_DELAY_MS = 200

function ThinkingIndicator() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), RENDER_DELAY_MS)
    return () => clearTimeout(timer)
  }, [])

  if (!visible) return null

  return (
    <div
      className="max-w-prose border-l-2 border-l-[hsl(var(--claude-assistant))] pl-2.5 py-0.5"
      role="status"
      aria-label="Claude is thinking"
    >
      <span className="text-sm text-muted-foreground animate-pulse">
        Thinking...
      </span>
    </div>
  )
}

export default memo(ThinkingIndicator)
