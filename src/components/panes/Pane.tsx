import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PaneContent } from '@/store/paneTypes'

interface PaneProps {
  id: string
  content: PaneContent
  isActive: boolean
  isOnlyPane: boolean
  onClose: () => void
  onFocus: () => void
  children: React.ReactNode
}

export default function Pane({
  id,
  content,
  isActive,
  isOnlyPane,
  onClose,
  onFocus,
  children,
}: PaneProps) {
  return (
    <div
      className={cn(
        'relative h-full w-full overflow-hidden',
        isActive && 'shadow-[0_0_0_2px_rgba(255,255,255,0.3),0_0_20px_rgba(255,255,255,0.1)]'
      )}
      onClick={onFocus}
    >
      {/* Close button - hidden if only pane */}
      {!isOnlyPane && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          className="absolute top-1 right-1 z-10 p-1 rounded opacity-50 hover:opacity-100 text-muted-foreground hover:bg-muted/50 transition-opacity"
          title="Close pane"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}

      {/* Content */}
      <div className="h-full w-full">
        {children}
      </div>
    </div>
  )
}
