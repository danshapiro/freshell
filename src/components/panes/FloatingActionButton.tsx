import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Plus, Terminal, Globe } from 'lucide-react'
import { cn } from '@/lib/utils'

interface FloatingActionButtonProps {
  onAddTerminal: () => void
  onAddBrowser: () => void
}

interface MenuItem {
  id: string
  label: string
  icon: typeof Terminal
  action: () => void
}

const MENU_ID = 'fab-menu'

export default function FloatingActionButton({ onAddTerminal, onAddBrowser }: FloatingActionButtonProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [focusedIndex, setFocusedIndex] = useState(0)
  const menuRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuItemRefs = useRef<(HTMLButtonElement | null)[]>([])

  const menuItems: MenuItem[] = useMemo(() => [
    { id: 'terminal', label: 'Terminal', icon: Terminal, action: onAddTerminal },
    { id: 'browser', label: 'Browser', icon: Globe, action: onAddBrowser },
  ], [onAddTerminal, onAddBrowser])

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

  // Focus first menu item when menu opens
  useEffect(() => {
    if (isOpen) {
      setFocusedIndex(0)
      // Use setTimeout to ensure the menu is rendered before focusing
      setTimeout(() => {
        menuItemRefs.current[0]?.focus()
      }, 0)
    }
  }, [isOpen])

  const closeMenuAndFocusButton = useCallback(() => {
    setIsOpen(false)
    buttonRef.current?.focus()
  }, [])

  const handleSelectItem = useCallback((action: () => void) => {
    action()
    closeMenuAndFocusButton()
  }, [closeMenuAndFocusButton])

  const handleButtonKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'Enter':
      case ' ':
        e.preventDefault()
        setIsOpen(prev => !prev)
        break
      case 'ArrowDown':
      case 'ArrowUp':
        e.preventDefault()
        if (!isOpen) {
          setIsOpen(true)
        }
        break
    }
  }, [isOpen])

  const handleMenuKeyDown = useCallback((e: React.KeyboardEvent, index: number) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        {
          const nextIndex = (index + 1) % menuItems.length
          setFocusedIndex(nextIndex)
          menuItemRefs.current[nextIndex]?.focus()
        }
        break
      case 'ArrowUp':
        e.preventDefault()
        {
          const prevIndex = (index - 1 + menuItems.length) % menuItems.length
          setFocusedIndex(prevIndex)
          menuItemRefs.current[prevIndex]?.focus()
        }
        break
      case 'Home':
        e.preventDefault()
        setFocusedIndex(0)
        menuItemRefs.current[0]?.focus()
        break
      case 'End':
        e.preventDefault()
        {
          const lastIndex = menuItems.length - 1
          setFocusedIndex(lastIndex)
          menuItemRefs.current[lastIndex]?.focus()
        }
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        handleSelectItem(menuItems[index].action)
        break
      case 'Escape':
      case 'Tab':
        e.preventDefault()
        closeMenuAndFocusButton()
        break
    }
  }, [menuItems, handleSelectItem, closeMenuAndFocusButton])

  return (
    <div className="absolute bottom-4 right-4 z-50">
      {/* Dropdown menu */}
      {isOpen && (
        <div
          ref={menuRef}
          id={MENU_ID}
          role="menu"
          aria-labelledby="fab-button"
          className="absolute bottom-14 right-0 mb-2 w-40 bg-card border border-border rounded-lg shadow-lg overflow-hidden"
        >
          {menuItems.map((item, index) => (
            <button
              key={item.id}
              ref={el => { menuItemRefs.current[index] = el }}
              role="menuitem"
              tabIndex={focusedIndex === index ? 0 : -1}
              onClick={() => handleSelectItem(item.action)}
              onKeyDown={(e) => handleMenuKeyDown(e, index)}
              className="w-full flex items-center gap-3 px-4 py-3 text-sm hover:bg-muted transition-colors focus:bg-muted focus:outline-none"
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </button>
          ))}
        </div>
      )}

      {/* FAB button */}
      <button
        id="fab-button"
        ref={buttonRef}
        onClick={() => setIsOpen(!isOpen)}
        onKeyDown={handleButtonKeyDown}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? MENU_ID : undefined}
        aria-label="Add pane"
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
