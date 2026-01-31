import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal, Globe, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'

type PaneType = 'shell' | 'browser' | 'editor'

interface PickerOption {
  type: PaneType
  label: string
  icon: typeof Terminal
  shortcut: string
}

const options: PickerOption[] = [
  { type: 'shell', label: 'Shell', icon: Terminal, shortcut: 'S' },
  { type: 'browser', label: 'Browser', icon: Globe, shortcut: 'B' },
  { type: 'editor', label: 'Editor', icon: FileText, shortcut: 'E' },
]

interface PanePickerProps {
  onSelect: (type: PaneType) => void
  onCancel: () => void
  isOnlyPane: boolean
}

export default function PanePicker({ onSelect, onCancel, isOnlyPane }: PanePickerProps) {
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const [fading, setFading] = useState(false)
  const pendingSelection = useRef<PaneType | null>(null)
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([])

  // Start fade animation before selection
  const handleSelect = useCallback((type: PaneType) => {
    if (fading) return
    pendingSelection.current = type
    setFading(true)
  }, [fading])

  // After fade animation completes, trigger actual selection
  const handleTransitionEnd = useCallback(() => {
    if (pendingSelection.current) {
      onSelect(pendingSelection.current)
    }
  }, [onSelect])

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()

      // Single-key shortcuts
      const option = options.find((o) => o.shortcut.toLowerCase() === key)
      if (option) {
        e.preventDefault()
        handleSelect(option.type)
        return
      }

      // Escape to cancel (only if not only pane)
      if (e.key === 'Escape' && !isOnlyPane) {
        e.preventDefault()
        onCancel()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleSelect, onCancel, isOnlyPane])

  const handleArrowNav = useCallback((e: React.KeyboardEvent, currentIndex: number) => {
    let nextIndex: number | null = null

    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault()
        nextIndex = (currentIndex + 1) % options.length
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault()
        nextIndex = (currentIndex - 1 + options.length) % options.length
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        handleSelect(options[currentIndex].type)
        return
    }

    if (nextIndex !== null) {
      setFocusedIndex(nextIndex)
      buttonRefs.current[nextIndex]?.focus()
    }
  }, [handleSelect])

  const showHint = (index: number) => focusedIndex === index || hoveredIndex === index

  return (
    <div
      className={cn(
        'h-full w-full flex items-center justify-center p-8',
        'transition-opacity duration-150 ease-out',
        fading && 'opacity-0'
      )}
      onTransitionEnd={handleTransitionEnd}
    >
      <div className="flex flex-wrap justify-center gap-8">
        {options.map((option, index) => (
          <button
            key={option.type}
            ref={(el) => { buttonRefs.current[index] = el }}
            onClick={() => handleSelect(option.type)}
            onKeyDown={(e) => handleArrowNav(e, index)}
            onFocus={() => setFocusedIndex(index)}
            onBlur={() => setFocusedIndex(null)}
            onMouseEnter={() => setHoveredIndex(index)}
            onMouseLeave={() => setHoveredIndex(null)}
            className={cn(
              'flex flex-col items-center gap-3 p-6 rounded-lg',
              'transition-all duration-150',
              'hover:opacity-100 focus:opacity-100 focus:outline-none',
              'opacity-50 hover:scale-105'
            )}
          >
            <option.icon className="h-12 w-12" />
            <span className="text-sm font-medium">{option.label}</span>
            {showHint(index) && (
              <span className="shortcut-hint text-xs opacity-60 -mt-1">
                {option.shortcut}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
