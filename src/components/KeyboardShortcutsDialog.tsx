// Modal dialog displaying all keyboard shortcuts, grouped by category.

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { OVERLAY_Z } from '@/components/ui/overlay'
import { KEYBOARD_SHORTCUTS, SHORTCUT_CATEGORIES } from '@/lib/keyboard-shortcuts'

type KeyboardShortcutsDialogProps = {
  open: boolean
  onClose: () => void
}

export function KeyboardShortcutsDialog({ open, onClose }: KeyboardShortcutsDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    previousFocusRef.current = document.activeElement as HTMLElement | null

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('keydown', handleKey)
      previousFocusRef.current?.focus()
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      className={`fixed inset-0 flex items-center justify-center bg-black/50 ${OVERLAY_Z.modal}`}
      onClick={onClose}
      role="presentation"
      tabIndex={-1}
    >
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={dialogRef}
        className="bg-background border border-border rounded-lg shadow-lg w-full max-w-sm mx-4 p-5"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      >
        <h2 className="text-lg font-semibold mb-4">Keyboard Shortcuts</h2>
        {SHORTCUT_CATEGORIES.map(({ id, label }) => {
          const entries = KEYBOARD_SHORTCUTS.filter((s) => s.category === id)
          if (entries.length === 0) return null
          return (
            <div key={id} className="mb-4 last:mb-0">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">{label}</h3>
              <div className="space-y-1.5 text-sm">
                {entries.map((entry) => (
                  <div key={entry.description} className="flex items-center justify-between">
                    <span className="text-muted-foreground">{entry.description}</span>
                    <div className="flex items-center gap-1">
                      {entry.keys.map((key, i) => (
                        <span key={i}>
                          {i > 0 && <span className="text-muted-foreground/40 mx-0.5">+</span>}
                          <kbd className="px-1.5 py-0.5 text-2xs bg-muted rounded font-mono">{key}</kbd>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>,
    document.body,
  )
}
