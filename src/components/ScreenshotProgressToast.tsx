import { useSyncExternalStore } from 'react'
import { Camera } from 'lucide-react'
import { getScreenshotInProgress, subscribeScreenshotProgress } from '@/lib/screenshot-progress'

export function ScreenshotProgressToast() {
  const active = useSyncExternalStore(subscribeScreenshotProgress, getScreenshotInProgress)
  if (!active) return null
  return (
    <div
      role="status"
      aria-live="polite"
      data-html2canvas-ignore="true"
      className="pointer-events-none fixed bottom-4 right-4 z-[100] flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground shadow-lg"
    >
      <Camera className="h-4 w-4" aria-hidden="true" />
      Taking screenshot…
    </div>
  )
}
