import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { OVERLAY_Z } from '@/components/ui/overlay'

type Osc52PromptModalProps = {
  open: boolean
  onYes: () => void
  onNo: () => void
  onAlways: () => void
  onNever: () => void
}

export function Osc52PromptModal({
  open,
  onYes,
  onNo,
  onAlways,
  onNever,
}: Osc52PromptModalProps) {
  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onNo()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onNo])

  if (!open) return null

  return createPortal(
    <div
      className={`fixed inset-0 flex items-center justify-center bg-black/50 ${OVERLAY_Z.modal}`}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Clipboard access request"
        className="w-full max-w-lg rounded-lg border border-border bg-background p-5 shadow-xl"
      >
        <h2 className="text-base font-semibold">Clipboard access request</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          This terminal is trying to copy something to your clipboard. Allow?
        </p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button type="button" className="h-8 rounded-md px-3 text-sm" onClick={onNo}>
            No
          </button>
          <button type="button" className="h-8 rounded-md px-3 text-sm" onClick={onNever}>
            Never
          </button>
          <button type="button" className="h-8 rounded-md px-3 text-sm" onClick={onYes}>
            Yes
          </button>
          <button
            type="button"
            className="h-8 rounded-md bg-foreground px-3 text-sm text-background"
            onClick={onAlways}
          >
            Always
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
