import { Plus } from 'lucide-react'
import { cn } from '@/lib/utils'

interface FloatingActionButtonProps {
  onAdd: () => void
}

export default function FloatingActionButton({ onAdd }: FloatingActionButtonProps) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onAdd()
    }
  }

  return (
    <div className="absolute bottom-12 right-4 z-50">
      <button
        onClick={onAdd}
        onKeyDown={handleKeyDown}
        aria-label="Add pane"
        className={cn(
          'h-12 w-12 rounded-full bg-foreground text-background',
          'flex items-center justify-center',
          'shadow-lg hover:shadow-xl transition-all',
          'hover:scale-105 active:scale-95'
        )}
        title="Add pane"
      >
        <Plus className="h-5 w-5" />
      </button>
    </div>
  )
}
