import { useState, useRef, useEffect, useCallback } from 'react'
import { Plus, Terminal, Globe } from 'lucide-react'
import { cn } from '@/lib/utils'

interface FloatingActionButtonProps {
  onAddTerminal: () => void
  onAddBrowser: () => void
}

export default function FloatingActionButton({ onAddTerminal, onAddBrowser }: FloatingActionButtonProps) {
  const [isOpen, setIsOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  // Close menu on outside click
  useEffect(() => {
    if (!isOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  const handleAddTerminal = useCallback(() => {
    onAddTerminal()
    setIsOpen(false)
  }, [onAddTerminal])

  const handleAddBrowser = useCallback(() => {
    onAddBrowser()
    setIsOpen(false)
  }, [onAddBrowser])

  return (
    <div className="absolute bottom-4 right-4 z-50">
      {/* Dropdown menu */}
      {isOpen && (
        <div
          ref={menuRef}
          className="absolute bottom-14 right-0 mb-2 w-40 bg-card border border-border rounded-lg shadow-lg overflow-hidden"
        >
          <button
            onClick={handleAddTerminal}
            className="w-full flex items-center gap-3 px-4 py-3 text-sm hover:bg-muted transition-colors"
          >
            <Terminal className="h-4 w-4" />
            Terminal
          </button>
          <button
            onClick={handleAddBrowser}
            className="w-full flex items-center gap-3 px-4 py-3 text-sm hover:bg-muted transition-colors"
          >
            <Globe className="h-4 w-4" />
            Browser
          </button>
        </div>
      )}

      {/* FAB button */}
      <button
        ref={buttonRef}
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          'h-12 w-12 rounded-full bg-foreground text-background',
          'flex items-center justify-center',
          'shadow-lg hover:shadow-xl transition-all',
          'hover:scale-105 active:scale-95',
          isOpen && 'rotate-45'
        )}
        title="Add pane"
      >
        <Plus className="h-5 w-5" />
      </button>
    </div>
  )
}
