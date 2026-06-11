import { useEffect } from 'react'

export type ActionSheetItem = {
  label: string
  disabled?: boolean
  destructive?: boolean
  run: () => void
}

/**
 * Bottom action sheet for touch devices — the coarse-pointer counterpart of
 * the floating right-click menu. Fixed to the bottom edge (thumb zone), 48px
 * rows, safe-area padded, dismissed by backdrop tap or Cancel.
 */
export function FreshAgentActionSheet({
  title,
  items,
  onClose,
}: {
  title?: string
  items: ActionSheetItem[]
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50" role="presentation">
      <button
        type="button"
        aria-label="Dismiss"
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
      />
      <div
        role="menu"
        aria-label={title ?? 'Actions'}
        className="absolute inset-x-0 bottom-0 rounded-t-xl border-t border-border bg-popover pb-[max(env(safe-area-inset-bottom),0.5rem)] shadow-lg"
      >
        <div className="mx-auto mt-2 h-1 w-9 rounded-full bg-border" aria-hidden />
        {title ? (
          <div className="truncate px-5 pb-1 pt-2 text-xs text-muted-foreground">{title}</div>
        ) : null}
        <div className="px-2 pt-1">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              className={[
                'block min-h-[3rem] w-full rounded-lg px-4 text-left text-base',
                item.disabled
                  ? 'cursor-not-allowed opacity-40'
                  : item.destructive
                    ? 'text-destructive active:bg-destructive/10'
                    : 'active:bg-accent',
              ].join(' ')}
              onClick={() => {
                onClose()
                if (!item.disabled) item.run()
              }}
            >
              {item.label}
            </button>
          ))}
          <button
            type="button"
            className="mt-1 block min-h-[3rem] w-full rounded-lg border-t border-border px-4 text-left text-base text-muted-foreground active:bg-accent"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

export default FreshAgentActionSheet
