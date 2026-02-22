import { Plus, SplitSquareHorizontal, SplitSquareVertical } from 'lucide-react'
import { cn } from '@/lib/utils'

interface FloatingActionButtonProps {
  onAdd: () => void
  onSplitHorizontal?: () => void
  onSplitVertical?: () => void
}

export default function FloatingActionButton({ onAdd, onSplitHorizontal, onSplitVertical }: FloatingActionButtonProps) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onAdd()
    }
  }

  return (
    <div className="absolute bottom-12 right-4 z-50 group">
      {(onSplitHorizontal || onSplitVertical) && (
        <div className="mb-2 flex flex-col items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100">
          {onSplitHorizontal && (
            <button
              onClick={onSplitHorizontal}
              aria-label="Split horizontally"
              className={cn(
                'h-9 w-9 rounded-full bg-foreground text-background',
                'flex items-center justify-center',
                'shadow-lg hover:shadow-xl transition-all',
                'hover:scale-105 active:scale-95',
              )}
              title="Split horizontally"
            >
              <SplitSquareHorizontal className="h-4 w-4" />
            </button>
          )}
          {onSplitVertical && (
            <button
              onClick={onSplitVertical}
              aria-label="Split vertically"
              className={cn(
                'h-9 w-9 rounded-full bg-foreground text-background',
                'flex items-center justify-center',
                'shadow-lg hover:shadow-xl transition-all',
                'hover:scale-105 active:scale-95',
              )}
              title="Split vertically"
            >
              <SplitSquareVertical className="h-4 w-4" />
            </button>
          )}
        </div>
      )}
      <button
        onClick={onAdd}
        onKeyDown={handleKeyDown}
        aria-label="Add pane"
        className={cn(
          'h-12 w-12 rounded-full bg-foreground/70 text-background',
          'flex items-center justify-center',
          'shadow-lg hover:shadow-xl transition-all',
          'hover:scale-105 active:scale-95',
        )}
        title="Add pane"
      >
        <Plus className="h-5 w-5" />
      </button>
    </div>
  )
}
